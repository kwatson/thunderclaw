from __future__ import annotations

import argparse
import base64
import configparser
import hashlib
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Callable

from marionette_driver.addons import Addons
from marionette_driver.by import By
from marionette_driver.marionette import Marionette

from stub_backend import start_stub


EXTENSION_ID = "thunderclaw@addons.thunderbird.net"
ORIGINAL = "This draft needs work."
EXPECTED = (
    "Polished opening that should wrap naturally without a forced line break.\n\n"
    "A separate paragraph should also wrap naturally in Thunderbird."
)
BODY_TEXT_ORIGINAL = "Water testing is automated. Results are reported wirelessly."
BODY_TEXT_PREVIEW = "<ul><li>Automated testing</li><li>Water level monitoring</li><li>Wireless reporting</li></ul>"
PARAGRAPH_ORIGINAL = "Quick update: The cPanel api is finished. I'll update our api documentation website later this week."
PARAGRAPH_PREVIEW = "<p>Quick update: the cPanel API is finished.</p><p>I'll update our API documentation later this week.</p>"


def wait_until(description: str, operation: Callable[[], Any], timeout: float = 20.0) -> Any:
    deadline = time.monotonic() + timeout
    last_error: BaseException | None = None
    while time.monotonic() < deadline:
        try:
            value = operation()
            if value:
                return value
        except BaseException as error:  # The next observable state may not exist yet.
            last_error = error
        time.sleep(0.1)
    detail = f": {last_error}" if last_error else ""
    raise TimeoutError(f"Timed out waiting for {description}{detail}")


def wait_for_port(port: int, process: subprocess.Popen[str], timeout: float = 30.0) -> None:
    def ready() -> bool:
        if process.poll() is not None:
            raise RuntimeError(f"Thunderbird exited before Marionette became ready ({process.returncode})")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return True
        except OSError:
            return False

    wait_until("Marionette port", ready, timeout)


def unused_local_port() -> int:
    """Select a Marionette port without depending on a runner-global default."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def stop_process(process: subprocess.Popen[str]) -> None:
    """Allow Thunderbird to finish profile shutdown before forcing it to exit."""
    if process.poll() is not None:
        return
    try:
        process.wait(timeout=10)
        return
    except subprocess.TimeoutExpired:
        process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def chrome(client: Marionette, script: str, args: list[Any] | None = None) -> Any:
    client.set_context("chrome")
    return client.execute_script(script, script_args=args or [])


FIND_EXTENSION_DOCUMENT = r"""
const suffix = arguments[0];
const windows = Services.wm.getEnumerator(null);
while (windows.hasMoreElements()) {
  const win = windows.getNext();
  const documents = [win.document];
  const tab = win.gTabmail?.currentTabInfo;
  for (const browser of [tab?.browser, tab?.chromeBrowser]) {
    try { if (browser?.contentDocument) documents.push(browser.contentDocument); } catch (_) {}
  }
  for (const browser of win.document.querySelectorAll("browser")) {
    try { if (browser.contentDocument) documents.push(browser.contentDocument); } catch (_) {}
  }
  for (const document of documents) {
    try {
      if (document.location.href.endsWith(suffix)) return true;
    } catch (_) {}
  }
}
return false;
"""


WITH_EXTENSION_DOCUMENT = r"""
const suffix = arguments[0];
const action = arguments[1];
const value = arguments[2];
const windows = Services.wm.getEnumerator(null);
while (windows.hasMoreElements()) {
  const win = windows.getNext();
  const documents = [win.document];
  const tab = win.gTabmail?.currentTabInfo;
  for (const browser of [tab?.browser, tab?.chromeBrowser]) {
    try { if (browser?.contentDocument) documents.push(browser.contentDocument); } catch (_) {}
  }
  for (const browser of win.document.querySelectorAll("browser")) {
    try { if (browser.contentDocument) documents.push(browser.contentDocument); } catch (_) {}
  }
  for (const document of documents) {
    try {
      if (!document.location.href.endsWith(suffix)) continue;
      if (action === "text") return document.querySelector(value)?.textContent ?? null;
      if (action === "html") return document.querySelector(value)?.innerHTML ?? null;
      if (action === "value") return document.querySelector(value)?.value ?? null;
      if (action === "hidden") return document.querySelector(value)?.hidden ?? null;
      if (action === "dataset") {
        const element = document.querySelector(value.selector);
        return element?.dataset?.[value.name] ?? null;
      }
      if (action === "click") {
        const element = document.querySelector(value);
        if (!element) return false;
        element.click();
        return true;
      }
      if (action === "confirm-click") {
        const element = document.querySelector(value);
        if (!element) return false;
        const original = document.defaultView.confirm;
        document.defaultView.confirm = () => true;
        try { element.click(); }
        finally { document.defaultView.confirm = original; }
        return true;
      }
      if (action === "close") {
        document.defaultView.close();
        return true;
      }
      if (action === "set") {
        const element = document.querySelector(value.selector);
        if (!element) return false;
        element.value = value.value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      if (action === "pair") {
        const endpoint = document.querySelector("#endpoint");
        const consent = document.querySelector("#consent-accepted");
        const pair = document.querySelector("#pair");
        if (!endpoint || !consent || !pair) return false;
        endpoint.value = value.endpoint;
        endpoint.dispatchEvent(new Event("input", { bubbles: true }));
        consent.checked = true;
        consent.dispatchEvent(new Event("input", { bubbles: true }));
        consent.dispatchEvent(new Event("change", { bubbles: true }));
        if (pair.disabled) return false;
        pair.click();
        return true;
      }
    } catch (_) {}
  }
}
return null;
"""


def extension_document(client: Marionette, suffix: str, action: str, value: Any) -> Any:
    return chrome(client, WITH_EXTENSION_DOCUMENT, [suffix, action, value])


def open_options(client: Marionette) -> str:
    return chrome(client, r"""
const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
const extension = ExtensionParent.GlobalManager.extensionMap.get(arguments[0]);
if (!extension) throw new Error("installed extension is not running");
const url = extension.baseURI.resolve("options.html");
const win = Services.wm.getMostRecentWindow("mail:3pane");
const tabmail = win.document.getElementById("tabmail");
tabmail.openTab("contentTab", { url, background: false });
return url;
""", [EXTENSION_ID])


def accept_permission_prompt(client: Marionette) -> dict[str, Any]:
    return wait_until("host-permission prompt", lambda: chrome(client, r"""
const windows = Services.wm.getEnumerator(null);
while (windows.hasMoreElements()) {
  const win = windows.getNext();
  const selectors = [
    ".popup-notification-primary-button",
    "button[dlgtype='accept']",
    "button[data-l10n-id*='allow']",
    "button[data-l10n-id*='accept']"
  ];
  for (const selector of selectors) {
    for (const button of win.document.querySelectorAll(selector)) {
      if (button.disabled || button.hidden) continue;
      const label = button.label || button.textContent || button.getAttribute("data-l10n-id") || selector;
      button.click();
      return { clicked: true, label: String(label).trim().slice(0, 80) };
    }
  }
}
return null;
"""), 15.0)


def configure_connection(
    client: Marionette,
    port: int,
    *,
    initial_phases: tuple[str, ...] = ("not_configured",),
    open_new_options: bool = True,
) -> dict[str, Any]:
    url = open_options(client) if open_new_options else "already-open options document"
    wait_until("ThunderClaw options document", lambda: chrome(client, FIND_EXTENSION_DOCUMENT, ["options.html"]))
    wait_until(
        "initial ThunderClaw options phase",
        lambda: extension_document(client, "options.html", "dataset", {
            "selector": "#connection-panel", "name": "phase",
        }) in initial_phases,
    )
    configured = extension_document(client, "options.html", "pair", {
        "endpoint": f"http://127.0.0.1:{port}/thunderclaw/v1",
    })
    if configured is not True:
        raise RuntimeError(f"Could not configure extension options at {url}")
    prompt = accept_permission_prompt(client)
    wait_until("pairing request", lambda: extension_document(
        client, "options.html", "dataset", {"selector": "#connection-panel", "name": "phase"}
    ) == "awaiting_approval")
    if extension_document(client, "options.html", "click", "#claim") is not True:
        raise RuntimeError("Claim approved pairing button was not available")
    wait_until("authorized extension state", lambda: extension_document(
        client, "options.html", "dataset", {"selector": "#connection-panel", "name": "phase"}
    ) == "authorized_untested")
    if extension_document(client, "options.html", "click", "#diagnose") is not True:
        raise RuntimeError("Test connection button was not available")
    wait_until(
        "ready extension state",
        lambda: extension_document(client, "options.html", "dataset", {
            "selector": "#connection-panel", "name": "phase",
        }) == "ready",
    )
    return {"optionsUrl": url, "permissionPrompt": prompt}


def open_compose(client: Marionette) -> None:
    chrome(client, r"""
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
let account = MailServices.accounts.accounts.find(account => account.incomingServer?.hostName === "e2e.invalid");
let identity;
if (!account) {
  account = MailServices.accounts.createAccount();
  const server = MailServices.accounts.createIncomingServer("thunderclaw", "e2e.invalid", "pop3");
  server.valid = true;
  account.incomingServer = server;
  identity = MailServices.accounts.createIdentity();
  identity.email = "author@e2e.invalid";
  identity.fullName = "ThunderClaw E2E";
  const outgoing = MailServices.outgoingServer.createServer("smtp");
  outgoing.QueryInterface(Ci.nsISmtpServer);
  outgoing.username = "thunderclaw";
  outgoing.hostname = "e2e.invalid";
  outgoing.port = 587;
  identity.smtpServerKey = outgoing.key;
  account.addIdentity(identity);
  account.defaultIdentity = identity;
  MailServices.accounts.defaultAccount = account;
} else identity = account.defaultIdentity;
if (!identity) throw new Error("fixture identity was not created");
const main = Services.wm.getMostRecentWindow("mail:3pane");
main.goDoCommand("cmd_newMessage");
return {
  accountKey: account.key,
  identityKey: identity.key,
  defaultAccountKey: MailServices.accounts.defaultAccount?.key || null,
};
""")
    wait_until("compose window", lambda: chrome(client, r"""
const windows = Services.wm.getEnumerator(null);
const found = [];
while (windows.hasMoreElements()) {
  const win = windows.getNext();
  found.push({ type: win.document.documentElement.getAttribute("windowtype"), href: win.location.href });
}
const compose = found.find(item => item.type === "msgcompose");
return compose ? { compose, found } : null;
"""), 15.0)
    wait_until("compose editor", lambda: chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const frame = win?.document.getElementById("messageEditor");
const body = frame?.contentDocument?.body;
return body ? {
  frameName: frame.localName,
  readyState: frame.contentDocument.readyState,
  designMode: frame.contentDocument.designMode,
  contentEditable: body.contentEditable,
  isContentEditable: body.isContentEditable,
} : null;
"""), 30.0)


def set_and_select_body(client: Marionette, text: str) -> str:
    return chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const editor = win.document.getElementById("messageEditor");
const body = editor.contentDocument.body;
body.focus();
body.replaceChildren();
const selection = editor.contentWindow.getSelection();
const insertion = editor.contentDocument.createRange();
insertion.selectNodeContents(body);
selection.removeAllRanges();
selection.addRange(insertion);
editor.contentDocument.execCommand("insertText", false, arguments[0]);
const textNode = body.firstChild;
if (!textNode || textNode.nodeType !== Node.TEXT_NODE) throw new Error("unexpected initial compose DOM");
const range = editor.contentDocument.createRange();
range.setStart(textNode, 0);
range.setEnd(textNode, textNode.data.length);
selection.removeAllRanges();
selection.addRange(range);
return body.textContent;
""", [text])


def compose_body(client: Marionette) -> str:
    return chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
return win.document.getElementById("messageEditor").contentDocument.body.innerText;
""")


def body_text_expected_html(applied: bool) -> str:
    br = "<br>"
    content = BODY_TEXT_PREVIEW if applied else BODY_TEXT_ORIGINAL
    return f"BEFORE_CANARY{br}{br}{content}{br}{br}AFTER_CANARY"


def set_and_select_body_text_paragraph(client: Marionette, backward: bool = False) -> dict[str, Any]:
    return chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const editor = win.document.getElementById("messageEditor");
const doc = editor.contentDocument, body = doc.body;
const before = doc.createTextNode("BEFORE_CANARY");
const target = doc.createTextNode(arguments[0]);
const after = doc.createTextNode("AFTER_CANARY");
const br = () => doc.createElement("br");
body.replaceChildren(before, br(), br(), target, br(), br(), after);
editor.contentWindow.__thunderclawBodyTextRefs = { before, target, after };
const selection = editor.contentWindow.getSelection(), range = doc.createRange();
range.setStart(target, 0); range.setEnd(target, target.data.length);
body.focus(); selection.removeAllRanges();
if (arguments[1]) selection.setBaseAndExtent(target, target.data.length, target, 0);
else selection.addRange(range);
return { html: body.innerHTML, text: range.toString() };
""", [BODY_TEXT_ORIGINAL, backward])


def body_text_state(client: Marionette) -> dict[str, Any]:
    return chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose"), editor = win.document.getElementById("messageEditor");
const body = editor.contentDocument.body, selection = editor.contentWindow.getSelection();
const refs = editor.contentWindow.__thunderclawBodyTextRefs;
const range = selection.rangeCount === 1 ? selection.getRangeAt(0) : null;
const path = node => { const result = []; while (node !== body) { const parent = node?.parentNode; if (!parent) return null;
  result.unshift(Array.prototype.indexOf.call(parent.childNodes, node)); node = parent; } return result; };
return { html: body.innerHTML, identities: { before: refs.before.isConnected && body.firstChild === refs.before,
  target: refs.target.isConnected, after: refs.after.isConnected && body.lastChild === refs.after },
  selection: range ? { startPath: path(range.startContainer), startOffset: range.startOffset,
    endPath: path(range.endContainer), endOffset: range.endOffset, anchorPath: path(selection.anchorNode),
    anchorOffset: selection.anchorOffset, focusPath: path(selection.focusNode), focusOffset: selection.focusOffset } : null };
""")


def set_and_select_paragraph(client: Marionette, backward: bool = False) -> dict[str, Any]:
    return chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose"), editor = win.document.getElementById("messageEditor");
const doc = editor.contentDocument, body = doc.body;
const make = value => { const paragraph = doc.createElement("p"); paragraph.setAttribute("_moz_dirty", "");
  paragraph.append(doc.createTextNode(value)); return paragraph; };
const before = make("BEFORE_CANARY"), target = make(arguments[0]), after = make("AFTER_CANARY");
body.replaceChildren(before, target, after); editor.contentWindow.__thunderclawParagraphRefs = { before, target, after };
const selection = editor.contentWindow.getSelection(), range = doc.createRange();
range.setStart(target.firstChild, 0); range.setEnd(target.firstChild, target.firstChild.data.length);
body.focus(); selection.removeAllRanges();
if (arguments[1]) selection.setBaseAndExtent(target.firstChild, target.firstChild.data.length, target.firstChild, 0);
else selection.addRange(range);
return { html: body.innerHTML, text: range.toString() };
""", [PARAGRAPH_ORIGINAL, backward])


def paragraph_state(client: Marionette) -> dict[str, Any]:
    return chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose"), editor = win.document.getElementById("messageEditor");
const body = editor.contentDocument.body, selection = editor.contentWindow.getSelection();
const refs = editor.contentWindow.__thunderclawParagraphRefs;
const range = selection.rangeCount === 1 ? selection.getRangeAt(0) : null;
const path = node => { const result = []; while (node !== body) { const parent = node?.parentNode; if (!parent) return null;
  result.unshift(Array.prototype.indexOf.call(parent.childNodes, node)); node = parent; } return result; };
return { html: body.innerHTML, identities: { before: refs.before.isConnected && body.firstChild === refs.before,
  target: refs.target.isConnected, after: refs.after.isConnected && body.lastChild === refs.after },
  selection: range ? { startPath: path(range.startContainer), startOffset: range.startOffset,
    endPath: path(range.endContainer), endOffset: range.endOffset, anchorPath: path(selection.anchorNode),
    anchorOffset: selection.anchorOffset, focusPath: path(selection.focusNode), focusOffset: selection.focusOffset } : null };
""")


def open_compose_action(client: Marionette) -> dict[str, Any]:
    action_id = "thunderclaw_addons_thunderbird_net-composeAction-toolbarbutton"

    def click_action() -> dict[str, Any] | None:
        for handle in client.chrome_window_handles:
            client.switch_to_window(handle)
            if chrome(client, "return document.documentElement.getAttribute('windowtype');") != "msgcompose":
                continue
            element = client.find_element(By.ID, action_id)
            details = {
                "id": element.get_attribute("id"),
                "label": element.get_attribute("label") or element.get_attribute("title") or "",
            }
            chrome(client, "window.focus();")
            wait_until(
                "focused compose window",
                lambda: chrome(client, "return Services.focus.activeWindow === window;"),
                5.0,
            )
            triggered = chrome(client, r"""
const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
const extension = ExtensionParent.GlobalManager.extensionMap.get(arguments[0]);
const action = ExtensionParent.apiManager.global.composeActionFor(extension);
return action.triggerAction(window, { requirePopupUrl: true });
""", [EXTENSION_ID])
            if triggered is not True:
                raise RuntimeError("Thunderbird did not trigger the compose action popup")
            # Thunderbird 153's non-remote popup browser can miss its initial
            # about:blank load event. The harness uses non-remote extension
            # pages only because Marionette cannot address Thunderbird's
            # remote content-tab/popup browsing contexts yet.
            chrome(client, r"""
const browser = document.querySelector("browser.webextension-popup-browser");
if (browser?.currentURI?.spec === "about:blank") browser.dispatchEvent(new Event("load"));
""")
            return details
        return None

    return wait_until("ThunderClaw compose action", click_action, 20.0)


def exercise_popup(client: Marionette) -> dict[str, Any]:
    action = open_compose_action(client)
    wait_until("compose action popup", lambda: chrome(client, FIND_EXTENSION_DOCUMENT, ["popup.html"]))
    selected = wait_until(
        "captured compose selection",
        lambda: extension_document(client, "popup.html", "text", "#status") == f"{len(ORIGINAL)} characters selected",
    )
    before_preview = compose_body(client)
    if extension_document(client, "popup.html", "click", "#run") is not True:
        raise RuntimeError("Generate preview button was not available")
    wait_until(
        "compose preview",
        lambda: extension_document(client, "popup.html", "text", "#status") == "Preview ready",
        30.0,
    )
    preview = extension_document(client, "popup.html", "text", "#replacement")
    after_preview = compose_body(client)
    if after_preview != before_preview:
        raise AssertionError("Generate/Preview mutated the compose body")
    if preview != EXPECTED:
        raise AssertionError(f"Unexpected preview: {preview!r}")
    if extension_document(client, "popup.html", "click", "#apply") is not True:
        raise RuntimeError("Apply button was not available")
    wait_until(
        "applied compose state",
        lambda: extension_document(client, "popup.html", "text", "#status") == "Applied — Thunderbird still controls Send",
    )
    after_apply = compose_body(client)
    if after_apply != EXPECTED:
        raise AssertionError(f"Unexpected body after Apply: {after_apply!r}")
    if extension_document(client, "popup.html", "click", "#discard") is not True:
        raise RuntimeError("Undo button was not available")
    wait_until(
        "undone compose state",
        lambda: extension_document(client, "popup.html", "text", "#status") == "Change undone",
    )
    after_undo = compose_body(client)
    if after_undo != ORIGINAL:
        raise AssertionError(f"Unexpected body after Undo: {after_undo!r}")
    return {
        "action": action,
        "selectionReady": selected,
        "beforePreview": before_preview,
        "preview": preview,
        "afterPreview": after_preview,
        "afterApply": after_apply,
        "afterUndo": after_undo,
    }


def exercise_body_text_list_popup(client: Marionette) -> dict[str, Any]:
    action = open_compose_action(client)
    wait_until("Body Text compose action popup", lambda: chrome(client, FIND_EXTENSION_DOCUMENT, ["popup.html"]))
    wait_until("Body Text selection capture", lambda: extension_document(client, "popup.html", "text", "#status")
               == f"{len(BODY_TEXT_ORIGINAL)} characters selected")
    if extension_document(client, "popup.html", "set", {"selector": "#action", "value": "ask"}) is not True:
        raise RuntimeError("Custom instruction action was unavailable")
    if extension_document(client, "popup.html", "set", {
        "selector": "#instruction", "value": "can you convert this to a bullet list?",
    }) is not True:
        raise RuntimeError("Custom instruction field was unavailable")
    original = body_text_state(client)
    if original["html"] != body_text_expected_html(False) or not all(original["identities"].values()):
        raise AssertionError(f"Unexpected Body Text fixture: {original!r}")
    if extension_document(client, "popup.html", "click", "#run") is not True:
        raise RuntimeError("Generate preview button was unavailable for Body Text")
    wait_until("Body Text list preview", lambda: extension_document(client, "popup.html", "text", "#status") == "Preview ready", 30.0)
    preview_html = extension_document(client, "popup.html", "html", "#replacement")
    after_preview = body_text_state(client)
    if preview_html != BODY_TEXT_PREVIEW:
        raise AssertionError(f"Body Text preview was not a real unordered list: {preview_html!r}")
    if after_preview != original:
        raise AssertionError("Body Text Preview mutated the compose DOM or selection")
    if extension_document(client, "popup.html", "click", "#apply") is not True:
        raise RuntimeError("Apply was unavailable for Body Text list conversion")
    wait_until("Body Text list Apply", lambda: extension_document(client, "popup.html", "text", "#status")
               == "Applied — Thunderbird still controls Send")
    applied = body_text_state(client)
    if applied["html"] != body_text_expected_html(True) or not applied["identities"]["before"] or not applied["identities"]["after"]:
        raise AssertionError(f"Body Text Apply did not create an exact real list: {applied!r}")
    if extension_document(client, "popup.html", "click", "#discard") is not True:
        raise RuntimeError("Undo was unavailable for Body Text list conversion")
    wait_until("Body Text list Undo", lambda: extension_document(client, "popup.html", "text", "#status") == "Change undone")
    undone = body_text_state(client)
    if undone != original:
        raise AssertionError(f"Body Text Undo was not exact: {undone!r}")
    redo = chrome(client, r"""
const frame = Services.wm.getMostRecentWindow("msgcompose").document.getElementById("messageEditor");
frame.contentDocument.body.focus(); return frame.contentDocument.execCommand("redo");
""")
    redone = body_text_state(client)
    if redo is not True or redone != applied:
        raise AssertionError(f"Body Text native Redo was not exact: {redone!r}")
    return {"action": action, "instruction": "can you convert this to a bullet list?",
            "boundaryMarkerProfile": "attribute-free", "original": original,
            "previewHtml": preview_html, "afterPreview": after_preview, "applied": applied,
            "undone": undone, "redoReturned": redo, "redone": redone}


def exercise_paragraph_expansion_popup(client: Marionette) -> dict[str, Any]:
    action = open_compose_action(client)
    wait_until("paragraph compose action popup", lambda: chrome(client, FIND_EXTENSION_DOCUMENT, ["popup.html"]))
    wait_until("paragraph selection capture", lambda: extension_document(client, "popup.html", "text", "#status")
               == f"{len(PARAGRAPH_ORIGINAL)} characters selected")
    if extension_document(client, "popup.html", "set", {"selector": "#action", "value": "ask"}) is not True:
        raise RuntimeError("Custom instruction action was unavailable")
    if extension_document(client, "popup.html", "set", {
        "selector": "#instruction", "value": "split this into two paragraphs",
    }) is not True:
        raise RuntimeError("Custom instruction field was unavailable")
    original = paragraph_state(client)
    expected_original = f"<p>BEFORE_CANARY</p><p>{PARAGRAPH_ORIGINAL}</p><p>AFTER_CANARY</p>"
    if original["html"] != expected_original or not all(original["identities"].values()):
        raise AssertionError(f"Unexpected paragraph fixture: {original!r}")
    if extension_document(client, "popup.html", "click", "#run") is not True:
        raise RuntimeError("Generate preview button was unavailable for paragraph expansion")
    wait_until("paragraph expansion preview", lambda: extension_document(client, "popup.html", "text", "#status") == "Preview ready", 30.0)
    preview_html = extension_document(client, "popup.html", "html", "#replacement")
    after_preview = paragraph_state(client)
    if preview_html != PARAGRAPH_PREVIEW or after_preview != original:
        raise AssertionError("Paragraph expansion Preview was not exact and non-mutating")
    if extension_document(client, "popup.html", "click", "#apply") is not True:
        raise RuntimeError("Apply was unavailable for paragraph expansion")
    wait_until("paragraph expansion Apply", lambda: extension_document(client, "popup.html", "text", "#status")
               == "Applied — Thunderbird still controls Send")
    applied = paragraph_state(client)
    expected_applied = f"<p>BEFORE_CANARY</p>{PARAGRAPH_PREVIEW}<p>AFTER_CANARY</p>"
    if applied["html"] != expected_applied or applied["identities"] != {"before": True, "target": False, "after": True}:
        raise AssertionError(f"Paragraph expansion left an empty source wrapper: {applied!r}")
    if extension_document(client, "popup.html", "click", "#discard") is not True:
        raise RuntimeError("Undo was unavailable for paragraph expansion")
    wait_until("paragraph expansion Undo", lambda: extension_document(client, "popup.html", "text", "#status") == "Change undone")
    undone = paragraph_state(client)
    if undone != original:
        raise AssertionError(f"Paragraph expansion Undo was not exact: {undone!r}")
    redo = chrome(client, r"""
const frame = Services.wm.getMostRecentWindow("msgcompose").document.getElementById("messageEditor");
frame.contentDocument.body.focus(); return frame.contentDocument.execCommand("redo");
""")
    redone = paragraph_state(client)
    if redo is not True or redone != applied:
        raise AssertionError(f"Paragraph expansion native Redo was not exact: {redone!r}")
    return {"action": action, "instruction": "split this into two paragraphs", "original": original,
            "previewHtml": preview_html, "afterPreview": after_preview, "applied": applied,
            "undone": undone, "redoReturned": redo, "redone": redone}


def save_screenshot(client: Marionette, path: Path) -> None:
    try:
        encoded = client.screenshot(full=True)
        if isinstance(encoded, str):
            path.write_bytes(base64.b64decode(encoded))
    except BaseException:
        pass


def run_trial(
    number: int,
    xpi: Path,
    artifacts: Path,
    stub_port: int,
    expected_version: str,
    expected_build_id: str,
    thunderbird: Path,
    user_js: Path,
    headless: bool,
) -> dict[str, Any]:
    trial_dir = artifacts / f"trial-{number}"
    trial_dir.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix=f"thunderclaw-e2e-{number}-"))
    shutil.copyfile(user_js, profile / "user.js")
    marionette_port = unused_local_port()
    with (profile / "user.js").open("a", encoding="utf-8", newline="\n") as preferences:
        preferences.write(f'user_pref("marionette.port", {marionette_port});\n')
    log_path = trial_dir / "thunderbird.log"
    with log_path.open("w", encoding="utf-8") as log:
        command = [
            str(thunderbird),
            "--marionette",
            "-remote-allow-system-access",
            "-no-remote",
        ]
        if headless:
            command.append("--headless")
        command.extend(["-profile", str(profile)])
        process = subprocess.Popen(
            command,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
        )
        client: Marionette | None = None
        try:
            wait_for_port(marionette_port, process)
            client = Marionette(host="127.0.0.1", port=marionette_port)
            capabilities = client.start_session()
            runtime = chrome(client, "return { version: Services.appinfo.version, buildId: Services.appinfo.appBuildID };")
            if runtime != {"version": expected_version, "buildId": expected_build_id}:
                raise AssertionError(
                    f"Expected Thunderbird {expected_version} build {expected_build_id}, got {runtime!r}"
                )
            installed_id = Addons(client).install(str(xpi), temp=True)
            if installed_id != EXTENSION_ID:
                raise AssertionError(f"Installed unexpected extension ID: {installed_id!r}")
            wait_until("extension startup", lambda: chrome(client, r"""
const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
return ExtensionParent.GlobalManager.extensionMap.has(arguments[0]);
""", [EXTENSION_ID]))
            connection = configure_connection(client, stub_port)
            open_compose(client)
            initial = set_and_select_body(client, ORIGINAL)
            if initial != ORIGINAL:
                raise AssertionError(f"Unexpected initial compose body: {initial!r}")
            compose = exercise_popup(client)
            body_text_list = None
            paragraph_expansion = None
            if expected_version.startswith("153."):
                extension_document(client, "popup.html", "close", None)
                wait_until("first compose popup close", lambda: not chrome(client, FIND_EXTENSION_DOCUMENT, ["popup.html"]))
                fixture = set_and_select_body_text_paragraph(client)
                if fixture != {"html": body_text_expected_html(False), "text": BODY_TEXT_ORIGINAL}:
                    raise AssertionError(f"Unexpected Body Text list fixture: {fixture!r}")
                body_text_list = exercise_body_text_list_popup(client)
                extension_document(client, "popup.html", "close", None)
                wait_until("Body Text popup close", lambda: not chrome(client, FIND_EXTENSION_DOCUMENT, ["popup.html"]))
                fixture = set_and_select_paragraph(client, backward=number == 2)
                if fixture != {"html": f"<p>BEFORE_CANARY</p><p>{PARAGRAPH_ORIGINAL}</p><p>AFTER_CANARY</p>",
                               "text": PARAGRAPH_ORIGINAL}:
                    raise AssertionError(f"Unexpected paragraph expansion fixture: {fixture!r}")
                paragraph_expansion = exercise_paragraph_expansion_popup(client)
            result = {
                "trial": number,
                "status": "passed",
                "capabilities": capabilities,
                "runtime": runtime,
                "installedExtensionId": installed_id,
                "connection": connection,
                "compose": compose,
                "bodyTextListConversion": body_text_list,
                "paragraphExpansion": paragraph_expansion,
            }
            (trial_dir / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
            return result
        except BaseException as error:
            if client is not None:
                save_screenshot(client, trial_dir / "failure.png")
            failure = {"trial": number, "status": "failed", "error": str(error), "traceback": traceback.format_exc()}
            (trial_dir / "result.json").write_text(json.dumps(failure, indent=2), encoding="utf-8")
            raise
        finally:
            if client is not None:
                try:
                    client.quit(in_app=True)
                except BaseException:
                    pass
            stop_process(process)
            shutil.rmtree(profile, ignore_errors=True)


def write_junit(
    artifacts: Path,
    results: list[dict[str, Any]],
    error: BaseException | None,
    error_traceback: str | None,
) -> None:
    suite = ET.Element("testsuite", name="thunderclaw.real-thunderbird.compose", tests=str(len(results) + (1 if error else 0)))
    for result in results:
        ET.SubElement(suite, "testcase", classname="real-thunderbird", name=f"fresh-profile-{result['trial']}")
    if error is not None:
        case = ET.SubElement(suite, "testcase", classname="real-thunderbird", name=f"fresh-profile-{len(results) + 1}")
        failure = ET.SubElement(case, "failure", message=str(error))
        failure.text = error_traceback or str(error)
        suite.set("failures", "1")
    else:
        suite.set("failures", "0")
    ET.ElementTree(suite).write(artifacts / "junit.xml", encoding="utf-8", xml_declaration=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xpi", required=True, type=Path)
    parser.add_argument("--artifacts", required=True, type=Path)
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--thunderbird", type=Path, default=Path(shutil.which("thunderbird") or "thunderbird"))
    parser.add_argument("--application-ini", type=Path, default=Path("/opt/thunderbird/application.ini"))
    parser.add_argument("--user-js", type=Path, default=Path("/opt/thunderclaw-e2e/user.js"))
    parser.add_argument("--headless", action="store_true")
    args = parser.parse_args()
    args.xpi = args.xpi.resolve()
    args.artifacts = args.artifacts.resolve()
    args.thunderbird = args.thunderbird.resolve()
    args.application_ini = args.application_ini.resolve()
    args.user_js = args.user_js.resolve()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    if not args.xpi.is_file():
        raise FileNotFoundError(args.xpi)
    if not args.thunderbird.is_file():
        raise FileNotFoundError(args.thunderbird)
    if not args.user_js.is_file():
        raise FileNotFoundError(args.user_js)
    application = configparser.ConfigParser()
    if not application.read(args.application_ini):
        raise FileNotFoundError(args.application_ini)
    actual_version = application["App"]["Version"]
    actual_build_id = application["App"]["BuildID"]
    expected_app_version = args.expected_version.removesuffix("esr")
    if actual_version != expected_app_version:
        raise AssertionError(f"Expected Thunderbird {args.expected_version}, got {actual_version}")
    metadata = {
        "release": args.expected_version,
        "version": actual_version,
        "buildId": actual_build_id,
        "extensionId": EXTENSION_ID,
        "platform": sys.platform,
        "headless": args.headless,
        "xpiSha256": hashlib.sha256(args.xpi.read_bytes()).hexdigest(),
        "coverage": {
            "kind": "real-compose-action-popup",
            "network": "none",
            "freshProfiles": 2,
            "qualification": "product-e2e",
        },
    }
    (args.artifacts / "metadata.json").write_text(json.dumps(metadata, indent=2, sort_keys=True), encoding="utf-8")
    server, state, thread = start_stub()
    results: list[dict[str, Any]] = []
    caught: BaseException | None = None
    caught_traceback: str | None = None
    try:
        for trial in (1, 2):
            results.append(run_trial(
                trial,
                args.xpi,
                args.artifacts,
                server.server_address[1],
                actual_version,
                actual_build_id,
                args.thunderbird,
                args.user_js,
                args.headless,
            ))
    except BaseException as error:
        caught = error
        caught_traceback = traceback.format_exc()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        (args.artifacts / "stub-requests.json").write_text(
            json.dumps(state.requests, indent=2, sort_keys=True), encoding="utf-8"
        )
        write_junit(args.artifacts, results, caught, caught_traceback)
    if caught is not None:
        raise caught
    print(json.dumps({"status": "passed", "trials": len(results), "artifacts": str(args.artifacts)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

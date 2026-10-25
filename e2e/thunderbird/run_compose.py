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

from stub_inference import RICH_FORMATTING_INSTRUCTION, RICH_SOURCE_BLOCKS, RICH_SOURCE_TEXT, start_stub


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
RICH_SOURCE_HTML = "<p>This <b>draft</b> keeps <i>important</i> and <u>timely</u> details.</p>"
RICH_FORMATTING_PREVIEW = RICH_SOURCE_HTML.replace("<b>draft</b>", "<b>final</b>")


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


def quit_thunderbird(client: Marionette) -> None:
    # The runner launches Thunderbird itself; Marionette.quit requires an owned instance.
    chrome(client, r"""
Services.tm.dispatchToMainThread(() => Services.startup.quit(Ci.nsIAppStartup.eForceQuit));
return true;
""")


FIND_EXTENSION_DOCUMENT = r"""
const suffix = arguments[0];
const windows = Services.wm.getEnumerator(null);
while (windows.hasMoreElements()) {
  const win = windows.getNext();
  const documents = [win.document];
  const tab = (win.gTabmail ?? win.document.getElementById("tabmail"))?.currentTabInfo;
  for (const browser of [tab?.browser, tab?.chromeBrowser]) {
    try { if (browser?.contentDocument) documents.push(browser.contentDocument); } catch (_) {}
  }
  for (const browser of win.document.querySelectorAll("browser")) {
    try { if (browser.contentDocument) documents.push(browser.contentDocument); } catch (_) {}
  }
  // Received-action popups may be hosted inside the about:message document.
  const visited = new Set(documents);
  for (let index = 0; index < documents.length; index++) {
    for (const frame of documents[index].querySelectorAll("browser, iframe")) {
      try {
        if (frame.contentDocument && !visited.has(frame.contentDocument)) {
          visited.add(frame.contentDocument); documents.push(frame.contentDocument);
        }
      } catch (_) {}
    }
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
  const tab = (win.gTabmail ?? win.document.getElementById("tabmail"))?.currentTabInfo;
  for (const browser of [tab?.browser, tab?.chromeBrowser]) {
    try { if (browser?.contentDocument) documents.push(browser.contentDocument); } catch (_) {}
  }
  for (const browser of win.document.querySelectorAll("browser")) {
    try { if (browser.contentDocument) documents.push(browser.contentDocument); } catch (_) {}
  }
  // Received-action popups may be hosted inside the about:message document.
  const visited = new Set(documents);
  for (let index = 0; index < documents.length; index++) {
    for (const frame of documents[index].querySelectorAll("browser, iframe")) {
      try {
        if (frame.contentDocument && !visited.has(frame.contentDocument)) {
          visited.add(frame.contentDocument); documents.push(frame.contentDocument);
        }
      } catch (_) {}
    }
  }
  for (const document of documents) {
    try {
      if (!document.location.href.endsWith(suffix)) continue;
      if (action === "text") return document.querySelector(value)?.textContent ?? null;
      if (action === "html") return document.querySelector(value)?.innerHTML ?? null;
      if (action === "value") return document.querySelector(value)?.value ?? null;
      if (action === "model-options") {
        const picker = document.querySelector("#available-models");
        return picker && !document.querySelector("#model-choices")?.hidden ? Array.from(document.querySelectorAll("#model-options [role=option]"), item => item.dataset.value) : [];
      }
      if (action === "pointer-target") {
        const element = document.querySelector(value.selector);
        if (!element) throw new Error("Pointer target is missing");
        if (value.scroll) element.scrollIntoView({ block: "center" });
        const host = Array.from(win.document.querySelectorAll("browser")).find(item => item.contentDocument === document);
        if (!host) throw new Error("Options browser is missing");
        if (!document.documentElement.dataset.pickerProbeInstalled) {
          document.documentElement.dataset.pickerProbeInstalled = "true";
          document.addEventListener("mousemove", event => {
            document.documentElement.dataset.pickerPointerX = String(event.clientX);
            document.documentElement.dataset.pickerPointerY = String(event.clientY);
          });
        }
        const bounds = element.getBoundingClientRect(), frame = host.getBoundingClientRect();
        return { x: Math.round(frame.left + bounds.left + bounds.width / 2), y: Math.round(frame.top + bounds.top + bounds.height / 2),
          clientX: Math.round(bounds.left + bounds.width / 2), clientY: Math.round(bounds.top + bounds.height / 2) };
      }
      if (action === "pointer-position") {
        return { x: Number(document.documentElement.dataset.pickerPointerX), y: Number(document.documentElement.dataset.pickerPointerY) };
      }
      if (action === "picker-open") {
        const picker = document.querySelector("#available-models"), options = document.querySelector("#model-options");
        return picker?.getAttribute("aria-expanded") === "true" && options && !options.hidden;
      }
      if (action === "picker-style") {
        const field = document.defaultView.getComputedStyle(document.querySelector("#model"));
        const picker = document.defaultView.getComputedStyle(document.querySelector("#available-models"));
        return ["backgroundColor", "color", "fontFamily", "fontSize", "borderTopWidth", "borderTopStyle", "borderTopColor", "borderTopLeftRadius"].every(property => field[property] === picker[property]);
      }
      if (action === "save-inference") {
        const picker = document.querySelector("#available-models"), options = document.querySelector("#model-options");
        const form = document.querySelector("#connection-form");
        if (!form || picker?.getAttribute("aria-expanded") !== "false" || !options?.hidden) return false;
        if (document.querySelector("#model")?.value !== "fixture-model") return false;
        document.querySelector("#consent-accepted").checked = true;
        const userInput = win.windowUtils.setHandlingUserInput(true);
        try { form.requestSubmit(); } finally { userInput.destruct(); }
        return true;
      }
      if (action === "hidden") return document.querySelector(value)?.hidden ?? null;
      if (action === "checked") return document.querySelector(value)?.checked ?? null;
      if (action === "dataset") {
        const element = document.querySelector(value.selector);
        return element?.dataset?.[value.name] ?? null;
      }
      if (action === "probe-credentials") {
        const request = document.defaultView.indexedDB.open("thunderclaw-inference-credentials-v1");
        request.onupgradeneeded = () => { document.documentElement.dataset.credentialProbe = "missing"; request.transaction.abort(); };
        request.onerror = () => { document.documentElement.dataset.credentialProbe ??= String(request.error?.name ?? "open-error"); };
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("credentials")) { document.documentElement.dataset.credentialProbe = "missing-store"; db.close(); return; }
          const transaction = db.transaction("credentials", "readonly");
          const count = transaction.objectStore("credentials").count();
          count.onsuccess = () => { document.documentElement.dataset.credentialProbe = `records:${count.result}`; };
          transaction.onerror = () => { document.documentElement.dataset.credentialProbe = String(transaction.error?.name ?? "transaction-error"); };
          transaction.oncomplete = transaction.onabort = () => db.close();
        };
        return true;
      }
      if (action === "click") {
        const element = document.querySelector(value);
        if (!element) return false;
        const userInput = win.windowUtils.setHandlingUserInput(true);
        try { element.click(); }
        finally { userInput.destruct(); }
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
      if (action === "inference") {
        const provider = document.querySelector("#provider");
        const endpoint = document.querySelector("#endpoint");
        const model = document.querySelector("#model");
        const key = document.querySelector("#api-key");
        const consent = document.querySelector("#consent-accepted");
        const form = document.querySelector("#connection-form");
        if (!provider || !endpoint || !model || !key || !consent || !form) return false;
        provider.value = "deepseek";
        provider.dispatchEvent(new Event("change", { bubbles: true }));
        endpoint.value = value.endpoint;
        model.value = "";
        key.value = "thunderclaw-synthetic-e2e-key";
        for (const input of [endpoint, model, key]) input.dispatchEvent(new Event("input", { bubbles: true }));
        consent.checked = true;
        // Discovery must work before selecting a model or saving the connection.
        const userInput = win.windowUtils.setHandlingUserInput(true);
        try { document.querySelector("#load-models").click(); }
        finally { userInput.destruct(); }
        return true;
      }

    } catch (error) { if (action === "save-inference") return { pickerFailure: String(error.message) }; }
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
    configured = extension_document(client, "options.html", "inference", {
        "endpoint": f"http://127.0.0.1:{port}/v1",
    })
    if configured is not True:
        raise RuntimeError(f"Could not configure standalone extension at {url}")
    if extension_document(client, "options.html", "value", "#thinking") != "none":
        raise AssertionError("DeepSeek thinking did not default off")
    if extension_document(client, "options.html", "value", "#max-response-tokens") != "16384":
        raise AssertionError("The response token limit did not default to 16384")
    try:
        prompt = accept_permission_prompt(client)
    except TimeoutError as error:
        message = extension_document(client, "options.html", "text", "#result")
        raise RuntimeError(f"Inference permission prompt did not appear; settings status: {message}") from error
    wait_until("visible discovered model choices", lambda: "fixture-model" in extension_document(
        client, "options.html", "model-options", None
    ))
    if extension_document(client, "options.html", "value", "#model") != "":
        raise AssertionError("Discovery selected a model without a user choice")
    def pointer_click(selector: str, scroll: bool = False) -> None:
        point = extension_document(client, "options.html", "pointer-target", {"selector": selector, "scroll": scroll})
        if not isinstance(point, dict) or "x" not in point:
            raise AssertionError(f"Could not locate picker pointer target: {point!r}")
        # W3C pointer actions exercise actual focus and pointer/mouse event order
        # on both pinned Gecko versions without version-specific windowUtils hooks.
        client.actions.sequence("pointer", "model-picker", {"pointerType": "mouse"}).pointer_move(
            point["x"], point["y"], duration=100, origin="viewport"
        ).perform()
        observed = extension_document(client, "options.html", "pointer-position", None)
        # Chrome viewport origins differ between Thunderbird generations. Measure
        # their offset using mouse movement, never an extra activation click.
        click_x = point["clientX"] + point["x"] - observed["x"]
        click_y = point["clientY"] + point["y"] - observed["y"]
        client.actions.sequence("pointer", "model-picker", {"pointerType": "mouse"}).pointer_move(
            click_x, click_y, duration=100, origin="viewport"
        ).click().perform()
    pointer_click("#available-models", scroll=True)
    wait_until("single pointer click opens model picker", lambda: extension_document(client, "options.html", "picker-open", None) is True)
    if extension_document(client, "options.html", "picker-style", None) is not True:
        raise AssertionError("Model picker styling does not match form fields")
    pointer_click('#model-options [data-value="fixture-model"]')
    wait_until("single pointer click selects model", lambda: extension_document(client, "options.html", "value", "#model") == "fixture-model")
    chosen = extension_document(client, "options.html", "save-inference", None)
    if chosen is not True:
        raise AssertionError(f"Could not choose the discovered model and save: {chosen!r}")
    wait_until("saved inference connection", lambda: extension_document(
        client, "options.html", "dataset", {"selector": "#connection-panel", "name": "phase"}
    ) == "untested")
    if extension_document(client, "options.html", "click", "#test") is not True:
        raise RuntimeError("Test inference connection button was not available")
    try:
        wait_until("tested inference connection", lambda: extension_document(
            client, "options.html", "dataset", {"selector": "#connection-panel", "name": "phase"}
        ) == "ready")
    except TimeoutError as error:
        message = extension_document(client, "options.html", "text", "#result")
        raise RuntimeError(f"Inference test did not pass; settings status: {message}") from error
    # Reopening settings must read the saved background credential without revealing it.
    open_options(client)
    wait_until("reopened inference connection", lambda: extension_document(
        client, "options.html", "dataset", {"selector": "#connection-panel", "name": "phase"}
    ) == "ready")
    if extension_document(client, "options.html", "value", "#api-key") != "":
        raise AssertionError("Reopened settings exposed the saved API key")
    if "A key is saved" not in (extension_document(client, "options.html", "text", "#key-status") or ""):
        raise AssertionError("Reopened settings did not retain the synthetic API key")
    if extension_document(client, "options.html", "value", "#thinking") != "none":
        raise AssertionError("Reopened settings did not retain DeepSeek thinking off")
    if extension_document(client, "options.html", "value", "#max-response-tokens") != "16384":
        raise AssertionError("Reopened settings did not retain the response token limit")
    return {"optionsUrl": url, "permissionPrompt": prompt, "standalone": True,
            "savedKeyOnReopen": True, "reopenedPasswordBlank": True, "deepSeekModelDiscovery": True, "singleClickStyledPicker": True,
            "deepSeekThinkingDefaultOff": True, "responseTokenDefault": 16384}


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


def set_and_select_rich_paragraph(client: Marionette, backward: bool = False) -> dict[str, Any]:
    return chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose"), editor = win.document.getElementById("messageEditor");
const doc = editor.contentDocument, body = doc.body;
const make = value => { const paragraph = doc.createElement("p"); paragraph.setAttribute("_moz_dirty", "");
  paragraph.append(doc.createTextNode(value)); return paragraph; };
const before = make("BEFORE_CANARY"), target = make("This "), after = make("AFTER_CANARY");
for (const [tag, text, following] of [["b", "draft", " keeps "], ["i", "important", " and "], ["u", "timely", " details."]]) {
  const mark = doc.createElement(tag); mark.append(doc.createTextNode(text));
  target.append(mark, doc.createTextNode(following));
}
body.replaceChildren(before, target, after); editor.contentWindow.__thunderclawParagraphRefs = { before, target, after };
const selection = editor.contentWindow.getSelection(), range = doc.createRange();
range.setStart(target.firstChild, 0); range.setEnd(target.lastChild, target.lastChild.data.length);
body.focus(); selection.removeAllRanges();
if (arguments[0]) selection.setBaseAndExtent(target.lastChild, target.lastChild.data.length, target.firstChild, 0);
else selection.addRange(range);
return { html: body.innerHTML, text: range.toString() };
""", [backward])


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
    try:
        selected = wait_until(
            "captured compose selection",
            lambda: extension_document(client, "popup.html", "text", "#status") == f"{len(ORIGINAL)} characters selected",
        )
    except TimeoutError as error:
        status = extension_document(client, "popup.html", "text", "#status")
        detail = extension_document(client, "popup.html", "text", "#error")
        raise RuntimeError(f"Compose popup did not capture selection: {status}; {detail}") from error
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


def exercise_rich_formatting_popup(client: Marionette) -> dict[str, Any]:
    action = open_compose_action(client)
    wait_until("rich formatting compose popup", lambda: chrome(client, FIND_EXTENSION_DOCUMENT, ["popup.html"]))
    wait_until("rich formatting selection capture", lambda: extension_document(client, "popup.html", "text", "#status")
               == f"{len(RICH_SOURCE_TEXT)} characters selected")
    if extension_document(client, "popup.html", "set", {"selector": "#action", "value": "ask"}) is not True:
        raise RuntimeError("Custom instruction action was unavailable")
    if extension_document(client, "popup.html", "set", {
        "selector": "#instruction", "value": RICH_FORMATTING_INSTRUCTION,
    }) is not True:
        raise RuntimeError("Custom instruction field was unavailable")
    original = paragraph_state(client)
    expected_original = f"<p>BEFORE_CANARY</p>{RICH_SOURCE_HTML}<p>AFTER_CANARY</p>"
    if original["html"] != expected_original or not all(original["identities"].values()):
        raise AssertionError(f"Unexpected rich formatting fixture: {original!r}")
    if extension_document(client, "popup.html", "click", "#run") is not True:
        raise RuntimeError("Generate preview was unavailable for rich formatting")
    # The inference fixture only returns this replacement after checking the
    # selected original paragraph's exact text, blocks, and all three marks.
    wait_until("source-verified rich formatting preview", lambda: extension_document(client, "popup.html", "text", "#status")
               == "Preview ready", 30.0)
    preview_html = extension_document(client, "popup.html", "html", "#replacement")
    after_preview = paragraph_state(client)
    if preview_html != RICH_FORMATTING_PREVIEW or after_preview != original:
        raise AssertionError("Rich formatting Preview lost marks or mutated the compose DOM or selection")
    if extension_document(client, "popup.html", "click", "#apply") is not True:
        raise RuntimeError("Apply was unavailable for rich formatting")
    wait_until("rich formatting Apply", lambda: extension_document(client, "popup.html", "text", "#status")
               == "Applied — Thunderbird still controls Send")
    applied = paragraph_state(client)
    expected_applied = f"<p>BEFORE_CANARY</p>{RICH_FORMATTING_PREVIEW}<p>AFTER_CANARY</p>"
    if applied["html"] != expected_applied or applied["identities"] != {"before": True, "target": False, "after": True}:
        raise AssertionError(f"Rich formatting Apply lost marks or surrounding nodes: {applied!r}")
    if extension_document(client, "popup.html", "click", "#discard") is not True:
        raise RuntimeError("Undo was unavailable for rich formatting")
    wait_until("rich formatting Undo", lambda: extension_document(client, "popup.html", "text", "#status") == "Change undone")
    undone = paragraph_state(client)
    if undone != original:
        raise AssertionError(f"Rich formatting Undo was not exact: {undone!r}")
    redo = chrome(client, r"""
const frame = Services.wm.getMostRecentWindow("msgcompose").document.getElementById("messageEditor");
frame.contentDocument.body.focus(); return frame.contentDocument.execCommand("redo");
""")
    redone = paragraph_state(client)
    if redo is not True or redone != applied:
        raise AssertionError(f"Rich formatting native Redo was not exact: {redone!r}")
    return {"action": action, "instruction": RICH_FORMATTING_INSTRUCTION, "sourceBlocksVerifiedByFixture": RICH_SOURCE_BLOCKS,
            "original": original, "previewHtml": preview_html, "afterPreview": after_preview, "applied": applied,
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
            # Install in the disposable profile so a real restart exercises saved credentials.
            installed_id = Addons(client).install(str(xpi), temp=False)
            if installed_id != EXTENSION_ID:
                raise AssertionError(f"Installed unexpected extension ID: {installed_id!r}")
            wait_until("extension startup", lambda: chrome(client, r"""
const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
return ExtensionParent.GlobalManager.extensionMap.get(arguments[0])?.backgroundState === "running";
""", [EXTENSION_ID]))
            connection = configure_connection(client, stub_port)
            quit_thunderbird(client)
            process.wait(timeout=15)
            client = None
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, text=True)
            wait_for_port(marionette_port, process)
            client = Marionette(host="127.0.0.1", port=marionette_port)
            client.start_session()
            wait_until("installed extension after restart", lambda: chrome(client, r"""
const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
return ExtensionParent.GlobalManager.extensionMap.get(arguments[0])?.backgroundState === "running";
""", [EXTENSION_ID]))
            open_options(client)
            try:
                wait_until("saved connection after restart", lambda: extension_document(
                    client, "options.html", "dataset", {"selector": "#connection-panel", "name": "phase"}
                ) == "ready")
            except TimeoutError as error:
                state = extension_document(client, "options.html", "text", "#state")
                detail = extension_document(client, "options.html", "text", "#result")
                key_status = extension_document(client, "options.html", "text", "#key-status")
                extension_document(client, "options.html", "probe-credentials", None)
                probe = wait_until("credential store diagnostic", lambda: extension_document(
                    client, "options.html", "dataset", {"selector": "html", "name": "credentialProbe"}
                ), 3)
                raise RuntimeError(f"Connection after restart: {state}; {detail}; {key_status}; IDB {probe}") from error
            if extension_document(client, "options.html", "value", "#api-key") != "":
                raise AssertionError("Settings exposed the saved API key after restart")
            if "A key is saved" not in (extension_document(client, "options.html", "text", "#key-status") or ""):
                raise AssertionError("Synthetic API key was not retained across Thunderbird restart")
            extension_document(client, "options.html", "click", "#test")
            wait_until("authenticated inference after restart", lambda: extension_document(
                client, "options.html", "text", "#result"
            ) == "The selected model passed the synthetic connection test.")
            connection["savedKeyAcrossRestart"] = True
            connection["authenticatedTestAfterRestart"] = True

            open_compose(client)
            initial = set_and_select_body(client, ORIGINAL)
            if initial != ORIGINAL:
                raise AssertionError(f"Unexpected initial compose body: {initial!r}")
            compose = exercise_popup(client)
            body_text_list = None
            paragraph_expansion = None
            rich_formatting = None
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
                extension_document(client, "popup.html", "close", None)
                wait_until("paragraph expansion popup close", lambda: not chrome(client, FIND_EXTENSION_DOCUMENT, ["popup.html"]))
                fixture = set_and_select_rich_paragraph(client, backward=number == 2)
                if fixture != {"html": f"<p>BEFORE_CANARY</p>{RICH_SOURCE_HTML}<p>AFTER_CANARY</p>", "text": RICH_SOURCE_TEXT}:
                    raise AssertionError(f"Unexpected rich formatting fixture: {fixture!r}")
                rich_formatting = exercise_rich_formatting_popup(client)
            import received
            received_result = received.exercise(client)
            result = {
                "receivedMessage": received_result,
                "trial": number,
                "status": "passed",
                "capabilities": capabilities,
                "runtime": runtime,
                "installedExtensionId": installed_id,
                "connection": connection,
                "compose": compose,
                "bodyTextListConversion": body_text_list,
                "paragraphExpansion": paragraph_expansion,
                "richSourceFormatting": rich_formatting,
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
                    quit_thunderbird(client)
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
    suite = ET.Element("testsuite", name="thunderclaw.real-thunderbird", tests=str(len(results) + (1 if error else 0)))
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
    xpi_sha256 = hashlib.sha256(args.xpi.read_bytes()).hexdigest()
    metadata = {
        "release": args.expected_version,
        "version": actual_version,
        "buildId": actual_build_id,
        "extensionId": EXTENSION_ID,
        "platform": sys.platform,
        "headless": args.headless,
        "xpiSha256": xpi_sha256,
        "coverage": {
            "kind": "real-compose-and-received-action-popups",
            "network": "loopback-synthetic-inference-only",
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
    if hashlib.sha256(args.xpi.read_bytes()).hexdigest() != xpi_sha256:
        raise AssertionError("Candidate XPI bytes changed during native qualification")
    if caught is not None:
        raise caught
    print(json.dumps({"status": "passed", "trials": len(results), "artifacts": str(args.artifacts)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

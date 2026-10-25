"""Real received-message UI coverage, using generated synthetic mail only."""
from __future__ import annotations

import html
import json
from pathlib import Path
from typing import Any

import run_compose as harness


def open_newsletter(client) -> None:
    source = Path(__file__).with_name("newsletter.json")
    if not source.is_file():
        source = Path(__file__).resolve().parents[2] / "fixtures/provider-trials/newsletter.json"
    fixture = json.loads(source.read_text(encoding="utf-8"))
    paragraphs = [f"Edition {edition + 1}: {text}"
                  for edition in range(fixture["repetitions"]) for text in fixture["paragraphs"]]
    body = '<p><b>ThunderClaw synthetic newsletter</b> <i>Preliminary findings</i></p>'
    body += "".join(f"<p>{html.escape(text)}</p>" for text in paragraphs)
    raw = (f'From: {fixture["author"]}\r\nTo: reader@example.invalid\r\n'
           f'Subject: {fixture["subject"]}\r\nMessage-ID: <synthetic-newsletter@example.invalid>\r\n'
           'Date: Fri, 23 Oct 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\n'
           'Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'
           f'<html><body>{body}</body></html>\r\n')
    harness.chrome(client, r"""
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
let localServer;
try { localServer = MailServices.accounts.localFoldersServer; } catch (_) {}
if (!localServer) { MailServices.accounts.createLocalMailAccount(); localServer = MailServices.accounts.localFoldersServer; }
const root = localServer.rootFolder;
let folder;
try { folder = root.getChildNamed("ThunderClaw Synthetic"); } catch (_) {}
if (!folder) {
  root.QueryInterface(Ci.nsIMsgLocalMailFolder).createLocalSubfolder("ThunderClaw Synthetic");
  folder = root.getChildNamed("ThunderClaw Synthetic");
}
const header = folder.QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(arguments[0]);
const main = Services.wm.getMostRecentWindow("mail:3pane");
main.document.getElementById("tabmail").openTab("mailMessageTab", { messageURI: folder.getUriForMsg(header) });
main.focus();
return true;
""", [raw])
    try:
        harness.wait_until("synthetic received newsletter", lambda: "ThunderClaw synthetic newsletter" in state(client).get("text", ""))
    except TimeoutError as error:
        diagnostic = harness.chrome(client, r"""
const main = Services.wm.getMostRecentWindow("mail:3pane");
const tabs = main.document.getElementById("tabmail");
const about = tabs.currentAboutMessage;
return { mode: tabs.currentTabInfo.mode.name, location: about?.location.href,
  browsers: Array.from(about?.document.querySelectorAll("browser") ?? [], item => ({ id: item.id, uri: item.currentURI?.spec })),
  text: about?.document.body?.textContent?.slice(0, 200) };
""")
        raise TimeoutError(f"{error}; diagnostic={diagnostic!r}") from error


STATE = r"""
if (!document.body) return {};
const body = document.body;
const clone = body.cloneNode(true);
for (const card of clone.querySelectorAll("[data-thunderclaw-ui]")) card.remove();
const elements = Array.from(body.querySelectorAll("p,b,i"));
if (!globalThis.__thunderclawOriginalElements) globalThis.__thunderclawOriginalElements = elements;
return { text: clone.textContent, html: clone.innerHTML,
  summaryCards: body.querySelectorAll('[data-thunderclaw-ui="summary"]').length,
  elementIdentityPreserved: globalThis.__thunderclawOriginalElements.every((node, index) => node === elements[index] && node.isConnected),
  bold: body.querySelector("p b")?.textContent, italic: body.querySelector("p i")?.textContent };
"""


def state(client) -> dict[str, Any]:
    # A Thunderbird message browser is a separate top-level remote browsing
    # context; WebDriver switch_to_frame cannot reach it. Use the same built-in
    # Marionette actor directly for read-only DOM inspection. Product behavior
    # still runs through the actual popup, background, provider and display script.
    return harness.chrome(client, r"""
const main = Services.wm.getMostRecentWindow("mail:3pane");
const pane = main?.document.getElementById("tabmail")?.currentAboutMessage?.document.getElementById("messagepane");
if (!pane?.browsingContext?.currentWindowGlobal) return {};
return pane.browsingContext.currentWindowGlobal.getActor("MarionetteCommands").executeScript(arguments[0], [], {
  sandboxName: "thunderclaw-native-received-inspector", newSandbox: false, timeout: 10000, async: false,
});
""", [STATE])


def open_action(client) -> None:
    for handle in client.chrome_window_handles:
        client.switch_to_window(handle)
        if harness.chrome(client, 'return document.documentElement.getAttribute("windowtype");') == "mail:3pane":
            break
    triggered = harness.chrome(client, r"""
const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
const extension = ExtensionParent.GlobalManager.extensionMap.get(arguments[0]);
const action = ExtensionParent.apiManager.global.messageDisplayActionFor(extension);
return action.triggerAction(window, { requirePopupUrl: true });
""", [harness.EXTENSION_ID])
    if triggered is not True:
        raise RuntimeError("Thunderbird did not trigger the received-message action")
    harness.chrome(client, r"""
const about = document.getElementById("tabmail")?.currentAboutMessage;
for (const doc of [document, about?.document].filter(Boolean)) {
  const browser = doc.querySelector("browser.webextension-popup-browser");
  if (browser?.currentURI?.spec === "about:blank") browser.dispatchEvent(new Event("load"));
}
return true;
""")
    harness.wait_until("received action popup", lambda: harness.chrome(client, harness.FIND_EXTENSION_DOCUMENT, ["message-popup.html"]))
    harness.wait_until("received newsletter captured", lambda: "message characters" in (harness.extension_document(client, "message-popup.html", "text", "#status") or ""))


def exercise(client) -> dict[str, Any]:
    # Close the compose popup and compose window before opening the received UI.
    harness.extension_document(client, "popup.html", "close", None)
    harness.chrome(client, 'Services.wm.getMostRecentWindow("msgcompose")?.close(); return true;')
    for handle in client.chrome_window_handles:
        client.switch_to_window(handle)
        if harness.chrome(client, 'return document.documentElement.getAttribute("windowtype");') == "mail:3pane":
            break
    open_newsletter(client)
    original = state(client)
    if len(original["text"]) < 40_000:
        raise AssertionError("The synthetic newsletter did not retain the long-output regression size")
    open_action(client)
    if harness.extension_document(client, "message-popup.html", "click", "#run") is not True:
        raise RuntimeError("Summarize received message button unavailable")
    harness.wait_until("received summary ready", lambda: harness.extension_document(client, "message-popup.html", "text", "#status") == "Summary ready", 30)
    summary = state(client)
    if summary["html"] != original["html"] or summary["summaryCards"] != 1 or not summary["elementIdentityPreserved"]:
        raise AssertionError("Summary changed original received content or failed to display its separate card")
    harness.extension_document(client, "message-popup.html", "click", "#dismiss")
    harness.wait_until("received summary dismissed", lambda: state(client)["summaryCards"] == 0)
    open_action(client)
    if harness.extension_document(client, "message-popup.html", "value", "#source-language") != "Auto-detect":
        raise AssertionError("Received translation did not default to automatic language detection")
    harness.extension_document(client, "message-popup.html", "set", {"selector": "#action", "value": "translate"})
    harness.extension_document(client, "message-popup.html", "set", {"selector": "#target-language", "value": "French"})
    harness.extension_document(client, "message-popup.html", "click", "#run")
    harness.wait_until("received auto translation ready", lambda: harness.extension_document(client, "message-popup.html", "text", "#status") == "Translated to French", 30)
    translated = state(client)
    if translated["text"] == original["text"] or translated["bold"] != "Bonjour." or translated["italic"] != "Bonjour." or not translated["elementIdentityPreserved"]:
        raise AssertionError("Translation did not replace text while preserving original formatting nodes")
    harness.extension_document(client, "message-popup.html", "click", "#show-original")
    harness.wait_until("received original restored", lambda: state(client)["html"] == original["html"])
    harness.extension_document(client, "message-popup.html", "click", "#show-translation")
    harness.wait_until("received translation shown again", lambda: state(client)["html"] == translated["html"])
    harness.extension_document(client, "message-popup.html", "click", "#dismiss")
    harness.wait_until("received dismiss restores original", lambda: state(client)["html"] == original["html"])
    return {"status": "passed", "sourceCharacters": len(original["text"]), "summaryPreservesOriginal": True,
            "automaticSourceLanguage": True, "translationPreservesFormattingNodes": True,
            "showOriginal": True, "showTranslation": True, "dismissRestoresOriginal": True}

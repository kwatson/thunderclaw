from __future__ import annotations

import argparse
import hashlib
import json
import queue
import shutil
import subprocess
import sys
import tempfile
import traceback
from email import policy
from email.parser import BytesParser
from pathlib import Path

sys.path.insert(0, "/opt/thunderclaw-e2e")
sys.path.insert(0, "/work")

from marionette_driver.addons import Addons
from marionette_driver.marionette import Marionette

import live_thunderbird as live
import product_whole_list_live as product
import run_compose as harness


AGENT_ID = "deepseek-flash"
ORIGINAL_ITEMS = ["Alpha migration task", "Beta verification task", "Gamma release task"]
OPERATIONS = ("rewrite", "add", "remove", "reorder")
KINDS = ("ul", "ol")
ORIGIN_TRIALS = ("origin-new", "origin-reply", "origin-forward-inline", "origin-reopened-draft")
DIAGNOSTIC_TRIALS = ("probe-reopened-whitespace",)


class PreviewRejected(RuntimeError):
    pass


def popup(client: Marionette, action: str, selector: str, value: str | None = None):
    return harness.chrome(client, r"""
const [action, selector, value] = arguments;
for (const win of Services.wm.getEnumerator(null)) {
  for (const browser of win.document.querySelectorAll("browser")) {
    try {
      const doc = browser.contentDocument;
      if (!doc?.location.href.endsWith("popup.html")) continue;
      const element = doc.querySelector(selector);
      if (!element) continue;
      if (action === "value") return element.value;
      if (action === "html") return element.innerHTML;
      if (action === "text") return element.textContent;
      if (action === "set") {
        element.value = value;
        return element.value;
      }
      if (action === "click") { element.click(); return true; }
    } catch (_) {}
  }
}
return null;
""", [action, selector, value])


def switch_to_main(client: Marionette) -> None:
    for handle in client.chrome_window_handles:
        client.switch_to_window(handle)
        if harness.chrome(client, 'return document.documentElement.getAttribute("windowtype");') == "mail:3pane":
            return
    raise RuntimeError("main Thunderbird window unavailable")


def open_compose(client: Marionette) -> None:
    existing_identity = harness.chrome(client,
        "return Boolean(MailServices.accounts.defaultAccount?.defaultIdentity);")
    if not existing_identity:
        harness.open_compose(client)
        return
    switch_to_main(client)
    harness.chrome(client, 'Services.wm.getMostRecentWindow("mail:3pane").goDoCommand("cmd_newMessage"); return true;')
    harness.wait_until("compose editor", lambda: harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
return Boolean(win?.document.getElementById("messageEditor")?.contentDocument?.body);
"""), 30)


def metadata_state(client: Marionette) -> dict:
    return harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const fields = win.gMsgCompose.compFields;
return {
  subject: win.document.getElementById("msgSubject").value,
  to: fields.to, cc: fields.cc, bcc: fields.bcc, replyTo: fields.replyTo,
  from: fields.from, organization: fields.organization,
  attachments: Array.from(fields.attachments ?? [], attachment => ({
    name: attachment.name, url: attachment.url, contentType: attachment.contentType,
    size: attachment.size, sendViaCloud: attachment.sendViaCloud,
  })),
};
""")


def list_state(client: Marionette) -> dict:
    return harness.chrome(client, r"""
const frame = Services.wm.getMostRecentWindow("msgcompose").document.getElementById("messageEditor");
const body = frame.contentDocument.body;
const list = body.querySelector(":scope > ul, :scope > ol");
const refs = frame.contentWindow.__qualificationRefs;
const selection = frame.contentWindow.getSelection();
const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
const path = node => { const value = []; while (node && node !== body) { value.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node)); node = node.parentNode; } return value; };
return {
  html: body.innerHTML,
  kind: list?.localName ?? null,
  items: list ? Array.from(list.children, item => item.textContent) : [],
  attributes: list ? {
    list: Array.from(list.attributes, attribute => [attribute.namespaceURI, attribute.name, attribute.value]),
    items: Array.from(list.children, item => Array.from(item.attributes,
      attribute => [attribute.namespaceURI, attribute.name, attribute.value])),
    directChildKinds: Array.from(list.childNodes, node => node.nodeType === Node.ELEMENT_NODE ? node.localName : `#${node.nodeType}`),
    itemChildKinds: Array.from(list.children, item => Array.from(item.childNodes,
      node => node.nodeType === Node.TEXT_NODE ? "#text" : node.localName)),
  } : null,
  protected: {
    cite: body.querySelector("blockquote[type=cite]")?.textContent ?? null,
    signature: body.querySelector(".moz-signature")?.textContent ?? null,
  },
  identities: refs ? {
    list: refs.list === list && refs.list.isConnected,
    cite: refs.cite === body.querySelector("blockquote[type=cite]") && refs.cite.isConnected,
    signature: refs.signature === body.querySelector(".moz-signature") && refs.signature.isConnected,
  } : null,
  selection: range ? {
    startPath: path(range.startContainer), startOffset: range.startOffset,
    endPath: path(range.endContainer), endOffset: range.endOffset,
    anchorPath: path(selection.anchorNode), anchorOffset: selection.anchorOffset,
    focusPath: path(selection.focusNode), focusOffset: selection.focusOffset,
    text: range.toString(), collapsed: range.collapsed,
  } : null,
};
""")


def setup_fixture(client: Marionette, kind: str, operation: str, profile: Path, smtp_port: int) -> dict:
    attachment = profile / f"qualification-{kind}-{operation}.bin"
    attachment.write_bytes(b"ThunderClaw real-agent qualification attachment\r\n")
    fixture = harness.chrome(client, r"""
const [kind, operation, values, attachmentPath, smtpPort] = arguments;
const win = Services.wm.getMostRecentWindow("msgcompose");
const frame = win.document.getElementById("messageEditor");
const doc = frame.contentDocument;
const body = doc.body;
const list = doc.createElement(kind);
list.setAttribute("_moz_dirty", "");
for (const value of values) {
  const item = doc.createElement("li"); item.setAttribute("_moz_dirty", ""); item.append(doc.createTextNode(value)); list.append(item);
}
const cite = doc.createElement("blockquote"); cite.setAttribute("type", "cite"); cite.append(doc.createTextNode("QUALIFICATION_PROTECTED_CITE"));
const signature = doc.createElement("div"); signature.className = "moz-signature"; signature.append(doc.createTextNode("QUALIFICATION_PROTECTED_SIGNATURE"));
body.replaceChildren(list, cite, signature);
frame.contentWindow.__qualificationRefs = { list, cite, signature };
const subject = `ThunderClaw qualification ${kind} ${operation}`;
win.document.getElementById("msgSubject").value = subject;
win.gMsgCompose.compFields.subject = subject;
win.awAddRecipients(win.gMsgCompose.compFields, "addr_to", "to@e2e.invalid");
win.awAddRecipients(win.gMsgCompose.compFields, "addr_cc", "cc@e2e.invalid");
win.awAddRecipients(win.gMsgCompose.compFields, "addr_bcc", "bcc@e2e.invalid");
const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
const attachment = Cc["@mozilla.org/messengercompose/attachment;1"].createInstance(Ci.nsIMsgAttachment);
attachment.url = Services.io.newFileURI(new FileUtils.File(attachmentPath)).spec;
attachment.name = attachmentPath.split("/").at(-1);
attachment.contentType = "application/octet-stream";
win.AddAttachments([attachment]);
if (typeof win.Recipients2CompFields === "function") win.Recipients2CompFields(win.gMsgCompose.compFields);
if (typeof win.Attachments2CompFields === "function") win.Attachments2CompFields(win.gMsgCompose.compFields);
const identity = win.getCurrentIdentity?.() ?? win.gCurrentIdentity;
win.gMsgCompose.compFields.from = identity.fullAddress;
const outgoing = MailServices.outgoingServer.createServer("smtp");
outgoing.QueryInterface(Ci.nsISmtpServer); outgoing.hostname = "127.0.0.1"; outgoing.port = smtpPort;
outgoing.username = ""; outgoing.authMethod = Ci.nsMsgAuthMethod.none; outgoing.socketType = Ci.nsMsgSocketType.plain;
identity.smtpServerKey = outgoing.key;
const account = MailServices.accounts.accounts.find(candidate => candidate.identities.some(item => item.key === identity.key));
const root = account.incomingServer.rootFolder;
let drafts;
if (typeof identity.getOrCreateDraftsFolder === "function") drafts = identity.getOrCreateDraftsFolder();
else {
  try { drafts = root.getChildNamed("Drafts"); }
  catch (_) { root.createSubfolder("Drafts", null); drafts = root.getChildNamed("Drafts"); }
}
if (!drafts) throw new Error("Drafts folder unavailable");
drafts.setFlag(Ci.nsMsgFolderFlags.Drafts);
if ("draftFolder" in identity) identity.draftFolder = drafts.URI; else identity.draftsFolderURI = drafts.URI;
win.__qualificationDrafts = drafts;
const range = doc.createRange(); range.selectNode(list);
const selection = frame.contentWindow.getSelection(); selection.removeAllRanges(); selection.addRange(range); body.focus();
return { subject, draftsURI: drafts.URI, attachmentName: attachment.name, smtpPort, selectedText: range.toString() };
""", [kind, operation, ORIGINAL_ITEMS, str(attachment), smtp_port])
    fixture["attachmentSha256"] = hashlib.sha256(attachment.read_bytes()).hexdigest()
    fixture["attachmentByteLength"] = attachment.stat().st_size
    return fixture


def create_origin_message(client: Marionette, origin: str) -> dict:
    harness.chrome(client, r"""
const origin = arguments[0];
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
let server;
try { server = MailServices.accounts.localFoldersServer; } catch (_) {}
if (!server) { MailServices.accounts.createLocalMailAccount(); server = MailServices.accounts.localFoldersServer; }
const root = server.rootFolder;
let inbox;
try { inbox = root.getChildNamed("ThunderClaw Origin Fixtures"); }
catch (_) {}
if (!inbox) root.createSubfolder("ThunderClaw Origin Fixtures", null);
return { origin, rootURI: root.URI, ready: Boolean(inbox) };
""", [origin])
    harness.wait_until("origin fixture folder", lambda: harness.chrome(client, r"""
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
try { return MailServices.accounts.localFoldersServer.rootFolder.getChildNamed("ThunderClaw Origin Fixtures")?.URI ?? null; }
catch (_) { return null; }
"""), 20)
    return harness.chrome(client, r"""
const origin = arguments[0];
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const inbox = MailServices.accounts.localFoldersServer.rootFolder.getChildNamed("ThunderClaw Origin Fixtures");
const subject = `ThunderClaw real origin ${origin}`;
const raw = [
  "From - Sun Aug 10 20:00:00 2026",
  "From: Origin Sender <sender@origin.invalid>",
  "To: ThunderClaw E2E <author@e2e.invalid>",
  `Subject: ${subject}`,
  "Date: Sun, 10 Aug 2026 20:00:00 +0000",
  `Message-ID: <${crypto.randomUUID()}@origin.invalid>`,
  "MIME-Version: 1.0",
  "Content-Type: text/html; charset=UTF-8",
  "",
  "<html><body><p>ORIGIN_PROTECTED_ALPHA</p><p>ORIGIN_PROTECTED_BETA</p></body></html>",
  "",
].join("\r\n");
inbox.QueryInterface(Ci.nsIMsgLocalMailFolder).addMessageBatch([raw]);
let header = null;
for (const candidate of inbox.messages) if (candidate.mime2DecodedSubject === subject) header = candidate;
if (!header) throw new Error("origin source message was not stored");
return { subject, key: header.messageKey, uri: inbox.getUriForMsg(header), folderURI: inbox.URI };
""", [origin])


def open_real_origin(client: Marionette, origin: str, profile: Path) -> dict:
    if origin == "new":
        open_compose(client)
        source = {"origin": origin, "sourceMessage": None}
    elif origin in ("reply", "forward-inline"):
        if not harness.chrome(client, "return Boolean(MailServices.accounts.defaultAccount?.defaultIdentity);"):
            open_compose(client)
            close_compose(client)
        source_message = create_origin_message(client, origin)
        source = harness.chrome(client, r"""
const [origin, uri] = arguments;
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const header = MailServices.messageServiceFromURI(uri).messageURIToMsgHdr(uri);
const identity = MailServices.accounts.defaultAccount.defaultIdentity;
const type = origin === "reply" ? Ci.nsIMsgCompType.Reply : Ci.nsIMsgCompType.ForwardInline;
MailServices.compose.OpenComposeWindow(null, header, uri, type, Ci.nsIMsgCompFormat.HTML, identity, null, null);
return { origin, sourceMessage: { uriSha256Input: uri, key: header.messageKey }, expectedType: type };
""", [origin, source_message["uri"]])
        source["sourceMessage"].update({"subject": source_message["subject"], "folderURI": source_message["folderURI"]})
        harness.wait_until(f"{origin} compose editor", lambda: harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const body = win?.document.getElementById("messageEditor")?.contentDocument?.body;
return body && !win.gMsgCompose?.isInsertingQuotedContent && win.gComposeType === arguments[0]
  && body.textContent.includes("ORIGIN_PROTECTED_ALPHA") ? true : null;
""", [source["expectedType"]]), 30)
    elif origin == "reopened-draft":
        open_compose(client)
        setup_fixture(client, "ul", "rewrite", profile, 9)
        harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
win.document.commandDispatcher.getControllerForCommand("cmd_saveAsDraft").doCommand("cmd_saveAsDraft");
return true;
""")
        saved = harness.wait_until("origin Draft save", lambda: harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose"); const folder = win?.__qualificationDrafts;
if (!folder || win.gSaveOperationInProgress) return null;
let found = null; for (const header of folder.messages) if (header.mime2DecodedSubject === win.gMsgCompose.compFields.subject
  && (!found || header.messageKey > found.messageKey)) found = header;
return found ? { uri: folder.getUriForMsg(found), key: found.messageKey, folderURI: folder.URI } : null;
"""), 30)
        close_compose(client)
        source = harness.chrome(client, r"""
const uri = arguments[0]; const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const header = MailServices.messageServiceFromURI(uri).messageURIToMsgHdr(uri);
MailServices.compose.OpenComposeWindow(null, header, uri, Ci.nsIMsgCompType.Draft, Ci.nsIMsgCompFormat.Default,
  MailServices.accounts.defaultAccount.defaultIdentity, null, null);
return { origin: "reopened-draft", sourceMessage: { key: header.messageKey, uriSha256Input: uri },
  expectedType: Ci.nsIMsgCompType.Draft };
""", [saved["uri"]])
        source["sourceMessage"]["folderURI"] = saved["folderURI"]
        harness.wait_until("reopened origin Draft", lambda: harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const body = win?.document.getElementById("messageEditor")?.contentDocument?.body;
return body && win.gComposeType === Ci.nsIMsgCompType.Draft && !win.gMsgCompose?.isInsertingQuotedContent ? true : null;
"""), 30)
    else:
        raise ValueError(f"unsupported origin {origin}")

    observed = harness.chrome(client, r"""
const [origin, values] = arguments; const win = Services.wm.getMostRecentWindow("msgcompose");
const frame = win.document.getElementById("messageEditor"); const doc = frame.contentDocument; const body = doc.body;
const identity = win.getCurrentIdentity?.() ?? win.gCurrentIdentity;
if (identity?.fullAddress) win.gMsgCompose.compFields.from = identity.fullAddress;
let list = body.querySelector(":scope > ul, :scope > ol");
if (origin !== "reopened-draft") {
  list = doc.createElement("ul"); list.setAttribute("_moz_dirty", "");
  for (const value of values) { const item = doc.createElement("li"); item.setAttribute("_moz_dirty", "");
    item.append(doc.createTextNode(value)); list.append(item); }
  body.insertBefore(list, body.firstChild);
}
const protectedRoot = origin === "reply" ? body.querySelector('blockquote[type="cite"]')
  : origin === "forward-inline" ? (body.querySelector(".moz-forward-container") ?? Array.from(body.children).find(node => node !== list))
  : body.querySelector('blockquote[type="cite"], .moz-signature');
if (["reply", "forward-inline"].includes(origin) && (!protectedRoot || !body.textContent.includes("ORIGIN_PROTECTED_ALPHA")))
  throw new Error(`real ${origin} protected content was not retained`);
const signature = body.querySelector(".moz-signature");
    frame.contentWindow.__qualificationRefs = { list, cite: protectedRoot ?? {}, signature: signature ?? {} };
const range = doc.createRange(); range.selectNode(list);
const selection = frame.contentWindow.getSelection(); selection.removeAllRanges(); selection.addRange(range); body.focus();
return { composeType: win.gComposeType, listKind: list.localName, listOuterHTML: list.outerHTML,
  itemShapes: Array.from(list.childNodes, node => ({ nodeType: node.nodeType, name: node.localName ?? null,
    attributes: node.nodeType === Node.ELEMENT_NODE ? Array.from(node.attributes, attribute => [attribute.name, attribute.value]) : [],
    childKinds: node.nodeType === Node.ELEMENT_NODE ? Array.from(node.childNodes, child => child.nodeType === Node.TEXT_NODE ? "#text" : child.localName) : [] })),
  protectedTag: protectedRoot?.localName ?? null,
  protectedClass: protectedRoot?.className ?? null, protectedText: protectedRoot?.textContent ?? null,
  selectedText: range.toString(), bodyText: body.textContent };
""", [origin, ORIGINAL_ITEMS])
    source["observed"] = observed
    if source.get("sourceMessage") and source["sourceMessage"].get("uriSha256Input"):
        source["sourceMessage"]["uriSha256"] = hashlib.sha256(
            source["sourceMessage"].pop("uriSha256Input").encode()).hexdigest()
    return source


def run_origin_case(client: Marionette, profile: Path, origin: str, nonce: str) -> dict:
    fixture = open_real_origin(client, origin, profile)
    before_body, before_metadata = list_state(client), metadata_state(client)
    try:
        values = generate_preview(client, "rewrite", nonce)
    except PreviewRejected as error:
        raise PreviewRejected(f"{error}; observed={json.dumps(fixture['observed'], sort_keys=True)}") from error
    if list_state(client) != before_body or metadata_state(client) != before_metadata:
        raise AssertionError(f"{origin} Preview mutated the draft")
    if popup(client, "click", "#apply") is not True:
        raise RuntimeError(f"{origin} Apply unavailable")
    harness.wait_until(f"{origin} Apply", lambda: product.extension_document(client, "popup.html", "text", "#status")
        == "Applied — Thunderbird still controls Send", 20)
    after_apply = list_state(client)
    if after_apply["kind"] != "ul" or after_apply["items"] != values or not after_apply["selection"]["collapsed"] \
            or not after_apply["identities"]["list"] or metadata_state(client) != before_metadata:
        raise AssertionError(f"{origin} Apply failed exact origin checks")
    if popup(client, "click", "#discard") is not True:
        raise RuntimeError(f"{origin} Undo unavailable")
    harness.wait_until(f"{origin} Undo", lambda: product.extension_document(client, "popup.html", "text", "#status")
        == "Change undone", 20)
    if list_state(client) != before_body or metadata_state(client) != before_metadata:
        raise AssertionError(f"{origin} ThunderClaw Undo was not exact")
    redone = harness.chrome(client, r"""
const frame = Services.wm.getMostRecentWindow("msgcompose").document.getElementById("messageEditor");
frame.contentDocument.body.focus(); return frame.contentDocument.execCommand("redo");
""")
    if redone is not True or list_state(client) != after_apply or metadata_state(client) != before_metadata:
        raise AssertionError(f"{origin} native Redo was not exact")
    close_compose(client)
    return {"origin": origin, "fixture": fixture, "replacementItems": values,
        "previewNonmutation": True, "applyExact": True, "undoExact": True, "redoExact": True}


def run_reopened_whitespace_probe(client: Marionette, profile: Path) -> dict:
    fixture = open_real_origin(client, "reopened-draft", profile)
    before = list_state(client)
    after = harness.chrome(client, r"""
const frame = Services.wm.getMostRecentWindow("msgcompose").document.getElementById("messageEditor");
const doc = frame.contentDocument; const list = doc.body.querySelector(":scope > ul");
const originalList = list; const originalProtected = doc.body.querySelector('blockquote[type="cite"]');
const wrapper = doc.createElement("ul");
for (const value of ["PROBE_REWRITE_ONE", "PROBE_REWRITE_TWO", "PROBE_REWRITE_THREE"]) {
  const item = doc.createElement("li"); item.append(doc.createTextNode(value)); wrapper.append(item);
}
const container = doc.createElement("div"); container.append(wrapper);
const commandReturned = doc.execCommand("insertHTML", false, container.innerHTML);
const shape = () => ({ html: list.outerHTML, sameList: list === originalList && list.isConnected,
  sameProtected: originalProtected === doc.body.querySelector('blockquote[type="cite"]') && originalProtected.isConnected,
  childNodes: Array.from(list.childNodes, node => ({ type: node.nodeType, value: node.nodeType === Node.TEXT_NODE ? node.data : null,
    name: node.localName ?? null, text: node.textContent })) });
return { commandReturned, applied: shape() };
""")
    after_apply = list_state(client)
    undone = harness.chrome(client, r"""
const frame = Services.wm.getMostRecentWindow("msgcompose").document.getElementById("messageEditor");
frame.contentDocument.body.focus(); return frame.contentDocument.execCommand("undo");
""")
    after_undo = list_state(client)
    redone = harness.chrome(client, r"""
const frame = Services.wm.getMostRecentWindow("msgcompose").document.getElementById("messageEditor");
frame.contentDocument.body.focus(); return frame.contentDocument.execCommand("redo");
""")
    after_redo = list_state(client)
    close_compose(client)
    return {"fixture": fixture, "before": before, "command": after, "undoReturned": undone,
        "undoExact": undone is True and after_undo == before, "redoReturned": redone,
        "redoExact": redone is True and after_redo == after_apply,
        "afterApply": after_apply, "afterUndo": after_undo, "afterRedo": after_redo}


def instruction(operation: str, nonce: str) -> str:
    demands = {
        "rewrite": "Rewrite every item for clarity and return exactly three items.",
        "add": "Improve the list and add exactly one useful fourth item; return exactly four items.",
        "remove": "Remove the least important item and polish the remainder; return exactly two items.",
        "reorder": "Return exactly the same three item strings, reordered Gamma then Alpha then Beta.",
    }
    return f"{demands[operation]} Qualification request ID {nonce}; do not repeat the ID in output."


def generate_preview(client: Marionette, operation: str, nonce: str) -> list[str]:
    product.open_compose_action(client)
    try:
        initialized = harness.wait_until("real product popup initialization", lambda:
            {"ready": True} if "characters selected" in (
                product.extension_document(client, "popup.html", "text", "#status") or "")
            else ({"error": product.popup_error(client)} if product.popup_error(client) else None), 30)
    except TimeoutError as error:
        raise PreviewRejected("compose popup did not initialize") from error
    if initialized.get("error"):
        raise PreviewRejected(initialized["error"])
    configured = harness.chrome(client, r"""
for (const win of Services.wm.getEnumerator(null)) for (const browser of win.document.querySelectorAll("browser")) {
  try {
    const doc = browser.contentDocument; if (!doc?.location.href.endsWith("popup.html")) continue;
    const agent = doc.querySelector("#agent"); const action = doc.querySelector("#action"); const instruction = doc.querySelector("#instruction");
    const index = Array.from(agent.options).findIndex(option => option.value === arguments[0]);
    if (index < 0) return { error: "agent-option-missing", options: Array.from(agent.options, option => option.value) };
    agent.selectedIndex = index; action.value = "ask"; instruction.value = arguments[1];
    return { agent: agent.value, action: action.value, instruction: instruction.value };
  } catch (error) { return { error: String(error) }; }
} return null;
""", [AGENT_ID, instruction(operation, nonce)])
    if configured != {"agent": AGENT_ID, "action": "ask", "instruction": instruction(operation, nonce)}:
        raise AssertionError(f"deepseek-flash popup configuration failed: {configured!r}")
    if popup(client, "click", "#run") is not True:
        raise RuntimeError("Generate preview was unavailable")
    outcome = harness.wait_until("real-agent Preview", lambda:
        {"ready": True} if product.extension_document(client, "popup.html", "text", "#status") == "Preview ready"
        else ({"error": product.popup_error(client)} if product.popup_error(client) else None), 150)
    if outcome.get("error"):
        raise PreviewRejected(outcome["error"])
    values = harness.chrome(client, r"""
for (const win of Services.wm.getEnumerator(null)) for (const browser of win.document.querySelectorAll("browser")) {
  try { const doc = browser.contentDocument; if (doc?.location.href.endsWith("popup.html")) return Array.from(doc.querySelectorAll("#replacement > ul > li, #replacement > ol > li"), item => item.textContent); } catch (_) {}
}
return null;
""")
    if not isinstance(values, list) or not values or any(not isinstance(value, str) or not value.strip() for value in values):
        raise AssertionError(f"invalid structured Preview values: {values!r}")
    expected_count = {"rewrite": 3, "add": 4, "remove": 2, "reorder": 3}[operation]
    if len(values) != expected_count:
        raise AssertionError(f"{operation} returned {len(values)} items instead of {expected_count}")
    if operation == "reorder" and values != [ORIGINAL_ITEMS[2], ORIGINAL_ITEMS[0], ORIGINAL_ITEMS[1]]:
        raise AssertionError(f"reorder changed item text or order: {values!r}")
    return values


def save_reopen_send(client: Marionette, fixture: dict, expected_items: list[str], expected_metadata: dict,
        sink: live.LoopbackSMTPSink, artifacts: Path) -> dict:
    harness.chrome(client, 'Services.wm.getMostRecentWindow("msgcompose").goDoCommand("cmd_saveAsDraft"); return true;')
    saved = harness.wait_until("qualification Draft save", lambda: harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose"); const folder = win?.__qualificationDrafts;
if (!folder || win.gSaveOperationInProgress) return null;
let found = null; for (const header of folder.messages) if (header.mime2DecodedSubject === arguments[0] && (!found || header.messageKey > found.messageKey)) found = header;
return found ? { uri: folder.getUriForMsg(found), key: found.messageKey } : null;
""", [fixture["subject"]]), 30)
    raw = live.stream_raw_message(client, saved["uri"]).encode("latin1")
    saved_folder_uri = saved["uri"].replace("mailbox-message:", "mailbox:").split("#", 1)[0]
    if saved_folder_uri != fixture["draftsURI"]:
        raise AssertionError(f"Draft URI escaped expected folder: {saved!r}")
    draft_message = BytesParser(policy=policy.default).parsebytes(raw)
    draft_leaves = {part.get_content_type(): part.get_content() for part in draft_message.walk()
        if not part.is_multipart() and part.get_filename() is None}
    draft_text = "\n".join(value for value in draft_leaves.values() if isinstance(value, str))
    if not draft_text: raise AssertionError("Draft MIME contained no decoded text body")
    normalized_draft_text = " ".join(draft_text.split())
    for value in [*expected_items, "QUALIFICATION_PROTECTED_CITE", "QUALIFICATION_PROTECTED_SIGNATURE"]:
        if " ".join(value.split()) not in normalized_draft_text:
            raise AssertionError(f"Draft MIME omitted {value!r}")
    draft_attachments = [part for part in draft_message.walk() if part.get_filename() == fixture["attachmentName"]]
    if len(draft_attachments) != 1 or hashlib.sha256(draft_attachments[0].get_payload(decode=True)).hexdigest() != fixture["attachmentSha256"]:
        raise AssertionError("Draft MIME attachment mismatch")
    switch_to_main(client)
    harness.chrome(client, 'Services.wm.getMostRecentWindow("msgcompose").goDoCommand("cmd_close"); return true;')
    harness.wait_until("Draft compose close", lambda: harness.chrome(client, 'return Services.wm.getMostRecentWindow("msgcompose") === null;'), 20)
    switch_to_main(client)
    harness.chrome(client, r"""
const uri = arguments[0]; const header = MailServices.messageServiceFromURI(uri).messageURIToMsgHdr(uri);
MailServices.compose.OpenComposeWindow("", header, uri, Ci.nsIMsgCompType.Draft, Ci.nsIMsgCompFormat.Default, null, "", null, null, false); return true;
""", [saved["uri"]])
    harness.wait_until("Draft reopen", lambda: harness.chrome(client, r"""
const body = Services.wm.getMostRecentWindow("msgcompose")?.document.getElementById("messageEditor")?.contentDocument?.body;
const win = Services.wm.getMostRecentWindow("msgcompose");
return Boolean(body?.textContent.includes("QUALIFICATION_PROTECTED_CITE")
  && win?.gComposeType === Ci.nsIMsgCompType.Draft);
"""), 30)
    reopened = list_state(client)
    if [" ".join(item.split()) for item in reopened["items"]] != [" ".join(item.split()) for item in expected_items] \
            or reopened["protected"] != {"cite": "QUALIFICATION_PROTECTED_CITE", "signature": "QUALIFICATION_PROTECTED_SIGNATURE"}:
        raise AssertionError(f"reopened Draft mismatch: {reopened!r}")
    reopened_metadata = harness.wait_until("reopened Draft metadata", lambda: metadata_state(client)
        if metadata_state(client)["to"] == expected_metadata["to"]
        and metadata_state(client)["cc"] == expected_metadata["cc"]
        and metadata_state(client)["bcc"] == expected_metadata["bcc"]
        and len(metadata_state(client)["attachments"]) == 1 else None, 20)
    if reopened_metadata["subject"] != expected_metadata["subject"] \
            or reopened_metadata["attachments"][0]["name"] != fixture["attachmentName"]:
        raise AssertionError(f"reopened Draft headers/attachment mismatch: {reopened_metadata!r}")
    harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose"); win.focus();
const controller = win.document.commandDispatcher.getControllerForCommand("cmd_sendNow");
if (!controller?.isCommandEnabled("cmd_sendNow")) throw new Error("Send unavailable"); controller.doCommand("cmd_sendNow"); return true;
""")
    try: message = sink.receive(30)
    except queue.Empty as error: raise TimeoutError("SMTP DATA not received") from error
    smtp_data = message.pop("data")
    parsed = BytesParser(policy=policy.default).parsebytes(smtp_data)
    leaves = {part.get_content_type(): part.get_content() for part in parsed.walk() if not part.is_multipart()}
    if parsed["Bcc"] is not None or parsed.get_content_type() != "multipart/mixed":
        raise AssertionError("SMTP MIME headers/topology mismatch")
    if parsed["Subject"] != fixture["subject"] or "to@e2e.invalid" not in str(parsed["To"]) \
            or "cc@e2e.invalid" not in str(parsed["Cc"]):
        raise AssertionError("SMTP semantic headers mismatch")
    alternative = next((part for part in parsed.walk() if part.get_content_type() == "multipart/alternative"), None)
    if alternative is None or not {"text/plain", "text/html"}.issubset(leaves):
        raise AssertionError("SMTP MIME omitted multipart/alternative leaves")
    for value in [*expected_items, "QUALIFICATION_PROTECTED_CITE", "QUALIFICATION_PROTECTED_SIGNATURE"]:
        normalized_value = " ".join(value.split())
        if normalized_value not in " ".join(leaves["text/plain"].split()) \
                or normalized_value not in " ".join(leaves["text/html"].split()):
            raise AssertionError(f"SMTP MIME omitted {value!r}")
    expected_recipients = ["<to@e2e.invalid>", "<cc@e2e.invalid>", "<bcc@e2e.invalid>"]
    if message["envelopeRecipients"] != expected_recipients:
        raise AssertionError(f"SMTP envelope mismatch: {message!r}")
    attachment_parts = [part for part in parsed.walk() if part.get_filename() == fixture["attachmentName"]]
    if len(attachment_parts) != 1 or hashlib.sha256(attachment_parts[0].get_payload(decode=True)).hexdigest() != fixture["attachmentSha256"]:
        raise AssertionError("SMTP attachment payload mismatch")
    harness.wait_until("normal Send compose close", lambda: harness.chrome(client,
        'return Services.wm.getMostRecentWindow("msgcompose") === null;'), 30)
    try: sink.server.messages.get_nowait()
    except queue.Empty: pass
    else: raise AssertionError("normal Send produced more than one SMTP DATA transaction")
    lowered = smtp_data.lower()
    if b"qualification request id" in lowered or b"authorization:" in lowered or b"bearer " in lowered:
        raise AssertionError("qualification transport marker leaked into SMTP MIME")
    # Retain the exact, already-validated messages for independent re-parsing.
    # The top-level runner subsequently scans these files for every configured
    # test secret and credential-shaped content before promoting the run.
    (artifacts / "draft.eml").write_bytes(raw)
    (artifacts / "smtp.eml").write_bytes(smtp_data)
    return {"draftSha256": hashlib.sha256(raw).hexdigest(), "smtpSha256": hashlib.sha256(smtp_data).hexdigest(),
        "draftArtifact": "draft.eml", "smtpArtifact": "smtp.eml",
        "envelopeRecipients": message["envelopeRecipients"], "draftReopened": True,
        "savedDraftUriSha256": hashlib.sha256(saved["uri"].encode()).hexdigest(), "normalComposeClose": True,
        "transactionCount": 1, "attachmentSha256": fixture["attachmentSha256"], "mime": parsed.get_content_type()}


def run_case(client: Marionette, profile: Path, artifacts: Path, kind: str, operation: str, nonce: str) -> dict:
    open_compose(client)
    with live.LoopbackSMTPSink() as sink:
        fixture = setup_fixture(client, kind, operation, profile, sink.port)
        harness.wait_until("compose metadata synchronization", lambda:
            metadata_state(client) if "to@e2e.invalid" in metadata_state(client)["to"]
            and "cc@e2e.invalid" in metadata_state(client)["cc"]
            and "bcc@e2e.invalid" in metadata_state(client)["bcc"]
            and len(metadata_state(client)["attachments"]) == 1 else None, 20)
        before_body, before_metadata = list_state(client), metadata_state(client)
        values = generate_preview(client, operation, nonce)
        after_preview, preview_metadata = list_state(client), metadata_state(client)
        if after_preview != before_body or preview_metadata != before_metadata:
            raise AssertionError(f"Preview mutated body or compose metadata: bodyBefore={before_body!r} bodyAfter={after_preview!r} metadataBefore={before_metadata!r} metadataAfter={preview_metadata!r}")
        if popup(client, "click", "#apply") is not True:
            raise RuntimeError("Apply unavailable")
        harness.wait_until("whole-list Apply", lambda: product.extension_document(client, "popup.html", "text", "#status") == "Applied — Thunderbird still controls Send", 20)
        after_apply, apply_metadata = list_state(client), metadata_state(client)
        expected_marker = [[None, "_moz_dirty", ""]]
        if after_apply["kind"] != kind or after_apply["items"] != values or apply_metadata != before_metadata \
                or after_apply["identities"] != {"list": True, "cite": True, "signature": True} \
                or after_apply["protected"] != before_body["protected"] \
                or after_apply["attributes"]["list"] != before_body["attributes"]["list"] \
                or after_apply["attributes"]["items"] != [expected_marker for _ in values] \
                or after_apply["attributes"]["directChildKinds"] != ["li" for _ in values] \
                or after_apply["attributes"]["itemChildKinds"] != [["#text"] for _ in values] \
                or not after_apply["selection"]["collapsed"]:
            raise AssertionError("Apply changed kind, values, headers, recipients, or attachments")
        if popup(client, "click", "#discard") is not True:
            raise RuntimeError("ThunderClaw Undo unavailable")
        harness.wait_until("ThunderClaw Undo", lambda: product.extension_document(client, "popup.html", "text", "#status") == "Change undone", 20)
        after_undo, undo_metadata = list_state(client), metadata_state(client)
        if after_undo != before_body or undo_metadata != before_metadata:
            raise AssertionError("ThunderClaw Undo was not exact")
        redone = harness.chrome(client, r"""
const frame = Services.wm.getMostRecentWindow("msgcompose").document.getElementById("messageEditor"); frame.contentDocument.body.focus(); return frame.contentDocument.execCommand("redo");
""")
        after_redo = list_state(client)
        if redone is not True or after_redo != after_apply or metadata_state(client) != before_metadata:
            raise AssertionError("native Redo failed")
        persistence = save_reopen_send(client, fixture, values, before_metadata, sink, artifacts)
        return {"kind": kind, "operation": operation, "replacementItems": values, "previewNonmutation": True,
            "applyMetadataUnchanged": True, "undoExact": True, "redoExact": True, "persistence": persistence}


def run_case_with_retries(client: Marionette, profile: Path, artifacts: Path,
        kind: str, operation: str, nonce: str) -> dict:
    rejected = []
    for attempt in range(1, 4):
        try:
            result = run_case(client, profile, artifacts, kind, operation, nonce)
            return {**result, "attempts": attempt, "rejectedAttempts": rejected}
        except PreviewRejected as error:
            rejected.append(str(error))
            try: close_compose(client)
            except Exception: pass
    raise RuntimeError(f"real agent produced no valid {kind} {operation} result after three bounded attempts")


def close_compose(client: Marionette) -> None:
    switch_to_main(client)
    harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
try { win.gMsgCompose?.editor?.resetModificationCount(); } catch (_) {}
win.close(); return true;
""")
    harness.wait_until("compose close", lambda: harness.chrome(client,
        'return Services.wm.getMostRecentWindow("msgcompose") === null;'), 20)


def run_stale(client: Marionette, stale_case: str, nonce: str) -> dict:
    with tempfile.TemporaryDirectory(prefix="qualification-stale-") as temporary:
        open_compose(client)
        fixture = setup_fixture(client, "ul", "rewrite", Path(temporary), 9)
        harness.wait_until("stale fixture metadata", lambda: metadata_state(client)
            if "to@e2e.invalid" in metadata_state(client)["to"] and len(metadata_state(client)["attachments"]) == 1 else None, 20)
        before_body, before_metadata = list_state(client), metadata_state(client)
        generate_preview(client, "rewrite", nonce)
        mutation = harness.chrome(client, r"""
const which = arguments[0]; const win = Services.wm.getMostRecentWindow("msgcompose");
const frame = win.document.getElementById("messageEditor"); const list = frame.contentDocument.body.querySelector("ul");
if (which === "body") list.firstElementChild.firstChild.data += " NEWER_BODY";
if (which === "selection") frame.contentWindow.getSelection().collapse(list.children[1].firstChild, 2);
if (which === "header") {
  win.awAddRecipients(win.gMsgCompose.compFields, "addr_to", "newer@e2e.invalid");
  if (typeof win.Recipients2CompFields === "function") win.Recipients2CompFields(win.gMsgCompose.compFields);
  win.document.getElementById("msgSubject").value += " newer";
  win.gMsgCompose.compFields.subject = win.document.getElementById("msgSubject").value;
}
if (which === "attachment") {
  const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
  const attachment = Cc["@mozilla.org/messengercompose/attachment;1"].createInstance(Ci.nsIMsgAttachment);
  attachment.url = Services.io.newFileURI(new FileUtils.File("/etc/hosts")).spec;
  attachment.name = "newer.txt"; attachment.contentType = "text/plain"; win.AddAttachments([attachment]);
  if (typeof win.Attachments2CompFields === "function") win.Attachments2CompFields(win.gMsgCompose.compFields);
}
return which;
""", [stale_case])
        if stale_case == "header":
            harness.wait_until("stale header mutation", lambda: metadata_state(client)
                if "newer@e2e.invalid" in metadata_state(client)["to"]
                and metadata_state(client)["subject"].endswith(" newer") else None, 20)
        if stale_case == "attachment":
            harness.wait_until("stale attachment mutation", lambda: metadata_state(client)
                if len(metadata_state(client)["attachments"]) == 2
                and metadata_state(client)["attachments"][-1]["name"] == "newer.txt" else None, 20)
        expected_body, expected_metadata = list_state(client), metadata_state(client)
        if popup(client, "click", "#apply") is not True: raise RuntimeError("stale Apply unavailable")
        error = harness.wait_until(f"stale {stale_case} rejection", lambda: product.popup_error(client), 20)
        after_body, after_metadata = list_state(client), metadata_state(client)
        if after_body != expected_body or after_metadata != expected_metadata:
            raise AssertionError(f"stale {stale_case} Apply changed the newer state: expectedBody={expected_body!r} afterBody={after_body!r} expectedMetadata={expected_metadata!r} afterMetadata={after_metadata!r}")
        close_compose(client)
        return {"case": stale_case, "fixture": fixture, "mutation": mutation, "error": error,
            "originalBody": before_body, "originalMetadata": before_metadata,
            "newerBodyRetained": True, "newerMetadataRetained": True}


def run_newer_edit_undo(client: Marionette, nonce: str) -> dict:
    with tempfile.TemporaryDirectory(prefix="qualification-newer-undo-") as temporary:
        open_compose(client)
        setup_fixture(client, "ol", "rewrite", Path(temporary), 9)
        harness.wait_until("newer-edit fixture metadata", lambda: metadata_state(client)
            if "to@e2e.invalid" in metadata_state(client)["to"] and len(metadata_state(client)["attachments"]) == 1 else None, 20)
        values = generate_preview(client, "rewrite", nonce)
        if popup(client, "click", "#apply") is not True: raise RuntimeError("Apply unavailable")
        harness.wait_until("newer-edit Apply", lambda: product.extension_document(client, "popup.html", "text", "#status")
            == "Applied — Thunderbird still controls Send", 20)
        harness.chrome(client, r"""
const body = Services.wm.getMostRecentWindow("msgcompose").document.getElementById("messageEditor").contentDocument.body;
body.querySelector("ol > li").firstChild.data += " USER_NEWER_EDIT"; return true;
""")
        newer = list_state(client)
        if popup(client, "click", "#discard") is not True: raise RuntimeError("Undo unavailable")
        error = harness.wait_until("newer-edit Undo rejection", lambda: product.popup_error(client), 20)
        if list_state(client) != newer: raise AssertionError("rejected ThunderClaw Undo changed newer editor state")
        close_compose(client)
        return {"replacementItems": values, "error": error, "newerEditRetained": True}


def retry_preview_trial(client: Marionette, trial, *args) -> dict:
    rejected = []
    for attempt in range(1, 4):
        try: return {**trial(client, *args), "attempts": attempt, "rejectedAttempts": rejected}
        except PreviewRejected as error:
            rejected.append(str(error))
            try: close_compose(client)
            except Exception: pass
    raise RuntimeError(f"real agent produced no valid preview after three bounded attempts: {rejected!r}")


def run(args: argparse.Namespace) -> dict:
    profile = Path(tempfile.mkdtemp(prefix="thunderclaw-real-agent-"))
    shutil.copyfile("/opt/thunderclaw-e2e/user.js", profile / "user.js")
    log = (args.artifacts / "thunderbird.log").open("w", encoding="utf-8")
    process = subprocess.Popen(["thunderbird", "--marionette", "-remote-allow-system-access", "-no-remote", "-profile", str(profile)], stdout=log, stderr=subprocess.STDOUT, text=True)
    client = None
    try:
        harness.wait_for_port(2828, process)
        client = Marionette(host="127.0.0.1", port=2828); client.start_session()
        actual = harness.chrome(client, "return Services.appinfo.version;")
        if actual != "153.0.3": raise AssertionError(f"unexpected Thunderbird {actual}")
        if Addons(client).install(str(args.xpi), temp=True) != product.EXTENSION_ID: raise AssertionError("unexpected extension ID")
        harness.wait_until("extension startup", lambda: harness.chrome(client, r"""
const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs"); return ExtensionParent.GlobalManager.extensionMap.has(arguments[0]);
""", [product.EXTENSION_ID]))
        connection = harness.configure_connection(client, args.gateway_port)
        harness.chrome(client, 'return browser;') if False else None
        if args.trial == "probe-reopened-whitespace":
            trial_result = run_reopened_whitespace_probe(client, profile)
        elif args.trial.startswith("origin-"):
            origin = args.trial.removeprefix("origin-")
            trial_result = retry_preview_trial(client, run_origin_case, profile, origin,
                f"{args.nonce}-{args.trial}")
        elif args.trial.startswith(("ul-", "ol-")):
            kind, operation = args.trial.split("-", 1)
            trial_result = run_case_with_retries(client, profile, args.artifacts,
                kind, operation, f"{args.nonce}-{args.trial}")
        elif args.trial.startswith("stale-"):
            stale_case = args.trial.removeprefix("stale-")
            trial_result = retry_preview_trial(client, run_stale, stale_case, f"{args.nonce}-{args.trial}")
        else:
            trial_result = retry_preview_trial(client, run_newer_edit_undo, f"{args.nonce}-{args.trial}")
        return {"status": "passed", "thunderbirdVersion": actual, "xpiSha256": hashlib.sha256(args.xpi.read_bytes()).hexdigest(),
            "agentId": AGENT_ID, "connection": connection, "trial": args.trial, "trialResult": trial_result}
    finally:
        if client:
            try: client.quit(in_app=True)
            except Exception: pass
        if process.poll() is None:
            process.terminate()
            try: process.wait(10)
            except subprocess.TimeoutExpired: process.kill()
        log.close(); shutil.rmtree(profile, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xpi", type=Path, required=True); parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--gateway-port", type=int, required=True)
    parser.add_argument("--nonce", required=True)
    parser.add_argument("--trial", required=True, choices=[
        *[f"{kind}-{operation}" for kind in KINDS for operation in OPERATIONS],
        "stale-body", "stale-selection", "stale-header", "stale-attachment", "newer-edit-undo", *ORIGIN_TRIALS,
        *DIAGNOSTIC_TRIALS])
    args = parser.parse_args(); args.artifacts.mkdir(parents=True, exist_ok=True)
    try: result = run(args)
    except Exception as error: result = {"status": "failed", "error": str(error), "traceback": traceback.format_exc()}
    (args.artifacts / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"status": result["status"], "artifacts": str(args.artifacts)}))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__": raise SystemExit(main())

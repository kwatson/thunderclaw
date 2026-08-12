from __future__ import annotations

import argparse
import hashlib
import html
import json
import shutil
import subprocess
import tempfile
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock, Thread
from typing import Any
from urllib.parse import parse_qs, urlsplit

from marionette_driver.addons import Addons
from marionette_driver.marionette import Marionette

from run_compose import (
    EXTENSION_ID,
    chrome,
    configure_connection,
    extension_document,
    open_compose,
    open_compose_action,
    save_screenshot,
    wait_for_port,
    wait_until,
)


TOKEN = "thunderclaw-e2e-token"
ORIGINAL_ITEMS = ["first", "second", "third"]
REPLACEMENTS = {
    "rewrite": ["First polished", "Second polished", "Third polished"],
    "add": ["First polished", "Second polished", "Third polished", "New item"],
    "remove": ["First polished", "Third polished"],
    "reorder": ["third", "first", "second"],
    "literal": ["<img src=x onerror=alert(1)>", "Fish & chips", "2 > 1"],
}


class State:
    def __init__(self) -> None:
        self.lock = Lock()
        self.requests: list[dict[str, Any]] = []

    def record(self, method: str, path: str, body: dict[str, Any] | None) -> None:
        with self.lock:
            self.requests.append({"method": method, "path": path, "body": body})


def verified_agent() -> dict[str, Any]:
    return {
        "agentId": "e2e-agent",
        "displayName": "Deterministic list agent",
        "isDefault": True,
        "provider": "fixture",
        "model": "typed-list-v1",
        "reasoning": {"defaultLevel": None, "levels": []},
        "compatibility": {
            "state": "verified",
            "executionMode": "restricted-agent",
            "usesPersonality": True,
            "usesMemory": True,
            "toolsDisabled": True,
            "checks": {
                "configuration": "passed", "credentials": "passed", "structuredOutput": "passed",
                "toolIsolation": "passed", "cancellation": "passed", "fallbacks": "not_applicable",
            },
            "lastProbe": {
                "testedAt": "2026-08-10T00:00:00.000Z",
                "observedProvider": "fixture", "observedModel": "typed-list-v1",
            },
            "reason": "Deterministic local product acceptance evidence.",
        },
    }


class Handler(BaseHTTPRequestHandler):
    server: "Server"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def reply(self, status: int, value: dict[str, Any]) -> None:
        encoded = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def authorized(self) -> bool:
        if self.headers.get("Authorization") == f"Bearer {TOKEN}":
            return True
        self.reply(401, {"error": {"code": "UNAUTHORIZED", "message": "Unauthorized"}})
        return False

    def body(self) -> dict[str, Any]:
        value = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        if not isinstance(value, dict):
            raise ValueError("request must be an object")
        return value

    def do_GET(self) -> None:
        if not self.authorized():
            return
        url = urlsplit(self.path)
        if url.path == "/thunderclaw/v1/status":
            self.server.state.record("GET", url.path, None)
            self.reply(200, {"protocolVersion": 1, "plugin": "thunderclaw", "gatewayVersion": "typed-list-stub-v1",
                "capabilities": {"transform": True, "cancellation": "compose", "flatListItemReplacement": True}})
            return
        if url.path == "/thunderclaw/v1/agents":
            request_id = parse_qs(url.query).get("requestId", [""])[0]
            self.server.state.record("GET", url.path, {"requestId": request_id})
            self.reply(200, {"protocolVersion": 1, "requestId": request_id, "agents": [verified_agent()]})
            return
        self.reply(404, {"error": {"code": "NOT_FOUND", "message": "Not found"}})

    def do_POST(self) -> None:
        if not self.authorized():
            return
        path = urlsplit(self.path).path
        try:
            body = self.body()
        except (ValueError, json.JSONDecodeError):
            self.reply(400, {"error": {"code": "INVALID_REQUEST", "message": "Invalid request"}})
            return
        self.server.state.record("POST", path, body)
        if path == "/thunderclaw/v1/compose/open":
            self.reply(201, {"protocolVersion": 1, "requestId": body["requestId"], "composeId": body["composeId"],
                "composeGeneration": body["composeGeneration"], "sessionId": f"fixture-{body['composeId']}"})
            return
        if path == "/thunderclaw/v1/compose/transform":
            target = body["target"]
            if self.server.backend_case == "wrong-shape":
                operation = {"type": "replace_text_range", "targetId": target["targetId"],
                    "start": 0, "end": target["end"], "text": "wrong shape"}
            else:
                items = {
                    "empty": [], "newline": ["bad\nitem"], "c1": ["bad\u0085item"],
                }.get(self.server.backend_case, self.server.replacement_items)
                operation = {"type": "replace_flat_list_items", "targetId": target["targetId"], "items": items}
            self.reply(200, {"protocolVersion": 1, "runId": body["runId"], "result": {
                "version": 1, "requestId": body["requestId"], "composeGeneration": body["composeGeneration"],
                "contextHash": body["contextHash"], "targetHash": body["targetHash"],
                "operations": [operation], "summary": "Deterministic typed whole-list replacement.",
            }, "evidence": {"runtimeSessionMarker": None, "repairAttempted": False}})
            return
        if path == "/thunderclaw/v1/compose/close":
            self.reply(200, {"protocolVersion": 1, "requestId": body["requestId"], "composeId": body["composeId"],
                "composeGeneration": body["composeGeneration"], "closed": True})
            return
        if path == "/thunderclaw/v1/compose/cancel":
            self.reply(202, {"protocolVersion": 1, "requestId": body["requestId"], "runId": body["runId"], "cancelled": True})
            return
        self.reply(404, {"error": {"code": "NOT_FOUND", "message": "Not found"}})


class Server(ThreadingHTTPServer):
    def __init__(self, state: State, replacement_items: list[str], backend_case: str = "valid"):
        super().__init__(("127.0.0.1", 0), Handler)
        self.state = state
        self.replacement_items = replacement_items
        self.backend_case = backend_case


def setup_list(client: Marionette, list_kind: str, backward: bool, fixture_case: str = "valid") -> dict[str, Any]:
    return chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const frame = win.document.getElementById("messageEditor");
const doc = frame.contentDocument;
const body = doc.body;
const make = (tag, text) => { const node = doc.createElement(tag); if (text !== undefined) node.append(doc.createTextNode(text)); return node; };
const before = make("p", "BEFORE_CANARY");
const list = make(arguments[1]);
list.setAttribute("_moz_dirty", "");
for (const text of arguments[0]) { const li = make("li", text); li.setAttribute("_moz_dirty", ""); list.append(li); }
if (arguments[3] === "formatted") {
  const strong = make("strong", "first");
  list.firstElementChild.replaceChildren(strong);
}
if (arguments[3] === "nested") {
  const nested = make("ul"); nested.append(make("li", "nested"));
  list.children[1].append(nested);
}
if (arguments[3] === "interstitial") list.insertBefore(doc.createComment("INTERSTITIAL"), list.children[1]);
if (arguments[3] === "interstitial-text") list.insertBefore(doc.createTextNode("NOT_WHITESPACE"), list.children[1]);
if (arguments[3] === "partial-whitespace") list.insertBefore(doc.createTextNode("\n  "), list.children[1]);
if (arguments[3] === "custom") list.setAttribute("class", "custom-list");
const after = make("p", "AFTER_CANARY");
body.replaceChildren(before, list, after);
frame.contentWindow.__productListRefs = { before, list, after };
const range = doc.createRange();
range.selectNode(list);
const selection = frame.contentWindow.getSelection();
body.focus(); selection.removeAllRanges();
if (arguments[2]) selection.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset);
else selection.addRange(range);
return { html: body.innerHTML, text: range.toString(), selection: {
  startPath: [], startOffset: range.startOffset,
  endPath: [], endOffset: range.endOffset, backward: arguments[2],
}};
""", [ORIGINAL_ITEMS, list_kind, backward, fixture_case])


def editor_state(client: Marionette) -> dict[str, Any]:
    return chrome(client, r"""
const frame = Services.wm.getMostRecentWindow("msgcompose").document.getElementById("messageEditor");
const body = frame.contentDocument.body;
const refs = frame.contentWindow.__productListRefs;
const list = body.querySelector("ul,ol");
const selection = frame.contentWindow.getSelection();
let selected = null;
if (selection?.rangeCount === 1) {
  const r = selection.getRangeAt(0);
  selected = { text: r.toString(), startOffset: r.startOffset, endOffset: r.endOffset,
    startText: r.startContainer?.data ?? null, endText: r.endContainer?.data ?? null,
    anchorText: selection.anchorNode?.data ?? null, anchorOffset: selection.anchorOffset,
    focusText: selection.focusNode?.data ?? null, focusOffset: selection.focusOffset };
}
return {
  html: body.innerHTML, text: body.textContent, listKind: list?.localName ?? null,
  items: list ? Array.from(list.children, li => ({ text: li.textContent, html: li.outerHTML })) : [],
  attributes: list ? { list: Array.from(list.attributes, a => [a.name, a.value]),
    items: Array.from(list.children, li => Array.from(li.attributes, a => [a.name, a.value])) } : null,
  identities: { before: body.firstChild === refs.before && refs.before.isConnected,
    list: list === refs.list && refs.list.isConnected, after: body.lastChild === refs.after && refs.after.isConnected },
  selection: selected,
};
""")


def popup_error(client: Marionette) -> str | None:
    value = extension_document(client, "popup.html", "text", "#error")
    return value if value else None


def item_texts(state: dict[str, Any]) -> list[str]:
    return [item["text"] for item in state["items"]]


def exact_marker_attributes(count: int) -> dict[str, Any]:
    return {"list": [["_moz_dirty", ""]], "items": [[["_moz_dirty", ""]] for _ in range(count)]}


def require_exact_original(state: dict[str, Any], fixture_state: dict[str, Any], description: str) -> None:
    for key in ("html", "listKind", "items", "attributes", "selection"):
        if state[key] != fixture_state[key]:
            raise AssertionError(f"{description} changed {key}: expected={fixture_state[key]!r} actual={state[key]!r}")
    if not all(state["identities"].values()):
        raise AssertionError(f"{description} changed tracked identities: {state['identities']!r}")


def require_exact_applied(state: dict[str, Any], list_kind: str, replacement_items: list[str], description: str) -> None:
    if state["listKind"] != list_kind or item_texts(state) != replacement_items:
        raise AssertionError(f"{description} has wrong list topology/items: {state!r}")
    if state["attributes"] != exact_marker_attributes(len(replacement_items)):
        raise AssertionError(f"{description} has wrong attribute tuples: {state['attributes']!r}")
    if not all(state["identities"].values()):
        raise AssertionError(f"{description} changed tracked identities: {state['identities']!r}")
    selection = state["selection"]
    last = replacement_items[-1]
    expected = {"text": "", "startText": last, "endText": last, "anchorText": last, "focusText": last,
        "startOffset": len(last), "endOffset": len(last), "anchorOffset": len(last), "focusOffset": len(last)}
    if selection != expected:
        raise AssertionError(f"{description} has wrong collapsed selection: expected={expected!r} actual={selection!r}")


def run(client: Marionette, version: str, state: State, list_kind: str, replacement_items: list[str], backward: bool,
        fixture_case: str = "valid", backend_case: str = "valid", stale_case: str = "none",
        induced_marker: bool = False) -> dict[str, Any]:
    open_compose(client)
    fixture = setup_list(client, list_kind, backward, fixture_case)
    fixture_state = editor_state(client)
    request_baseline = len(state.requests)
    action = open_compose_action(client)
    wait_until("compose action popup", lambda: extension_document(client, "popup.html", "text", "#status"))
    if version.startswith("128.") or fixture_case != "valid":
        error = wait_until("Thunderbird 128 whole-list rejection", lambda: popup_error(client))
        after = editor_state(client)
        if len(state.requests) != request_baseline:
            raise AssertionError(f"capture rejection made backend calls: before={request_baseline} after={len(state.requests)}")
        require_exact_original(after, fixture_state, "capture rejection")
        return {"mode": "pre-network-rejection", "fixture": fixture, "action": action, "error": error,
            "requestsBeforePopup": request_baseline, "requestsAfterPopup": len(state.requests), "after": after}

    expected_length = len("\n".join(ORIGINAL_ITEMS))
    wait_until("captured whole list", lambda: extension_document(client, "popup.html", "text", "#status") == f"{expected_length} characters selected")
    before_preview = editor_state(client)
    if extension_document(client, "popup.html", "click", "#run") is not True:
        raise RuntimeError("Generate preview button unavailable")
    if backend_case != "valid":
        error = wait_until("malformed typed result rejection", lambda: popup_error(client), 30)
        after = editor_state(client)
        preview_hidden = extension_document(client, "popup.html", "hidden", "#preview")
        require_exact_original(after, fixture_state, "malformed backend rejection")
        if preview_hidden is not True:
            raise AssertionError("malformed backend result exposed a preview")
        return {"mode": "malformed-backend-rejection", "fixture": fixture, "action": action,
            "backendCase": backend_case, "error": error, "previewHidden": preview_hidden, "after": after}
    wait_until("typed list preview", lambda: extension_document(client, "popup.html", "text", "#status") == "Preview ready", 30)
    preview_html = chrome(client, r"""
const suffix = "popup.html";
for (const win of Services.wm.getEnumerator(null)) {
  for (const browser of win.document.querySelectorAll("browser")) {
    try { const doc = browser.contentDocument; if (doc?.location.href.endsWith(suffix)) return doc.querySelector("#replacement")?.innerHTML; } catch (_) {}
  }
}
return null;
""")
    expected_preview_html = f"<{list_kind}>" + "".join(f"<li>{html.escape(item)}</li>" for item in replacement_items) + f"</{list_kind}>"
    if preview_html != expected_preview_html:
        raise AssertionError(f"preview did not render exact local text nodes: expected={expected_preview_html!r} actual={preview_html!r}")
    after_preview = editor_state(client)
    if after_preview["html"] != before_preview["html"]:
        raise AssertionError("preview mutated the compose DOM")
    if induced_marker:
        chrome(client, r"""
const frame = Services.wm.getMostRecentWindow("msgcompose").document.getElementById("messageEditor");
frame.contentWindow.__productInputEvents = [];
frame.contentDocument.body.addEventListener("input", event => {
  frame.contentWindow.__productInputEvents.push(event.inputType || "");
}, { capture: true });
frame.contentDocument.body.addEventListener("input", () => {
  frame.contentDocument.body.querySelector("ul > li, ol > li")?.setAttribute("data-induced-browser-marker", "true");
}, { once: true, capture: true });
""")
        if extension_document(client, "popup.html", "click", "#apply") is not True:
            raise RuntimeError("Apply button unavailable for induced rollback")
        error = wait_until("exact induced rollback", lambda: popup_error(client), 20)
        after = editor_state(client)
        input_events = chrome(client, r"""
const frame = Services.wm.getMostRecentWindow("msgcompose").document.getElementById("messageEditor");
return frame.contentWindow.__productInputEvents;
""")
        require_exact_original(after, fixture_state, "induced rollback")
        history_undos = [value for value in input_events if value == "historyUndo"]
        if len(history_undos) != 1:
            raise AssertionError(f"induced rollback expected exactly one native historyUndo event, got {input_events!r}")
        return {"mode": "induced-postcondition-rollback", "fixture": fixture, "action": action,
            "error": error, "inputEvents": input_events, "nativeHistoryUndoCount": len(history_undos), "after": after}
    if stale_case != "none":
        stale_mutation = chrome(client, r"""
const which = arguments[0];
const win = Services.wm.getMostRecentWindow("msgcompose");
const frame = win.document.getElementById("messageEditor");
const refs = frame.contentWindow.__productListRefs;
if (which === "body") refs.before.firstChild.data = "CHANGED_CANARY";
if (which === "selection") {
  const selection = frame.contentWindow.getSelection();
  selection.collapse(refs.list.firstElementChild.firstChild, 1);
}
if (which === "header") {
  const subject = win.document.getElementById("msgSubject");
  subject.value = "Changed after preview";
  subject.dispatchEvent(new win.Event("input", { bubbles: true }));
  win.gMsgCompose.compFields.subject = subject.value;
}
if (which === "attachment") {
  const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
  const attachment = Cc["@mozilla.org/messengercompose/attachment;1"].createInstance(Ci.nsIMsgAttachment);
  attachment.url = Services.io.newFileURI(new FileUtils.File("/etc/hosts")).spec;
  attachment.name = "hosts.txt";
  attachment.contentType = "text/plain";
  win.AddAttachments([attachment]);
}
return which;
""", [stale_case])
        if extension_document(client, "popup.html", "click", "#apply") is not True:
            raise RuntimeError("Apply button unavailable for stale test")
        error = wait_until("stale Apply rejection", lambda: popup_error(client), 20)
        after = editor_state(client)
        if item_texts(after) != ORIGINAL_ITEMS or not all(after["identities"].values()) or after["attributes"] != fixture_state["attributes"]:
            raise AssertionError(f"stale Apply changed list topology: {after!r}")
        return {"mode": "stale-apply-rejection", "fixture": fixture, "action": action,
            "staleCase": stale_case, "staleMutation": stale_mutation, "error": error, "after": after}
    if extension_document(client, "popup.html", "click", "#apply") is not True:
        raise RuntimeError("Apply button unavailable")
    wait_until("whole-list apply", lambda: extension_document(client, "popup.html", "text", "#status") == "Applied — Thunderbird still controls Send")
    after_apply = editor_state(client)
    require_exact_applied(after_apply, list_kind, replacement_items, "Apply")
    if extension_document(client, "popup.html", "click", "#discard") is not True:
        raise RuntimeError("ThunderClaw Undo button unavailable")
    wait_until("ThunderClaw Undo", lambda: extension_document(client, "popup.html", "text", "#status") == "Change undone")
    after_undo = editor_state(client)
    require_exact_original(after_undo, fixture_state, "ThunderClaw Undo")
    redo_returned = chrome(client, r"""
const frame = Services.wm.getMostRecentWindow("msgcompose").document.getElementById("messageEditor");
frame.contentDocument.body.focus();
return frame.contentDocument.execCommand("redo");
""")
    after_redo = editor_state(client)
    if redo_returned is not True:
        raise AssertionError(f"native Redo failed: returned={redo_returned!r}, state={after_redo!r}")
    require_exact_applied(after_redo, list_kind, replacement_items, "native Redo")
    if after_redo["selection"] != after_apply["selection"]:
        raise AssertionError("native Redo did not restore the exact applied selection")
    return {"mode": "typed-whole-list", "fixture": fixture, "action": action, "beforePreview": before_preview,
        "previewHtml": preview_html, "afterPreview": after_preview, "afterApply": after_apply,
        "afterUndo": after_undo, "redoReturned": redo_returned, "afterRedo": after_redo}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xpi", required=True, type=Path)
    parser.add_argument("--artifacts", required=True, type=Path)
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--list-kind", choices=["ul", "ol"], default="ul")
    parser.add_argument("--operation", choices=sorted(REPLACEMENTS), default="rewrite")
    parser.add_argument("--backward", action="store_true")
    parser.add_argument("--fixture-case", choices=["valid", "formatted", "nested", "interstitial", "interstitial-text",
        "partial-whitespace", "custom"], default="valid")
    parser.add_argument("--backend-case", choices=["valid", "empty", "newline", "c1", "wrong-shape"], default="valid")
    parser.add_argument("--stale-case", choices=["none", "body", "selection", "header", "attachment"], default="none")
    parser.add_argument("--induced-marker", action="store_true")
    args = parser.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix="thunderclaw-product-list-"))
    shutil.copyfile("/opt/thunderclaw-e2e/user.js", profile / "user.js")
    log_path = args.artifacts / "thunderbird.log"
    state = State()
    replacement_items = REPLACEMENTS[args.operation]
    server = Server(state, replacement_items, args.backend_case)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    result: dict[str, Any]
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(["thunderbird", "--marionette", "-remote-allow-system-access", "-no-remote", "-profile", str(profile)], stdout=log, stderr=subprocess.STDOUT, text=True)
        client: Marionette | None = None
        try:
            wait_for_port(2828, process)
            client = Marionette(host="127.0.0.1", port=2828)
            capabilities = client.start_session()
            actual = chrome(client, "return Services.appinfo.version;")
            if actual != args.expected_version.removesuffix("esr"):
                raise AssertionError(f"expected {args.expected_version}, got {actual}")
            installed = Addons(client).install(str(args.xpi), temp=True)
            if installed != EXTENSION_ID:
                raise AssertionError(f"unexpected extension id {installed}")
            wait_until("extension startup", lambda: chrome(client, r"""
const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
return ExtensionParent.GlobalManager.extensionMap.has(arguments[0]);
""", [EXTENSION_ID]))
            connection = configure_connection(client, server.server_address[1])
            evidence = run(client, args.expected_version, state, args.list_kind, replacement_items, args.backward,
                args.fixture_case, args.backend_case, args.stale_case, args.induced_marker)
            result = {"status": "passed", "version": actual, "capabilities": capabilities, "connection": connection, "evidence": evidence}
        except BaseException as error:
            if client is not None:
                save_screenshot(client, args.artifacts / "failure.png")
            result = {"status": "failed", "error": str(error), "traceback": traceback.format_exc()}
        finally:
            if client is not None:
                try: client.quit(in_app=True)
                except BaseException: pass
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
            server.shutdown(); server.server_close(); thread.join(timeout=5)
            shutil.rmtree(profile, ignore_errors=True)
    metadata = {"release": args.expected_version, "xpiSha256": hashlib.sha256(args.xpi.read_bytes()).hexdigest(),
        "network": "none", "artifact": str(args.xpi), "listKind": args.list_kind,
        "operation": args.operation, "backward": args.backward, "fixtureCase": args.fixture_case,
        "backendCase": args.backend_case, "staleCase": args.stale_case, "inducedMarker": args.induced_marker}
    (args.artifacts / "metadata.json").write_text(json.dumps(metadata, indent=2, sort_keys=True))
    (args.artifacts / "requests.json").write_text(json.dumps(state.requests, indent=2, sort_keys=True))
    (args.artifacts / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True))
    print(json.dumps({"status": result["status"], "artifacts": str(args.artifacts)}))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

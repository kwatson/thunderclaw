from __future__ import annotations

import argparse
import hashlib
import json
import queue
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, "/opt/thunderclaw-e2e")

from marionette_driver.addons import Addons
from marionette_driver.marionette import Marionette

import run_compose as harness


EXTENSION_ID = "thunderclaw-rich-compose-r0@example.invalid"
AUTOMATION_BUILD_ID = f"{EXTENSION_ID}:0.0.1"
EXPERIMENT_HTML = (
    "<p>TC_R0_PARAGRAPH_EXPERIMENT<br>TC_R0_BREAK_EXPERIMENT</p>"
    "<p><b>TC_R0_BOLD_EXPERIMENT</b> <i>TC_R0_ITALIC_EXPERIMENT</i> "
    "<b><i>TC_R0_COMBINED_EXPERIMENT</i></b></p>"
    "<ol><li>TC_R0_ORDERED_ONE_EXPERIMENT</li><li>TC_R0_ORDERED_TWO_EXPERIMENT</li></ol>"
    "<ul><li>TC_R0_UNORDERED_ONE_EXPERIMENT</li><li>TC_R0_UNORDERED_TWO_EXPERIMENT</li></ul>"
)


class _SMTPHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        envelope_from = ""
        recipients: list[str] = []
        self.wfile.write(b"220 thunderclaw-r0.local ESMTP\r\n")
        while line := self.rfile.readline(65537):
            command = line.rstrip(b"\r\n")
            upper = command.upper()
            if upper.startswith((b"EHLO ", b"HELO ")):
                self.wfile.write(b"250-thunderclaw-r0.local\r\n250 SIZE 10485760\r\n")
            elif upper.startswith(b"MAIL FROM:"):
                envelope_from = command[10:].split(b" ", 1)[0].decode("ascii", "strict").strip()
                self.wfile.write(b"250 2.1.0 sender accepted\r\n")
            elif upper.startswith(b"RCPT TO:"):
                recipients.append(command[8:].split(b" ", 1)[0].decode("ascii", "strict").strip())
                self.wfile.write(b"250 2.1.5 recipient accepted\r\n")
            elif upper == b"DATA":
                self.wfile.write(b"354 end with <CRLF>.<CRLF>\r\n")
                chunks = []
                byte_count = 0
                while data_line := self.rfile.readline(10485761):
                    if data_line == b".\r\n":
                        break
                    byte_count += len(data_line)
                    if byte_count > 10485760:
                        raise RuntimeError("SMTP DATA exceeded fixed test limit")
                    chunks.append(data_line[1:] if data_line.startswith(b"..") else data_line)
                self.server.messages.put({"envelopeFrom": envelope_from,
                    "envelopeRecipients": recipients.copy(), "data": b"".join(chunks)})
                self.wfile.write(b"250 2.0.0 queued as TC-R0\r\n")
            elif upper == b"RSET":
                envelope_from = ""
                recipients.clear()
                self.wfile.write(b"250 2.0.0 reset\r\n")
            elif upper == b"NOOP":
                self.wfile.write(b"250 2.0.0 ok\r\n")
            elif upper == b"QUIT":
                self.wfile.write(b"221 2.0.0 bye\r\n")
                return
            else:
                self.wfile.write(b"502 5.5.1 unsupported command\r\n")


class LoopbackSMTPSink:
    def __init__(self) -> None:
        self.server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _SMTPHandler)
        self.server.daemon_threads = True
        self.server.messages = queue.Queue()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def port(self) -> int:
        return self.server.server_address[1]

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def receive(self, timeout: float = 30.0) -> dict:
        return self.server.messages.get(timeout=timeout)


def automation(client: Marionette, operation: str, extra: dict | None = None, timeout: float = 20.0) -> dict:
    sequence = str(time.monotonic_ns())
    started = harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const editor = win?.document.getElementById("messageEditor");
const document = editor?.contentDocument;
if (!document) return false;
document.documentElement.dataset.thunderclawR0AutomationSequence = arguments[0];
document.documentElement.dataset.thunderclawR0AutomationRequest = arguments[1];
document.dispatchEvent(new editor.contentWindow.Event("thunderclaw-r0-automation-request"));
return true;
""", [sequence, json.dumps({"buildId": AUTOMATION_BUILD_ID, "operation": operation, "extra": extra or {}})])
    if started is not True:
        raise RuntimeError("R0 automation popup unavailable")

    def completed():
        return harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const document = win?.document.getElementById("messageEditor")?.contentDocument;
return document?.documentElement.dataset.thunderclawR0AutomationCompleted === arguments[0]
  ? document.documentElement.dataset.thunderclawR0AutomationResult
  : null;
""", [sequence])

    try:
        encoded = harness.wait_until(f"R0 {operation}", completed, timeout)
    finally:
        harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const root = win?.document.getElementById("messageEditor")?.contentDocument?.documentElement;
if (root) {
  delete root.dataset.thunderclawR0AutomationSequence;
  delete root.dataset.thunderclawR0AutomationRequest;
  delete root.dataset.thunderclawR0AutomationResult;
  delete root.dataset.thunderclawR0AutomationCompleted;
}
""")
    value = json.loads(encoded)
    if value.pop("buildId", None) != AUTOMATION_BUILD_ID:
        raise RuntimeError(f"R0 {operation} returned the wrong build ID")
    if not value.get("ok"):
        raise RuntimeError(value.get("error", f"R0 {operation} failed"))
    return value["value"]


def wait_for_automation_ready(client: Marionette) -> None:
    def ping_ready():
        try:
            return automation(client, "ping", timeout=0.5).get("ready")
        except (RuntimeError, TimeoutError):
            return None

    try:
        harness.wait_until("exact R0 automation build readiness", ping_ready, 20.0)
    except TimeoutError as error:
        diagnostic = harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const frame = win?.document.getElementById("messageEditor");
const root = frame?.contentDocument?.documentElement;
const messages = Services.console.getMessageArray().slice(-100)
  .map((item) => String(item.message ?? item))
  .filter((message) => /rich-compose|compose\.js|thunderclaw-r0|ExtensionError/iu.test(message))
  .slice(-10);
return { frameURI: frame?.contentDocument?.documentURI ?? null,
  readyState: frame?.contentDocument?.readyState ?? null,
  automationAttributes: Array.from(root?.attributes ?? [], attribute => attribute.name)
    .filter(name => name.startsWith("data-thunderclaw-r0-automation")),
  messages };
""")
        raise TimeoutError(f"{error}; diagnostic={json.dumps(diagnostic, sort_keys=True)}") from error


def editor_state(client: Marionette) -> dict:
    return harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const editor = win.document.getElementById("messageEditor");
const document = editor.contentDocument;
const body = document.body;
const state = node => {
  if (node.nodeType === Node.TEXT_NODE) return { kind: "text", data: node.data };
  if (node.nodeType === Node.COMMENT_NODE) return { kind: "comment", data: node.data };
  return { kind: "element", namespace: node.namespaceURI, name: node.localName,
    attributes: Array.from(node.attributes, attribute => [attribute.namespaceURI, attribute.name, attribute.value]).sort(),
    children: Array.from(node.childNodes, state) };
};
const path = node => {
  const value = [];
  while (node !== body) {
    value.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node));
    node = node.parentNode;
  }
  return value;
};
const selection = editor.contentWindow.getSelection();
const range = selection.rangeCount === 1 ? selection.getRangeAt(0) : null;
const tokenNodes = [];
const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
let text;
while ((text = walker.nextNode())) if (text.data.startsWith("TC_R0_")) tokenNodes.push(text.data);
const profile = element => element ? {
  namespace: element.namespaceURI,
  name: element.localName,
  attributes: Array.from(element.attributes,
    attribute => [attribute.namespaceURI, attribute.name, attribute.value]).sort(),
} : null;
const underlineTokens = [];
for (const node of Array.from(body.querySelectorAll("u"))) {
  const value = node.textContent;
  if (!/^TC_R0_(?:BOLD_|ITALIC_|COMBINED_)?UNDERLINE_/u.test(value)) continue;
  const ancestors = [];
  for (let ancestor = node.parentElement; ancestor && ancestor !== body; ancestor = ancestor.parentElement) {
    ancestors.push(profile(ancestor));
  }
  underlineTokens.push({ value, element: profile(node), parent: profile(node.parentElement),
    ancestors,
    childKinds: Array.from(node.childNodes, child => child.nodeType === Node.TEXT_NODE ? "text" : child.localName) });
}
const listFixture = win.__thunderclawR0ListFixture;
return {
  body: state(body),
  selection: range ? { startPath: path(range.startContainer), startOffset: range.startOffset,
    endPath: path(range.endContainer), endOffset: range.endOffset, textLength: range.toString().length } : null,
  tokenNodes,
  orderedParents: tokenNodes.filter(value => value.includes("TC_R0_ORDERED_")).map(value => {
    const node = Array.from(body.querySelectorAll("li")).find(item => item.textContent === value);
    return node?.parentElement?.localName ?? null;
  }),
  unorderedParents: tokenNodes.filter(value => value.includes("TC_R0_UNORDERED_")).map(value => {
    const node = Array.from(body.querySelectorAll("li")).find(item => item.textContent === value);
    return node?.parentElement?.localName ?? null;
  }),
  canaryIdentity: (win.__thunderclawR0Canaries ?? []).map(node => node.isConnected && body.contains(node)),
  underlineTokens,
  listFixture: listFixture ? {
    kind: listFixture.list.localName,
    listIdentity: listFixture.list.isConnected && body.firstChild === listFixture.list,
    listProfile: profile(listFixture.list),
    itemIdentity: listFixture.items.map((item, index) => item.isConnected
      && item.parentNode === listFixture.list && listFixture.list.children[index] === item),
    itemProfiles: listFixture.items.map(profile),
    edgeTextIdentity: [listFixture.firstText, listFixture.thirdText].map(node => node.isConnected
      && node.parentNode?.parentNode === listFixture.list),
    edgeTexts: [listFixture.firstText.data, listFixture.thirdText.data],
    adjacentBreakIdentity: listFixture.adjacentBreak.isConnected
      && listFixture.adjacentBreak.parentNode === body,
    adjacentBreakProfile: profile(listFixture.adjacentBreak),
  } : null,
};
""")


def runtime_metadata(client: Marionette, xpi: Path, expected_version: str | None) -> dict:
    runtime = harness.chrome(client, r"""
return { version: Services.appinfo.version, buildId: Services.appinfo.appBuildID };
""")
    if expected_version and runtime["version"] != expected_version.removesuffix("esr"):
        raise AssertionError(f"Expected Thunderbird {expected_version}, got {runtime!r}")
    return {
        "release": expected_version,
        "version": runtime["version"],
        "buildId": runtime["buildId"],
        "xpiSha256": hashlib.sha256(xpi.read_bytes()).hexdigest(),
        "coverage": {
            "kind": "editor-feasibility-compose-script-bridge",
            "popup": False,
            "network": "none",
            "freshProfile": True,
        },
    }


UNDERLINE_PROBES = ("direct-body", "marked-paragraph", "flat-ul-second-item", "flat-ol-second-item")

WHOLE_LIST_CHILD_CASES = tuple(
    f"child-range-{kind}-{operation}"
    for kind in ("ul", "ol")
    for operation in ("preserve", "rewrite", "add", "remove", "reorder")
) + tuple(
    f"{mode}-{kind}-{operation}"
    for mode in ("natural-li", "natural-wrapper", "natural-shell", "asymmetric-shell", "reverse-li", "reverse-wrapper")
    for kind in ("ul", "ol")
    for operation in (("preserve", "rewrite", "add", "remove", "reorder", "format")
        if mode == "natural-wrapper" else ("rewrite", "add"))
) + ("natural-wrapper-ul-to-ol", "natural-wrapper-ol-to-ul")
WHOLE_LIST_CHILD_CASES += tuple(
    f"{mode}-ul-rewrite" for mode in ("natural-text", "natural-br", "natural-div", "natural-p")
)
WHOLE_LIST_CHILD_CASES += tuple(
    f"{mode}-{kind}-{operation}"
    for mode in ("sole-body-wrapper", "reverse-sole-body-wrapper")
    for kind in ("ul", "ol")
    for operation in ("rewrite", "add", "remove", "reorder")
)
WHOLE_LIST_CHILD_CASES += ("natural-wrapper-compatible-split-ul-rewrite",)
WHOLE_LIST_CHILD_CASES += tuple(
    f"{mode}-{kind}-{operation}"
    for mode in ("body-wrapper", "reverse-body-wrapper")
    for kind in ("ul", "ol")
    for operation in ("rewrite", "add", "remove", "reorder")
)

SAME_KIND_HANDLER_CASES = tuple(
    f"handler-{kind}-{operation}"
    for kind in ("ul", "ol")
    for operation in ("rewrite", "add", "remove", "reorder")
) + ("handler-ul-rewrite-backward", "handler-ul-rewrite-rollback", "handler-ul-rewrite-native",
    "handler-ul-rewrite-rejected")
SAME_KIND_HANDLER_CASES += tuple(
    f"handler-{shape}-{kind}-{operation}{suffix}"
    for shape in ("body", "sole-body")
    for kind in ("ul", "ol")
    for operation in ("rewrite", "add", "remove", "reorder")
    for suffix in ("", "-backward")
)
SAME_KIND_HANDLER_CASES += tuple(
    f"handler-{shape}-{kind}-rewrite-{modifier}"
    for shape in ("body", "sole-body")
    for kind in ("ul", "ol")
    for modifier in ("native", "rollback", "rejected")
)


def outer_command(client: Marionette, command: str) -> dict:
    return harness.chrome(client, r"""
const command = arguments[0];
const win = Services.wm.getMostRecentWindow("msgcompose");
const editor = win.document.getElementById("messageEditor");
win.focus();
editor.contentWindow.focus();
editor.contentDocument.body.focus();
const controller = win.document.commandDispatcher.getControllerForCommand(command);
if (!controller) throw new Error(`${command} has no controller`);
const enabled = controller.isCommandEnabled(command);
if (!enabled) throw new Error(`${command} is unavailable`);
controller.doCommand(command);
return { command, enabled };
""", [command])


def install_underline_probe_fixture(client: Marionette, probe: str) -> dict:
    return harness.chrome(client, r"""
const probe = arguments[0];
const token = "TC_R0_UNDERLINE_NATIVE_PROBE";
const win = Services.wm.getMostRecentWindow("msgcompose");
const editor = win.document.getElementById("messageEditor");
const document = editor.contentDocument;
const body = document.body;
win.__thunderclawR0Canaries = [];
delete win.__thunderclawR0ListFixture;
let target;
if (probe === "direct-body") {
  target = document.createTextNode(token);
  body.replaceChildren(target);
} else if (probe === "marked-paragraph") {
  const paragraph = document.createElement("p");
  paragraph.setAttribute("_moz_dirty", "");
  target = document.createTextNode(token);
  paragraph.append(target);
  body.replaceChildren(paragraph);
  win.__thunderclawR0Canaries = [paragraph];
} else {
  const list = document.createElement(probe === "flat-ul-second-item" ? "ul" : "ol");
  list.setAttribute("_moz_dirty", "");
  const values = ["TC_R0_LIST_FIRST_CANARY", token, "TC_R0_LIST_THIRD_CANARY"];
  const items = values.map(value => {
    const item = document.createElement("li");
    item.setAttribute("_moz_dirty", "");
    item.append(document.createTextNode(value));
    return item;
  });
  list.append(...items);
  target = items[1].firstChild;
  const adjacentBreak = document.createElement("br");
  adjacentBreak.setAttribute("_moz_dirty", "");
  body.replaceChildren(list, adjacentBreak);
  win.__thunderclawR0Canaries = [list, ...items, adjacentBreak];
  win.__thunderclawR0ListFixture = {
    list,
    items,
    firstText: items[0].firstChild,
    thirdText: items[2].firstChild,
    adjacentBreak,
  };
}
body.focus();
const range = document.createRange();
range.setStart(target, 0);
range.setEnd(target, target.data.length);
const selection = editor.contentWindow.getSelection();
selection.removeAllRanges();
selection.addRange(range);
return { probe, token, selected: range.toString(), selectedLength: range.toString().length };
""", [probe])


def run_underline_probe(client: Marionette, probe: str) -> dict:
    fixture = install_underline_probe_fixture(client, probe)
    before = editor_state(client)
    command = outer_command(client, "cmd_underline")
    after_command = editor_state(client)
    if len(after_command["underlineTokens"]) != 1 or not all(after_command["canaryIdentity"]):
        raise AssertionError(f"{probe} native underline topology or object preservation failed")
    if after_command["underlineTokens"][0]["value"] != fixture["token"]:
        raise AssertionError(f"{probe} native underline wrapped the wrong token")
    if after_command["listFixture"] and (not after_command["listFixture"]["listIdentity"]
            or not all(after_command["listFixture"]["itemIdentity"])
            or not all(after_command["listFixture"]["edgeTextIdentity"])
            or not after_command["listFixture"]["adjacentBreakIdentity"]):
        raise AssertionError(f"{probe} native underline replaced a list or canary object")
    undo = outer_command(client, "cmd_undo")
    after_undo = editor_state(client)
    redo = outer_command(client, "cmd_redo")
    after_redo = editor_state(client)
    if after_undo != before:
        raise AssertionError(f"{probe} native underline Undo was not independently exact")
    if after_redo != after_command:
        raise AssertionError(f"{probe} native underline Redo was not independently exact")
    return {
        "probe": probe,
        "fixture": fixture,
        "command": command,
        "undo": undo,
        "redo": redo,
        "before": before,
        "afterCommand": after_command,
        "afterUndo": after_undo,
        "afterRedo": after_redo,
    }


def install_whole_list_child_fixture(client: Marionette, case: str) -> dict:
    return harness.chrome(client, r"""
const testCase = arguments[0];
const ordinary = /^(child-range|natural-li|natural-wrapper|natural-wrapper-compatible-split|natural-shell|asymmetric-shell|reverse-li|reverse-wrapper|body-wrapper|reverse-body-wrapper|sole-body-wrapper|reverse-sole-body-wrapper|natural-text|natural-br|natural-div|natural-p)-(ul|ol)-(preserve|rewrite|add|remove|reorder|format)$/u.exec(testCase);
const conversion = /^natural-wrapper-(ul|ol)-to-(ul|ol)$/u.exec(testCase);
if (!ordinary && !conversion) throw new Error("Unknown whole-list child-range case.");
const mode = ordinary?.[1] ?? "natural-wrapper";
const kind = ordinary?.[2] ?? conversion[1];
const operation = ordinary?.[3] ?? "convert";
const targetKind = conversion?.[2] ?? kind;
if (["natural-text", "natural-br", "natural-div", "natural-p"].includes(mode)
    && (kind !== "ul" || operation !== "rewrite")) {
  throw new Error("This bounded content-shape diagnostic supports only UL rewrite.");
}
if (!["child-range", "natural-wrapper", "natural-wrapper-compatible-split", "body-wrapper", "reverse-body-wrapper", "sole-body-wrapper", "reverse-sole-body-wrapper", "natural-text", "natural-br", "natural-div", "natural-p"].includes(mode)
    && !["rewrite", "add"].includes(operation)) {
  throw new Error("This bounded selection/serialization mode supports only rewrite and add.");
}
const replacements = {
  preserve: ["TC_R0_LIST_ALPHA", "TC_R0_LIST_BETA", "TC_R0_LIST_GAMMA"],
  rewrite: ["TC_R0_LIST_REWRITTEN_ALPHA", "TC_R0_LIST_REWRITTEN_BETA", "TC_R0_LIST_REWRITTEN_GAMMA"],
  add: ["TC_R0_LIST_ALPHA", "TC_R0_LIST_BETA", "TC_R0_LIST_GAMMA", "TC_R0_LIST_DELTA_ADDED"],
  remove: ["TC_R0_LIST_ALPHA", "TC_R0_LIST_GAMMA"],
  reorder: ["TC_R0_LIST_GAMMA", "TC_R0_LIST_ALPHA", "TC_R0_LIST_BETA"],
  format: ["TC_R0_LIST_FORMAT_BOLD", "TC_R0_LIST_FORMAT_ITALIC_UNDERLINE", "TC_R0_LIST_FORMAT_COMBINED"],
  convert: ["TC_R0_LIST_CONVERTED_ALPHA", "TC_R0_LIST_CONVERTED_BETA", "TC_R0_LIST_CONVERTED_GAMMA"],
};
const win = Services.wm.getMostRecentWindow("msgcompose");
const editor = win.document.getElementById("messageEditor");
const document = editor.contentDocument;
const body = document.body;
const before = document.createComment("thunderclaw-r0-before-list-canary");
const after = document.createComment("thunderclaw-r0-after-list-canary");
const list = document.createElement(kind);
list.setAttribute("_moz_dirty", "");
const originalValues = ["TC_R0_LIST_ALPHA", "TC_R0_LIST_BETA", "TC_R0_LIST_GAMMA"];
const items = originalValues.map(value => {
  const item = document.createElement("li");
  item.setAttribute("_moz_dirty", "");
  item.append(document.createTextNode(value));
  return item;
});
list.append(...items);
const soleBody = ["sole-body-wrapper", "reverse-sole-body-wrapper"].includes(mode);
if (soleBody) body.replaceChildren(list);
else body.replaceChildren(before, list, after);
win.__thunderclawR0WholeListChildFixture = {
  case: testCase,
  mode,
  kind,
  targetKind,
  operation,
  before,
  list,
  after,
  items,
  originalValues,
  replacementValues: replacements[operation],
};
body.focus();
const natural = document.createRange();
if (["body-wrapper", "reverse-body-wrapper", "sole-body-wrapper", "reverse-sole-body-wrapper"].includes(mode)) {
  const startOffset = soleBody ? 0 : 1;
  natural.setStart(body, startOffset);
  natural.setEnd(body, startOffset + 1);
} else {
  natural.setStart(items[0].firstChild, 0);
  natural.setEnd(items.at(-1).firstChild, items.at(-1).firstChild.data.length);
}
const selection = editor.contentWindow.getSelection();
selection.removeAllRanges();
if (["reverse-body-wrapper", "reverse-sole-body-wrapper"].includes(mode)) {
  const startOffset = soleBody ? 0 : 1;
  selection.setBaseAndExtent(body, startOffset + 1, body, startOffset);
} else if (mode.startsWith("reverse-")) {
  selection.setBaseAndExtent(items.at(-1).firstChild, items.at(-1).firstChild.data.length,
    items[0].firstChild, 0);
} else {
  selection.addRange(natural);
}
return {
  case: testCase,
  mode,
  kind,
  targetKind,
  operation,
  originalValues,
  replacementValues: replacements[operation],
  selectedTextLength: natural.toString().length,
  selectionShape: {
    startContainer: natural.startContainer === body ? "body" : "text",
    startOffset: natural.startOffset,
    endContainer: natural.endContainer === body ? "body" : "text",
    endOffset: natural.endOffset,
    backward: ["reverse-body-wrapper", "reverse-sole-body-wrapper"].includes(mode),
  },
  selectionFragment: (() => {
    const container = document.createElement("div");
    container.append(natural.cloneContents());
    return container.innerHTML;
  })(),
};
""", [case])


def whole_list_child_state(client: Marionette) -> dict:
    return harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const editor = win.document.getElementById("messageEditor");
const document = editor.contentDocument;
const body = document.body;
const fixture = win.__thunderclawR0WholeListChildFixture;
if (!fixture) throw new Error("Whole-list child fixture is unavailable.");
const state = node => {
  if (node.nodeType === Node.TEXT_NODE) return { kind: "text", data: node.data };
  if (node.nodeType === Node.COMMENT_NODE) return { kind: "comment", data: node.data };
  return {
    kind: "element",
    namespace: node.namespaceURI,
    name: node.localName,
    attributes: Array.from(node.attributes, attribute => [
      attribute.namespaceURI, attribute.prefix, attribute.localName, attribute.name, attribute.value,
    ]).sort(),
    children: Array.from(node.childNodes, state),
  };
};
const path = node => {
  const value = [];
  while (node !== body) {
    if (!node?.parentNode) return null;
    value.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node));
    node = node.parentNode;
  }
  return value;
};
const selection = editor.contentWindow.getSelection();
const range = selection.rangeCount === 1 ? selection.getRangeAt(0) : null;
const list = fixture.list;
const wrapperIndex = ["sole-body-wrapper", "reverse-sole-body-wrapper"].includes(fixture.mode) ? 0 : 1;
const liveList = body.childNodes[wrapperIndex]?.nodeType === Node.ELEMENT_NODE
  && ["ul", "ol"].includes(body.childNodes[wrapperIndex].localName) ? body.childNodes[wrapperIndex] : null;
return {
  body: state(body),
  selection: range ? {
    startPath: path(range.startContainer),
    startOffset: range.startOffset,
    endPath: path(range.endContainer),
    endOffset: range.endOffset,
    textLength: range.toString().length,
    anchorPath: path(selection.anchorNode),
    anchorOffset: selection.anchorOffset,
    focusPath: path(selection.focusNode),
    focusOffset: selection.focusOffset,
  } : null,
  wrapper: {
    connected: list.isConnected,
    sameNode: body.childNodes[wrapperIndex]?.isSameNode(list) === true,
    namespace: list.namespaceURI,
    name: list.localName,
    attributes: Array.from(list.attributes, attribute => [
      attribute.namespaceURI, attribute.prefix, attribute.localName, attribute.name, attribute.value,
    ]).sort(),
  },
  liveWrapper: liveList ? {
    sameNode: liveList.isSameNode(list),
    namespace: liveList.namespaceURI,
    name: liveList.localName,
    attributes: Array.from(liveList.attributes, attribute => [
      attribute.namespaceURI, attribute.prefix, attribute.localName, attribute.name, attribute.value,
    ]).sort(),
  } : null,
  canaries: {
    beforeConnected: fixture.before.isConnected,
    afterConnected: fixture.after.isConnected,
    beforeSameNode: body.firstChild?.isSameNode(fixture.before) === true,
    afterSameNode: body.lastChild?.isSameNode(fixture.after) === true,
    beforeState: state(fixture.before),
    afterState: state(fixture.after),
  },
  items: Array.from(liveList?.children ?? [], item => ({
    namespace: item.namespaceURI,
    name: item.localName,
    attributes: Array.from(item.attributes, attribute => [
      attribute.namespaceURI, attribute.prefix, attribute.localName, attribute.name, attribute.value,
    ]).sort(),
    children: Array.from(item.childNodes, state),
    text: item.textContent,
  })),
  originalItemIdentity: fixture.items.map((item, index) => ({
    connected: item.isConnected,
    atOriginalIndex: list.children[index]?.isSameNode(item) === true,
  })),
};
""")


def restore_whole_list_selection(client: Marionette, values: list[str], natural: bool) -> dict:
    return harness.chrome(client, r"""
const values = arguments[0];
const natural = arguments[1];
const win = Services.wm.getMostRecentWindow("msgcompose");
const editor = win.document.getElementById("messageEditor");
const document = editor.contentDocument;
const list = win.__thunderclawR0WholeListChildFixture.list;
if (!list.isConnected || list.children.length !== values.length) {
  throw new Error("Cannot restore selection across an unexpected list shape.");
}
const actual = Array.from(list.children, item => item.textContent);
if (JSON.stringify(actual) !== JSON.stringify(values)) {
  throw new Error("Cannot restore selection across unexpected list text.");
}
const range = document.createRange();
if (natural) {
  const first = list.firstElementChild.firstChild;
  const last = list.lastElementChild.firstChild;
  range.setStart(first, 0);
  range.setEnd(last, last.data.length);
} else {
  range.setStart(list, 0);
  range.setEnd(list, list.childNodes.length);
}
const selection = editor.contentWindow.getSelection();
selection.removeAllRanges();
selection.addRange(range);
return true;
""", [values, natural])


def run_whole_list_child_case(client: Marionette, case: str) -> dict:
    fixture = install_whole_list_child_fixture(client, case)
    before = whole_list_child_state(client)
    handler_capture = None
    if fixture["mode"] in ("body-wrapper", "reverse-body-wrapper", "sole-body-wrapper", "reverse-sole-body-wrapper"):
        handler_capture = automation(client, "capture")
        if whole_list_child_state(client) != before:
            raise AssertionError(f"{case} R0 Capture changed the direct-BODY selection or DOM")
    expected_wrapper_attributes = [[None, None, "_moz_dirty", "_moz_dirty", ""]]
    sole_body = fixture["mode"] in ("sole-body-wrapper", "reverse-sole-body-wrapper")
    canaries_installed = all(before["canaries"].values())
    if sole_body:
        canaries_installed = before["canaries"]["beforeConnected"] is False \
            and before["canaries"]["afterConnected"] is False \
            and before["canaries"]["beforeSameNode"] is False \
            and before["canaries"]["afterSameNode"] is False \
            and len(before["body"]["children"]) == 1
    if before["wrapper"]["attributes"] != expected_wrapper_attributes \
            or not before["wrapper"]["sameNode"] or not canaries_installed:
        raise AssertionError(f"{case} did not install the exact wrapper/canary fixture")

    compatibility = None
    if fixture["mode"] == "natural-wrapper-compatible-split":
        compatibility = harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const editor = win.document.getElementById("messageEditor");
const document = editor.contentDocument;
const body = document.body;
const controller = win.document.commandDispatcher.getControllerForCommand("cmd_undo");
const undoEnabledBefore = controller?.isCommandEnabled("cmd_undo") ?? null;
const observer = new MutationObserver(() => {});
observer.observe(body, { subtree: true, childList: true, characterData: true, attributes: true });
let supported = null;
let stateBefore = null;
let valueBefore = null;
let returned = null;
let stateAfter = null;
let valueAfter = null;
let error = null;
try {
  supported = document.queryCommandSupported("enableCompatibleJoinSplitDirection");
  stateBefore = document.queryCommandState("enableCompatibleJoinSplitDirection");
  valueBefore = document.queryCommandValue("enableCompatibleJoinSplitDirection");
  returned = document.execCommand("enableCompatibleJoinSplitDirection", false, "false");
  stateAfter = document.queryCommandState("enableCompatibleJoinSplitDirection");
  valueAfter = document.queryCommandValue("enableCompatibleJoinSplitDirection");
} catch (caught) {
  error = caught instanceof Error ? caught.name : "unknown";
}
const records = observer.takeRecords();
observer.disconnect();
return {
  supported, stateBefore, valueBefore, returned, stateAfter, valueAfter, error,
  mutationRecordCount: records.length,
  undoEnabledBefore,
  undoEnabledAfter: controller?.isCommandEnabled("cmd_undo") ?? null,
};
""")
        after_compatibility = whole_list_child_state(client)
        if compatibility["mutationRecordCount"] != 0 or after_compatibility != before \
                or compatibility["undoEnabledAfter"] != compatibility["undoEnabledBefore"]:
            raise AssertionError(f"{case} compatibility preflight changed DOM, selection, or Undo availability")

    command = harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const editor = win.document.getElementById("messageEditor");
const document = editor.contentDocument;
const body = document.body;
const fixture = win.__thunderclawR0WholeListChildFixture;
const list = fixture.list;
const container = document.createElement("div");
let commandName = "insertHTML";
let safeHtml;
if (fixture.mode === "natural-text") {
  commandName = "insertText";
  safeHtml = fixture.replacementValues.join("\n");
} else if (fixture.mode === "natural-br") {
  fixture.replacementValues.forEach((value, index) => {
    if (index > 0) container.append(document.createElement("br"));
    container.append(document.createTextNode(value));
  });
  safeHtml = container.innerHTML;
} else if (["natural-div", "natural-p"].includes(fixture.mode)) {
  const tag = fixture.mode === "natural-div" ? "div" : "p";
  for (const value of fixture.replacementValues) {
    const block = document.createElement(tag);
    block.append(document.createTextNode(value));
    container.append(block);
  }
  safeHtml = container.innerHTML;
} else {
  const fullItemValues = ["natural-shell", "asymmetric-shell"].includes(fixture.mode)
    ? fixture.replacementValues.slice(0, -1) : fixture.replacementValues;
  for (const value of fullItemValues) {
    const item = document.createElement("li");
    if (fixture.operation === "format") {
      const index = fullItemValues.indexOf(value);
      const bold = index === 0 || index === 2 ? document.createElement("b") : null;
      const italic = index >= 1 ? document.createElement("i") : null;
      const underline = index >= 1 ? document.createElement("u") : null;
      let leaf = document.createTextNode(value);
      if (underline) { underline.append(leaf); leaf = underline; }
      if (italic) { italic.append(leaf); leaf = italic; }
      if (bold) { bold.append(leaf); leaf = bold; }
      item.append(leaf);
    } else {
      item.append(document.createTextNode(value));
    }
    container.append(item);
  }
  if (["natural-shell", "asymmetric-shell"].includes(fixture.mode)) {
    container.append(document.createTextNode(fixture.replacementValues.at(-1)));
  } else if (["natural-wrapper", "natural-wrapper-compatible-split", "reverse-wrapper", "body-wrapper", "reverse-body-wrapper", "sole-body-wrapper", "reverse-sole-body-wrapper"].includes(fixture.mode)) {
    const wrapper = document.createElement(fixture.targetKind);
    wrapper.append(...Array.from(container.childNodes));
    container.append(wrapper);
  }
  safeHtml = container.innerHTML;
}
const range = document.createRange();
const selection = editor.contentWindow.getSelection();
if (fixture.mode === "child-range") {
  range.setStartBefore(list.firstElementChild);
  range.setEndAfter(list.lastElementChild);
  selection.removeAllRanges();
  selection.addRange(range);
} else if (fixture.mode === "asymmetric-shell") {
  range.setStartBefore(list.firstElementChild);
  const last = list.lastElementChild.firstChild;
  range.setEnd(last, last.data.length);
  selection.removeAllRanges();
  selection.addRange(range);
}
const observer = new MutationObserver(() => {});
observer.observe(body, { subtree: true, childList: true, characterData: true, attributes: true });
body.focus();
const returned = document.execCommand(commandName, false, safeHtml);
const records = observer.takeRecords();
observer.disconnect();
return {
  api: `document.execCommand(${commandName})`,
  returned,
  serializedElementCount: container.children.length,
  mutationRecordCount: records.length,
  mutationTypes: Array.from(new Set(records.map(record => record.type))).sort(),
  childListAdded: records.reduce((count, record) => count + record.addedNodes.length, 0),
  childListRemoved: records.reduce((count, record) => count + record.removedNodes.length, 0),
};
""")
    after_native_apply = whole_list_child_state(client)
    if command["returned"] is not True or command["mutationRecordCount"] < 1:
        raise AssertionError(f"{case} insertHTML did not report a mutating editor command: {command!r}")
    if after_native_apply["wrapper"] != before["wrapper"] \
            or after_native_apply["canaries"] != before["canaries"]:
        raise AssertionError(f"{case} replaced or changed the wrapper/adjacent canaries")
    moz_dirty = [[None, None, "_moz_dirty", "_moz_dirty", ""]]
    if fixture["operation"] == "format":
        def formatted(name: str, child: dict) -> dict:
            return {"kind": "element", "namespace": "http://www.w3.org/1999/xhtml",
                "name": name, "attributes": [], "children": [child]}

        formatted_children = [
            formatted("b", {"kind": "text", "data": fixture["replacementValues"][0]}),
            formatted("i", formatted("u", {"kind": "text", "data": fixture["replacementValues"][1]})),
            formatted("b", formatted("i", formatted("u",
                {"kind": "text", "data": fixture["replacementValues"][2]}))),
        ]
        expected_items = [{
            "namespace": "http://www.w3.org/1999/xhtml",
            "name": "li",
            "attributes": moz_dirty,
            "children": [child],
            "text": value,
        } for value, child in zip(fixture["replacementValues"], formatted_children)]
    else:
        expected_items = [{
            "namespace": "http://www.w3.org/1999/xhtml",
            "name": "li",
            "attributes": moz_dirty,
            "children": [{"kind": "text", "data": value}],
            "text": value,
        } for value in fixture["replacementValues"]]
    topology_exact = after_native_apply["items"] == expected_items \
        and after_native_apply["liveWrapper"] == {
            "sameNode": fixture["targetKind"] == fixture["kind"],
            "namespace": "http://www.w3.org/1999/xhtml",
            "name": fixture["targetKind"],
            "attributes": moz_dirty,
        }
    same_kind = fixture["targetKind"] == fixture["kind"]
    wrapper_confinement_exact = after_native_apply["wrapper"] == before["wrapper"] if same_kind else (
        after_native_apply["wrapper"]["connected"] is False
        and after_native_apply["liveWrapper"] == {
            "sameNode": False,
            "namespace": "http://www.w3.org/1999/xhtml",
            "name": fixture["targetKind"],
            "attributes": moz_dirty,
        })
    confinement_exact = wrapper_confinement_exact \
        and after_native_apply["canaries"] == before["canaries"]
    after_apply = after_native_apply

    undo = outer_command(client, "cmd_undo")
    after_undo_native = whole_list_child_state(client)
    undo_dom_exact = after_undo_native["body"] == before["body"] \
        and after_undo_native["wrapper"] == before["wrapper"] \
        and after_undo_native["canaries"] == before["canaries"]
    undo_selection_exact = after_undo_native["selection"] == before["selection"]

    redo = outer_command(client, "cmd_redo")
    after_redo_native = whole_list_child_state(client)
    redo_dom_exact = after_redo_native["body"] == after_apply["body"] \
        and after_redo_native["wrapper"] == after_apply["wrapper"] \
        and after_redo_native["canaries"] == after_apply["canaries"]
    redo_selection_exact = after_redo_native["selection"] == after_apply["selection"]
    candidate_qualified = topology_exact and confinement_exact and undo_dom_exact \
        and undo_selection_exact and redo_dom_exact and redo_selection_exact
    return {
        "case": case,
        "fixture": fixture,
        "handlerCapture": handler_capture,
        "compatibilityPreflight": compatibility,
        "command": command,
        "undo": undo,
        "redo": redo,
        "gate": {
            "topologyExact": topology_exact,
            "confinementExact": confinement_exact,
            "nativeUndoDomExact": undo_dom_exact,
            "nativeUndoSelectionExact": undo_selection_exact,
            "nativeRedoDomExact": redo_dom_exact,
            "nativeRedoSelectionExact": redo_selection_exact,
            "candidateQualified": candidate_qualified,
        },
        "before": before,
        "afterNativeApply": after_native_apply,
        "afterApply": after_apply,
        "afterUndoNative": after_undo_native,
        "afterRedoNative": after_redo_native,
    }


def run_same_kind_handler_case(client: Marionette, case: str) -> dict:
    natural_match = __import__("re").fullmatch(
        r"handler-(ul|ol)-(rewrite|add|remove|reorder)(?:-(backward|rollback|native|rejected))?", case)
    body_match = __import__("re").fullmatch(
        r"handler-(body|sole-body)-(ul|ol)-(rewrite|add|remove|reorder)(?:-(backward|rollback|native|rejected))?", case)
    if not natural_match and not body_match:
        raise AssertionError(f"Unknown same-kind handler case: {case}")
    if body_match:
        shape, kind, operation, modifier = body_match.groups()
        fixture_mode = "sole-body-wrapper" if shape == "sole-body" else "body-wrapper"
        if modifier == "backward": fixture_mode = f"reverse-{fixture_mode}"
    else:
        kind, operation, modifier = natural_match.groups()
        fixture_mode = "reverse-wrapper" if modifier == "backward" else "natural-wrapper"
    fixture_case = f"{fixture_mode}-{kind}-{operation}"
    fixture = install_whole_list_child_fixture(client, fixture_case)
    before = whole_list_child_state(client)
    captured = automation(client, "capture")
    if modifier == "rejected":
        if captured.get("sameKindListEligible") or captured.get("sameKindListMinimumThunderbirdMajor") != 153:
            raise AssertionError(f"{case} did not fail closed at the exact runtime gate: {captured!r}")
        rejection = None
        try:
            automation(client, "apply", {
                "captureId": captured["captureId"],
                "preset": f"same-kind-list-{operation}",
                "induceFailure": False,
                "editorMode": {"isPlainText": False, "deliveryFormat": "auto"},
            })
        except RuntimeError as error:
            rejection = str(error)
        after_rejection = whole_list_child_state(client)
        if rejection is None or after_rejection != before:
            raise AssertionError(f"{case} did not reject before mutation with exact editor state")
        return {"case": case, "fixture": fixture, "capture": captured,
            "rejection": rejection, "before": before, "afterRejection": after_rejection}
    if not captured.get("wholeListTargeted") or not captured.get("sameKindListEligible") \
            or captured.get("sameKindListMinimumThunderbirdMajor") != 153:
        raise AssertionError(f"{case} did not capture as an eligible Thunderbird 153 same-kind list: {captured!r}")
    preset = f"same-kind-list-{operation}"
    applied = automation(client, "apply", {
        "captureId": captured["captureId"],
        "preset": preset,
        "induceFailure": modifier == "rollback",
        "editorMode": {"isPlainText": False, "deliveryFormat": "auto"},
    })
    after_apply = whole_list_child_state(client)
    if modifier == "rollback":
        rollback = applied.get("rollback", {})
        if applied.get("applied") or not rollback.get("undoReturned") or not rollback.get("restored") \
                or rollback.get("richApplyDisabled") or after_apply != before:
            raise AssertionError(f"{case} did not roll back through the handler exactly: {applied!r}")
        return {"case": case, "fixture": fixture, "capture": captured, "apply": applied,
            "before": before, "afterRollback": after_apply}
    if not applied.get("applied") or not applied.get("postcondition"):
        raise AssertionError(f"{case} handler Apply failed: {applied!r}")
    if after_apply["wrapper"] != before["wrapper"] or after_apply["canaries"] != before["canaries"]:
        raise AssertionError(f"{case} changed the original wrapper or adjacent canaries")
    expected_shapes = {
        "rewrite": (("li",), ("li", "b"), ("li", "i", "u")),
        "add": (("li",), ("li", "b"), ("li", "i", "u"), ("li",)),
        "remove": (("li", "b"), ("li", "u")),
        "reorder": (("li",), ("li", "b"), ("li", "i")),
    }[operation]
    exact_marker = [[None, None, "_moz_dirty", "_moz_dirty", ""]]

    def item_shape(item: dict) -> tuple[str, ...]:
        if item["attributes"] != exact_marker:
            raise AssertionError(f"{case} produced a noncanonical LI marker tuple: {item['attributes']!r}")
        result = [item["name"]]
        children = item["children"]
        while len(children) == 1 and children[0].get("kind") == "element":
            if children[0].get("attributes") != []:
                raise AssertionError(f"{case} decorated a generated inline element: {children[0]!r}")
            result.append(children[0]["name"])
            children = children[0]["children"]
        if len(children) != 1 or children[0].get("kind") != "text":
            raise AssertionError(f"{case} produced a noncanonical item leaf: {item!r}")
        return tuple(result)

    actual_shapes = tuple(item_shape(item) for item in after_apply["items"])
    if actual_shapes != expected_shapes:
        raise AssertionError(f"{case} produced wrong handler item topology: {actual_shapes!r}")
    nonce_matches = [__import__("re").fullmatch(r"TC_R0_LIST_[A-Z_]+_([0-9a-f]{12})", item["text"])
        for item in after_apply["items"]]
    if not all(nonce_matches) or len({value.group(1) for value in nonce_matches if value}) != 1:
        raise AssertionError(f"{case} produced missing or mixed fixture nonces")

    if modifier == "native":
        undo = outer_command(client, "cmd_undo")
        after_undo = whole_list_child_state(client)
        verified_pre = automation(client, "verify", {"trialId": applied["trialId"], "expected": "pre"})
        redo = outer_command(client, "cmd_redo")
        after_redo = whole_list_child_state(client)
        verified_post = automation(client, "verify", {"trialId": applied["trialId"], "expected": "post"})
        if not verified_pre.get("exact") or after_undo != before \
                or not verified_post.get("exact") or after_redo != after_apply:
            raise AssertionError(f"{case} native Undo/Redo was not independently exact")
        return {"case": case, "fixture": fixture, "capture": captured, "apply": applied,
            "undoCommand": undo, "redoCommand": redo, "verifyPre": verified_pre,
            "verifyPost": verified_post, "before": before, "afterApply": after_apply,
            "afterUndo": after_undo, "afterRedo": after_redo}
    undone = automation(client, "undo", {"trialId": applied["trialId"]})
    after_undo = whole_list_child_state(client)
    redone = automation(client, "redo", {"trialId": applied["trialId"]})
    after_redo = whole_list_child_state(client)
    independent_undo_exact = bool(undone.get("exact")) and after_undo == before
    independent_redo_exact = bool(redone.get("exact")) and after_redo == after_apply
    if modifier == "backward":
        return {"case": case, "fixture": fixture, "capture": captured, "apply": applied,
            "undo": undone, "redo": redone, "before": before, "afterApply": after_apply,
            "afterUndo": after_undo, "afterRedo": after_redo,
            "gate": {"independentUndoExact": independent_undo_exact,
                "independentRedoExact": independent_redo_exact,
                "backwardAnchorFocusRestored": after_undo["selection"] == before["selection"]}}
    if not independent_undo_exact or not independent_redo_exact:
        raise AssertionError(f"{case} ThunderClaw Undo/Redo was not independently exact")
    return {"case": case, "fixture": fixture, "capture": captured, "apply": applied,
        "undo": undone, "redo": redone, "before": before, "afterApply": after_apply,
        "afterUndo": after_undo, "afterRedo": after_redo}


def run_experiment(client: Marionette, variant: str) -> dict:
    before = editor_state(client)
    command = harness.chrome(client, r"""
const variant = arguments[0];
const safeHtml = arguments[1];
const win = Services.wm.getMostRecentWindow("msgcompose");
const editorFrame = win.document.getElementById("messageEditor");
const document = editorFrame.contentDocument;
const body = document.body;
const selection = editorFrame.contentWindow.getSelection();
const list = body.querySelector("ul");
const range = document.createRange();
range.setStartBefore(list);
range.setEndAfter(list);
selection.removeAllRanges();
selection.addRange(range);
body.focus();
const nativeEditor = win.GetCurrentEditor();
const result = { variant, deleteReturned: null, contextReturned: null, insertReturned: null, error: null };
try {
  if (variant === "baseline") {
    result.insertReturned = document.execCommand("insertHTML", false, safeHtml);
  } else if (variant === "exec-delete-insert") {
    result.deleteReturned = document.execCommand("delete");
    result.insertReturned = document.execCommand("insertHTML", false, safeHtml);
  } else if (variant === "exec-delete-outdent-insert") {
    result.deleteReturned = document.execCommand("delete");
    result.contextReturned = document.execCommand("outdent");
    result.insertReturned = document.execCommand("insertHTML", false, safeHtml);
  } else if (variant === "exec-delete-toggle-ul-insert") {
    result.deleteReturned = document.execCommand("delete");
    result.contextReturned = document.execCommand("insertUnorderedList");
    result.insertReturned = document.execCommand("insertHTML", false, safeHtml);
  } else if (variant === "transaction-exec-delete-insert") {
    nativeEditor.beginTransaction();
    try {
      result.deleteReturned = document.execCommand("delete");
      result.insertReturned = document.execCommand("insertHTML", false, safeHtml);
    } finally {
      nativeEditor.endTransaction();
    }
  } else if (variant === "native-delete-insert") {
    nativeEditor.deleteSelection(Ci.nsIEditor.eNone, Ci.nsIEditor.eStrip);
    result.deleteReturned = true;
    nativeEditor.insertHTML(safeHtml);
    result.insertReturned = true;
  } else if (variant === "transaction-native-delete-insert") {
    nativeEditor.beginTransaction();
    try {
      nativeEditor.deleteSelection(Ci.nsIEditor.eNone, Ci.nsIEditor.eStrip);
      result.deleteReturned = true;
      nativeEditor.insertHTML(safeHtml);
      result.insertReturned = true;
    } finally {
      nativeEditor.endTransaction();
    }
  } else if (variant === "transaction-native-nostrip-delete-insert") {
    nativeEditor.beginTransaction();
    try {
      nativeEditor.deleteSelection(Ci.nsIEditor.eNone, Ci.nsIEditor.eNoStrip);
      result.deleteReturned = true;
      nativeEditor.insertHTML(safeHtml);
      result.insertReturned = true;
    } finally {
      nativeEditor.endTransaction();
    }
  } else if (variant === "transaction-native-delete-outdent-insert") {
    nativeEditor.beginTransaction();
    try {
      nativeEditor.deleteSelection(Ci.nsIEditor.eNone, Ci.nsIEditor.eStrip);
      result.deleteReturned = true;
      result.contextReturned = document.execCommand("outdent");
      nativeEditor.insertHTML(safeHtml);
      result.insertReturned = true;
    } finally {
      nativeEditor.endTransaction();
    }
  } else if (variant === "transaction-native-delete-outdent-insert-delete-placeholder") {
    nativeEditor.beginTransaction();
    try {
      nativeEditor.deleteSelection(Ci.nsIEditor.eNone, Ci.nsIEditor.eStrip);
      result.deleteReturned = true;
      result.contextReturned = document.execCommand("outdent");
      nativeEditor.insertHTML(safeHtml);
      result.insertReturned = true;
      const placeholder = Array.from(body.children).find(element => element.localName === "br"
        && element.nextSibling?.nodeType === Node.COMMENT_NODE
        && element.nextSibling.data === "thunderclaw-r0-after-canary");
      if (!placeholder) throw new Error("outdent placeholder unavailable");
      nativeEditor.deleteNode(placeholder);
      result.placeholderDeleted = true;
    } finally {
      nativeEditor.endTransaction();
    }
  } else if (variant === "transaction-native-nostrip-delete-outdent-insert-delete-placeholder") {
    nativeEditor.beginTransaction();
    try {
      nativeEditor.deleteSelection(Ci.nsIEditor.eNone, Ci.nsIEditor.eNoStrip);
      result.deleteReturned = true;
      result.contextReturned = document.execCommand("outdent");
      nativeEditor.insertHTML(safeHtml);
      result.insertReturned = true;
      const placeholder = Array.from(body.children).find(element => element.localName === "br"
        && element.nextSibling?.nodeType === Node.COMMENT_NODE
        && element.nextSibling.data === "thunderclaw-r0-after-canary");
      if (!placeholder) throw new Error("outdent placeholder unavailable");
      nativeEditor.deleteNode(placeholder);
      result.placeholderDeleted = true;
    } finally {
      nativeEditor.endTransaction();
    }
  } else if (variant === "transaction-native-delete-toggle-ul-insert") {
    nativeEditor.beginTransaction();
    try {
      nativeEditor.deleteSelection(Ci.nsIEditor.eNone, Ci.nsIEditor.eStrip);
      result.deleteReturned = true;
      result.contextReturned = document.execCommand("insertUnorderedList");
      nativeEditor.insertHTML(safeHtml);
      result.insertReturned = true;
    } finally {
      nativeEditor.endTransaction();
    }
  } else if (variant === "transaction-native-delete-remove-list-insert") {
    nativeEditor.beginTransaction();
    try {
      nativeEditor.deleteSelection(Ci.nsIEditor.eNone, Ci.nsIEditor.eStrip);
      result.deleteReturned = true;
      nativeEditor.removeList("ul");
      result.contextReturned = true;
      nativeEditor.insertHTML(safeHtml);
      result.insertReturned = true;
    } finally {
      nativeEditor.endTransaction();
    }
  } else {
    throw new Error("unknown experiment variant");
  }
} catch (error) {
  result.error = String(error?.name ?? "Error");
}
return result;
""", [variant, EXPERIMENT_HTML])
    after_apply = editor_state(client)
    semantic = {
        "tokenCount": len(after_apply["tokenNodes"]),
        "uniqueTokens": len(after_apply["tokenNodes"]) == len(set(after_apply["tokenNodes"])),
        "orderedParents": after_apply["orderedParents"],
        "unorderedParents": after_apply["unorderedParents"],
        "canaries": after_apply["canaryIdentity"],
        "topLevel": ["#comment" if child["kind"] == "comment" else child["name"]
            for child in after_apply["body"]["children"]],
        "topLevelAttributeCounts": [len(child.get("attributes", []))
            for child in after_apply["body"]["children"] if child["kind"] == "element"],
    }
    undo_returned = harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const document = win.document.getElementById("messageEditor").contentDocument;
document.body.focus();
return document.execCommand("undo");
""")
    after_undo_native = editor_state(client)
    if after_undo_native["body"] == before["body"]:
        harness.chrome(client, r"""
const boundary = arguments[0];
const win = Services.wm.getMostRecentWindow("msgcompose");
const editor = win.document.getElementById("messageEditor");
const document = editor.contentDocument;
const resolve = path => path.reduce((node, index) => node.childNodes[index], document.body);
const range = document.createRange();
range.setStart(resolve(boundary.startPath), boundary.startOffset);
range.setEnd(resolve(boundary.endPath), boundary.endOffset);
const selection = editor.contentWindow.getSelection();
selection.removeAllRanges();
selection.addRange(range);
""", [before["selection"]])
        after_undo_restored = editor_state(client)
    else:
        after_undo_restored = after_undo_native
    redo_returned = harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const document = win.document.getElementById("messageEditor").contentDocument;
document.body.focus();
return document.execCommand("redo");
""")
    after_redo = editor_state(client)
    return {
        "variant": variant,
        "command": command,
        "semantic": semantic,
        "undoReturned": undo_returned,
        "redoReturned": redo_returned,
        "bodyPassed": semantic["tokenCount"] == 9 and semantic["uniqueTokens"]
            and semantic["orderedParents"] == ["ol", "ol"]
            and semantic["unorderedParents"] == ["ul", "ul"] and all(semantic["canaries"])
            and semantic["topLevel"] == ["#comment", "p", "p", "ol", "ul", "#comment"]
            and semantic["topLevelAttributeCounts"] == [0, 0, 0, 0],
        "nativeUndoBodyExact": after_undo_native["body"] == before["body"],
        "nativeUndoSelectionExact": after_undo_native["selection"] == before["selection"],
        "restoredUndoExact": after_undo_restored == before,
        "redoExact": after_redo["body"] == after_apply["body"] and after_redo["selection"] == after_apply["selection"],
        "before": before,
        "afterApply": after_apply,
        "afterUndoNative": after_undo_native,
        "afterUndoRestored": after_undo_restored,
        "afterRedo": after_redo,
    }


MATRIX_CASES = ("inline-direct", "inline-direct-spaced-failure", "induced-rollback",
    "opaque-adjacent", "opaque-intersecting", "native-ctrl-z-y")
NEXT_SLICE_CASES = (
    "flat-ul-second-item-partial",
    "flat-ul-second-item-full",
    "flat-ol-second-item-partial",
    "flat-ol-second-item-full",
    "flat-ul-second-item-native-ctrl-z-y",
    "flat-ol-second-item-native-ctrl-z-y",
    "flat-ul-second-item-induced-rollback",
    "flat-ol-second-item-induced-rollback",
)


def install_next_slice_fixture(client: Marionette, case: str) -> dict:
    return harness.chrome(client, r"""
const testCase = arguments[0];
const win = Services.wm.getMostRecentWindow("msgcompose");
const editor = win.document.getElementById("messageEditor");
const document = editor.contentDocument;
const body = document.body;
const list = document.createElement(testCase.includes("flat-ul-") ? "ul" : "ol");
list.setAttribute("_moz_dirty", "");
const values = ["TC_R0_LIST_FIRST_CANARY", "xxTARGETyy", "TC_R0_LIST_THIRD_CANARY"];
const items = values.map(value => {
  const item = document.createElement("li");
  item.setAttribute("_moz_dirty", "");
  item.append(document.createTextNode(value));
  return item;
});
list.append(...items);
const adjacentBreak = document.createElement("br");
adjacentBreak.setAttribute("_moz_dirty", "");
body.replaceChildren(list, adjacentBreak);
win.__thunderclawR0Canaries = [list, ...items, adjacentBreak];
win.__thunderclawR0ListFixture = {
  list,
  items,
  firstText: items[0].firstChild,
  thirdText: items[2].firstChild,
  adjacentBreak,
};
body.focus();
const target = items[1].firstChild;
const partial = testCase.endsWith("-partial") || testCase.endsWith("-induced-rollback");
const startOffset = partial ? 2 : 0;
const endOffset = partial ? 8 : target.data.length;
const range = document.createRange();
range.setStart(target, startOffset);
range.setEnd(target, endOffset);
const selection = editor.contentWindow.getSelection();
selection.removeAllRanges();
selection.addRange(range);
return {
  testCase,
  listKind: list.localName,
  boundaryKind: partial ? "partial-text" : "full-text-edge",
  startPath: [0, 1, 0],
  startOffset,
  endPath: [0, 1, 0],
  endOffset,
  selectedLength: range.toString().length,
};
""", [case])


def assert_list_and_underline(case: str, state: dict) -> None:
    fixture = state.get("listFixture") or {}
    expected_kind = "ul" if "flat-ul-" in case else "ol"
    expected_attributes = [[None, "_moz_dirty", ""]]
    expected_namespace = "http://www.w3.org/1999/xhtml"
    expected_profile = {"namespace": expected_namespace, "name": expected_kind,
        "attributes": expected_attributes}
    if fixture.get("kind") != expected_kind or fixture.get("listProfile") != expected_profile \
            or not fixture.get("listIdentity") or fixture.get("itemIdentity") != [True, True, True] \
            or fixture.get("edgeTextIdentity") != [True, True] \
            or fixture.get("edgeTexts") != ["TC_R0_LIST_FIRST_CANARY", "TC_R0_LIST_THIRD_CANARY"] \
            or not fixture.get("adjacentBreakIdentity") or not all(state.get("canaryIdentity", [])):
        raise AssertionError(f"{case} did not preserve the flat-list fixture identities and profiles")
    item_profile = {"namespace": expected_namespace, "name": "li", "attributes": expected_attributes}
    break_profile = {"namespace": expected_namespace, "name": "br", "attributes": expected_attributes}
    if fixture.get("itemProfiles") != [item_profile, item_profile, item_profile] \
            or fixture.get("adjacentBreakProfile") != break_profile:
        raise AssertionError(f"{case} changed a list-item or adjacent-BR profile")
    underlines = state.get("underlineTokens", [])
    if len(underlines) != 4:
        raise AssertionError(f"{case} produced {len(underlines)} underline tokens")
    marked_profile = lambda name: {"namespace": expected_namespace, "name": name,
        "attributes": expected_attributes}
    plain_profile = lambda name: {"namespace": expected_namespace, "name": name, "attributes": []}
    expected_ancestors = {
        "TC_R0_UNDERLINE_": [item_profile, expected_profile],
        "TC_R0_BOLD_UNDERLINE_": [marked_profile("b"), item_profile, expected_profile],
        "TC_R0_ITALIC_UNDERLINE_": [marked_profile("i"), item_profile, expected_profile],
        "TC_R0_COMBINED_UNDERLINE_": [plain_profile("i"), marked_profile("b"),
            item_profile, expected_profile],
    }
    expected_u_profile = {
        "TC_R0_UNDERLINE_": marked_profile("u"),
        "TC_R0_BOLD_UNDERLINE_": plain_profile("u"),
        "TC_R0_ITALIC_UNDERLINE_": plain_profile("u"),
        "TC_R0_COMBINED_UNDERLINE_": plain_profile("u"),
    }
    seen = set()
    for underline in underlines:
        prefix = next((value for value in expected_ancestors if underline.get("value", "").startswith(value)), None)
        if prefix is None or prefix in seen \
                or underline.get("element") != expected_u_profile.get(prefix) \
                or underline.get("ancestors") != expected_ancestors[prefix] \
                or underline.get("childKinds") != ["text"]:
            raise AssertionError(f"{case} produced an unexpected underline topology/profile: {underline!r}")
        seen.add(prefix)
    if seen != set(expected_ancestors):
        raise AssertionError(f"{case} omitted an underline topology: {seen!r}")


def run_next_slice_case(client: Marionette, case: str) -> dict:
    fixture = install_next_slice_fixture(client, case)
    before = editor_state(client)
    if before["selection"] != {"startPath": fixture["startPath"], "startOffset": fixture["startOffset"],
            "endPath": fixture["endPath"], "endOffset": fixture["endOffset"],
            "textLength": fixture["selectedLength"]}:
        raise AssertionError(f"{case} did not install the exact independent selection fixture")
    captured = automation(client, "capture")
    classification = captured["classification"]
    if not classification["eligible"] or classification["placement"] != "inline" \
            or classification.get("wholeListTargeted") or captured.get("wholeListTargeted"):
        raise AssertionError(f"{case} was not an eligible non-promoted inline LI capture: {captured!r}")
    induced = case.endswith("-induced-rollback")
    applied = automation(client, "apply", {
        "captureId": captured["captureId"],
        "preset": "inline",
        "induceFailure": induced,
        "editorMode": {"isPlainText": False, "deliveryFormat": "auto"},
    })
    after_apply = editor_state(client)
    if induced:
        if applied.get("applied") or applied.get("verificationFailedAt") != "induced-failure" \
                or not applied.get("rollback", {}).get("restored") or after_apply != before:
            raise AssertionError(f"{case} failed to restore the exact LI pre-state after U insertion")
        return {"case": case, "fixture": fixture, "capture": captured, "apply": applied,
            "before": before, "afterApply": after_apply}
    generated_tokens = [value for value in after_apply["tokenNodes"] if "_LIST_" not in value]
    if not applied.get("applied") or len(generated_tokens) != 8 \
            or len(generated_tokens) != len(set(generated_tokens)):
        raise AssertionError(f"{case} did not apply eight unique inline tokens: {applied!r}")
    assert_list_and_underline(case, after_apply)
    trial_id = applied["trialId"]
    if case.endswith("-native-ctrl-z-y"):
        undo = outer_command(client, "cmd_undo")
        after_undo = editor_state(client)
        verified_pre = automation(client, "verify", {"trialId": trial_id, "expected": "pre"})
        redo = outer_command(client, "cmd_redo")
        after_redo = editor_state(client)
        verified_post = automation(client, "verify", {"trialId": trial_id, "expected": "post"})
        if not verified_pre.get("exact") or after_undo != before:
            raise AssertionError(f"{case} native Undo was not independently exact")
        if not verified_post.get("exact") or after_redo != after_apply:
            raise AssertionError(f"{case} native Redo was not independently exact")
        return {"case": case, "fixture": fixture, "capture": captured, "apply": applied,
            "undoCommand": undo, "redoCommand": redo, "verifyPre": verified_pre,
            "verifyPost": verified_post, "before": before, "afterApply": after_apply,
            "afterUndo": after_undo, "afterRedo": after_redo}
    undone = automation(client, "undo", {"trialId": trial_id})
    after_undo = editor_state(client)
    redone = automation(client, "redo", {"trialId": trial_id})
    after_redo = editor_state(client)
    if not undone.get("exact") or after_undo != before:
        raise AssertionError(f"{case} ThunderClaw Undo was not independently exact")
    if not redone.get("exact") or after_redo != after_apply:
        raise AssertionError(f"{case} ThunderClaw Redo was not independently exact")
    return {"case": case, "fixture": fixture, "capture": captured, "apply": applied,
        "undo": undone, "redo": redone, "before": before, "afterApply": after_apply,
        "afterUndo": after_undo, "afterRedo": after_redo}


def stream_raw_message(client: Marionette, message_uri: str) -> str:
    client.set_context("chrome")
    response = client.execute_async_script(r"""
const messageURI = arguments[0];
const done = arguments[arguments.length - 1];
const service = MailServices.messageServiceFromURI(messageURI);
const chunks = [];
const listener = {
  stream: null,
  onStartRequest() {},
  onDataAvailable(_request, inputStream, _offset, count) {
    if (!this.stream) {
      this.stream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
      this.stream.init(inputStream);
    }
    chunks.push(this.stream.read(count));
  },
  onStopRequest(_request, status) {
    done(Components.isSuccessCode(status) ? { value: chunks.join("") }
      : { error: `stream status ${status}` });
  },
  QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
};
try { service.streamMessage(messageURI, listener, null, null, false, "", true); }
catch (error) { done({ error: String(error?.name ?? "stream failure") }); }
""", script_args=[message_uri])
    if response.get("error"):
        raise RuntimeError(response["error"])
    return response["value"]


PERSISTENCE_CASES = ("control-paragraph", "treatment-paragraph",
    "control-flat-ul", "treatment-flat-ul", "control-flat-ol", "treatment-flat-ol") + tuple(
        f"treatment-whole-{kind}-{operation}"
        for kind in ("ul", "ol")
        for operation in ("rewrite", "add", "remove", "reorder"))
OUTGOING_CASES = PERSISTENCE_CASES


def automation_transport_clean(client: Marionette) -> bool:
    return harness.chrome(client, r"""
const document = Services.wm.getMostRecentWindow("msgcompose")
  ?.document.getElementById("messageEditor")?.contentDocument;
if (!document) return false;
return Array.from(document.querySelectorAll("*"), element => Array.from(element.attributes,
  attribute => [attribute.name, attribute.value])).flat()
  .every(([name, value]) => !name.toLowerCase().includes("thunderclaw-r0-automation")
    && !value.toLowerCase().includes("thunderclaw-r0-automation"));
""")


def run_persistence_case(client: Marionette, case: str) -> dict:
    fixture = harness.chrome(client, r"""
const testCase = arguments[0];
const win = Services.wm.getMostRecentWindow("msgcompose");
const editor = win.document.getElementById("messageEditor");
const document = editor.contentDocument;
const body = document.body;
let target;
let primary;
const wholeList = testCase.includes("whole-");
if (testCase.includes("paragraph")) {
  primary = document.createElement("p");
  primary.setAttribute("_moz_dirty", "");
  target = document.createTextNode("TC_R0_PERSIST_TARGET");
  primary.append(target);
} else {
  primary = document.createElement(testCase.includes("-ol") ? "ol" : "ul");
  primary.setAttribute("_moz_dirty", "");
  for (const value of ["TC_R0_PERSIST_FIRST", "TC_R0_PERSIST_TARGET", "TC_R0_PERSIST_THIRD"]) {
    const item = document.createElement("li");
    item.setAttribute("_moz_dirty", "");
    item.append(document.createTextNode(value));
    primary.append(item);
  }
  target = primary.children[1].firstChild;
}
const cite = document.createElement("blockquote");
cite.setAttribute("type", "cite");
cite.append(document.createTextNode("TC_R0_PERSIST_PROTECTED_CITE"));
const signature = document.createElement("div");
signature.className = "moz-signature";
signature.append(document.createTextNode("TC_R0_PERSIST_PROTECTED_SIGNATURE"));
body.replaceChildren(primary, cite, signature);
const subject = `TC_R0_PERSIST_${testCase.toUpperCase().replaceAll("-", "_")}`;
win.document.getElementById("msgSubject").value = subject;
// Spell-check initialization can otherwise race whether the Draft receives a
// Content-Language header. Pin the synthetic fixture's compose field so
// control/treatment header comparisons are deterministic.
win.gMsgCompose.compFields.contentLanguage = "en-US";
const range = document.createRange();
if (wholeList) {
  range.setStart(primary.firstElementChild.firstChild, 0);
  const last = primary.lastElementChild.firstChild;
  range.setEnd(last, last.data.length);
} else {
  range.selectNodeContents(target);
}
const selection = editor.contentWindow.getSelection();
selection.removeAllRanges();
selection.addRange(range);
const identity = win.getCurrentIdentity?.() ?? win.gCurrentIdentity;
if (!identity) throw new Error("compose identity unavailable");
let drafts;
if (typeof identity.getOrCreateDraftsFolder === "function") {
  drafts = identity.getOrCreateDraftsFolder();
} else {
  const account = MailServices.accounts.accounts.find(candidate =>
    candidate.identities.some(candidateIdentity => candidateIdentity.key === identity.key));
  if (!account) throw new Error("compose account unavailable");
  const root = account.incomingServer.rootFolder;
  try { drafts = root.getChildNamed("Drafts"); }
  catch (_) {
    root.createSubfolder("Drafts", null);
    drafts = root.getChildNamed("Drafts");
  }
  drafts.setFlag(Ci.nsMsgFolderFlags.Drafts);
  if ("draftFolder" in identity) identity.draftFolder = drafts.URI;
  else identity.draftsFolderURI = drafts.URI;
}
win.__thunderclawR0DraftsFolder = drafts;
return { draftsURI: drafts.URI, subject, contentLanguage: win.gMsgCompose.compFields.contentLanguage,
  selectedLength: range.toString().length };
""", [case])
    before = editor_state(client)
    clean_before_apply = automation_transport_clean(client)
    if not clean_before_apply:
        raise AssertionError("R0 automation transport metadata existed before persistence Apply")
    applied = None
    after_apply = before
    if case.startswith("treatment-"):
        captured = automation(client, "capture")
        whole_list = "whole-" in case
        if not captured["classification"]["eligible"] or (whole_list and (
                not captured.get("wholeListTargeted") or not captured.get("sameKindListEligible"))) or (
                not whole_list and (captured["classification"]["placement"] != "inline"
                    or captured.get("wholeListTargeted"))):
            raise AssertionError(f"{case} persistence Capture had the wrong target profile")
        operation = case.rsplit("-", 1)[-1]
        preset = f"same-kind-list-{operation}" if whole_list else "inline"
        applied = automation(client, "apply", {"captureId": captured["captureId"], "preset": preset,
            "induceFailure": False, "editorMode": {"isPlainText": False, "deliveryFormat": "auto"}})
        if not applied.get("applied"):
            raise AssertionError(f"{case} persistence Apply failed: {applied!r}")
        after_apply = editor_state(client)
    clean_after_apply = automation_transport_clean(client)
    if not clean_after_apply:
        raise AssertionError("R0 automation transport metadata remained after persistence Apply")
    clean_before_save = automation_transport_clean(client)
    if not clean_before_save:
        raise AssertionError("R0 automation transport metadata remained before Draft save")
    harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
win.focus();
win.goDoCommand("cmd_saveAsDraft");
return true;
""")

    def saved_header():
        return harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const folder = win?.__thunderclawR0DraftsFolder;
if (!folder || win.gSaveOperationInProgress) return null;
let newest = null;
for (const header of folder.messages) {
  if (header.mime2DecodedSubject !== arguments[0]) continue;
  if (!newest || header.messageKey > newest.messageKey) newest = header;
}
return newest ? { messageURI: folder.getUriForMsg(newest), messageKey: newest.messageKey,
  subject: newest.mime2DecodedSubject, folderURI: folder.URI } : null;
""", [fixture["subject"]])

    saved = harness.wait_until("saved synthetic control draft", saved_header, 30.0)
    raw_mime = stream_raw_message(client, saved["messageURI"])
    raw_bytes = raw_mime.encode("latin1")
    if b"thunderclaw-r0-automation" in raw_bytes.lower():
        raise AssertionError("R0 automation transport metadata leaked into raw Draft MIME")
    harness.chrome(client, r"""
Services.wm.getMostRecentWindow("msgcompose").goDoCommand("cmd_close");
return true;
""")
    harness.wait_until("control compose close", lambda: harness.chrome(client,
        'return Services.wm.getMostRecentWindow("msgcompose") === null;'), 15.0)
    harness.chrome(client, r"""
const uri = arguments[0];
const header = MailServices.messageServiceFromURI(uri).messageURIToMsgHdr(uri);
MailServices.compose.OpenComposeWindow("", header, uri, Ci.nsIMsgCompType.Draft,
  Ci.nsIMsgCompFormat.Default, null, "", null, null, false);
return true;
""", [saved["messageURI"]])
    reopen_token = "TC_R0_LIST_" if "whole-" in case else (
        "TC_R0_UNDERLINE_" if case.startswith("treatment-") else "TC_R0_PERSIST_TARGET")
    harness.wait_until("reopened control draft", lambda: harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const body = win?.document.getElementById("messageEditor")?.contentDocument?.body;
return body?.textContent.includes(arguments[0]) ? true : null;
""", [reopen_token]), 30.0)
    reopened = editor_state(client)
    clean_after_reopen = automation_transport_clean(client)
    if not clean_after_reopen:
        raise AssertionError("R0 automation transport metadata leaked into reopened Draft DOM")
    required = ["TC_R0_PERSIST_PROTECTED_CITE", "TC_R0_PERSIST_PROTECTED_SIGNATURE"]
    if case.startswith("control-"):
        required.append("TC_R0_PERSIST_TARGET")
    if "flat-" in case:
        required += ["TC_R0_PERSIST_FIRST", "TC_R0_PERSIST_THIRD"]
    if "whole-" in case:
        required += sorted(set(__import__("re").findall(r"TC_R0_LIST_[A-Z_]+_[0-9a-f]{12}",
            applied.get("safeHtml", ""))))
    elif case.startswith("treatment-"):
        required += ["TC_R0_UNDERLINE_", "TC_R0_BOLD_UNDERLINE_", "TC_R0_ITALIC_UNDERLINE_",
            "TC_R0_COMBINED_UNDERLINE_"]
    if not all(value.encode() in raw_bytes for value in required):
        raise AssertionError("stored control MIME omitted a fixed synthetic canary")
    reopened_json = json.dumps(reopened["body"], sort_keys=True)
    if "thunderclaw-r0-automation" in reopened_json.lower():
        raise AssertionError("R0 automation transport metadata leaked into reopened Draft DOM")
    if not all(value in reopened_json for value in required):
        raise AssertionError("reopened control draft omitted a fixed synthetic canary")
    return {"case": case, "fixture": fixture, "saved": saved,
        "before": before, "apply": applied, "afterApply": after_apply,
        "automationTransportCleanBeforeApply": clean_before_apply,
        "automationTransportCleanAfterApply": clean_after_apply,
        "automationTransportCleanBeforeSave": clean_before_save,
        "automationTransportCleanAfterReopen": clean_after_reopen, "reopened": reopened,
        "rawMime": {"sha256": hashlib.sha256(raw_bytes).hexdigest(), "byteLength": len(raw_bytes),
            "contentTypeHeaders": [line for line in raw_mime.splitlines()
                if line.lower().startswith("content-type:")]}, "_rawMime": raw_mime}


def run_outgoing_case(client: Marionette, case: str, profile: Path) -> dict:
    recipients = {"to": "to@e2e.invalid", "cc": "cc@e2e.invalid", "bcc": "bcc@e2e.invalid"}
    attachment_bytes = b"\x00ThunderClaw R0 deterministic attachment\r\n\xff"
    attachment_path = profile / "thunderclaw-r0-attachment.bin"
    attachment_path.write_bytes(attachment_bytes)
    attach_fixture = "flat-ul" in case
    with LoopbackSMTPSink() as sink:
        fixture = harness.chrome(client, r"""
const [testCase, recipients, smtpPort, attachmentPath, attachFixture] = arguments;
const win = Services.wm.getMostRecentWindow("msgcompose");
const editor = win.document.getElementById("messageEditor");
const document = editor.contentDocument;
const body = document.body;
let target;
let primary;
const wholeList = testCase.includes("whole-");
if (testCase.includes("paragraph")) {
  primary = document.createElement("p");
  primary.setAttribute("_moz_dirty", "");
  target = document.createTextNode("TC_R0_PERSIST_TARGET");
  primary.append(target);
} else {
  primary = document.createElement(testCase.includes("-ol") ? "ol" : "ul");
  primary.setAttribute("_moz_dirty", "");
  for (const value of ["TC_R0_PERSIST_FIRST", "TC_R0_PERSIST_TARGET", "TC_R0_PERSIST_THIRD"]) {
    const item = document.createElement("li");
    item.setAttribute("_moz_dirty", "");
    item.append(document.createTextNode(value));
    primary.append(item);
  }
  target = primary.children[1].firstChild;
}
const cite = document.createElement("blockquote");
cite.setAttribute("type", "cite");
const citeBold = document.createElement("b");
citeBold.append(document.createTextNode("TC_R0_PERSIST_PROTECTED_CITE"));
cite.append(citeBold);
const signature = document.createElement("div");
signature.className = "moz-signature";
signature.append(document.createTextNode("TC_R0_PERSIST_PROTECTED_SIGNATURE"));
body.replaceChildren(primary, cite, signature);
const subject = `TC_R0_OUTGOING_${testCase.toUpperCase().replaceAll("-", "_")}`;
win.document.getElementById("msgSubject").value = subject;
win.gMsgCompose.compFields.contentLanguage = "en-US";
if (typeof win.awAddRecipients !== "function") {
  throw new Error("compose recipient helper unavailable");
}
win.awAddRecipients(win.gMsgCompose.compFields, "addr_to", recipients.to);
win.awAddRecipients(win.gMsgCompose.compFields, "addr_cc", recipients.cc);
win.awAddRecipients(win.gMsgCompose.compFields, "addr_bcc", recipients.bcc);
const identity = win.getCurrentIdentity?.() ?? win.gCurrentIdentity;
if (!identity) throw new Error("compose identity unavailable");
const account = MailServices.accounts.accounts.find(candidate =>
  candidate.identities.some(candidateIdentity => candidateIdentity.key === identity.key));
if (!account) throw new Error("compose account unavailable");
const root = account.incomingServer.rootFolder;
let sentFolder;
try { sentFolder = root.getChildNamed("Sent"); }
catch (_) {}
if (!sentFolder) {
  root.createSubfolder("Sent", null);
  sentFolder = root.getChildNamed("Sent");
}
if (!sentFolder) throw new Error("Sent folder was not created");
sentFolder.setFlag(Ci.nsMsgFolderFlags.SentMail);
if (Services.vc.compare(Services.appinfo.version, "140") < 0) {
  identity.doFcc = true;
  identity.fccFolder = sentFolder.URI;
}
const outgoing = MailServices.outgoingServer.createServer("smtp");
outgoing.QueryInterface(Ci.nsISmtpServer);
outgoing.hostname = "127.0.0.1";
outgoing.port = smtpPort;
outgoing.username = "";
outgoing.authMethod = Ci.nsMsgAuthMethod.none;
outgoing.socketType = Ci.nsMsgSocketType.plain;
identity.smtpServerKey = outgoing.key;
if (attachFixture) {
  const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
  const attachment = Cc["@mozilla.org/messengercompose/attachment;1"]
    .createInstance(Ci.nsIMsgAttachment);
  attachment.url = Services.io.newFileURI(new FileUtils.File(attachmentPath)).spec;
  attachment.name = "thunderclaw-r0-attachment.bin";
  attachment.contentType = "application/octet-stream";
  win.AddAttachments([attachment]);
}
const range = document.createRange();
if (wholeList) {
  range.setStart(primary.firstElementChild.firstChild, 0);
  const last = primary.lastElementChild.firstChild;
  range.setEnd(last, last.data.length);
} else {
  range.selectNodeContents(target);
}
const selection = editor.contentWindow.getSelection();
selection.removeAllRanges();
selection.addRange(range);
return { subject, recipients, smtpPort, smtpServerKey: outgoing.key,
  sentFolderURI: sentFolder.URI,
  smtpHostname: outgoing.hostname, smtpAuthMethod: outgoing.authMethod,
  smtpSocketType: outgoing.socketType, attachmentExpected: attachFixture,
  contentLanguage: win.gMsgCompose.compFields.contentLanguage,
  selectedLength: range.toString().length };
""", [case, recipients, sink.port, str(attachment_path), attach_fixture])
        if fixture["smtpHostname"] != "127.0.0.1" or fixture["smtpPort"] != sink.port \
                or fixture["recipients"] != recipients:
            raise AssertionError("outgoing fixture escaped exact loopback identity")
        fixture["attachment"] = {"filename": "thunderclaw-r0-attachment.bin",
            "sha256": hashlib.sha256(attachment_bytes).hexdigest(),
            "byteLength": len(attachment_bytes)} if attach_fixture else None
        before = editor_state(client)
        clean_before_apply = automation_transport_clean(client)
        if not clean_before_apply:
            raise AssertionError("automation transport existed before outgoing Apply")
        applied = None
        after_apply = before
        if case.startswith("treatment-"):
            captured = automation(client, "capture")
            whole_list = "whole-" in case
            if not captured["classification"]["eligible"] or (whole_list and (
                    not captured.get("wholeListTargeted") or not captured.get("sameKindListEligible"))) or (
                    not whole_list and (captured["classification"]["placement"] != "inline"
                        or captured.get("wholeListTargeted"))):
                raise AssertionError(f"{case} outgoing Capture had the wrong target profile")
            operation = case.rsplit("-", 1)[-1]
            applied = automation(client, "apply", {"captureId": captured["captureId"],
                "preset": f"same-kind-list-{operation}" if whole_list else "inline",
                "induceFailure": False,
                "editorMode": {"isPlainText": False, "deliveryFormat": "auto"}})
            if not applied.get("applied"):
                raise AssertionError(f"{case} outgoing Apply failed: {applied!r}")
            after_apply = editor_state(client)
        clean_after_apply = automation_transport_clean(client)
        if not clean_after_apply:
            raise AssertionError("automation transport remained after outgoing Apply")
        clean_before_send = automation_transport_clean(client)
        if not clean_before_send:
            raise AssertionError("automation transport remained before Send")
        send_state = harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
win.focus();
const controller = win.document.commandDispatcher.getControllerForCommand("cmd_sendNow");
if (!controller?.isCommandEnabled("cmd_sendNow")) throw new Error("cmd_sendNow unavailable");
controller.doCommand("cmd_sendNow");
return { command: "cmd_sendNow", subject: win.document.getElementById("msgSubject").value };
""")
        try:
            message = sink.receive(30.0)
        except queue.Empty as error:
            raise TimeoutError("loopback SMTP sink received no DATA") from error
        smtp_data = message.pop("data")
        expected_envelope = [f"<{recipients[key]}>" for key in ("to", "cc", "bcc")]
        if message["envelopeFrom"] != "<author@e2e.invalid>" \
                or message["envelopeRecipients"] != expected_envelope:
            raise AssertionError(f"unexpected SMTP envelope: {message!r}")
        if b"thunderclaw-r0-automation" in smtp_data.lower():
            raise AssertionError("automation transport leaked into SMTP DATA")
        required = [b"TC_R0_PERSIST_PROTECTED_CITE", b"TC_R0_PERSIST_PROTECTED_SIGNATURE"]
        if case.startswith("control-"):
            required.append(b"TC_R0_PERSIST_TARGET")
        elif "whole-" in case:
            required += [value.encode() for value in sorted(set(__import__("re").findall(
                r"TC_R0_LIST_[A-Z_]+_[0-9a-f]{12}", applied.get("safeHtml", ""))))]
        else:
            required += [b"TC_R0_UNDERLINE_", b"TC_R0_BOLD_UNDERLINE_",
                b"TC_R0_ITALIC_UNDERLINE_", b"TC_R0_COMBINED_UNDERLINE_"]
        if "flat-" in case:
            required += [b"TC_R0_PERSIST_FIRST", b"TC_R0_PERSIST_THIRD"]
        if not all(value in smtp_data for value in required):
            raise AssertionError("SMTP DATA omitted a fixed synthetic canary")
        harness.wait_until("compose closed after Send", lambda: harness.chrome(client,
            'return Services.wm.getMostRecentWindow("msgcompose") === null ? true : null;'), 30.0)
        try:
            sink.server.messages.get_nowait()
        except queue.Empty:
            pass
        else:
            raise AssertionError("Send produced more than one SMTP DATA transaction")
        return {"case": case, "fixture": fixture, "before": before, "apply": applied,
            "afterApply": after_apply,
            "automationTransportCleanBeforeApply": clean_before_apply,
            "automationTransportCleanAfterApply": clean_after_apply,
            "automationTransportCleanBeforeSend": clean_before_send,
            "send": {**send_state, **message, "transactionCount": 1,
                "captureCount": 1, "composeClosed": True,
                "sha256": hashlib.sha256(smtp_data).hexdigest(),
                "byteLength": len(smtp_data)}, "_smtpData": smtp_data}


def install_matrix_fixture(client: Marionette, case: str) -> dict:
    return harness.chrome(client, r"""
const testCase = arguments[0];
const win = Services.wm.getMostRecentWindow("msgcompose");
const editor = win.document.getElementById("messageEditor");
const document = editor.contentDocument;
const body = document.body;
body.focus();
const range = document.createRange();
let target;
win.__thunderclawR0Canaries = [];
if (["inline-direct", "inline-direct-spaced-failure", "induced-rollback", "native-ctrl-z-y"].includes(testCase)) {
  target = document.createTextNode(testCase === "inline-direct-spaced-failure"
    ? "prefix TARGET suffix"
    : "prefixTARGETsuffix");
  body.replaceChildren(target);
  const targetStart = testCase === "inline-direct-spaced-failure" ? 7 : 6;
  range.setStart(target, targetStart);
  range.setEnd(target, targetStart + 6);
} else {
  const paragraph = document.createElement("p");
  target = document.createTextNode("TARGET");
  const opaque = document.createElement("a");
  opaque.setAttribute("href", "#synthetic-opaque");
  opaque.setAttribute("data-r0-opaque-canary", "fixed");
  const opaqueText = document.createTextNode("OPAQUE");
  opaque.append(opaqueText);
  paragraph.append(target, opaque);
  body.replaceChildren(paragraph);
  win.__thunderclawR0Canaries = [opaque];
  range.setStart(target, 0);
  if (testCase === "opaque-adjacent") range.setEnd(target, target.data.length);
  else range.setEnd(opaqueText, opaqueText.data.length);
}
const selection = editor.contentWindow.getSelection();
selection.removeAllRanges();
selection.addRange(range);
return { testCase, selectedLength: range.toString().length, bodyTextLength: body.textContent.length };
""", [case])


def run_matrix_case(client: Marionette, case: str) -> dict:
    fixture = install_matrix_fixture(client, case)
    before = editor_state(client)
    captured = automation(client, "capture")
    if case == "opaque-intersecting":
        after = editor_state(client)
        if captured["classification"]["eligible"] or after != before:
            raise AssertionError("opaque-intersecting Capture did not fail closed without mutation")
        return {"case": case, "fixture": fixture, "capture": captured, "before": before, "after": after}
    if not captured["classification"]["eligible"] or captured["classification"]["placement"] != "inline":
        raise AssertionError(f"{case} did not capture as an eligible inline target")
    applied = automation(client, "apply", {
        "captureId": captured["captureId"],
        "preset": "inline",
        "induceFailure": case == "induced-rollback",
        "editorMode": {"isPlainText": False, "deliveryFormat": "auto"},
    })
    after_apply = editor_state(client)
    if case == "inline-direct-spaced-failure":
        detail = applied.get("verificationFailureDetail", {})
        expected = detail.get("expected", {})
        actual = detail.get("actual", {})
        if applied.get("applied") or applied.get("verificationFailedAt") != "exact-confinement" \
                or applied.get("verificationFailureSubtype") != "canonical-mask-mismatch" \
                or not applied.get("rollback", {}).get("restored") or after_apply != before \
                or expected.get("kind") != "text" or actual.get("kind") != "text" \
                or expected.get("characterCount") != actual.get("characterCount"):
            raise AssertionError("spaced direct-body case did not fail closed at the expected "
                f"normalization boundary: {applied!r}")
        return {"case": case, "fixture": fixture, "capture": captured, "apply": applied,
            "before": before, "afterApply": after_apply}
    if case == "induced-rollback":
        if applied.get("applied") or not applied.get("rollback", {}).get("restored") or after_apply != before:
            raise AssertionError("induced rollback did not independently restore exact DOM, selection, and objects")
        return {"case": case, "fixture": fixture, "capture": captured, "apply": applied,
            "before": before, "afterApply": after_apply}
    if not applied.get("applied") or len(after_apply["tokenNodes"]) != 8 \
            or len(after_apply["tokenNodes"]) != len(set(after_apply["tokenNodes"])) \
            or not all(after_apply["canaryIdentity"]):
        raise AssertionError(f"{case} Apply failed independent checks: applied={applied!r}, "
            f"tokens={after_apply['tokenNodes']!r}, canaries={after_apply['canaryIdentity']!r}")
    trial_id = applied["trialId"]
    if case in ("inline-direct", "opaque-adjacent"):
        undone = automation(client, "undo", {"trialId": trial_id})
        after_undo = editor_state(client)
        redone = automation(client, "redo", {"trialId": trial_id})
        after_redo = editor_state(client)
        if not undone.get("exact") or after_undo != before:
            raise AssertionError(f"{case} ThunderClaw Undo was not independently exact")
        if not redone.get("exact") or after_redo != after_apply:
            raise AssertionError(f"{case} ThunderClaw Redo was not independently exact")
        return {"case": case, "fixture": fixture, "capture": captured, "apply": applied,
            "undo": undone, "redo": redone, "before": before, "afterApply": after_apply,
            "afterUndo": after_undo, "afterRedo": after_redo}
    harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const editor = win.document.getElementById("messageEditor");
win.focus();
editor.contentWindow.focus();
editor.contentDocument.body.focus();
const controller = win.document.commandDispatcher.getControllerForCommand("cmd_undo");
if (!controller?.isCommandEnabled("cmd_undo")) throw new Error("outer cmd_undo is unavailable");
controller.doCommand("cmd_undo");
return true;
""")
    after_ctrl_z = editor_state(client)
    verified_pre = automation(client, "verify", {"trialId": trial_id, "expected": "pre"})
    if not verified_pre.get("exact") or after_ctrl_z != before:
        raise AssertionError("outer Ctrl+Z mismatch: "
            f"verified={verified_pre!r}, body={after_ctrl_z['body'] == before['body']}, "
            f"selection={after_ctrl_z['selection'] == before['selection']}, "
            f"canaries={after_ctrl_z['canaryIdentity'] == before['canaryIdentity']}")
    harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const editor = win.document.getElementById("messageEditor");
win.focus();
editor.contentWindow.focus();
editor.contentDocument.body.focus();
const controller = win.document.commandDispatcher.getControllerForCommand("cmd_redo");
if (!controller?.isCommandEnabled("cmd_redo")) throw new Error("outer cmd_redo is unavailable");
controller.doCommand("cmd_redo");
return true;
""")
    after_ctrl_y = editor_state(client)
    verified_post = automation(client, "verify", {"trialId": trial_id, "expected": "post"})
    if not verified_post.get("exact") or after_ctrl_y != after_apply:
        raise AssertionError("outer Ctrl+Y did not independently restore the exact post-state")
    return {"case": case, "fixture": fixture, "capture": captured, "apply": applied,
        "verifyPre": verified_pre, "verifyPost": verified_post, "before": before, "afterApply": after_apply,
        "afterCtrlZ": after_ctrl_z, "afterCtrlY": after_ctrl_y}


def run(xpi: Path, experiment: str | None = None, matrix_case: str | None = None,
        underline_probe: str | None = None, expected_version: str | None = None,
        next_slice_case: str | None = None, persistence_control: bool = False,
        persistence_case: str | None = None, outgoing_case: str | None = None,
        whole_list_child_case: str | None = None,
        paragraph_default: bool | None = None,
        same_kind_handler_case: str | None = None) -> dict:
    profile = Path(tempfile.mkdtemp(prefix="thunderclaw-rich-compose-live-"))
    shutil.copyfile("/opt/thunderclaw-e2e/user.js", profile / "user.js")
    process = subprocess.Popen(
        ["thunderbird", "--marionette", "-remote-allow-system-access", "-no-remote", "-profile", str(profile)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
        text=True,
    )
    client: Marionette | None = None
    try:
        harness.wait_for_port(2828, process)
        client = Marionette(host="127.0.0.1", port=2828)
        client.start_session()
        metadata = runtime_metadata(client, xpi, expected_version)
        installed_id = Addons(client).install(str(xpi), temp=True)
        if installed_id != EXTENSION_ID:
            raise AssertionError(f"Installed unexpected extension ID: {installed_id!r}")
        harness.wait_until("R0 startup", lambda: harness.chrome(client, r"""
const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
return ExtensionParent.GlobalManager.extensionMap.has(arguments[0]);
""", [EXTENSION_ID]))
        if paragraph_default is not None:
            harness.chrome(client, r"""
Services.prefs.setBoolPref("mail.compose.default_to_paragraph", arguments[0]);
return Services.prefs.getBoolPref("mail.compose.default_to_paragraph") === arguments[0];
""", [paragraph_default])
            metadata["paragraphDefault"] = paragraph_default
        harness.open_compose(client)
        if outgoing_case:
            wait_for_automation_ready(client)
            return {"metadata": metadata, **run_outgoing_case(client, outgoing_case, profile)}
        if persistence_control or persistence_case:
            wait_for_automation_ready(client)
            return {"metadata": metadata, **run_persistence_case(client,
                persistence_case or "control-flat-ul")}
        if underline_probe:
            return {"metadata": metadata, **run_underline_probe(client, underline_probe)}
        wait_for_automation_ready(client)
        if whole_list_child_case:
            return {"metadata": metadata, **run_whole_list_child_case(client, whole_list_child_case)}
        if same_kind_handler_case:
            return {"metadata": metadata, **run_same_kind_handler_case(client, same_kind_handler_case)}
        fixture = harness.chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const editor = win.document.getElementById("messageEditor");
const document = editor.contentDocument;
const body = document.body;
const list = document.createElement("ul");
list.setAttribute("_moz_dirty", "");
for (const value of ["one", "elevenchars", "tri"]) {
  const item = document.createElement("li");
  item.setAttribute("_moz_dirty", "");
  item.append(document.createTextNode(value));
  list.append(item);
}
const beforeCanary = document.createComment("thunderclaw-r0-before-canary");
const afterCanary = document.createComment("thunderclaw-r0-after-canary");
body.replaceChildren(beforeCanary, list, afterCanary);
win.__thunderclawR0Canaries = [beforeCanary, afterCanary];
body.focus();
const range = document.createRange();
range.setStart(list.firstElementChild.firstChild, 0);
range.setEnd(list.lastElementChild.firstChild, list.lastElementChild.firstChild.data.length);
const selection = editor.contentWindow.getSelection();
selection.removeAllRanges();
selection.addRange(range);
const nativeEditor = win.GetCurrentEditor?.();
return { html: body.innerHTML, selected: selection.toString(), capabilities: {
  getCurrentEditor: typeof win.GetCurrentEditor,
  beginTransaction: typeof nativeEditor?.beginTransaction,
  endTransaction: typeof nativeEditor?.endTransaction,
  deleteSelection: typeof nativeEditor?.deleteSelection,
  insertHTML: typeof nativeEditor?.insertHTML,
} };
""")
        if matrix_case:
            return {"metadata": metadata, **run_matrix_case(client, matrix_case)}
        if next_slice_case:
            return {"metadata": metadata, **run_next_slice_case(client, next_slice_case)}
        if experiment:
            return {"metadata": metadata, "fixture": fixture, "experiment": run_experiment(client, experiment)}
        before = editor_state(client)
        captured = automation(client, "capture")
        applied = automation(client, "apply", {
            "captureId": captured["captureId"],
            "preset": "blocks",
            "induceFailure": False,
            "editorMode": { "isPlainText": False, "deliveryFormat": "auto" },
        })
        undone = None
        redone = None
        after_apply = editor_state(client)
        after_undo = None
        after_redo = None
        if applied.get("applied"):
            trial_id = applied["trialId"]
            undone = automation(client, "undo", {"trialId": trial_id})
            after_undo = editor_state(client)
            redone = automation(client, "redo", {"trialId": trial_id})
            after_redo = editor_state(client)
        if not captured.get("wholeListTargeted") or captured["classification"]["placement"] != "blocks":
            raise AssertionError("whole-list Capture did not promote to a block target")
        if applied.get("applied"):
            if after_apply["tokenNodes"] != list(dict.fromkeys(after_apply["tokenNodes"])) or len(after_apply["tokenNodes"]) != 9:
                raise AssertionError("live Apply did not produce nine unique fixture token nodes")
            if after_apply["orderedParents"] != ["ol", "ol"] or after_apply["unorderedParents"] != ["ul", "ul"]:
                raise AssertionError("live Apply produced incorrect list parents")
            if not all(after_apply["canaryIdentity"]):
                raise AssertionError("live Apply lost an adjacent canary")
            if not undone.get("exact") or after_undo["body"] != before["body"] or after_undo["selection"] != before["selection"]:
                raise AssertionError("live Undo did not restore the independent pre-state")
            if not redone.get("exact") or after_redo["body"] != after_apply["body"] or after_redo["selection"] != after_apply["selection"]:
                raise AssertionError("live Redo did not restore the independent post-state")
        else:
            if not applied.get("rollback", {}).get("restored") or after_apply["body"] != before["body"] \
                    or after_apply["selection"] != before["selection"] or after_apply["tokenNodes"] \
                    or not all(after_apply["canaryIdentity"]):
                raise AssertionError("failed live Apply did not restore the independent pre-state")
        return { "fixture": fixture, "capture": captured, "apply": applied,
            "undo": undone, "redo": redone, "before": before, "afterApply": after_apply,
            "afterUndo": after_undo, "afterRedo": after_redo }
    finally:
        if client is not None:
            try:
                client.quit(in_app=True)
            except BaseException:
                pass
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
        shutil.rmtree(profile, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xpi", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--experiment", choices=["baseline", "exec-delete-insert", "exec-delete-outdent-insert",
        "exec-delete-toggle-ul-insert", "transaction-exec-delete-insert",
        "native-delete-insert", "transaction-native-delete-insert", "transaction-native-delete-outdent-insert",
        "transaction-native-delete-outdent-insert-delete-placeholder",
        "transaction-native-nostrip-delete-insert",
        "transaction-native-nostrip-delete-outdent-insert-delete-placeholder",
        "transaction-native-delete-toggle-ul-insert", "transaction-native-delete-remove-list-insert"])
    parser.add_argument("--matrix", action="store_true")
    parser.add_argument("--matrix-case", choices=MATRIX_CASES)
    parser.add_argument("--next-slice", action="store_true")
    parser.add_argument("--next-slice-case", choices=NEXT_SLICE_CASES)
    parser.add_argument("--underline-probe", choices=UNDERLINE_PROBES)
    parser.add_argument("--persistence-control", action="store_true")
    parser.add_argument("--persistence-case", choices=PERSISTENCE_CASES)
    parser.add_argument("--raw-mime-output", type=Path)
    parser.add_argument("--outgoing-case", choices=OUTGOING_CASES)
    parser.add_argument("--smtp-data-output", type=Path)
    parser.add_argument("--whole-list-child-matrix", action="store_true")
    parser.add_argument("--whole-list-child-case", choices=WHOLE_LIST_CHILD_CASES)
    parser.add_argument("--same-kind-handler-case", choices=SAME_KIND_HANDLER_CASES)
    parser.add_argument("--paragraph-default", choices=("paragraph", "body"))
    parser.add_argument("--expected-version")
    args = parser.parse_args()
    if sum(bool(value) for value in (args.matrix, args.next_slice, args.experiment, args.matrix_case,
            args.next_slice_case, args.underline_probe, args.persistence_control, args.persistence_case,
            args.outgoing_case, args.whole_list_child_matrix, args.whole_list_child_case,
            args.same_kind_handler_case)) > 1:
        parser.error("matrix, case, underline-probe, and experiment modes are mutually exclusive")
    result = {"wholeListChildMatrix": [run(args.xpi, expected_version=args.expected_version,
        whole_list_child_case=case,
        paragraph_default=args.paragraph_default == "paragraph" if args.paragraph_default else None)
        for case in WHOLE_LIST_CHILD_CASES]} \
        if args.whole_list_child_matrix else ({"matrix": [run(
        args.xpi, matrix_case=case, expected_version=args.expected_version)
        for case in MATRIX_CASES]} if args.matrix else ({"nextSlice": [run(
            args.xpi, expected_version=args.expected_version, next_slice_case=case)
            for case in NEXT_SLICE_CASES]} if args.next_slice else run(
                args.xpi, args.experiment, args.matrix_case, args.underline_probe,
                args.expected_version, args.next_slice_case, args.persistence_control,
                args.persistence_case, args.outgoing_case,
                args.whole_list_child_case,
                args.paragraph_default == "paragraph" if args.paragraph_default else None,
                args.same_kind_handler_case)))
    raw_mime = result.pop("_rawMime", None)
    if raw_mime is not None and args.raw_mime_output:
        args.raw_mime_output.write_bytes(raw_mime.encode("latin1"))
    smtp_data = result.pop("_smtpData", None)
    if smtp_data is not None and args.smtp_data_output:
        args.smtp_data_output.write_bytes(smtp_data)
    encoded = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        args.output.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

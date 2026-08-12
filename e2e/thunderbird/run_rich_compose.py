from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import traceback
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from marionette_driver.addons import Addons
from marionette_driver.marionette import Marionette

from run_compose import chrome, open_compose, save_screenshot, wait_for_port, wait_until


EXTENSION_ID = "thunderclaw-rich-compose-r0@example.invalid"


def popup_document(client: Marionette, action: str, value: Any = None) -> Any:
    return chrome(client, r"""
const action = arguments[0];
const value = arguments[1];
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
      if (!document.location.href.endsWith("popup.html")) continue;
      if (action === "exists") {
        if (document.querySelector("#capture")) return true;
        continue;
      }
      if (action === "click") {
        const element = document.querySelector(value);
        if (!element) continue;
        element.click();
        return true;
      }
      if (action === "disabled") {
        const element = document.querySelector(value);
        if (element) return element.disabled;
        continue;
      }
      if (action === "report") {
        const element = document.querySelector("#report");
        if (element) return element.value;
        continue;
      }
      if (action === "status") {
        const element = document.querySelector("#status");
        if (element) return element.textContent;
        continue;
      }
      if (action === "debug") {
        return {
          href: document.location.href,
          readyState: document.readyState,
          status: document.querySelector("#status")?.textContent ?? null,
          scripts: Array.from(document.scripts, script => script.src),
          captureDisabled: document.querySelector("#capture")?.disabled ?? null,
        };
      }
    } catch (_) {}
  }
}
return action === "exists" ? false : null;
""", [action, value])


def close_compose(client: Marionette) -> None:
    main_handle = None
    for handle in client.chrome_window_handles:
        client.switch_to_window(handle)
        if chrome(client, "return document.documentElement.getAttribute('windowtype');") == "mail:3pane":
            main_handle = handle
            break
    if main_handle is None:
        raise RuntimeError("Could not find the main Thunderbird window")
    compose_handle = None
    for handle in client.chrome_window_handles:
        client.switch_to_window(handle)
        if chrome(client, "return document.documentElement.getAttribute('windowtype');") == "msgcompose":
            compose_handle = handle
            break
    if compose_handle is None:
        client.switch_to_window(main_handle)
        return
    chrome(client, r"""
try { window.gMsgCompose?.editor?.resetModificationCount(); } catch (_) {}
window.close();
""")
    client.switch_to_window(main_handle)
    wait_until(
        "compose window to close",
        lambda: chrome(client, 'return Services.wm.getMostRecentWindow("msgcompose") === null;'),
        10.0,
    )


def open_additional_compose(client: Marionette) -> None:
    chrome(client, r"""
const main = Services.wm.getMostRecentWindow("mail:3pane");
main.goDoCommand("cmd_newMessage");
""")
    wait_until("compose editor", lambda: chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
return Boolean(win?.document.getElementById("messageEditor")?.contentDocument?.body);
"""), 30.0)


def setup_fixture(client: Marionette, name: str) -> dict[str, Any]:
    return chrome(client, r"""
const name = arguments[0];
const win = Services.wm.getMostRecentWindow("msgcompose");
const frame = win.document.getElementById("messageEditor");
const doc = frame.contentDocument;
const body = doc.body;
const element = (tag, text) => {
  const node = doc.createElement(tag);
  if (text !== undefined) node.append(doc.createTextNode(text));
  return node;
};
const range = doc.createRange();
let opaque = null;
if (name === "inline-direct-body" || name === "induced-rollback") {
  const target = doc.createTextNode("prefix TARGET suffix");
  body.replaceChildren(target);
  range.setStart(target, 7);
  range.setEnd(target, 13);
} else if (name === "whole-ul") {
  const before = element("p", "BEFORE_CANARY");
  const list = element("ul");
  list.setAttribute("_moz_dirty", "");
  for (const value of ["first", "second", "third"]) {
    const item = element("li", value);
    item.setAttribute("_moz_dirty", "");
    list.append(item);
  }
  const after = element("p", "AFTER_CANARY");
  body.replaceChildren(before, list, after);
  frame.contentWindow.__thunderclawR0Canaries = { before, list, after };
  frame.contentWindow.__thunderclawR0CanaryState = {
    before: before.outerHTML,
    after: after.outerHTML,
  };
  range.setStart(list.children[0].firstChild, 0);
  range.setEnd(list.children[2].firstChild, list.children[2].firstChild.data.length);
} else if (name === "opaque-adjacent" || name === "opaque-intersecting") {
  const paragraph = element("p");
  const target = doc.createTextNode("TARGET");
  opaque = element("a", "opaque link");
  opaque.setAttribute("href", "#synthetic");
  paragraph.append(target, opaque);
  body.replaceChildren(paragraph);
  range.setStart(target, 0);
  if (name === "opaque-adjacent") range.setEnd(target, target.data.length);
  else range.setEnd(opaque.firstChild, opaque.firstChild.data.length);
  frame.contentWindow.__thunderclawR0Opaque = opaque;
  frame.contentWindow.__thunderclawR0OpaqueState = opaque.outerHTML;
}
body.focus();
const selection = frame.contentWindow.getSelection();
selection.removeAllRanges();
selection.addRange(range);
return { name, selectedText: range.toString(), bodyTextLength: body.textContent.length, opaqueState: opaque?.outerHTML ?? null };
""", [name])


def opaque_state(client: Marionette) -> dict[str, Any]:
    return chrome(client, r"""
const frame = Services.wm.getMostRecentWindow("msgcompose").document.getElementById("messageEditor");
const root = frame.contentWindow.__thunderclawR0Opaque;
const paragraph = frame.contentDocument.body.firstChild;
return {
  connected: root?.isConnected === true,
  sameNode: paragraph?.lastChild?.isSameNode(root) === true,
  exact: root?.outerHTML === frame.contentWindow.__thunderclawR0OpaqueState,
};
""")


def canary_state(client: Marionette) -> dict[str, Any]:
    return chrome(client, r"""
const frame = Services.wm.getMostRecentWindow("msgcompose").document.getElementById("messageEditor");
const body = frame.contentDocument.body;
const refs = frame.contentWindow.__thunderclawR0Canaries;
const expected = frame.contentWindow.__thunderclawR0CanaryState;
return {
  beforeConnected: refs?.before?.isConnected === true,
  afterConnected: refs?.after?.isConnected === true,
  beforeSameNode: body.firstChild?.isSameNode(refs?.before) === true,
  afterSameNode: body.lastChild?.isSameNode(refs?.after) === true,
  beforeExact: refs?.before?.outerHTML === expected?.before,
  afterExact: refs?.after?.outerHTML === expected?.after,
};
""")


def open_action(client: Marionette) -> None:
    compose_found = False
    for handle in client.chrome_window_handles:
        client.switch_to_window(handle)
        if chrome(client, "return document.documentElement.getAttribute('windowtype');") == "msgcompose":
            compose_found = True
            break
    if not compose_found:
        raise RuntimeError("Could not switch Marionette to the compose window")
    chrome(client, "window.focus();")
    wait_until("focused compose window", lambda: chrome(client, "return Services.focus.activeWindow === window;"), 5.0)
    triggered = chrome(client, r"""
const id = "thunderclaw-rich-compose-r0_example_invalid-composeAction-toolbarbutton";
const button = document.getElementById(id);
if (!button) {
  throw new Error("R0 compose-action toolbar button is unavailable: " +
    Array.from(document.querySelectorAll('[id*="composeAction"]'), node => node.id).join(","));
}
button.click();
return true;
""")
    if triggered is not True:
        raise RuntimeError("Thunderbird did not trigger the R0 compose action")
    chrome(client, r"""
const win = Services.wm.getMostRecentWindow("msgcompose");
const browser = win?.document.querySelector("browser.webextension-popup-browser");
if (browser?.currentURI?.spec === "about:blank") browser.dispatchEvent(new Event("load"));
    """)
    wait_until("R0 compose-action popup", lambda: popup_document(client, "exists"), 20.0)
    def initialized() -> str | None:
        value = popup_document(client, "status")
        return value if value and value != "Ready." else None

    try:
        status = wait_until("R0 popup initialization", initialized, 20.0)
    except TimeoutError as error:
        raise TimeoutError(f"{error}; popup={popup_document(client, 'debug')!r}") from error
    if status != "initialize finished.":
        raise RuntimeError(f"R0 popup initialization failed: {status}")


def popup_operation(client: Marionette, selector: str, operation: str) -> dict[str, Any]:
    previous = popup_document(client, "report")
    previous_status = popup_document(client, "status")
    if popup_document(client, "click", selector) is not True:
        raise RuntimeError(f"Popup control {selector} was not found")

    def completed() -> dict[str, Any] | None:
        raw = popup_document(client, "report")
        if raw and raw != previous:
            report = json.loads(raw)
            if report.get("operation") == operation:
                return {"report": report}
        status = popup_document(client, "status")
        if status and status != previous_status and status != f"{operation} finished.":
            return {"error": status}
        return None

    outcome = wait_until(operation, completed, 20.0)
    if "error" in outcome:
        raise RuntimeError(f"{operation} failed in the R0 popup: {outcome['error']}")
    return outcome["report"]


def require(value: Any, message: str) -> None:
    if value is not True:
        raise AssertionError(f"{message}: {value!r}")


def run_case(client: Marionette, name: str, first: bool) -> dict[str, Any]:
    if first:
        open_compose(client)
    else:
        open_additional_compose(client)
    try:
        fixture = setup_fixture(client, name)
        open_action(client)
        captured = popup_operation(client, "#capture", "capture selection")
        classification = captured["value"]["classification"]
        evidence: dict[str, Any] = {"fixture": fixture, "capture": captured}
        if name == "opaque-intersecting":
            require(classification["eligible"] is False, "opaque intersection must be ineligible")
            require(popup_document(client, "disabled", "#inline"), "inline control must stay disabled")
            require(popup_document(client, "disabled", "#blocks"), "blocks control must stay disabled")
            evidence["opaque"] = opaque_state(client)
            require(evidence["opaque"]["sameNode"], "opaque root identity changed")
            return evidence

        expected = "blocks" if name == "whole-ul" else "inline"
        if classification["placement"] != expected:
            raise AssertionError(f"Expected {expected} capture, got {classification!r}")
        if name == "whole-ul":
            require(captured["value"]["wholeListTargeted"], "whole list was not promoted")
        if name == "induced-rollback":
            rolled_back = popup_operation(client, "#rollback", "induced rollback")
            value = rolled_back["value"]
            require(value["applied"] is False, "induced failure claimed Apply")
            require(value["rollback"]["undoReturned"], "rollback Undo command failed")
            require(value["rollback"]["restored"], "rollback was not exact")
            require(value["rollback"]["richApplyDisabled"] is False, "exact rollback disabled rich Apply")
            evidence["rollback"] = rolled_back
            return evidence

        selector = "#blocks" if expected == "blocks" else "#inline"
        operation = "apply block/list fixture" if expected == "blocks" else "apply inline fixture"
        applied = popup_operation(client, selector, operation)
        require(applied["value"]["applied"], "Apply failed")
        require(applied["value"]["postcondition"], "Apply postcondition failed")
        require(applied["value"]["adjacentOpaqueUnchanged"], "opaque adjacency changed")
        evidence["apply"] = applied
        if name == "whole-ul":
            evidence["canariesAfterApply"] = canary_state(client)
            require(all(evidence["canariesAfterApply"].values()), "whole-list canaries changed after Apply")
        if name == "opaque-adjacent":
            evidence["opaqueAfterApply"] = opaque_state(client)
            require(all(evidence["opaqueAfterApply"].values()), "opaque root changed after Apply")
        undone = popup_operation(client, "#undo", "ThunderClaw Undo")
        require(undone["value"]["commandReturned"], "native Undo returned false")
        require(undone["value"]["exact"], "Undo was not exact")
        evidence["undo"] = undone
        if name == "whole-ul":
            evidence["canariesAfterUndo"] = canary_state(client)
            require(all(evidence["canariesAfterUndo"].values()), "whole-list canaries changed after Undo")
        if name == "opaque-adjacent":
            evidence["opaqueAfterUndo"] = opaque_state(client)
            require(all(evidence["opaqueAfterUndo"].values()), "opaque root changed after Undo")
        redone = popup_operation(client, "#redo", "ThunderClaw Redo")
        require(redone["value"]["commandReturned"], "native Redo returned false")
        require(redone["value"]["exact"], "Redo was not exact")
        evidence["redo"] = redone
        if name == "whole-ul":
            evidence["canariesAfterRedo"] = canary_state(client)
            require(all(evidence["canariesAfterRedo"].values()), "whole-list canaries changed after Redo")
        if name == "opaque-adjacent":
            evidence["opaqueAfterRedo"] = opaque_state(client)
            require(all(evidence["opaqueAfterRedo"].values()), "opaque root changed after Redo")
        return evidence
    finally:
        close_compose(client)


def write_junit(artifacts: Path, results: list[dict[str, Any]]) -> None:
    failures = sum(result["status"] == "failed" for result in results)
    suite = ET.Element("testsuite", name="thunderclaw.real-thunderbird.rich-compose-r0", tests=str(len(results)), failures=str(failures))
    for result in results:
        case = ET.SubElement(suite, "testcase", classname="real-thunderbird.rich-compose-r0", name=result["case"])
        if result["status"] == "failed":
            failure = ET.SubElement(case, "failure", message=result["error"])
            failure.text = result["traceback"]
    ET.ElementTree(suite).write(artifacts / "junit.xml", encoding="utf-8", xml_declaration=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xpi", required=True, type=Path)
    parser.add_argument("--artifacts", required=True, type=Path)
    parser.add_argument("--expected-version", required=True)
    args = parser.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix="thunderclaw-rich-compose-r0-e2e-"))
    shutil.copyfile("/opt/thunderclaw-e2e/user.js", profile / "user.js")
    results: list[dict[str, Any]] = []
    log_path = args.artifacts / "thunderbird.log"
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(
            ["thunderbird", "--marionette", "-remote-allow-system-access", "-no-remote", "-profile", str(profile)],
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
        )
        client: Marionette | None = None
        try:
            wait_for_port(2828, process)
            client = Marionette(host="127.0.0.1", port=2828)
            capabilities = client.start_session()
            actual_version = chrome(client, "return Services.appinfo.version;")
            expected_app_version = args.expected_version.removesuffix("esr")
            if actual_version != expected_app_version:
                raise AssertionError(f"Expected Thunderbird {args.expected_version}, got {actual_version}")
            installed_id = Addons(client).install(str(args.xpi), temp=True)
            if installed_id != EXTENSION_ID:
                raise AssertionError(f"Installed unexpected extension ID: {installed_id!r}")
            wait_until("R0 extension startup", lambda: chrome(client, r"""
const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
return ExtensionParent.GlobalManager.extensionMap.has(arguments[0]);
""", [EXTENSION_ID]))
            xpi_sha256 = hashlib.sha256(args.xpi.read_bytes()).hexdigest()
            metadata = {
                "release": args.expected_version,
                "version": actual_version,
                "capabilities": capabilities,
                "extensionId": installed_id,
                "xpiSha256": xpi_sha256,
                "coverage": {
                    "kind": "real-compose-action-popup",
                    "network": "none",
                    "extensionProcessIsolation": False,
                    "qualification": "editor-feasibility-r0",
                },
            }
            (args.artifacts / "metadata.json").write_text(json.dumps(metadata, indent=2, sort_keys=True), encoding="utf-8")
            default_cases = "whole-ul inline-direct-body induced-rollback opaque-adjacent opaque-intersecting"
            raw_cases = os.environ.get("THUNDERCLAW_R0_E2E_CASES")
            if raw_cases is not None and not raw_cases.strip():
                raise ValueError("THUNDERCLAW_R0_E2E_CASES must not be empty")
            case_names = (raw_cases or default_cases).split()
            for index, name in enumerate(case_names):
                case_dir = args.artifacts / name
                case_dir.mkdir(parents=True, exist_ok=True)
                try:
                    result = {"case": name, "status": "passed", "evidence": run_case(client, name, index == 0)}
                except BaseException as error:
                    save_screenshot(client, case_dir / "failure.png")
                    result = {"case": name, "status": "failed", "error": str(error), "traceback": traceback.format_exc()}
                    try:
                        close_compose(client)
                    except BaseException:
                        pass
                (case_dir / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
                results.append(result)
        finally:
            if client is not None:
                try:
                    client.quit(in_app=True)
                except BaseException:
                    pass
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            shutil.rmtree(profile, ignore_errors=True)
    write_junit(args.artifacts, results)
    (args.artifacts / "summary.json").write_text(json.dumps(results, indent=2, sort_keys=True), encoding="utf-8")
    failures = [result for result in results if result["status"] == "failed"]
    print(json.dumps({"status": "failed" if failures else "passed", "tests": len(results), "failures": len(failures)}))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

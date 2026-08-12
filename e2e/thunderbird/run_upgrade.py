from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
import traceback
from pathlib import Path

from marionette_driver.addons import Addons
from marionette_driver.marionette import Marionette

import run_compose as harness
from stub_backend import LEGACY_TOKEN, start_stub


def launch(profile: Path, log) -> tuple[subprocess.Popen[str], Marionette]:
    process = subprocess.Popen([
        "thunderbird", "--marionette", "-remote-allow-system-access", "-no-remote", "-profile", str(profile)
    ], stdout=log, stderr=subprocess.STDOUT, text=True)
    harness.wait_for_port(2828, process)
    client = Marionette(host="127.0.0.1", port=2828)
    client.start_session()
    return process, client


def stop(process: subprocess.Popen[str], client: Marionette | None) -> None:
    if client:
        try:
            client.quit(in_app=True)
        except Exception:
            pass
        try:
            process.wait(10)
            return
        except subprocess.TimeoutExpired:
            pass
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(10)
        except subprocess.TimeoutExpired:
            process.kill()


def legacy_configure(client: Marionette, port: int) -> dict:
    url = harness.open_options(client)
    harness.wait_until("legacy options document", lambda: harness.chrome(client, harness.FIND_EXTENSION_DOCUMENT, ["options.html"]))
    configured = harness.chrome(client, r"""
const [endpointValue, tokenValue] = arguments;
for (const win of Services.wm.getEnumerator(null)) {
  for (const browser of win.document.querySelectorAll("browser")) {
    try {
      const doc = browser.contentDocument;
      if (!doc?.location.href.endsWith("options.html") || !doc.querySelector("#token")) continue;
      const endpoint = doc.querySelector("#endpoint"); const token = doc.querySelector("#token");
      endpoint.value = endpointValue; token.value = tokenValue;
      endpoint.dispatchEvent(new Event("input", { bubbles: true }));
      token.dispatchEvent(new Event("input", { bubbles: true }));
      doc.querySelector("#authorize").click(); return true;
    } catch (_) {}
  }
}
return false;
""", [f"http://127.0.0.1:{port}/thunderclaw/v1", LEGACY_TOKEN])
    if configured is not True:
        raise RuntimeError(f"could not configure legacy extension at {url}")
    prompt = harness.accept_permission_prompt(client)
    harness.wait_until("legacy authorization", lambda: harness.extension_document(
        client, "options.html", "text", "#state") == "Authorized — not yet tested")
    if harness.extension_document(client, "options.html", "click", "#diagnose") is not True:
        raise RuntimeError("legacy Diagnose was unavailable")
    harness.wait_until("legacy ready state", lambda: harness.extension_document(
        client, "options.html", "text", "#state") == "Connected — status and agents tested")
    return {"optionsUrl": url, "permissionPrompt": prompt}


def current_state(client: Marionette) -> str:
    return str(harness.extension_document(client, "options.html", "text", "#state"))


def run(args: argparse.Namespace) -> dict:
    profile = Path(tempfile.mkdtemp(prefix="thunderclaw-upgrade-"))
    shutil.copyfile("/opt/thunderclaw-e2e/user.js", profile / "user.js")
    server, state, thread = start_stub()
    log = (args.artifacts / "thunderbird.log").open("w", encoding="utf-8")
    process: subprocess.Popen[str] | None = None
    client: Marionette | None = None
    try:
        process, client = launch(profile, log)
        if Addons(client).install(str(args.baseline), temp=False) != harness.EXTENSION_ID:
            raise AssertionError("unexpected baseline extension ID")
        legacy = legacy_configure(client, server.server_port)
        harness.extension_document(client, "options.html", "close", None)
        if Addons(client).install(str(args.candidate), temp=False) != harness.EXTENSION_ID:
            raise AssertionError("unexpected candidate extension ID")
        harness.wait_until("candidate version", lambda: harness.chrome(client, r"""
const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
return ExtensionParent.GlobalManager.extensionMap.get(arguments[0])?.manifest?.version === "0.1.0";
""", [harness.EXTENSION_ID]), 30)
        harness.open_options(client)
        harness.wait_until("candidate options document", lambda: harness.chrome(
            client, harness.FIND_EXTENSION_DOCUMENT, ["options.html"]))
        harness.wait_until("candidate startup", lambda: current_state(client) == "Not connected", 30)
        paired = harness.configure_connection(
            client,
            server.server_port,
            initial_states=("Not connected",),
            open_new_options=False,
        )

        stop(process, client)
        process, client = launch(profile, log)
        harness.wait_until("persisted candidate startup", lambda: harness.chrome(client, r"""
const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
return ExtensionParent.GlobalManager.extensionMap.has(arguments[0]);
""", [harness.EXTENSION_ID]))
        harness.open_options(client)
        harness.wait_until("persisted options", lambda: harness.chrome(client, harness.FIND_EXTENSION_DOCUMENT, ["options.html"]))
        harness.wait_until("persisted paired credential", lambda: current_state(client) == "Authorized — not yet tested")
        if harness.extension_document(client, "options.html", "click", "#diagnose") is not True:
            raise RuntimeError("post-restart Diagnose was unavailable")
        harness.wait_until("post-restart ready state", lambda: current_state(client) == "Connected — status and agents tested")
        if harness.extension_document(client, "options.html", "click", "#rotate") is not True:
            raise RuntimeError("Rotate was unavailable")
        harness.wait_until("completed credential rotation", lambda: harness.extension_document(
            client, "options.html", "text", "#result"
        ) == "The device credential was rotated. The replaced credential is no longer retained.")
        if harness.extension_document(client, "options.html", "click", "#disconnect") is not True:
            raise RuntimeError("Disconnect was unavailable")
        harness.wait_until("disconnected state", lambda: current_state(client) == "Not connected")
        repaired = harness.configure_connection(
            client,
            server.server_port,
            initial_states=("Not connected",),
            open_new_options=False,
        )
        if harness.extension_document(client, "options.html", "click", "#forget") is not True:
            raise RuntimeError("Forget was unavailable")
        harness.wait_until("forgotten state", lambda: current_state(client) == "Not configured")
        paths = [entry["path"] for entry in state.requests]
        required = ["/thunderclaw/pairing/v1/requests", "/thunderclaw/pairing/v1/claim",
                    "/thunderclaw/pairing/v1/rotate", "/thunderclaw/pairing/v1/revoke"]
        if any(path not in paths for path in required):
            raise AssertionError("upgrade lifecycle did not exercise every paired route")
        return {"status": "passed", "legacy": legacy, "migrationState": "Not connected",
                "paired": paired, "restart": True, "rotation": True, "disconnect": True,
                "repaired": repaired, "forget": True, "pairedRoutes": required}
    finally:
        if process is not None:
            stop(process, client)
        server.shutdown(); server.server_close(); thread.join(timeout=5)
        log.close(); shutil.rmtree(profile, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path, required=True)
    args = parser.parse_args(); args.artifacts.mkdir(parents=True, exist_ok=True)
    try:
        result = run(args)
    except Exception as error:
        result = {"status": "failed", "error": str(error), "traceback": traceback.format_exc()}
    (args.artifacts / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"status": result["status"], "artifacts": str(args.artifacts)}))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

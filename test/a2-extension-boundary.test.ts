import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { transform } from "esbuild";

const extensionRoot = new URL("../packages/thunderbird-extension/src/", import.meta.url);

test("credential custody is confined to the background controller and never uses sync or broad storage reads", async () => {
  const files = [
    "background-entry.ts", "compose-script-registration.ts", "inference-connection-controller.ts", "credential-store.ts", "inference-client.ts", "inference-provider.ts", "options-entry.ts",
    "compose.js", "message-display.js", "popup.js", "message-popup.js",
  ];
  const sources = new Map(await Promise.all(files.map(async (file) => [file, await readFile(new URL(file, extensionRoot), "utf8")] as const)));
  for (const [file, source] of sources) {
    assert.doesNotMatch(source, /storage\.sync/u, file);
    assert.doesNotMatch(source, /storage\.local\.get\(\s*(?:null|undefined)?\s*\)/u, file);
    assert.doesNotMatch(source, /console\.(?:log|warn|error|debug)/u, file);
  }
  for (const [file, source] of sources) {
    if (file === "inference-connection-controller.ts") continue;
    assert.doesNotMatch(source, /thunderclaw\.developmentNarrowCredential\.v1/u, file);
  }
  const controller = sources.get("inference-connection-controller.ts")!;
  assert.match(controller, /storage\.local\.get\(\[INFERENCE_SETTINGS_KEY, MIGRATION_KEY, \.\.\.LEGACY_KEYS\]\)/u);
  assert.match(controller, /storage\.local\.remove\(LEGACY_KEYS\)/u);
  assert.match(sources.get("credential-store.ts")!, /value\.provider === scope\.provider && value\.apiBase === scope\.apiBase/u);
  assert.doesNotMatch(controller, /URLSearchParams|searchParams/u, "credentials must not enter URLs");
});

test("the options-only controller is not reachable from compose, message-display, or ordinary popup scripts", async () => {
  const backgroundEntry = await readFile(new URL("background-entry.ts", extensionRoot), "utf8");
  assert.match(backgroundEntry, /installInferenceConnectionController\(\)/u);
  for (const file of ["compose.js", "message-display.js", "popup.js", "message-popup.js"]) {
    const source = await readFile(new URL(file, extensionRoot), "utf8");
    assert.doesNotMatch(source, /thunderclaw-(?:inference-)?options-v1|developmentNarrowCredential|connectionSettings|credential-store|indexedDB/u, file);
  }
});

test("background startup fails closed until the Thunderbird 128-compatible compose script is registered", async () => {
  const backgroundEntry = await readFile(new URL("background-entry.ts", extensionRoot), "utf8");
  const registration = await readFile(new URL("compose-script-registration.ts", extensionRoot), "utf8");
  assert.match(backgroundEntry, /createComposeScriptRegistrar\(browser\.composeScripts\)/u);
  assert.ok(backgroundEntry.indexOf("installInferenceConnectionController()") < backgroundEntry.indexOf("ensureComposeScriptRegistered()"));
  assert.match(backgroundEntry, /\.then\([\s\S]*installFeatureBackground\(controller\)[\s\S]*\(\) => undefined/u);
  assert.match(registration, /api\.register\(COMPOSE_SCRIPT_OPTIONS\)/u);
  assert.match(registration, /file: "compose\.js"/u);
});

test("settings ports are installed immediately while compose features wait for registration", async () => {
  const source = await readFile(new URL("background-entry.ts", extensionRoot), "utf8");
  const compiled = await transform(source, { loader: "ts", format: "cjs" });
  for (const succeeds of [true, false]) {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const registration = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const controller = {};
    const calls: string[] = [];
    const modules: Record<string, unknown> = {
      "./inference-connection-controller.js": { installInferenceConnectionController() { calls.push("settings"); return controller; } },
      "./compose-script-registration.js": { createComposeScriptRegistrar() { return () => registration; } },
      "./background-coordinator.js": { installFeatureBackground(value: unknown) { assert.equal(value, controller); calls.push("features"); } },
    };
    vm.runInNewContext(compiled.code, { browser: { composeScripts: {} }, require: (name: string) => modules[name] });
    assert.deepEqual(calls, ["settings"], "settings must accept connections while registration is pending");
    if (succeeds) resolve(); else reject(new Error("synthetic registration failure"));
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(calls, succeeds ? ["settings", "features"] : ["settings"]);
  }
});

test("settings diagnostics and public errors remain fixed-shape and omit backend detail", async () => {
  const controller = await readFile(new URL("inference-connection-controller.ts", extensionRoot), "utf8");
  assert.match(controller, /await [\w.]+\.testConnection/u);
  assert.doesNotMatch(controller, /error\.message/u);
  assert.match(controller, /return \{ kind, message: messages\[kind\] \?\?/u);
});

test("model setup uses explicit synthetic testing, exact options messages, and text-only rendering", async () => {
  const [controller, entry, html] = await Promise.all([
    readFile(new URL("inference-connection-controller.ts", extensionRoot), "utf8"),
    readFile(new URL("options-entry.ts", extensionRoot), "utf8"),
    readFile(new URL("options.html", extensionRoot), "utf8"),
  ]);
  assert.match(controller, /\["state", "save", "listModels", "test", "forget"\]\.includes/u);
  assert.match(controller, /Object\.keys\(input\)\.some\(\(key\) => !allowed\.includes\(key\)\)/u);
  assert.match(entry, /request\("test"\)/u);
  assert.match(entry, /request\("listModels",/u);
  assert.match(html, /Testing sends synthetic text, never your email/u);
  assert.match(html, /Hosted providers may charge for the test/u);
  assert.doesNotMatch(entry, /innerHTML|insertAdjacentHTML|outerHTML/u);
});

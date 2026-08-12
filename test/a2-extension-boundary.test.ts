import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const extensionRoot = new URL("../packages/thunderbird-extension/src/", import.meta.url);

test("credential custody is confined to the background controller and never uses sync or broad storage reads", async () => {
  const files = [
    "background-entry.ts", "compose-script-registration.ts", "connection-controller.ts", "direct-client.ts", "endpoint-policy.ts", "options-entry.ts",
    "compose.js", "message-display.js", "popup.js", "message-popup.js",
  ];
  const sources = new Map(await Promise.all(files.map(async (file) => [file, await readFile(new URL(file, extensionRoot), "utf8")] as const)));
  for (const [file, source] of sources) {
    assert.doesNotMatch(source, /storage\.sync/u, file);
    assert.doesNotMatch(source, /storage\.local\.get\(\s*(?:null|undefined)?\s*\)/u, file);
    assert.doesNotMatch(source, /console\.(?:log|warn|error|debug)/u, file);
  }
  for (const [file, source] of sources) {
    if (file === "connection-controller.ts") continue;
    assert.doesNotMatch(source, /thunderclaw\.developmentNarrowCredential\.v1/u, file);
  }
  const controller = sources.get("connection-controller.ts")!;
  assert.match(controller, /browser\.storage\.local\.get\(DEVICE_CREDENTIAL_KEY\)/u);
  assert.match(controller, /browser\.storage\.local\.remove\(LEGACY_DEVELOPMENT_CREDENTIAL_KEY\)/u);
  assert.doesNotMatch(controller, /URLSearchParams|searchParams/u, "credentials must not enter URLs");
});

test("the options-only controller is not reachable from compose, message-display, or ordinary popup scripts", async () => {
  const backgroundEntry = await readFile(new URL("background-entry.ts", extensionRoot), "utf8");
  assert.match(backgroundEntry, /installOptionsConnectionController\(\)/u);
  for (const file of ["compose.js", "message-display.js", "popup.js", "message-popup.js"]) {
    const source = await readFile(new URL(file, extensionRoot), "utf8");
    assert.doesNotMatch(source, /thunderclaw-options-v1|developmentNarrowCredential|connectionSettings/u, file);
  }
});

test("background startup fails closed until the Thunderbird 128-compatible compose script is registered", async () => {
  const backgroundEntry = await readFile(new URL("background-entry.ts", extensionRoot), "utf8");
  const registration = await readFile(new URL("compose-script-registration.ts", extensionRoot), "utf8");
  assert.match(backgroundEntry, /createComposeScriptRegistrar\(browser\.composeScripts\)/u);
  assert.ok(backgroundEntry.indexOf("ensureComposeScriptRegistered()") < backgroundEntry.indexOf("installOptionsConnectionController()"));
  assert.match(backgroundEntry, /\.then\([\s\S]*installOptionsConnectionController\(\)[\s\S]*installFeatureBackground\(controller\)[\s\S]*\(\) => undefined/u);
  assert.match(registration, /api\.register\(COMPOSE_SCRIPT_OPTIONS\)/u);
  assert.match(registration, /file: "compose\.js"/u);
});

test("settings diagnostics and public errors remain fixed-shape and omit backend detail", async () => {
  const controller = await readFile(new URL("connection-controller.ts", extensionRoot), "utf8");
  assert.match(controller, /const status = await client\.status/u);
  assert.match(controller, /const agents = await client\.listAgents/u);
  assert.ok(controller.indexOf("const status = await client.status") < controller.indexOf("const agents = await client.listAgents"));
  assert.doesNotMatch(controller, /error\.message/u);
  assert.match(controller, /return \{ kind, message: messages\[kind\] \?\? messages\.backend \}/u);
});

test("agent verification UI uses deliberate fixed copy, exact options messages, and text-only rendering", async () => {
  const [controller, entry, html] = await Promise.all([
    readFile(new URL("connection-controller.ts", extensionRoot), "utf8"),
    readFile(new URL("options-entry.ts", extensionRoot), "utf8"),
    readFile(new URL("options.html", extensionRoot), "utf8"),
  ]);
  assert.match(controller, /record\.method === "verifyAgent" \|\| record\.method === "cancelAgentVerification"/u);
  assert.match(controller, /new Set\(\["requestId", "method", "agentId", "probeRunId"\]\)/u);
  assert.match(entry, /request\("verifyAgent", \{ agentId, probeRunId \}\)/u);
  assert.match(entry, /request\("cancelAgentVerification", \{ agentId, probeRunId \}\)/u);
  assert.match(html, /up to two synthetic model calls/u);
  assert.match(html, /may incur provider charges/u);
  assert.match(entry, /Cancel verification/u);
  assert.doesNotMatch(entry, /innerHTML|insertAdjacentHTML|outerHTML/u);
});

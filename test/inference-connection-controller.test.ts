import test from "node:test";
import assert from "node:assert/strict";
import { InferenceConnectionController, INFERENCE_SETTINGS_KEY, INFERENCE_OPTIONS_PORT_NAME, installInferenceConnectionController, inferencePublicError } from "../packages/thunderbird-extension/src/inference-connection-controller.js";
import { validateInferenceConfiguration, type InferenceConfiguration } from "../packages/thunderbird-extension/src/inference-provider.js";
import type { InferenceCredentialStore } from "../packages/thunderbird-extension/src/credential-store.js";
import { inferenceFailureMessage, INFERENCE_FAILURE_MESSAGES } from "../packages/thunderbird-extension/src/inference-client.js";
import { DirectClientError } from "../packages/thunderbird-extension/src/direct-client-contract.js";

const configuration: InferenceConfiguration = { provider: "custom", apiBase: "https://inference.example/v1", model: "synthetic-model", outputMode: "json_schema", writingStyle: "Concise." };
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function harness(initial: Record<string, unknown> = {}) {
  const storage: Record<string, any> = structuredClone(initial);
  const keys = new Map<string, string>();
  const scopes = new Map<string, { provider: string; apiBase: string }>();
  const grants = new Set(["https://inference.example/*", "https://other.example/*"]);
  const removed: string[] = [];
  const removedListeners: Array<() => void> = [];
  const addedListeners: Array<() => void> = [];
  const connectListeners: Array<(port: any) => void> = [];
  const calls: Array<{ configuration: InferenceConfiguration; key: string }> = [];
  let networkCalls = 0;
  let testBarrier: Promise<void> | null = null;
  const api = {
    storage: { local: {
      async get(names: string[]) { return Object.fromEntries(names.filter((name) => Object.hasOwn(storage, name)).map((name) => [name, structuredClone(storage[name])])); },
      async set(values: Record<string, unknown>) { Object.assign(storage, structuredClone(values)); },
      async remove(names: string | string[]) { for (const name of Array.isArray(names) ? names : [names]) delete storage[name]; },
    } },
    permissions: {
      async contains(value: { origins: string[] }) { return value.origins.every((origin) => grants.has(origin)); },
      async remove(value: { origins: string[] }) { for (const origin of value.origins) { removed.push(origin); grants.delete(origin); } return true; },
      onRemoved: { addListener(listener: () => void) { removedListeners.push(listener); } },
      onAdded: { addListener(listener: () => void) { addedListeners.push(listener); } },
    },
    runtime: { id: "thunderclaw@addons.thunderbird.net", getURL: (path: string) => `moz-extension://synthetic/${path}`, onConnect: { addListener(listener: (port: any) => void) { connectListeners.push(listener); } } },
  };
  const credentials: InferenceCredentialStore = {
    async get(id, scope) { const saved = scopes.get(id); return saved?.provider === scope.provider && saved?.apiBase === scope.apiBase ? keys.get(id) ?? null : null; }, async put(id, key, scope) { keys.set(id, key); scopes.set(id, { provider: scope.provider, apiBase: scope.apiBase }); }, async delete(id) { keys.delete(id); },
    async retainOnly(id) { for (const current of keys.keys()) if (current !== id) keys.delete(current); },
  };
  const options = { credentialStore: credentials, createClient(config: InferenceConfiguration, key: string, binding: any, clientOptions: any): any {
    calls.push({ configuration: config, key });
    return { binding, async listModels() { networkCalls += 1; assert.equal(await clientOptions.permissionCheck(), true); return ["synthetic-model", "another-model"]; },
      async testConnection({ signal }: { signal: AbortSignal }) { networkCalls += 1; assert.equal(await clientOptions.permissionCheck(), true); if (testBarrier) await testBarrier; if (signal.aborted) throw new Error("synthetic private response"); },
    };
  } };
  return { api, options, storage, keys, grants, removed, removedListeners, addedListeners, connectListeners, calls, get networkCalls() { return networkCalls; }, setTestBarrier(value: Promise<void>) { testBarrier = value; } };
}

test("remembered key persists across controller restart, public state never returns it, startup never calls endpoint", async () => {
  const h = harness(); const first = new InferenceConnectionController(h.api, h.options);
  await first.save(configuration, "replace", "synthetic-api-key");
  assert.equal(h.networkCalls, 0);
  await assert.rejects(first.acquireFeatureLease());
  assert.equal((await first.testConnection()).phase, "ready");
  const lease = await first.acquireFeatureLease();
  const second = new InferenceConnectionController(h.api, h.options);
  const state = await second.getState();
  assert.equal(state.hasKey, true); assert.equal(state.phase, "ready");
  assert.equal(h.networkCalls, 1, "restart never performs remote discovery or inference");
  assert.equal(JSON.stringify(state).includes("synthetic-api-key"), false);
  assert.equal(JSON.stringify(h.storage).includes("synthetic-api-key"), false);
  assert.notEqual((await second.acquireFeatureLease()).binding.epoch, lease.binding.epoch);
  assert.equal(h.calls.at(-1)?.key, "synthetic-api-key");
});

test("preserve binds keys to exact canonical API base and provider, including port and path", async () => {
  for (const changed of [ { ...configuration, apiBase: "https://inference.example/v2" }, { ...configuration, apiBase: "https://inference.example:8443/v1" }, { ...configuration, provider: "openai" as const } ]) {
    const h = harness(); const controller = new InferenceConnectionController(h.api, h.options);
    await controller.save(configuration, "replace", "synthetic-key");
    await controller.save({ ...configuration, model: "changed-model", writingStyle: "Friendly." }, "preserve");
    assert.equal((await controller.getState()).hasKey, true);
    await controller.save(changed, "preserve");
    assert.equal((await controller.getState()).hasKey, false); assert.equal(h.keys.size, 0);
  }
});

test("key replacement/removal and style/model/output changes retire old leases and invalidate tests", async () => {
  const h = harness(); const controller = new InferenceConnectionController(h.api, h.options);
  await controller.save(configuration, "replace", "synthetic-key"); await controller.testConnection();
  const lease = await controller.acquireFeatureLease(); let retired = 0;
  controller.addFeatureRetirementHandler((old) => { assert.equal(old, lease); retired += 1; });
  const save = controller.save({ ...configuration, writingStyle: "Updated style" }, "replace", "replacement-key");
  assert.equal(controller.isFeatureBindingCurrent(lease.binding), false, "invalidation happens before awaiting storage");
  await save; assert.equal(retired, 1); assert.equal((await controller.getState()).phase, "untested");
  assert.deepEqual([...h.keys.values()], ["replacement-key"]);
  await controller.save(configuration, "remove"); assert.equal((await controller.getState()).hasKey, false); assert.equal(h.keys.size, 0);
});

test("DeepSeek thinking persists across restart, preserves the endpoint key and requires retesting after changes", async () => {
  const h = harness(); const controller = new InferenceConnectionController(h.api, h.options);
  const config = { ...configuration, provider: "deepseek" as const, outputMode: "json_object" as const, reasoningEffort: "high" as const };
  await controller.save(config, "replace", "synthetic-key"); await controller.testConnection();
  assert.equal(h.calls.at(-1)?.configuration.reasoningEffort, "high");
  const lease = await controller.acquireFeatureLease();
  const revision = h.storage[INFERENCE_SETTINGS_KEY].revision;
  const state = await controller.save({ ...config, reasoningEffort: "none", maxResponseTokens: 32_768 }, "preserve");
  assert.equal(controller.isFeatureBindingCurrent(lease.binding), false);
  assert.equal(state.testedAt, null); assert.equal(state.phase, "untested"); assert.equal(state.hasKey, true);
  assert.notEqual(h.storage[INFERENCE_SETTINGS_KEY].revision, revision);
  await assert.rejects(controller.acquireFeatureLease());
  const restarted = new InferenceConnectionController(h.api, h.options);
  assert.equal((await restarted.getState()).configuration?.reasoningEffort, "none");
  await restarted.testConnection(); assert.equal(h.calls.at(-1)?.configuration.reasoningEffort, "none");
  assert.equal(h.calls.at(-1)?.key, "synthetic-key");
  assert.equal((await new InferenceConnectionController(h.api, h.options).getState()).phase, "ready");
});

test("old DeepSeek settings without thinking migrate to off and discard only the outdated test receipt", async () => {
  const h = harness(); const controller = new InferenceConnectionController(h.api, h.options);
  await controller.save({ ...configuration, provider: "deepseek", outputMode: "json_object" }, "replace", "synthetic-key");
  await controller.testConnection();
  delete h.storage[INFERENCE_SETTINGS_KEY].configuration.reasoningEffort;
  delete h.storage[INFERENCE_SETTINGS_KEY].configuration.maxResponseTokens;
  const restarted = new InferenceConnectionController(h.api, h.options);
  const state = await restarted.getState();
  assert.equal(state.configuration?.reasoningEffort, "none"); assert.equal(state.hasKey, true);
  assert.equal(state.phase, "untested"); assert.equal(state.testedAt, null);
  assert.equal(h.networkCalls, 1, "migration does not contact the endpoint");
  await restarted.testConnection(); assert.equal(h.calls.at(-1)?.key, "synthetic-key");
});

test("an in-flight test cannot authorize changed settings or restore a removed key", async () => {
  const h = harness(); const controller = new InferenceConnectionController(h.api, h.options);
  await controller.save(configuration, "replace", "synthetic-key");
  const barrier = deferred(); h.setTestBarrier(barrier.promise);
  const checking = controller.testConnection();
  while (!h.networkCalls) await new Promise((resolve) => setImmediate(resolve));
  const rejected = assert.rejects(checking);
  await controller.save({ ...configuration, model: "replacement-model" }, "remove"); barrier.resolve(); await rejected;
  const state = await controller.getState(); assert.equal(state.phase, "untested"); assert.equal(state.testedAt, null); assert.equal(state.hasKey, false);
});

test("permission removal fences a lease immediately and permission regain does not resurrect test receipt", async () => {
  const h = harness(); const controller = new InferenceConnectionController(h.api, h.options);
  await controller.save(configuration, "preserve"); await controller.testConnection();
  const lease = await controller.acquireFeatureLease(); h.grants.delete("https://inference.example/*");
  for (const listener of h.removedListeners) listener();
  assert.equal(controller.isFeatureBindingCurrent(lease.binding), false);
  assert.equal((await controller.getState()).phase, "permission_required");
  h.grants.add("https://inference.example/*"); for (const listener of h.addedListeners) listener();
  assert.equal((await controller.getState()).phase, "untested"); await assert.rejects(controller.acquireFeatureLease());
});

test("legacy migration deletes paired/pending/rotation/recovery secrets, preserves preferences and unrelated permissions, never contacts old gateway", async () => {
  const old = "https://old.example/thunderclaw/v1";
  const h = harness({
    "thunderclaw.connectionSettings.v1": { apiBase: old, rawCredential: "legacy-secret" },
    "thunderclaw.deviceCredential.v1": { apiBase: old, rawCredential: "legacy-device-secret" },
    "thunderclaw.pendingPairing.v1": { apiBase: old, claimCredential: "legacy-claim-secret" },
    "thunderclaw.pendingRotation.v1": { apiBase: old, current: { apiBase: old, rawCredential: "legacy-rotation-secret" } },
    "thunderclaw.remoteCredentialRecovery.v1": { apiBase: old, candidates: [{ rawCredential: "legacy-recovery-secret" }] },
    messageTargetLanguage: "de", "unrelated.preference": true,
  });
  h.grants.add("https://old.example/*");
  const state = await new InferenceConnectionController(h.api, h.options).getState();
  assert.equal(state.phase, "not_configured"); assert.equal(state.legacyMigration, true); assert.equal(h.networkCalls, 0);
  assert.equal(JSON.stringify(h.storage).includes("secret"), false); assert.equal(h.storage.messageTargetLanguage, "de"); assert.equal(h.storage["unrelated.preference"], true);
  assert.deepEqual(h.removed, ["https://old.example/*"]); assert.equal(h.grants.has("https://other.example/*"), true);
  await new InferenceConnectionController(h.api, h.options).getState(); assert.equal(h.removed.length, 1, "migration is idempotent");
});

test("migration retries failed cleanup after restart and rejects corrupted broad legacy permission patterns", async () => {
  const h = harness({ "thunderclaw.pendingPairing.v1": { apiBase: "https://old.example/thunderclaw/v1", permissionPattern: "<all_urls>" }, "thunderclaw.pendingPermissionCleanup.v1": ["<all_urls>", "https://*.example/*"] });
  h.grants.add("https://old.example/*");
  const remove = h.api.permissions.remove;
  h.api.permissions.remove = async () => { throw new Error("synthetic denied"); };
  const first = await new InferenceConnectionController(h.api, h.options).getState();
  assert.equal(first.permissionCleanupPending, true); assert.equal(h.storage["thunderclaw.pendingPairing.v1"], undefined);
  h.api.permissions.remove = remove;
  const second = await new InferenceConnectionController(h.api, h.options).getState();
  assert.equal(second.permissionCleanupPending, false); assert.deepEqual(h.removed, ["https://old.example/*"]);
});

test("forget removes only connection key/settings and selected endpoint permission", async () => {
  const h = harness({ messageTargetLanguage: "fr" }); const controller = new InferenceConnectionController(h.api, h.options);
  await controller.save(configuration, "replace", "synthetic-key"); await controller.testConnection();
  const state = await controller.forget(); assert.equal(state.phase, "not_configured"); assert.equal(h.keys.size, 0); assert.equal(h.storage[INFERENCE_SETTINGS_KEY], undefined);
  assert.equal(h.storage.messageTargetLanguage, "fr"); assert.deepEqual(h.removed, ["https://inference.example/*"]); assert.equal(h.networkCalls, 1);
});

test("options IPC trusts only exact extension-owned options document, including its real extension tab", async () => {
  const h = harness(); installInferenceConnectionController(h.api, h.options);
  for (const sender of [undefined, { id: h.api.runtime.id, url: h.api.runtime.getURL("popup.html") }, { id: "other-extension", url: h.api.runtime.getURL("options.html") }, { id: h.api.runtime.id, url: `${h.api.runtime.getURL("options.html")}#forged` }]) {
    let disconnected = false; h.connectListeners[0]({ name: INFERENCE_OPTIONS_PORT_NAME, sender, disconnect() { disconnected = true; } }); assert.equal(disconnected, true);
  }
  const listeners: Array<(message: unknown) => void> = []; const replies: any[] = []; let disconnected = false;
  h.connectListeners[0]({ name: INFERENCE_OPTIONS_PORT_NAME, sender: { id: h.api.runtime.id, url: h.api.runtime.getURL("options.html"), tab: { id: 7 } }, disconnect() { disconnected = true; }, postMessage(value: unknown) { replies.push(value); }, onMessage: { addListener(listener: (message: unknown) => void) { listeners.push(listener); } }, onDisconnect: { addListener() {} } });
  listeners[0]({ requestId: "synthetic-id", method: "state" });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(replies[0].ok, true); assert.equal(JSON.stringify(replies).includes("apiKey"), false);
  listeners[0]({ requestId: "synthetic-id-2", method: "getKey" }); assert.equal(disconnected, true);
});

test("public error messages never forward provider/storage details", () => {
  const output = inferencePublicError(new Error("synthetic-key email@example.test private provider response"));
  assert.equal(output.message.includes("synthetic-key"), false); assert.equal(output.message.includes("email@"), false);
});

test("options distinguish response limits without forwarding provider error text", () => {
  assert.deepEqual(inferencePublicError(new DirectClientError("contract", "INFERENCE_OUTPUT_LIMIT", "synthetic-key private provider output")), {
    kind: "contract", code: "INFERENCE_OUTPUT_LIMIT", message: inferenceFailureMessage("INFERENCE_OUTPUT_LIMIT"),
  });
  assert.equal(inferencePublicError(new DirectClientError("contract", "UNKNOWN_PROVIDER_CODE", "synthetic-key private provider output")).message,
    "The model returned an unsupported result. Check its structured output support.");
  assert.equal(inferencePublicError(new DirectClientError("contract", "UNKNOWN_PROVIDER_CODE", "synthetic-key private provider output")).code, undefined);
});


test("tampered public settings cannot redirect a remembered key to another API base", async () => {
  const h = harness(); const first = new InferenceConnectionController(h.api, h.options);
  await first.save(configuration, "replace", "synthetic-remembered-key"); await first.testConnection();
  h.storage[INFERENCE_SETTINGS_KEY].configuration.apiBase = "https://other.example/v1";
  h.storage[INFERENCE_SETTINGS_KEY].permissionPattern = "https://other.example/*";
  const second = new InferenceConnectionController(h.api, h.options);
  assert.equal((await second.getState()).hasKey, false);
  await second.acquireFeatureLease();
  assert.equal(h.calls.at(-1)?.key, "");
});


test("discovery works before model selection without saving a configuration, key, or test receipt", async () => {
  const h = harness(); const controller = new InferenceConnectionController(h.api, h.options);
  const ids = await controller.listModels({ ...configuration, model: "" }, "synthetic-discovery-key");
  assert.deepEqual(ids, ["synthetic-model", "another-model"]);
  assert.equal(h.calls.at(-1)?.key, "synthetic-discovery-key");
  assert.equal(h.calls.at(-1)?.configuration.model, "thunderclaw-model-discovery");
  assert.equal(h.storage[INFERENCE_SETTINGS_KEY], undefined); assert.equal(h.keys.size, 0);
  assert.equal((await controller.getState()).phase, "not_configured");
});

test("draft discovery uses a saved key only for its exact provider and endpoint scope", async () => {
  const h = harness(); const controller = new InferenceConnectionController(h.api, h.options);
  await controller.save(configuration, "replace", "synthetic-scoped-key"); await controller.testConnection();
  const saved = structuredClone(h.storage[INFERENCE_SETTINGS_KEY]);
  await controller.listModels({ ...configuration, model: "" }); assert.equal(h.calls.at(-1)?.key, "synthetic-scoped-key");
  await controller.listModels({ ...configuration, apiBase: "https://other.example/v1", model: "" }); assert.equal(h.calls.at(-1)?.key, "");
  await assert.rejects(controller.listModels({ ...configuration, provider: "openai", model: "" }));
  assert.deepEqual(h.storage[INFERENCE_SETTINGS_KEY], saved, "discovery never changes the saved connection or test");
  assert.deepEqual([...h.keys.values()], ["synthetic-scoped-key"]);
});

test("old token budgets and thinking settings migrate once, preserve key scope, and persist canonical controls", async () => {
  for (const provider of ["custom", "deepseek"] as const) {
    for (const legacy of ["missing", "enabled", "disabled"] as const) {
      const h = harness(); const first = new InferenceConnectionController(h.api, h.options);
      await first.save({ ...configuration, provider, outputMode: "json_object" }, "replace", "synthetic-key");
      await first.testConnection();
      const before = structuredClone(h.storage[INFERENCE_SETTINGS_KEY]);
      const old = h.storage[INFERENCE_SETTINGS_KEY].configuration;
      delete old.maxResponseTokens; delete old.reasoningEffort;
      if (legacy !== "missing") old.thinking = legacy;
      const migrated = new InferenceConnectionController(h.api, h.options);
      const state = await migrated.getState();
      assert.equal(state.phase, "untested"); assert.equal(state.testedAt, null); assert.equal(state.hasKey, true);
      assert.equal(state.configuration?.maxResponseTokens, 16_384);
      assert.equal(state.configuration?.reasoningEffort, provider === "deepseek" ? legacy === "enabled" ? "high" : "none" : "default");
      const saved = h.storage[INFERENCE_SETTINGS_KEY];
      assert.equal(saved.credentialId, before.credentialId); assert.equal(saved.revision, before.revision);
      assert.equal(saved.permissionPattern, before.permissionPattern); assert.equal(Object.hasOwn(saved.configuration, "thinking"), false);
      assert.deepEqual(saved.configuration, validateInferenceConfiguration(saved.configuration));
      await assert.rejects(migrated.acquireFeatureLease());
      await migrated.testConnection(); assert.equal(h.calls.at(-1)?.key, "synthetic-key");
      const restarted = new InferenceConnectionController(h.api, h.options);
      assert.equal((await restarted.getState()).phase, "ready");
      assert.equal(h.networkCalls, 2, "neither migration nor restart contacts a provider");
    }
  }
});

test("changing response-token limits retires the tested lease and preserves the endpoint-bound key", async () => {
  const h = harness(); const controller = new InferenceConnectionController(h.api, h.options);
  await controller.save(configuration, "replace", "synthetic-key"); await controller.testConnection();
  const lease = await controller.acquireFeatureLease();
  const state = await controller.save({ ...configuration, maxResponseTokens: 24_576 }, "preserve");
  assert.equal(controller.isFeatureBindingCurrent(lease.binding), false);
  assert.equal(state.phase, "untested"); assert.equal(state.hasKey, true); assert.equal(state.configuration?.maxResponseTokens, 24_576);
  await assert.rejects(controller.acquireFeatureLease());
  await controller.testConnection(); assert.equal(h.calls.at(-1)?.key, "synthetic-key");
  assert.equal(h.calls.at(-1)?.configuration.maxResponseTokens, 24_576);
});

test("each reviewed inference failure exposes only its fixed code and message", () => {
  for (const [code, message] of Object.entries(INFERENCE_FAILURE_MESSAGES)) {
    assert.deepEqual(inferencePublicError(new DirectClientError("contract", code, "PRIVATE_PROVIDER_TEXT")), { kind: "contract", code, message });
  }
  for (const code of ["__proto__", "constructor", "INFERENCE_OUTPUT_LIMIT PRIVATE_PROVIDER_TEXT"]) {
    const output = inferencePublicError(new DirectClientError("contract", code, "PRIVATE_PROVIDER_TEXT"));
    assert.equal(output.code, undefined); assert.doesNotMatch(output.message, /PRIVATE_PROVIDER_TEXT/u);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { DirectClientError } from "../packages/thunderbird-extension/src/direct-client-contract.js";
import { BrowserThunderClawDirectClient } from "../packages/thunderbird-extension/src/direct-client.js";
import { ConnectionController, installOptionsConnectionController, OPTIONS_PORT_NAME } from "../packages/thunderbird-extension/src/connection-controller.js";

const SETTINGS_KEY = "thunderclaw.connectionSettings.v1";
const LEGACY_CREDENTIAL_KEY = "thunderclaw.developmentNarrowCredential.v1";
const IDENTITY_KEY = "thunderclaw.deviceIdentity.v1";
const CREDENTIAL_KEY = "thunderclaw.deviceCredential.v1";
const PENDING_PAIRING_KEY = "thunderclaw.pendingPairing.v1";
const PENDING_ROTATION_KEY = "thunderclaw.pendingRotation.v1";
const REMOTE_RECOVERY_KEY = "thunderclaw.remoteCredentialRecovery.v1";
const CREDENTIAL_LIFECYCLE_KEY = "thunderclaw.credentialLifecycle.v1";
const EPOCH_KEY = "thunderclaw.connectionEpoch.v1";
const PENDING_CLEANUP_KEY = "thunderclaw.pendingPermissionCleanup.v1";
const FEATURE_RETIREMENT_KEY = "thunderclaw.featureRetirement.v1";
const apiBase = "https://gateway.example:8443/thunderclaw/v1";
const origin = "https://gateway.example:8443";
const permissionPattern = "https://gateway.example/*";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, deny) => { resolve = accept; reject = deny; });
  return { promise, resolve, reject };
}

function storedConnection(epoch = 4, secret = "private-narrow-token") {
  const credentialId = "credential_123456789012345678";
  const rawCredential = `${credentialId}.${secret}${"x".repeat(Math.max(0, 43 - secret.length))}`;
  return {
    [SETTINGS_KEY]: { version: 1, apiBase, origin, permissionPattern, credentialId, connected: true, epoch },
    [IDENTITY_KEY]: { version: 1, deviceId: "device_123456789012345678901", deviceName: "Thunderbird on test" },
    [CREDENTIAL_KEY]: { version: 1, mode: "device_credential", apiBase, origin, credentialId,
      deviceId: "device_123456789012345678901", deviceName: "Thunderbird on test", rawCredential,
      expiresAt: "2099-01-01T00:00:00.000Z" },
    [EPOCH_KEY]: epoch,
  };
}

type BrowserHarness = ReturnType<typeof browserHarness>;

function browserHarness(initial: Record<string, unknown> = {}, granted: string[] = [permissionPattern], enumeratePermissions = false) {
  const data: Record<string, unknown> = structuredClone(initial);
  const grantedOrigins = new Set(granted);
  const containsAnswers: Array<boolean | Promise<boolean>> = [];
  const removeAnswers: Array<boolean | Promise<boolean> | Error> = [];
  const removedListeners: Array<(removed: { origins?: unknown }) => void> = [];
  const addedListeners: Array<(added: { origins?: unknown }) => void> = [];
  const connectListeners: Array<(port: MockPort) => void> = [];
  const storageGets: unknown[] = [];
  const storageSets: Record<string, unknown>[] = [];
  const storageRemoves: unknown[] = [];
  const permissionRemoves: unknown[] = [];
  const permissionContains: unknown[] = [];
  const browser = {
    storage: {
      local: {
        async get(keys: string | string[]) {
          storageGets.push(keys);
          const selected = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(selected.filter((key) => Object.hasOwn(data, key)).map((key) => [key, structuredClone(data[key])]));
        },
        async set(values: Record<string, unknown>) {
          storageSets.push(structuredClone(values));
          Object.assign(data, structuredClone(values));
        },
        async remove(keys: string | string[]) {
          storageRemoves.push(keys);
          for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
        },
      },
    },
    permissions: {
      async contains({ origins }: { origins: string[] }) {
        permissionContains.push({ origins: structuredClone(origins) });
        const answer = containsAnswers.shift();
        return answer === undefined ? origins.every((value) => grantedOrigins.has(value)) : await answer;
      },
      async remove(permission: unknown) {
        permissionRemoves.push(structuredClone(permission));
        const answer = removeAnswers.shift();
        if (answer instanceof Error) throw answer;
        const removed = answer === undefined ? true : await answer;
        if (removed) for (const value of (permission as { origins: string[] }).origins) grantedOrigins.delete(value);
        return removed;
      },
      ...(enumeratePermissions ? { async getAll() { return { origins: [...grantedOrigins] }; } } : {}),
      onRemoved: { addListener(listener: (removed: { origins?: unknown }) => void) { removedListeners.push(listener); } },
      onAdded: { addListener(listener: (added: { origins?: unknown }) => void) { addedListeners.push(listener); } },
    },
    runtime: {
      id: "thunderclaw@addons.thunderbird.net",
      getURL: (path: string) => `moz-extension://unit-test/${path}`,
      onConnect: { addListener(listener: (port: MockPort) => void) { connectListeners.push(listener); } },
    },
  };
  return {
    browser, data, grantedOrigins, containsAnswers, removeAnswers, storageGets, storageSets, storageRemoves,
    permissionRemoves, permissionContains,
    emitRemoved(origins: unknown) { for (const listener of removedListeners) listener({ origins }); },
    emitAdded(origins: unknown) { for (const listener of addedListeners) listener({ origins }); },
    connect(port: MockPort) { for (const listener of connectListeners) listener(port); },
  };
}

type MockPort = ReturnType<typeof mockPort>;

function mockPort(overrides: Partial<{ name: string; sender: Record<string, unknown> }> = {}) {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  return {
    name: overrides.name ?? OPTIONS_PORT_NAME,
    sender: overrides.sender ?? { id: "thunderclaw@addons.thunderbird.net", url: "moz-extension://unit-test/options.html" },
    disconnected: 0,
    posted: [] as unknown[],
    disconnect() { this.disconnected += 1; },
    postMessage(value: unknown) { this.posted.push(value); },
    onMessage: { addListener(listener: (message: unknown) => void) { messageListeners.push(listener); } },
    onDisconnect: { addListener(listener: () => void) { disconnectListeners.push(listener); } },
    emit(value: unknown) { for (const listener of messageListeners) listener(value); },
    emitDisconnect() { for (const listener of disconnectListeners) listener(); },
  };
}

function installBrowser(harness: BrowserHarness): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "browser");
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "browser", { configurable: true, value: harness.browser });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = { protocolVersion: 1, revoked: true };
    let status = 200;
    if (url.endsWith("/requests")) {
      const request = JSON.parse(String(init?.body)) as { requestId: string };
      body = { protocolVersion: 1, requestId: request.requestId, approvalCode: "ABCDE-23456",
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
      status = 201;
    }
    const response = new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    Object.defineProperty(response, "url", { configurable: true, value: url });
    return response;
  } });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, "browser", descriptor);
    else Reflect.deleteProperty(globalThis, "browser");
    if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor);
    else Reflect.deleteProperty(globalThis, "fetch");
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

test("hydration preserves a bound connection without exposing or broadly reading its secret", async () => {
  const secret = "private-narrow-token";
  const harness = browserHarness(storedConnection(4, secret));
  const restore = installBrowser(harness);
  try {
    const controller = new ConnectionController();
    const state = await controller.getState();
    assert.deepEqual(state, {
      phase: "authorized_untested",
      configured: true,
      apiBase,
      origin,
      permissionPattern,
      permissionGranted: true,
      connected: false,
      credentialExpiresAt: "2099-01-01T00:00:00.000Z",
      epoch: 4,
    });
    assert.equal(JSON.stringify(state).includes(secret), false);
    assert.deepEqual(harness.storageGets[0], [
      SETTINGS_KEY, IDENTITY_KEY, CREDENTIAL_KEY, PENDING_PAIRING_KEY, PENDING_ROTATION_KEY,
      REMOTE_RECOVERY_KEY, CREDENTIAL_LIFECYCLE_KEY, LEGACY_CREDENTIAL_KEY, EPOCH_KEY, PENDING_CLEANUP_KEY, FEATURE_RETIREMENT_KEY,
    ]);
    assert.equal((harness.storageGets as unknown[]).includes(null), false);
  } finally { restore(); }
});

test("feature retirement fences reacquisition before bounded old-client cleanup", async () => {
  const harness = browserHarness(storedConnection());
  const restore = installBrowser(harness);
  try {
    const controller = new ConnectionController();
    const lease = await controller.acquireFeatureLease();
    const cleanup = deferred<void>();
    let retired = false;
    controller.addFeatureRetirementHandler(async (captured) => {
      retired = true;
      assert.equal(captured.client, lease.client);
      await cleanup.promise;
    });
    const disconnecting = controller.disconnect();
    const synchronouslyFenced = !controller.isFeatureBindingCurrent(lease.binding);
    await settle();
    assert.equal(retired, true);
    assert.equal(controller.isFeatureBindingCurrent(lease.binding), false);
    await assert.rejects(controller.acquireFeatureLease(), (error: unknown) => error instanceof DirectClientError && error.code === "CONNECTION_RETIRING");
    assert.deepEqual(harness.data[FEATURE_RETIREMENT_KEY], { version: 1, epoch: 4 });
    cleanup.resolve();
    await disconnecting;
    assert.equal(Object.hasOwn(harness.data, FEATURE_RETIREMENT_KEY), false);
    assert.equal(synchronouslyFenced, true, "disconnect must synchronously fence UI effects before its first await");
  } finally { restore(); }
});

test("retirement intent cannot be superseded by reverse-order Diagnose or Authorize calls", async () => {
  for (const action of ["disconnect", "forget"] as const) {
    const harness = browserHarness(storedConnection());
    const restore = installBrowser(harness);
    try {
      const controller = new ConnectionController();
      const lease = await controller.acquireFeatureLease();
      const cleanup = deferred<void>();
      controller.addFeatureRetirementHandler(() => cleanup.promise);
      const retiring = controller[action]();
      assert.equal(controller.isFeatureBindingCurrent(lease.binding), false);
      await assert.rejects(controller.diagnose(), (error: unknown) => error instanceof DirectClientError && error.code === "CONNECTION_RETIRING");
      await assert.rejects(controller.beginPair(null), (error: unknown) => error instanceof DirectClientError && ["CONNECTION_RETIRING", "CREDENTIAL_ACTION_ACTIVE"].includes(error.code));
      await assert.rejects(controller.beginPair(apiBase), (error: unknown) => error instanceof DirectClientError && ["CONNECTION_RETIRING", "CREDENTIAL_ACTION_ACTIVE"].includes(error.code));
      await assert.rejects(controller.acquireFeatureLease(), (error: unknown) => error instanceof DirectClientError && error.code === "CONNECTION_RETIRING");
      assert.equal(controller.isFeatureBindingCurrent(lease.binding), false);
      cleanup.resolve();
      await retiring;
      assert.equal(controller.isFeatureBindingCurrent(lease.binding), false);
    } finally { restore(); }
  }
});

test("permission-event retirement remains fenced against reverse-order connection actions", async () => {
  const harness = browserHarness(storedConnection());
  const restore = installBrowser(harness);
  try {
    const controller = new ConnectionController();
    const lease = await controller.acquireFeatureLease();
    const cleanup = deferred<void>();
    controller.addFeatureRetirementHandler(() => cleanup.promise);
    harness.grantedOrigins.delete(permissionPattern);
    harness.emitRemoved([permissionPattern]);
    assert.equal(controller.isFeatureBindingCurrent(lease.binding), false);
    await assert.rejects(controller.diagnose(), (error: unknown) => error instanceof DirectClientError && error.code === "CONNECTION_RETIRING");
    await assert.rejects(controller.beginPair(apiBase), (error: unknown) => error instanceof DirectClientError && error.code === "CONNECTION_RETIRING");
    cleanup.resolve();
    for (let index = 0; index < 5; index += 1) await settle();
    assert.equal((await controller.getState()).phase, "disconnect_ambiguous");
    assert.equal(controller.isFeatureBindingCurrent(lease.binding), false);
  } finally { restore(); }
});

test("permission-preflight retirement cannot be superseded after revocation is observed", async () => {
  const harness = browserHarness(storedConnection());
  const restore = installBrowser(harness);
  try {
    const controller = new ConnectionController();
    const lease = await controller.acquireFeatureLease();
    const observedRevocation = deferred<boolean>();
    const cleanup = deferred<void>();
    controller.addFeatureRetirementHandler(() => cleanup.promise);
    harness.containsAnswers.push(observedRevocation.promise, false);
    const checking = controller.getState();
    observedRevocation.resolve(false);
    await settle();
    assert.equal(controller.isFeatureBindingCurrent(lease.binding), false);
    await assert.rejects(controller.diagnose(), (error: unknown) => error instanceof DirectClientError && error.code === "CONNECTION_RETIRING");
    await assert.rejects(controller.beginPair(apiBase), (error: unknown) => error instanceof DirectClientError && error.code === "CONNECTION_RETIRING");
    cleanup.resolve();
    assert.equal((await checking).phase, "disconnect_ambiguous");
    assert.equal(controller.isFeatureBindingCurrent(lease.binding), false);
  } finally { restore(); }
});

test("disconnect and forget retirement fences survive a later permission-removal event", async () => {
  for (const retirement of ["disconnect", "forget"] as const) {
    const harness = browserHarness(storedConnection());
    const restore = installBrowser(harness);
    try {
      const controller = new ConnectionController();
      const lease = await controller.acquireFeatureLease();
      const cleanup = deferred<void>();
      let cleanupStarted = false;
      controller.addFeatureRetirementHandler(async () => {
        cleanupStarted = true;
        await cleanup.promise;
      });

      const retiring = controller[retirement]();
      await settle();
      assert.equal(cleanupStarted, true);
      harness.grantedOrigins.delete(permissionPattern);
      harness.emitRemoved([permissionPattern]);
      await settle();

      assert.equal(controller.isFeatureBindingCurrent(lease.binding), false);
      await assert.rejects(controller.acquireFeatureLease(), (error: unknown) =>
        error instanceof DirectClientError && error.code === "CONNECTION_RETIRING",
      "the permission event cannot clear the active retirement fence");

      cleanup.resolve();
      const state = await retiring;
      assert.equal(state.phase, retirement === "forget" ? "not_configured" : "disconnected");
      assert.equal(controller.isFeatureBindingCurrent(lease.binding), false);
      await settle();
    } finally { restore(); }
  }
});

test("a diagnostic completing in reverse order while retirement is blocked cannot surface or reopen the old lease", async () => {
  const harness = browserHarness(storedConnection());
  const restore = installBrowser(harness);
  const originalStatus = BrowserThunderClawDirectClient.prototype.status;
  const originalAgents = BrowserThunderClawDirectClient.prototype.listAgents;
  const status = deferred<any>();
  const cleanup = deferred<void>();
  let agentCalls = 0;
  try {
    BrowserThunderClawDirectClient.prototype.status = async () => status.promise;
    BrowserThunderClawDirectClient.prototype.listAgents = async () => {
      agentCalls += 1;
      throw new Error("a retired diagnostic must not continue");
    };
    const controller = new ConnectionController();
    const lease = await controller.acquireFeatureLease();
    controller.addFeatureRetirementHandler(async () => cleanup.promise);
    const diagnostic = controller.diagnose();
    await settle();
    const disconnecting = controller.disconnect();
    await settle();

    status.resolve({
      binding: lease.binding,
      value: { protocolVersion: 1, plugin: "thunderclaw", gatewayVersion: "stale-success", capabilities: {} },
    });
    await assert.rejects(diagnostic, (error: unknown) => error instanceof DirectClientError && error.code === "STALE_CONNECTION");
    assert.equal(agentCalls, 0);
    assert.equal(controller.isFeatureBindingCurrent(lease.binding), false);
    await assert.rejects(controller.acquireFeatureLease(), (error: unknown) =>
      error instanceof DirectClientError && error.code === "CONNECTION_RETIRING");

    cleanup.resolve();
    await disconnecting;
    assert.equal((await controller.getState()).phase, "disconnected");
  } finally {
    BrowserThunderClawDirectClient.prototype.status = originalStatus;
    BrowserThunderClawDirectClient.prototype.listAgents = originalAgents;
    restore();
  }
});

test("overlapping disconnect and forget are serialized by the credential-action fence", async () => {
  const harness = browserHarness(storedConnection());
  const firstRemoval = deferred<boolean>();
  const secondRemoval = deferred<boolean>();
  harness.removeAnswers.push(firstRemoval.promise, secondRemoval.promise);
  const restore = installBrowser(harness);
  try {
    const controller = new ConnectionController();
    const lease = await controller.acquireFeatureLease();
    const cleanup = deferred<void>();
    controller.addFeatureRetirementHandler(async () => cleanup.promise);

    const disconnecting = controller.disconnect();
    await settle();
    await assert.rejects(controller.forget(), (error: unknown) => error instanceof DirectClientError && error.code === "CREDENTIAL_ACTION_ACTIVE");
    cleanup.resolve();
    await settle();
    firstRemoval.resolve(true);
    await disconnecting;
    assert.equal(harness.permissionRemoves.length, 1);
    assert.equal(controller.isFeatureBindingCurrent(lease.binding), false);
    await assert.rejects(controller.acquireFeatureLease(), (error: unknown) =>
      error instanceof DirectClientError && error.code === "CONNECTION_UNAVAILABLE");

    secondRemoval.resolve(true);
    assert.equal(controller.isFeatureBindingCurrent(lease.binding), false);
  } finally { restore(); }
});

test("a durable retirement marker recovers fail-closed after a background crash", async () => {
  const initial = {
    ...storedConnection(13, "crash-canary-secret"),
    [FEATURE_RETIREMENT_KEY]: { version: 1, epoch: 13 },
  };
  const harness = browserHarness(initial, [permissionPattern], true);
  const restore = installBrowser(harness);
  try {
    const controller = new ConnectionController();
    const state = await controller.getState();
    assert.equal(state.phase, "disconnect_ambiguous");
    assert.equal(state.epoch, 14);
    assert.equal(state.permissionGranted, true, "the exact recovery-bound permission remains available for revocation retry");
    assert.equal(Object.hasOwn(harness.data, CREDENTIAL_KEY), false);
    assert.equal(Object.hasOwn(harness.data, FEATURE_RETIREMENT_KEY), false);
    assert.equal(harness.grantedOrigins.has(permissionPattern), true);
    assert.deepEqual(harness.permissionRemoves, []);
    await assert.rejects(controller.acquireFeatureLease(), (error: unknown) =>
      error instanceof DirectClientError && error.code === "CONNECTION_UNAVAILABLE");
    assert.equal(JSON.stringify(await controller.getState()).includes("crash-canary-secret"), false);
  } finally { restore(); }
});

test("corrupt settings and mismatched credentials are cleaned without resetting the monotonic epoch", async () => {
  for (const [initial, expectedEpoch] of [
    [{ [SETTINGS_KEY]: { version: 99 }, [CREDENTIAL_KEY]: { token: "secret" }, [EPOCH_KEY]: 12 }, 12],
    [{ ...storedConnection(7), [CREDENTIAL_KEY]: { ...storedConnection(7)[CREDENTIAL_KEY], credentialId: "wrong" } }, 8],
  ] as const) {
    const harness = browserHarness(initial as Record<string, unknown>);
    const restore = installBrowser(harness);
    try {
      const state = await new ConnectionController().getState();
      assert.equal(state.connected, false);
      assert.equal(state.epoch, expectedEpoch);
      assert.equal(Object.hasOwn(harness.data, CREDENTIAL_KEY), false);
      if (expectedEpoch === 12) assert.equal(state.configured, false);
      else {
        assert.equal(state.configured, true);
        assert.equal((harness.data[SETTINGS_KEY] as { credentialId: unknown }).credentialId, null);
      }
      assert.equal(harness.data[EPOCH_KEY], expectedEpoch);
    } finally { restore(); }
  }
});

test("authorization rechecks permission after storage and fails closed if the grant races away", async () => {
  const harness = browserHarness({}, []);
  harness.containsAnswers.push(true, false);
  const restore = installBrowser(harness);
  try {
    const controller = new ConnectionController();
    await assert.rejects(controller.beginPair(apiBase), (error: unknown) => error instanceof DirectClientError && error.code === "HOST_PERMISSION_REMOVED");
    const state = await controller.getState();
    assert.equal(state.connected, false);
    assert.equal(state.permissionGranted, false);
    assert.equal(state.epoch, 0);
    assert.equal(Object.hasOwn(harness.data, CREDENTIAL_KEY), false);
  } finally { restore(); }
});

test("a failed pairing request removes and verifies an unowned hostname grant", async () => {
  const failedApiBase = "https://failed.example/thunderclaw/v1";
  const failedPermission = "https://failed.example/*";
  const harness = browserHarness({}, [failedPermission]);
  const restore = installBrowser(harness);
  try {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => { throw new Error("offline"); } });
    const controller = new ConnectionController();
    await assert.rejects(controller.beginPair(failedApiBase), (error: unknown) => error instanceof DirectClientError && error.kind === "network");
    assert.deepEqual(harness.permissionRemoves, [{ origins: [failedPermission] }]);
    assert.equal(harness.permissionContains.some((value) => JSON.stringify(value) === JSON.stringify({ origins: [failedPermission] })), true);
    assert.equal(harness.grantedOrigins.has(failedPermission), false);
  } finally { restore(); }
});

test("permission revocation event and per-call preflight both invalidate credentials and advance epochs", async () => {
  const originalStatus = BrowserThunderClawDirectClient.prototype.status;
  const originalAgents = BrowserThunderClawDirectClient.prototype.listAgents;
  try {
    BrowserThunderClawDirectClient.prototype.status = async function () {
      return { binding: this.binding, value: { protocolVersion: 1, plugin: "thunderclaw", gatewayVersion: "v", capabilities: {} } };
    };
    BrowserThunderClawDirectClient.prototype.listAgents = async function (requestId) {
      return { binding: this.binding, value: { protocolVersion: 1, requestId, agents: [] } };
    };
    for (const viaEvent of [true, false]) {
      const harness = browserHarness(storedConnection());
      const restore = installBrowser(harness);
      try {
        const controller = new ConnectionController();
        assert.deepEqual(await controller.getState(), {
          phase: "authorized_untested", configured: true, apiBase, origin, permissionPattern,
          permissionGranted: true, connected: false, credentialExpiresAt: "2099-01-01T00:00:00.000Z", epoch: 4,
        });
        await controller.diagnose();
        assert.equal((await controller.getState()).phase, "ready");
        assert.equal((await controller.getState()).connected, true);
        harness.grantedOrigins.delete(permissionPattern);
        if (viaEvent) {
          harness.emitRemoved([permissionPattern]);
          await settle();
        }
        const state = await controller.getState();
        assert.equal(state.phase, "disconnect_ambiguous");
        assert.equal(state.connected, false);
        assert.equal(state.permissionGranted, false);
        assert.equal(state.epoch, 5);
        assert.equal(Object.hasOwn(harness.data, CREDENTIAL_KEY), false);
      } finally { restore(); }
    }
  } finally {
    BrowserThunderClawDirectClient.prototype.status = originalStatus;
    BrowserThunderClawDirectClient.prototype.listAgents = originalAgents;
  }
});

test("diagnostics call status before agents and return only bounded sanitized fields", async () => {
  const harness = browserHarness(storedConnection());
  const restore = installBrowser(harness);
  const originalStatus = BrowserThunderClawDirectClient.prototype.status;
  const originalAgents = BrowserThunderClawDirectClient.prototype.listAgents;
  const calls: string[] = [];
  try {
    BrowserThunderClawDirectClient.prototype.status = async function () {
      calls.push("status");
      return { binding: this.binding, value: { protocolVersion: 1, plugin: "thunderclaw", gatewayVersion: "bad\nvalue", capabilities: { secret: "must-not-leak" } } };
    };
    BrowserThunderClawDirectClient.prototype.listAgents = async function () {
      calls.push("agents");
      return { binding: this.binding, value: { protocolVersion: 1, requestId: "request", agents: [{
        agentId: "agent-a", displayName: "Agent A", isDefault: true, provider: "x".repeat(257), model: "model-a",
        reasoning: { defaultLevel: null, levels: [] },
        compatibility: {
          state: "verified", executionMode: "restricted-agent", usesPersonality: true, usesMemory: true, toolsDisabled: true,
          checks: { configuration: "passed", credentials: "passed", structuredOutput: "passed", toolIsolation: "passed", cancellation: "passed", fallbacks: "not_applicable" },
          lastProbe: null, reason: "private detail",
        },
      }] } };
    };
    const controller = new ConnectionController();
    const value = await controller.diagnose();
    assert.deepEqual(calls, ["status", "agents"]);
    assert.deepEqual(value, {
      status: { protocolVersion: 1, plugin: "thunderclaw", gatewayVersion: null },
      agents: [{
        agentId: "agent-a", displayName: "Agent A", isDefault: true, provider: null, model: "model-a",
        compatibility: {
          state: "verified", executionMode: "restricted-agent", usesPersonality: true, usesMemory: true, toolsDisabled: true,
          checks: { configuration: "passed", credentials: "passed", structuredOutput: "passed", toolIsolation: "passed", cancellation: "passed", fallbacks: "not_applicable" },
          lastProbe: null, reason: "This agent passed the ThunderClaw compatibility checks.",
        },
      }],
    });
    assert.equal(JSON.stringify(value).includes("must-not-leak"), false);
    assert.equal(JSON.stringify(value).includes("private detail"), false);
    assert.equal((await controller.getState()).phase, "ready");
    assert.equal((await controller.getState()).connected, true);

    const restarted = new ConnectionController();
    assert.equal((await restarted.getState()).phase, "authorized_untested");
    assert.equal((await restarted.getState()).connected, false, "diagnostic readiness is not persisted across restart");

    const invalidated = await controller.disconnect();
    assert.equal(invalidated.phase, "disconnected");
    assert.equal(invalidated.connected, false);
  } finally {
    BrowserThunderClawDirectClient.prototype.status = originalStatus;
    BrowserThunderClawDirectClient.prototype.listAgents = originalAgents;
    restore();
  }
});

test("a stale diagnostic completion cannot proceed to agents after disconnect", async () => {
  const harness = browserHarness(storedConnection());
  const restore = installBrowser(harness);
  const originalStatus = BrowserThunderClawDirectClient.prototype.status;
  const originalAgents = BrowserThunderClawDirectClient.prototype.listAgents;
  const status = deferred<any>();
  let agentCalls = 0;
  try {
    BrowserThunderClawDirectClient.prototype.status = async () => status.promise;
    BrowserThunderClawDirectClient.prototype.listAgents = async () => { agentCalls += 1; throw new Error("stale agents call"); };
    const controller = new ConnectionController();
    const running = controller.diagnose();
    await settle();
    await controller.disconnect();
    status.resolve({ binding: { apiBase, origin, permissionId: permissionPattern, epoch: 4, credential: { mode: "device_credential", credentialId: "credential_123456789012345678" } }, value: { protocolVersion: 1, plugin: "thunderclaw", gatewayVersion: "v", capabilities: {} } });
    await assert.rejects(running, (error: unknown) => error instanceof DirectClientError && error.code === "STALE_CONNECTION");
    assert.equal(agentCalls, 0);
  } finally {
    BrowserThunderClawDirectClient.prototype.status = originalStatus;
    BrowserThunderClawDirectClient.prototype.listAgents = originalAgents;
    restore();
  }
});

test("agent verification is exact, refreshes authoritative sanitized evidence, and uses explicit cancellation", async () => {
  const harness = browserHarness(storedConnection());
  const restore = installBrowser(harness);
  const originalAgents = BrowserThunderClawDirectClient.prototype.listAgents;
  const originalProbe = BrowserThunderClawDirectClient.prototype.probeAgent;
  const originalCancel = BrowserThunderClawDirectClient.prototype.cancelAgentProbe;
  const compatibility = {
    state: "verified" as const, executionMode: "restricted-agent" as const, usesPersonality: true as const,
    usesMemory: true as const, toolsDisabled: true as const,
    checks: { configuration: "passed" as const, credentials: "passed" as const, structuredOutput: "passed" as const, toolIsolation: "passed" as const, cancellation: "passed" as const, fallbacks: "not_run" as const },
    lastProbe: { testedAt: "2026-08-08T18:00:00.000Z", observedProvider: "provider", observedModel: "model" },
    reason: "private provider detail must not cross the options port",
  };
  const agent = { agentId: "agent-a", displayName: "Agent A", isDefault: true, provider: "provider", model: "model", reasoning: { defaultLevel: null, levels: [] }, compatibility };
  const calls: unknown[] = [];
  try {
    BrowserThunderClawDirectClient.prototype.listAgents = async function (requestId) {
      calls.push(["list", requestId]);
      return { binding: this.binding, value: { protocolVersion: 1, requestId, agents: [agent] } };
    };
    BrowserThunderClawDirectClient.prototype.probeAgent = async function (request) {
      calls.push(["probe", structuredClone(request)]);
      return { binding: this.binding, value: { protocolVersion: 1, requestId: request.requestId, probeRunId: request.probeRunId, agent } };
    };
    const controller = new ConnectionController();
    const result = await controller.verifyAgent("agent-a", "probe-a") as any;
    assert.deepEqual(calls.map((call: any) => call[0]), ["list", "probe", "list"]);
    assert.equal(result.agent.compatibility.reason, "This agent passed the ThunderClaw compatibility checks.");
    assert.equal(JSON.stringify(result).includes("private provider detail"), false);
    assert.deepEqual(result.agent.compatibility.checks, compatibility.checks);
    assert.equal(result.agent.compatibility.lastProbe.testedAt, "2026-08-08T18:00:00.000Z");

    BrowserThunderClawDirectClient.prototype.probeAgent = function (request, options) {
      calls.push(["probe-pending", structuredClone(request)]);
      return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new DirectClientError("cancellation", "CALL_ABORTED", "aborted")), { once: true }));
    };
    BrowserThunderClawDirectClient.prototype.cancelAgentProbe = async function (request) {
      calls.push(["cancel", structuredClone(request)]);
      return { binding: this.binding, value: { ...request, cancelled: true as const } };
    };
    const running = controller.verifyAgent("agent-a", "probe-b");
    await settle();
    const cancelled = await controller.cancelAgentVerification("agent-a", "probe-b");
    assert.equal(cancelled.agentId, "agent-a");
    assert.equal(cancelled.probeRunId, "probe-b");
    assert.equal(cancelled.cancelled, true);
    assert.equal(Array.isArray(cancelled.agents), true);
    const cancel = calls.find((call: any) => call[0] === "cancel") as any;
    assert.equal(cancel[1].agentId, "agent-a");
    assert.equal(cancel[1].probeRunId, "probe-b");
    assert.notEqual(cancel[1].requestId, "probe-b");
    await assert.rejects(running, (error: unknown) => error instanceof DirectClientError && error.kind === "cancellation");
  } finally {
    BrowserThunderClawDirectClient.prototype.listAgents = originalAgents;
    BrowserThunderClawDirectClient.prototype.probeAgent = originalProbe;
    BrowserThunderClawDirectClient.prototype.cancelAgentProbe = originalCancel;
    restore();
  }
});

test("closing the owning options port during verification preflight prevents the probe from starting", async () => {
  const harness = browserHarness(storedConnection());
  const restore = installBrowser(harness);
  const originalAgents = BrowserThunderClawDirectClient.prototype.listAgents;
  const originalProbe = BrowserThunderClawDirectClient.prototype.probeAgent;
  const preflight = deferred<any>();
  let probeCalls = 0;
  const owner = {};
  try {
    BrowserThunderClawDirectClient.prototype.listAgents = async () => preflight.promise;
    BrowserThunderClawDirectClient.prototype.probeAgent = async () => {
      probeCalls += 1;
      throw new Error("a closed options owner must not start model-calling verification");
    };
    const controller = new ConnectionController();
    const binding = (await controller.acquireFeatureLease()).binding;
    const running = controller.verifyAgent("agent-a", "probe-preflight-close", owner);
    await settle();
    controller.cancelLocalAgentVerifications(owner);
    preflight.resolve({
      binding,
      value: {
        protocolVersion: 1,
        requestId: "preflight-list",
        agents: [{
          agentId: "agent-a", displayName: "Agent A", isDefault: true, provider: "provider", model: "model",
          reasoning: { defaultLevel: null, levels: [] },
          compatibility: {
            state: "unverified", executionMode: "restricted-agent", usesPersonality: true, usesMemory: true, toolsDisabled: true,
            checks: { configuration: "passed", credentials: "not_run", structuredOutput: "not_run", toolIsolation: "not_run", cancellation: "not_run", fallbacks: "not_run" },
            lastProbe: null, reason: "Run verification.",
          },
        }],
      },
    });
    await assert.rejects(running, (error: unknown) =>
      error instanceof DirectClientError && (error.kind === "cancellation" || error.code === "STALE_AGENT_VERIFICATION"),
    );
    assert.equal(probeCalls, 0);
  } finally {
    BrowserThunderClawDirectClient.prototype.listAgents = originalAgents;
    BrowserThunderClawDirectClient.prototype.probeAgent = originalProbe;
    restore();
  }
});

test("connection retirement during verification preflight prevents the probe from starting", async () => {
  const harness = browserHarness(storedConnection());
  const restore = installBrowser(harness);
  const originalAgents = BrowserThunderClawDirectClient.prototype.listAgents;
  const originalProbe = BrowserThunderClawDirectClient.prototype.probeAgent;
  const preflight = deferred<any>();
  let probeCalls = 0;
  try {
    BrowserThunderClawDirectClient.prototype.listAgents = async () => preflight.promise;
    BrowserThunderClawDirectClient.prototype.probeAgent = async () => {
      probeCalls += 1;
      throw new Error("a retired connection must not start model-calling verification");
    };
    const controller = new ConnectionController();
    const binding = (await controller.acquireFeatureLease()).binding;
    const running = controller.verifyAgent("agent-a", "probe-preflight-retire");
    await settle();
    await controller.disconnect();
    preflight.resolve({ binding, value: { protocolVersion: 1, requestId: "preflight-list", agents: [] } });
    await assert.rejects(running, (error: unknown) => error instanceof DirectClientError && error.code === "STALE_CONNECTION");
    assert.equal(probeCalls, 0);
  } finally {
    BrowserThunderClawDirectClient.prototype.listAgents = originalAgents;
    BrowserThunderClawDirectClient.prototype.probeAgent = originalProbe;
    restore();
  }
});

test("explicit cancellation during verification discovery is local and never calls either probe route", async () => {
  const harness = browserHarness(storedConnection());
  const restore = installBrowser(harness);
  const originalAgents = BrowserThunderClawDirectClient.prototype.listAgents;
  const originalProbe = BrowserThunderClawDirectClient.prototype.probeAgent;
  const originalCancel = BrowserThunderClawDirectClient.prototype.cancelAgentProbe;
  const preflight = deferred<any>();
  let probeCalls = 0;
  let cancelCalls = 0;
  try {
    BrowserThunderClawDirectClient.prototype.listAgents = async () => preflight.promise;
    BrowserThunderClawDirectClient.prototype.probeAgent = async () => { probeCalls += 1; throw new Error("unexpected probe"); };
    BrowserThunderClawDirectClient.prototype.cancelAgentProbe = async () => { cancelCalls += 1; throw new Error("unexpected cancel route"); };
    const controller = new ConnectionController();
    const binding = (await controller.acquireFeatureLease()).binding;
    const running = controller.verifyAgent("agent-a", "probe-preflight-cancel");
    await settle();
    assert.deepEqual(await controller.cancelAgentVerification("agent-a", "probe-preflight-cancel"), {
      probeRunId: "probe-preflight-cancel", agentId: "agent-a", cancelled: true,
    });
    preflight.resolve({ binding, value: { protocolVersion: 1, requestId: "preflight-list", agents: [] } });
    await assert.rejects(running, (error: unknown) => error instanceof DirectClientError && error.kind === "cancellation");
    assert.equal(probeCalls, 0);
    assert.equal(cancelCalls, 0);
  } finally {
    BrowserThunderClawDirectClient.prototype.listAgents = originalAgents;
    BrowserThunderClawDirectClient.prototype.probeAgent = originalProbe;
    BrowserThunderClawDirectClient.prototype.cancelAgentProbe = originalCancel;
    restore();
  }
});

test("disconnect and forget clear custody before removing only the captured old hostname permission", async () => {
  const harness = browserHarness(storedConnection());
  const restore = installBrowser(harness);
  try {
    const controller = new ConnectionController();
    const disconnected = await controller.disconnect();
    assert.equal(disconnected.phase, "disconnected");
    assert.equal(disconnected.connected, false);
    assert.equal(disconnected.epoch, 5);
    assert.deepEqual(harness.permissionRemoves, [{ origins: [permissionPattern] }]);
    assert.equal(Object.hasOwn(harness.data, CREDENTIAL_KEY), false);
    const forgotten = await controller.forget();
    assert.deepEqual(forgotten, { phase: "not_configured", configured: false, apiBase: null, origin: null, permissionPattern: null, permissionGranted: false, connected: false, epoch: 6, forgetRemoteRevocation: "unconfirmed" });
    assert.equal(Object.hasOwn(harness.data, SETTINGS_KEY), false);
    assert.equal(harness.permissionRemoves.length, 2);
  } finally { restore(); }
});

test("switching endpoints after disconnect removes the old permission and never carries its credential forward", async () => {
  const nextApiBase = "https://second.example/thunderclaw/v1";
  const nextPermission = "https://second.example/*";
  const harness = browserHarness(storedConnection(9, "old-secret"), [permissionPattern, nextPermission]);
  const restore = installBrowser(harness);
  try {
    const controller = new ConnectionController();
    await controller.disconnect();
    const next = await controller.beginPair(nextApiBase);
    assert.equal(next.apiBase, nextApiBase);
    assert.equal(next.phase, "awaiting_approval");
    assert.equal(next.connected, false);
    assert.equal(next.epoch, 10);
    assert.deepEqual(harness.permissionRemoves, [{ origins: [permissionPattern] }]);
    assert.equal(Object.hasOwn(harness.data, CREDENTIAL_KEY), false);
    assert.equal((harness.data[PENDING_PAIRING_KEY] as { apiBase: string }).apiBase, nextApiBase);
    assert.equal(JSON.stringify(await controller.getState()).includes("old-secret"), false);
  } finally { restore(); }
});

test("options controller accepts only its exact extension-owned options port and strict request shapes", async () => {
  const harness = browserHarness();
  const restore = installBrowser(harness);
  try {
    installOptionsConnectionController();
    const rejected = [
      mockPort({ name: "wrong" }),
      mockPort({ sender: { id: "other@extension", url: "moz-extension://unit-test/options.html" } }),
      mockPort({ sender: { id: "thunderclaw@addons.thunderbird.net", url: "moz-extension://unit-test/options.html?query" } }),
      mockPort({ sender: { id: "thunderclaw@addons.thunderbird.net", url: "moz-extension://unit-test/popup.html" } }),
      mockPort({ sender: {} }),
    ];
    for (const port of rejected) {
      harness.connect(port);
      assert.equal(port.disconnected, 1);
      assert.equal(port.posted.length, 0);
    }
    const accepted = mockPort();
    harness.connect(accepted);
    assert.equal(accepted.disconnected, 0);
    accepted.emit({ requestId: "request-a", method: "state", token: "outward-secret" });
    assert.equal(accepted.disconnected, 1, "extra fields including tokens fail closed");
    await settle();
    for (const invalid of [
      { requestId: "request-b", method: "verifyAgent", agentId: "agent-a" },
      { requestId: "request-c", method: "verifyAgent", agentId: "agent-a", probeRunId: "probe-a", extra: true },
      { requestId: "request-d", method: "cancelAgentVerification", agentId: "agent-a", probeRunId: "bad id" },
    ]) {
      const strict = mockPort();
      harness.connect(strict);
      strict.emit(invalid);
      assert.equal(strict.disconnected, 1);
    }
  } finally { restore(); }
});

test("options-port failures expose only the fixed local error taxonomy", async () => {
  const secretDetail = "Bearer private-token for private@example.test";
  const harness = browserHarness(storedConnection());
  const restore = installBrowser(harness);
  const originalStatus = BrowserThunderClawDirectClient.prototype.status;
  try {
    BrowserThunderClawDirectClient.prototype.status = async () => { throw new Error(secretDetail); };
    installOptionsConnectionController();
    const port = mockPort();
    harness.connect(port);
    port.emit({ requestId: "diagnostic-a", method: "diagnose" });
    await settle();
    assert.deepEqual(port.posted, [{
      requestId: "diagnostic-a",
      ok: false,
      error: { kind: "backend", message: "The OpenClaw service could not complete the request." },
    }]);
    assert.equal(JSON.stringify(port.posted).includes(secretDetail), false);
  } finally {
    BrowserThunderClawDirectClient.prototype.status = originalStatus;
    restore();
  }
});

test("a pairing request serializes a racing disconnect", async () => {
  const harness = browserHarness({}, [permissionPattern]);
  const permission = deferred<boolean>();
  harness.containsAnswers.push(permission.promise);
  const restore = installBrowser(harness);
  try {
    const controller = new ConnectionController();
    const authorizing = controller.beginPair(apiBase);
    await settle();
    await assert.rejects(controller.disconnect(), (error: unknown) => error instanceof DirectClientError && error.code === "CREDENTIAL_ACTION_ACTIVE");
    permission.resolve(true);
    const pending = await authorizing;
    assert.equal(pending.phase, "awaiting_approval");
    assert.equal((await controller.getState()).connected, false);
    assert.equal(Object.hasOwn(harness.data, CREDENTIAL_KEY), false);
  } finally { restore(); }
});

test("disconnect invalidates custody but retains its cleanup reference when permission removal cannot be verified", async () => {
  const originalStatus = BrowserThunderClawDirectClient.prototype.status;
  const originalAgents = BrowserThunderClawDirectClient.prototype.listAgents;
  try {
    BrowserThunderClawDirectClient.prototype.status = async function () {
      return { binding: this.binding, value: { protocolVersion: 1, plugin: "thunderclaw", gatewayVersion: "v", capabilities: {} } };
    };
    BrowserThunderClawDirectClient.prototype.listAgents = async function (requestId) {
      return { binding: this.binding, value: { protocolVersion: 1, requestId, agents: [] } };
    };
    for (const removal of [false, new Error("permission API failed")] as const) {
      const harness = browserHarness(storedConnection());
      harness.removeAnswers.push(removal);
      harness.containsAnswers.push(true, true);
      const restore = installBrowser(harness);
      try {
      const controller = new ConnectionController();
      await controller.diagnose();
      assert.equal((await controller.getState()).phase, "ready");
      await assert.rejects(controller.disconnect(), (error: unknown) => error instanceof DirectClientError && error.code === "PERMISSION_REMOVAL_FAILED");
      assert.equal(Object.hasOwn(harness.data, CREDENTIAL_KEY), false, "the secret is invalidated before cleanup");
      const retained = harness.data[SETTINGS_KEY] as { apiBase: string; permissionPattern: string; connected: boolean; credentialId: unknown; epoch: number };
      assert.equal(retained.apiBase, apiBase);
      assert.equal(retained.permissionPattern, permissionPattern);
      assert.equal(retained.connected, false);
      assert.equal(retained.credentialId, null);
      assert.equal(retained.epoch, 5);
      assert.deepEqual(harness.data[PENDING_CLEANUP_KEY], [permissionPattern], "every failed removal retains a durable cleanup handle");
      assert.equal(harness.grantedOrigins.has(permissionPattern), true);
      const state = await controller.getState();
      assert.equal(state.phase, "disconnected", "failed cleanup cannot preserve diagnostic readiness");
      assert.equal(state.connected, false);
      } finally { restore(); }
    }
  } finally {
    BrowserThunderClawDirectClient.prototype.status = originalStatus;
    BrowserThunderClawDirectClient.prototype.listAgents = originalAgents;
  }
});

test("forget removes local custody even when permission absence cannot be verified", async () => {
  const harness = browserHarness(storedConnection());
  harness.removeAnswers.push(false, false);
  harness.containsAnswers.push(true, true, true, false);
  const restore = installBrowser(harness);
  try {
    const controller = new ConnectionController();
    const first = await controller.forget();
    assert.equal(first.forgetRemoteRevocation, "confirmed");
    assert.equal(Object.hasOwn(harness.data, CREDENTIAL_KEY), false);
    assert.equal(Object.hasOwn(harness.data, SETTINGS_KEY), false);

    const forgotten = await controller.forget();
    assert.equal(forgotten.phase, "not_configured");
    assert.equal(Object.hasOwn(harness.data, SETTINGS_KEY), false, "a false remove result succeeds once contains verifies absence");
    assert.deepEqual(harness.permissionRemoves, [
      { origins: [permissionPattern] },
      { origins: [permissionPattern] },
    ]);
  } finally { restore(); }
});

test("a retained permission after failed disconnect blocks authorization to every hostname", async () => {
  const nextApiBase = "https://next.example/thunderclaw/v1";
  const nextPermission = "https://next.example/*";
  for (const [candidateApiBase, candidatePermission] of [[apiBase, permissionPattern], [nextApiBase, nextPermission]] as const) {
    const harness = browserHarness(storedConnection(), [permissionPattern, candidatePermission]);
    harness.removeAnswers.push(false);
    const restore = installBrowser(harness);
    try {
      const controller = new ConnectionController();
      await assert.rejects(controller.disconnect(), (error: unknown) => error instanceof DirectClientError && error.code === "PERMISSION_REMOVAL_FAILED");
      await assert.rejects(controller.beginPair(candidateApiBase),
        (error: unknown) => error instanceof DirectClientError && error.code === "PERMISSION_CLEANUP_REQUIRED");
      assert.equal(Object.hasOwn(harness.data, CREDENTIAL_KEY), false);
      assert.equal((harness.data[SETTINGS_KEY] as { permissionPattern: string }).permissionPattern, permissionPattern);
    } finally { restore(); }
  }
});

test("a persisted cleanup handle survives restart and is removed only after a verified retry", async () => {
  const orphan = "https://orphan.example/*";
  const harness = browserHarness({ [PENDING_CLEANUP_KEY]: [orphan] }, [orphan]);
  harness.removeAnswers.push(false);
  const restore = installBrowser(harness);
  try {
    const first = new ConnectionController();
    const pending = await first.getState();
    assert.equal(pending.cleanupRequired, true);
    assert.deepEqual(harness.data[PENDING_CLEANUP_KEY], [orphan]);
    assert.equal(JSON.stringify(pending).includes("orphan.example"), false, "the public ledger state exposes no cleanup hostname");

    const restarted = new ConnectionController();
    const cleaned = await restarted.getState();
    assert.equal(cleaned.cleanupRequired, undefined);
    assert.equal(Object.hasOwn(harness.data, PENDING_CLEANUP_KEY), false);
    assert.equal(harness.grantedOrigins.has(orphan), false);
  } finally { restore(); }
});

test("a removal API error does not retain cleanup after Thunderbird verifies the permission is absent", async () => {
  const orphan = "https://already-absent.example/*";
  const harness = browserHarness({ [PENDING_CLEANUP_KEY]: [orphan] }, []);
  harness.removeAnswers.push(new Error("permission was already absent"));
  const restore = installBrowser(harness);
  try {
    const state = await new ConnectionController().getState();
    assert.equal(state.phase, "not_configured");
    assert.equal(state.cleanupRequired, undefined);
    assert.equal(Object.hasOwn(harness.data, PENDING_CLEANUP_KEY), false);
    assert.deepEqual(harness.permissionRemoves, [{ origins: [orphan] }]);
    assert.equal(harness.permissionContains.some((value) => JSON.stringify(value) === JSON.stringify({ origins: [orphan] })), true);
  } finally { restore(); }
});

test("startup permission enumeration removes unowned optional origins and preserves the valid owner", async () => {
  const orphan = "https://orphan.example/*";
  const harness = browserHarness(storedConnection(), [permissionPattern, orphan], true);
  const restore = installBrowser(harness);
  try {
    const state = await new ConnectionController().getState();
    assert.equal(state.permissionPattern, permissionPattern);
    assert.equal(harness.grantedOrigins.has(permissionPattern), true);
    assert.equal(harness.grantedOrigins.has(orphan), false);
    assert.deepEqual(harness.permissionRemoves, [{ origins: [orphan] }]);
    assert.equal(Object.hasOwn(harness.data, PENDING_CLEANUP_KEY), false);
  } finally { restore(); }
});

test("authorization can claim its grant while startup permission enumeration is still hydrating", async () => {
  const harness = browserHarness({}, [permissionPattern], true);
  const restore = installBrowser(harness);
  try {
    const controller = new ConnectionController();
    const state = await controller.beginPair(apiBase);
    assert.equal(state.phase, "awaiting_approval");
    assert.equal(harness.grantedOrigins.has(permissionPattern), true);
    assert.deepEqual(harness.permissionRemoves, []);
    assert.equal(Object.hasOwn(harness.data, PENDING_CLEANUP_KEY), false);
  } finally { restore(); }
});

test("a startup-discovered removal failure persists the grant in the cleanup ledger", async () => {
  const orphan = "https://startup-orphan.example/*";
  const harness = browserHarness({}, [orphan], true);
  harness.removeAnswers.push(new Error("permission API failed"));
  const restore = installBrowser(harness);
  try {
    const state = await new ConnectionController().getState();
    assert.equal(state.cleanupRequired, true);
    assert.deepEqual(harness.data[PENDING_CLEANUP_KEY], [orphan]);
    assert.equal(harness.grantedOrigins.has(orphan), true);
  } finally { restore(); }
});

test("an unclaimed onAdded grant is reclaimed when the options port disconnects", async () => {
  const orphan = "https://orphan.example/*";
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let nextTimer = 1;
  const timers = new Map<number, () => void>();
  Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: (callback: () => void) => {
    const id = nextTimer++;
    timers.set(id, callback);
    return id;
  } });
  Object.defineProperty(globalThis, "clearTimeout", { configurable: true, value: (id: number) => { timers.delete(id); } });
  const harness = browserHarness({}, []);
  const restore = installBrowser(harness);
  try {
    installOptionsConnectionController();
    const port = mockPort();
    harness.connect(port);
    port.emit({ requestId: "state-a", method: "state" });
    await settle();
    harness.grantedOrigins.add(orphan);
    harness.emitAdded([orphan]);
    await settle();
    assert.deepEqual(harness.data[PENDING_CLEANUP_KEY], [orphan]);
    port.emitDisconnect();
    await settle();
    await settle();
    assert.deepEqual(harness.permissionRemoves, [{ origins: [orphan] }]);
    assert.equal(harness.grantedOrigins.has(orphan), false);
    assert.equal(Object.hasOwn(harness.data, PENDING_CLEANUP_KEY), false);
  } finally {
    restore();
    Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: realSetTimeout });
    Object.defineProperty(globalThis, "clearTimeout", { configurable: true, value: realClearTimeout });
  }
});

test("an active authorization durably records onAdded before reconciliation so restart can reclaim its pre-commit grant", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let nextTimer = 1;
  Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: () => nextTimer++ });
  Object.defineProperty(globalThis, "clearTimeout", { configurable: true, value: () => undefined });
  const harness = browserHarness({}, [], true);
  const permissionPreflight = deferred<boolean>();
  const restore = installBrowser(harness);
  try {
    installOptionsConnectionController();
    const port = mockPort();
    harness.connect(port);
    port.emit({ requestId: "state-before-authorize", method: "state" });
    await settle();

    harness.containsAnswers.push(permissionPreflight.promise);
    harness.grantedOrigins.add(permissionPattern);
    port.emit({ requestId: "pair-before-crash", method: "beginPair", apiBase });
    assert.equal(harness.permissionContains.length > 0, true, "authorization reached its deferred permission preflight");
    harness.emitAdded([permissionPattern]);
    await settle();
    assert.deepEqual(harness.data[PENDING_CLEANUP_KEY], [permissionPattern],
      "permissionAdded persists the grant even after the active-authorization map has claimed it");

    port.emitDisconnect();
    await settle();
    assert.deepEqual(harness.data[PENDING_CLEANUP_KEY], [permissionPattern], "port reconciliation retains a grant owned only by the pending authorization");
    assert.deepEqual(harness.permissionRemoves, []);

    (harness.browser.permissions as any).getAll = async () => { throw new Error("enumeration unavailable after restart"); };
    const restarted = new ConnectionController();
    const recovered = await restarted.getState();
    assert.equal(recovered.cleanupRequired, undefined);
    assert.deepEqual(harness.permissionRemoves, [{ origins: [permissionPattern] }]);
    assert.equal(harness.grantedOrigins.has(permissionPattern), false);
    assert.equal(Object.hasOwn(harness.data, PENDING_CLEANUP_KEY), false,
      "restart loads the durable handle and clears it only after verified removal");
    assert.equal(Object.hasOwn(harness.data, CREDENTIAL_KEY), false);
  } finally {
    restore();
    Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: realSetTimeout });
    Object.defineProperty(globalThis, "clearTimeout", { configurable: true, value: realClearTimeout });
  }
});

test("an unclaimed onAdded grant is reclaimed when its grace period expires", async () => {
  const orphan = "https://grace-orphan.example/*";
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let grace: (() => void) | null = null;
  Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: (callback: () => void, delay?: number) => {
    if (delay === 2_000) grace = callback;
    return 1;
  } });
  Object.defineProperty(globalThis, "clearTimeout", { configurable: true, value: () => undefined });
  const harness = browserHarness({}, []);
  const restore = installBrowser(harness);
  try {
    const controller = new ConnectionController();
    await controller.getState();
    harness.grantedOrigins.add(orphan);
    harness.emitAdded([orphan]);
    await settle();
    assert.ok(grace);
    (grace as () => void)();
    await settle();
    await settle();
    assert.deepEqual(harness.permissionRemoves, [{ origins: [orphan] }]);
    assert.equal(harness.grantedOrigins.has(orphan), false);
    assert.equal(Object.hasOwn(harness.data, PENDING_CLEANUP_KEY), false);
  } finally {
    restore();
    Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: realSetTimeout });
    Object.defineProperty(globalThis, "clearTimeout", { configurable: true, value: realClearTimeout });
  }
});

test("a successful same-pattern authorization claims an onAdded candidate before cleanup", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const graceCallbacks: Array<() => void> = [];
  Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: (callback: () => void, delay?: number) => {
    if (delay === 2_000) graceCallbacks.push(callback);
    return 1;
  } });
  Object.defineProperty(globalThis, "clearTimeout", { configurable: true, value: () => undefined });
  const harness = browserHarness({}, []);
  const restore = installBrowser(harness);
  try {
    const controller = new ConnectionController();
    await controller.getState();
    harness.grantedOrigins.add(permissionPattern);
    harness.emitAdded([permissionPattern]);
    await settle();
    assert.deepEqual(harness.data[PENDING_CLEANUP_KEY], [permissionPattern]);
    const state = await controller.beginPair(apiBase);
    assert.equal(state.phase, "awaiting_approval");
    for (const callback of graceCallbacks) callback();
    await settle();
    assert.deepEqual(harness.permissionRemoves, [], "neither authorization nor a late grace callback revokes the winner");
    assert.equal(harness.grantedOrigins.has(permissionPattern), true);
    assert.equal(Object.hasOwn(harness.data, PENDING_CLEANUP_KEY), false);
  } finally {
    restore();
    Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: realSetTimeout });
    Object.defineProperty(globalThis, "clearTimeout", { configurable: true, value: realClearTimeout });
  }
});

test("cleanup-ledger errors crossing the options port are fixed-shape and omit the stored hostname", async () => {
  const orphan = "https://private-cleanup-host.example/*";
  const candidateApiBase = "https://candidate.example/thunderclaw/v1";
  const candidatePermission = "https://candidate.example/*";
  const harness = browserHarness({ [PENDING_CLEANUP_KEY]: [orphan] }, [orphan, candidatePermission]);
  harness.removeAnswers.push(false);
  const restore = installBrowser(harness);
  try {
    installOptionsConnectionController();
    const port = mockPort();
    harness.connect(port);
    port.emit({ requestId: "pair-ledger", method: "beginPair", apiBase: candidateApiBase });
    await settle();
    await settle();
    const response = port.posted.find((value: any) => value.requestId === "pair-ledger");
    assert.deepEqual(response, {
      requestId: "pair-ledger",
      ok: false,
      error: {
        kind: "permission",
        message: "A previous hostname permission still needs cleanup. Retry Disconnect or revoke it in Add-ons Manager before authorizing.",
        permissionCleanup: "complete",
      },
    });
    assert.equal(JSON.stringify(response).includes("private-cleanup-host"), false);
    assert.equal(JSON.stringify(response).includes("secret"), false);
  } finally { restore(); }
});

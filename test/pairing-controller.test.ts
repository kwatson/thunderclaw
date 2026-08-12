import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ConnectionController } from "../packages/thunderbird-extension/src/connection-controller.js";
import { DirectClientError } from "../packages/thunderbird-extension/src/direct-client-contract.js";
import { BrowserThunderClawDirectClient } from "../packages/thunderbird-extension/src/direct-client.js";
import { BrowserPairingClient, type PairingRequestMaterial } from "../packages/thunderbird-extension/src/pairing-client.js";

const SETTINGS_KEY = "thunderclaw.connectionSettings.v1";
const LEGACY_KEY = "thunderclaw.developmentNarrowCredential.v1";
const IDENTITY_KEY = "thunderclaw.deviceIdentity.v1";
const CREDENTIAL_KEY = "thunderclaw.deviceCredential.v1";
const PENDING_PAIRING_KEY = "thunderclaw.pendingPairing.v1";
const PENDING_ROTATION_KEY = "thunderclaw.pendingRotation.v1";
const REMOTE_RECOVERY_KEY = "thunderclaw.remoteCredentialRecovery.v1";
const EPOCH_KEY = "thunderclaw.connectionEpoch.v1";
const apiBase = "https://gateway.example:8443/thunderclaw/v1";
const origin = "https://gateway.example:8443";
const permissionPattern = "https://gateway.example/*";
const deviceId = "device_123456789012345678901";
const credentialId = "credential_123456789012345678";
const rawCredential = `${credentialId}.${"s".repeat(43)}`;
const expiresAt = "2099-01-01T00:00:00.000Z";

function activeConnection(epoch = 4, expiry = expiresAt): Record<string, unknown> {
  return {
    [IDENTITY_KEY]: { version: 1, deviceId, deviceName: "Thunderbird on test" },
    [SETTINGS_KEY]: { version: 1, apiBase, origin, permissionPattern, credentialId, connected: true, epoch },
    [CREDENTIAL_KEY]: {
      version: 1, mode: "device_credential", apiBase, origin, credentialId,
      deviceId, deviceName: "Thunderbird on test", rawCredential, expiresAt: expiry,
    },
    [EPOCH_KEY]: epoch,
  };
}

function browserHarness(initial: Record<string, unknown> = {}, granted = true) {
  const data = structuredClone(initial);
  let permissionGranted = granted;
  const storageGets: unknown[] = [];
  const storageSets: Record<string, unknown>[] = [];
  const storageRemoves: unknown[] = [];
  const permissionRemoves: unknown[] = [];
  let rejectNextSet: Error | null = null;
  const removedListeners: Array<(value: { origins?: unknown }) => void> = [];
  const addedListeners: Array<(value: { origins?: unknown }) => void> = [];
  const browser = {
    storage: { local: {
      async get(keys: string | string[]) {
        storageGets.push(structuredClone(keys));
        const selected = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(selected.filter((key) => Object.hasOwn(data, key)).map((key) => [key, structuredClone(data[key])]));
      },
      async set(values: Record<string, unknown>) {
        if (rejectNextSet) { const error = rejectNextSet; rejectNextSet = null; throw error; }
        storageSets.push(structuredClone(values));
        Object.assign(data, structuredClone(values));
      },
      async remove(keys: string | string[]) {
        storageRemoves.push(structuredClone(keys));
        for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
      },
    } },
    permissions: {
      async contains() { return permissionGranted; },
      async remove(value: unknown) { permissionRemoves.push(structuredClone(value)); permissionGranted = false; return true; },
      async getAll() { return { origins: permissionGranted ? [permissionPattern] : [] }; },
      onRemoved: { addListener(listener: (value: { origins?: unknown }) => void) { removedListeners.push(listener); } },
      onAdded: { addListener(listener: (value: { origins?: unknown }) => void) { addedListeners.push(listener); } },
    },
    runtime: {
      id: "thunderclaw@addons.thunderbird.net",
      getURL: (path: string) => `moz-extension://unit-test/${path}`,
      getPlatformInfo: async () => ({ os: "test" }),
      onConnect: { addListener() {} },
    },
  };
  return {
    browser, data, storageGets, storageSets, storageRemoves, permissionRemoves,
    get permissionGranted() { return permissionGranted; },
    rejectStorageSet(error: Error) { rejectNextSet = error; },
  };
}

type Harness = ReturnType<typeof browserHarness>;

function installBrowser(context: TestContext, harness: Harness): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "browser");
  Object.defineProperty(globalThis, "browser", { configurable: true, value: harness.browser });
  context.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "browser", descriptor);
    else Reflect.deleteProperty(globalThis, "browser");
  });
}

function patchPairing<K extends "request" | "claim" | "rotate" | "revoke">(
  context: TestContext,
  method: K,
  implementation: BrowserPairingClient[K],
): void {
  const original = BrowserPairingClient.prototype[method];
  Object.defineProperty(BrowserPairingClient.prototype, method, { configurable: true, writable: true, value: implementation });
  context.after(() => Object.defineProperty(BrowserPairingClient.prototype, method, { configurable: true, writable: true, value: original }));
}

function publicDevice(id = credentialId) {
  return { credentialId: id, deviceId, deviceName: "Thunderbird on test", capabilities: [], expiresAt };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

test("startup destroys the retired development token without converting or exposing it", async (context) => {
  const legacySecret = "legacy-private-token";
  const harness = browserHarness({
    [LEGACY_KEY]: { version: 1, mode: "development_narrow_token", token: legacySecret },
    [SETTINGS_KEY]: { version: 1, apiBase, origin, permissionPattern, credentialId: "legacy-id", connected: true, epoch: 7 },
    [EPOCH_KEY]: 7,
  });
  installBrowser(context, harness);
  const state = await new ConnectionController().getState();
  assert.equal(Object.hasOwn(harness.data, LEGACY_KEY), false);
  assert.equal(Object.hasOwn(harness.data, CREDENTIAL_KEY), false);
  assert.equal(JSON.stringify(harness.data).includes(legacySecret), false);
  assert.equal(JSON.stringify(state).includes(legacySecret), false);
  assert.equal(state.connected, false);
});

test("beginPair keeps raw secrets in background custody and exposes only approval metadata", async (context) => {
  const harness = browserHarness();
  installBrowser(context, harness);
  let captured: PairingRequestMaterial | null = null;
  patchPairing(context, "request", async function (material) {
    captured = material;
    return { requestId: material.requestId, approvalCode: "ABCDE-23456", expiresAt: "2099-01-01T00:00:00.000Z" };
  });
  const controller = new ConnectionController();
  const state = await controller.beginPair(apiBase);
  assert.equal(state.phase, "awaiting_approval");
  assert.equal(state.approvalCode, "ABCDE-23456");
  const issued = captured as unknown as PairingRequestMaterial;
  assert.ok(issued);
  const secrets = [issued.claimCredential, issued.prospective.rawCredential];
  for (const secret of secrets) {
    assert.equal(JSON.stringify(state).includes(secret), false);
    assert.equal(state.approvalCode?.includes(secret), false);
  }
  assert.equal((harness.data[PENDING_PAIRING_KEY] as { claimCredential?: unknown }).claimCredential, issued.claimCredential);
  assert.equal(Object.hasOwn(harness.data, CREDENTIAL_KEY), false, "prospective credential is not active before claim");
  assert.deepEqual(Object.keys(harness.data[IDENTITY_KEY] as object).sort(), ["deviceId", "deviceName", "version"]);
});

test("claim atomically activates the prospective credential and consumes one-time claim custody", async (context) => {
  const harness = browserHarness();
  installBrowser(context, harness);
  let pending!: PairingRequestMaterial;
  patchPairing(context, "request", async function (material) {
    pending = material;
    return { requestId: material.requestId, approvalCode: "ABCDE-23456", expiresAt };
  });
  patchPairing(context, "claim", async function (material) {
    assert.equal(material.requestId, pending.requestId);
    assert.equal(material.claimCredential, pending.claimCredential);
    assert.deepEqual(material.prospective, pending.prospective);
    return { ...publicDevice(material.prospective.credentialId), credentialId: material.prospective.credentialId,
      deviceId: material.deviceId, deviceName: material.deviceName };
  });
  const controller = new ConnectionController();
  await controller.beginPair(apiBase);
  const state = await controller.claimPairing();
  assert.equal(state.phase, "authorized_untested");
  assert.equal(Object.hasOwn(harness.data, PENDING_PAIRING_KEY), false);
  assert.equal((harness.data[CREDENTIAL_KEY] as { rawCredential: string }).rawCredential, pending.prospective.rawCredential);
  assert.equal((harness.data[SETTINGS_KEY] as { credentialId: string }).credentialId, pending.prospective.credentialId);
  assert.equal(JSON.stringify(state).includes(pending.claimCredential), false);
  assert.equal(JSON.stringify(state).includes(pending.prospective.rawCredential), false);
});

test("an in-flight one-time claim serializes Cancel and Forget until its prospective credential is durably resolved", async (context) => {
  const harness = browserHarness();
  installBrowser(context, harness);
  let pending!: PairingRequestMaterial;
  patchPairing(context, "request", async function (material) {
    pending = material;
    return { requestId: material.requestId, approvalCode: "ABCDE-23456", expiresAt };
  });
  const claimed = deferred<ReturnType<typeof publicDevice>>();
  patchPairing(context, "claim", async function () { return claimed.promise; });
  const controller = new ConnectionController();
  await controller.beginPair(apiBase);
  const claim = controller.claimPairing();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((harness.data[PENDING_PAIRING_KEY] as { claimAmbiguous: boolean }).claimAmbiguous, true);
  await assert.rejects(controller.cancelPairing(), (error: unknown) => error instanceof DirectClientError && error.code === "CREDENTIAL_ACTION_ACTIVE");
  await assert.rejects(controller.forget(), (error: unknown) => error instanceof DirectClientError && error.code === "CREDENTIAL_ACTION_ACTIVE");
  assert.equal(Object.hasOwn(harness.data, PENDING_PAIRING_KEY), true);
  claimed.resolve({ ...publicDevice(pending.prospective.credentialId), credentialId: pending.prospective.credentialId,
    deviceId: pending.deviceId, deviceName: pending.deviceName });
  assert.equal((await claim).phase, "authorized_untested");
  assert.equal(Object.hasOwn(harness.data, PENDING_PAIRING_KEY), false);
});

test("rotation persists both candidates before I/O, retires the old credential only after durable replacement, and advances epoch", async (context) => {
  const harness = browserHarness(activeConnection());
  installBrowser(context, harness);
  let nextRaw = "";
  patchPairing(context, "rotate", async function (current, prospective, expected) {
    assert.equal(current, rawCredential);
    assert.deepEqual(expected, { deviceId, deviceName: "Thunderbird on test" });
    nextRaw = prospective.rawCredential;
    const pending = harness.data[PENDING_ROTATION_KEY] as { current: { rawCredential: string }; prospective: { rawCredential: string } };
    assert.equal(pending.current.rawCredential, rawCredential);
    assert.equal(pending.prospective.rawCredential, prospective.rawCredential);
    return { ...publicDevice(prospective.credentialId), credentialId: prospective.credentialId };
  });
  const controller = new ConnectionController();
  const state = await controller.rotateCredential();
  assert.equal(state.phase, "authorized_untested");
  assert.equal(state.epoch, 5);
  assert.equal((harness.data[CREDENTIAL_KEY] as { rawCredential: string }).rawCredential, nextRaw);
  assert.equal(JSON.stringify(harness.data).includes(rawCredential), false);
  assert.equal(Object.hasOwn(harness.data, PENDING_ROTATION_KEY), false);
  assert.equal(Object.hasOwn(harness.data, REMOTE_RECOVERY_KEY), false);
});

test("ambiguous rotation survives restart with both candidates and blocks feature leases", async (context) => {
  const harness = browserHarness(activeConnection());
  installBrowser(context, harness);
  patchPairing(context, "rotate", async function () {
    throw new DirectClientError("network", "NETWORK_FAILURE", "unavailable");
  });
  const controller = new ConnectionController();
  await assert.rejects(controller.rotateCredential(), (error: unknown) => error instanceof DirectClientError && error.kind === "network");
  assert.equal((await controller.getState()).phase, "rotation_ambiguous");
  assert.equal(Object.hasOwn(harness.data, PENDING_ROTATION_KEY), true);
  assert.equal(Object.hasOwn(harness.data, REMOTE_RECOVERY_KEY), true);
  const restarted = new ConnectionController();
  const state = await restarted.getState();
  assert.equal(state.phase, "rotation_ambiguous");
  assert.equal(state.remoteCredentialPossiblyActive, true);
  await assert.rejects(restarted.acquireFeatureLease(), (error: unknown) => error instanceof DirectClientError);
});

test("startup completes rotation cleanup after replacement persisted but journal removal crashed", async (context) => {
  const nextId = "credential_next_123456789012345";
  const nextRaw = `${nextId}.${"n".repeat(43)}`;
  const initial = activeConnection(5);
  const current = structuredClone(initial[CREDENTIAL_KEY]) as Record<string, unknown>;
  initial[SETTINGS_KEY] = { ...(initial[SETTINGS_KEY] as object), credentialId: nextId, epoch: 5 };
  initial[CREDENTIAL_KEY] = { ...current, credentialId: nextId, rawCredential: nextRaw };
  initial[PENDING_ROTATION_KEY] = {
    version: 1, apiBase, origin, permissionPattern, current,
    prospective: { credentialId: nextId, rawCredential: nextRaw, credentialVerifier: "a".repeat(64) },
    startedAt: "2026-08-10T12:00:00.000Z",
  };
  initial[REMOTE_RECOVERY_KEY] = {
    version: 1, possiblyActive: true, reason: "ambiguous credential rotation", apiBase, origin, permissionPattern,
    candidates: [{ credentialId, rawCredential }, { credentialId: nextId, rawCredential: nextRaw }],
  };
  const harness = browserHarness(initial);
  installBrowser(context, harness);
  const controller = new ConnectionController();
  assert.equal((await controller.getState()).phase, "authorized_untested");
  assert.equal(Object.hasOwn(harness.data, PENDING_ROTATION_KEY), false);
  assert.equal(Object.hasOwn(harness.data, REMOTE_RECOVERY_KEY), false);
  assert.equal((harness.data[CREDENTIAL_KEY] as { rawCredential: string }).rawCredential, nextRaw);
});

test("Disconnect revokes remotely before deleting local custody and retains custody on ambiguous failure", async (context) => {
  const harness = browserHarness(activeConnection());
  installBrowser(context, harness);
  let revokeCalls = 0;
  patchPairing(context, "revoke", async function (credential) {
    revokeCalls += 1;
    assert.equal(credential, rawCredential);
    assert.equal(Object.hasOwn(harness.data, CREDENTIAL_KEY), true, "remote revocation precedes local deletion");
  });
  const disconnected = await new ConnectionController().disconnect();
  assert.equal(revokeCalls, 1);
  assert.equal(disconnected.phase, "disconnected");
  assert.equal(Object.hasOwn(harness.data, CREDENTIAL_KEY), false);
  assert.equal(harness.permissionGranted, false);
  assert.deepEqual(harness.permissionRemoves, [{ origins: [permissionPattern] }]);

  const ambiguousHarness = browserHarness(activeConnection());
  Object.defineProperty(globalThis, "browser", { configurable: true, value: ambiguousHarness.browser });
  patchPairing(context, "revoke", async function () { throw new DirectClientError("network", "NETWORK_FAILURE", "offline"); });
  await assert.rejects(new ConnectionController().disconnect(), (error: unknown) => error instanceof DirectClientError && error.kind === "network");
  assert.equal(Object.hasOwn(ambiguousHarness.data, CREDENTIAL_KEY), true);
  assert.equal(ambiguousHarness.permissionGranted, true);
  const ambiguous = new ConnectionController();
  assert.equal((await ambiguous.getState()).phase, "disconnect_ambiguous");
  await assert.rejects(ambiguous.acquireFeatureLease(), (error: unknown) => error instanceof DirectClientError && error.code === "CONNECTION_UNAVAILABLE");
});

test("corrupt cross-origin recovery is removed without transmitting its held bearer", async (context) => {
  const hostileRaw = `${credentialId}.${"h".repeat(43)}`;
  const harness = browserHarness({
    [REMOTE_RECOVERY_KEY]: {
      version: 1, possiblyActive: true, reason: "corrupt restore", apiBase,
      origin: "https://attacker.example", permissionPattern,
      candidates: [{ credentialId, rawCredential: hostileRaw }],
    },
  });
  installBrowser(context, harness);
  let revocations = 0;
  patchPairing(context, "revoke", async function () { revocations += 1; });
  const controller = new ConnectionController();
  assert.equal((await controller.getState()).phase, "not_configured");
  assert.equal(Object.hasOwn(harness.data, REMOTE_RECOVERY_KEY), false);
  await controller.forget();
  assert.equal(revocations, 0);
});

test("Forget deletes local custody despite ambiguous remote revocation and reports the distinction", async (context) => {
  const harness = browserHarness(activeConnection());
  installBrowser(context, harness);
  patchPairing(context, "revoke", async function () { throw new DirectClientError("network", "NETWORK_FAILURE", "offline"); });
  const forgotten = await new ConnectionController().forget();
  assert.equal(forgotten.phase, "not_configured");
  assert.equal(forgotten.forgetRemoteRevocation, "unconfirmed");
  for (const key of [SETTINGS_KEY, CREDENTIAL_KEY, PENDING_PAIRING_KEY, PENDING_ROTATION_KEY, REMOTE_RECOVERY_KEY]) {
    assert.equal(Object.hasOwn(harness.data, key), false, key);
  }
  assert.equal(harness.permissionGranted, false);
});

test("expired credentials are visible only as lifecycle state and cannot create a feature lease", async (context) => {
  const harness = browserHarness(activeConnection(4, "2000-01-01T00:00:00.000Z"));
  installBrowser(context, harness);
  const controller = new ConnectionController();
  const state = await controller.getState();
  assert.equal(state.phase, "credential_expired");
  assert.equal(state.credentialExpiresAt, "2000-01-01T00:00:00.000Z");
  assert.equal(JSON.stringify(state).includes(rawCredential), false);
  await assert.rejects(controller.acquireFeatureLease(), (error: unknown) => error instanceof DirectClientError && error.code === "CONNECTION_UNAVAILABLE");
});

test("authoritative server revocation and early expiry retire the epoch and persist explicit lifecycle state", async (context) => {
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const browserDescriptor = Object.getOwnPropertyDescriptor(globalThis, "browser");
  context.after(() => {
    if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor);
    else Reflect.deleteProperty(globalThis, "fetch");
    if (browserDescriptor) Object.defineProperty(globalThis, "browser", browserDescriptor);
    else Reflect.deleteProperty(globalThis, "browser");
  });
  for (const [code, expected] of [["CREDENTIAL_REVOKED", "credential_revoked"], ["CREDENTIAL_EXPIRED", "credential_expired"]] as const) {
    const harness = browserHarness(activeConnection());
    Object.defineProperty(globalThis, "browser", { configurable: true, value: harness.browser });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL) => {
      const response = new Response(JSON.stringify({ error: { code, message: "authoritative lifecycle rejection" } }), {
        status: 401, headers: { "content-type": "application/json" },
      });
      Object.defineProperty(response, "url", { configurable: true, value: String(input) });
      return response;
    } });
    const controller = new ConnectionController();
    await assert.rejects(controller.diagnose(), (error: unknown) => error instanceof DirectClientError && error.code === code);
    const state = await controller.getState();
    assert.equal(state.phase, expected);
    assert.equal(state.epoch, 5);
    assert.equal(Object.hasOwn(harness.data, CREDENTIAL_KEY), false);
    await assert.rejects(controller.acquireFeatureLease(), (error: unknown) => error instanceof DirectClientError && error.code === "CONNECTION_UNAVAILABLE");
    const restarted = new ConnectionController();
    assert.equal((await restarted.getState()).phase, expected);
  }
});

test("corrupt remote recovery is discarded without contacting or retaining an attacker origin", async (context) => {
  installBrowser(context, browserHarness());
  const valid = {
    version: 1, possiblyActive: true, reason: "ambiguous disconnect", apiBase, origin, permissionPattern,
    candidates: [{ credentialId, rawCredential }],
  };
  const cases = [
    { ...valid, origin: "https://attacker.example" },
    { ...valid, permissionPattern: "https://attacker.example/*" },
    { ...valid, extra: true },
    { ...valid, candidates: [{ credentialId: "credential_other_1234567890123", rawCredential }] },
  ];
  for (const recovery of cases) {
    const harness = browserHarness({ [REMOTE_RECOVERY_KEY]: recovery });
    Object.defineProperty(globalThis, "browser", { configurable: true, value: harness.browser });
    const state = await new ConnectionController().getState();
    assert.equal(state.phase, "not_configured");
    assert.equal(Object.hasOwn(harness.data, REMOTE_RECOVERY_KEY), false);
    assert.equal(JSON.stringify(harness.permissionRemoves).includes("attacker.example"), false);
  }
});

test("valid recovery-only custody survives startup and retains exactly its bound permission", async (context) => {
  const recovery = {
    version: 1, possiblyActive: true, reason: "ambiguous disconnect", apiBase, origin, permissionPattern,
    candidates: [{ credentialId, rawCredential }],
  };
  const harness = browserHarness({ [REMOTE_RECOVERY_KEY]: recovery });
  installBrowser(context, harness);
  const state = await new ConnectionController().getState();
  assert.equal(state.phase, "disconnect_ambiguous");
  assert.equal(state.remoteCredentialPossiblyActive, true);
  assert.equal(state.apiBase, apiBase);
  assert.deepEqual(harness.permissionRemoves, []);
  assert.equal(harness.permissionGranted, true);
});

test("an ambiguous claim is recovered by probing the prospective product credential", async (context) => {
  const harness = browserHarness();
  installBrowser(context, harness);
  patchPairing(context, "request", async function (material) {
    return { requestId: material.requestId, approvalCode: "ABCDE-23456", expiresAt };
  });
  patchPairing(context, "claim", async function () {
    throw new DirectClientError("network", "NETWORK_FAILURE", "lost claim response");
  });
  const originalStatus = BrowserThunderClawDirectClient.prototype.status;
  BrowserThunderClawDirectClient.prototype.status = async function () {
    return { binding: this.binding, value: { protocolVersion: 1, plugin: "thunderclaw", gatewayVersion: "test", capabilities: {} } };
  };
  context.after(() => { BrowserThunderClawDirectClient.prototype.status = originalStatus; });
  const controller = new ConnectionController();
  await controller.beginPair(apiBase);
  const recovered = await controller.claimPairing();
  assert.equal(recovered.phase, "authorized_untested");
  assert.equal(Object.hasOwn(harness.data, PENDING_PAIRING_KEY), false);
  assert.equal(Object.hasOwn(harness.data, REMOTE_RECOVERY_KEY), false);
  assert.equal(Object.hasOwn(harness.data, CREDENTIAL_KEY), true);
});

test("a copied ambiguous pending profile fails closed when its prospective credential is rejected", async (context) => {
  const harness = browserHarness();
  installBrowser(context, harness);
  patchPairing(context, "request", async function (material) {
    return { requestId: material.requestId, approvalCode: "ABCDE-23456", expiresAt };
  });
  patchPairing(context, "claim", async function () {
    throw new DirectClientError("network", "NETWORK_FAILURE", "lost claim response");
  });
  const originalStatus = BrowserThunderClawDirectClient.prototype.status;
  BrowserThunderClawDirectClient.prototype.status = async function () {
    throw new DirectClientError("authentication", "AUTHENTICATION_FAILED", "rejected", 401);
  };
  context.after(() => { BrowserThunderClawDirectClient.prototype.status = originalStatus; });
  const first = new ConnectionController();
  await first.beginPair(apiBase);
  await assert.rejects(first.claimPairing(), (error: unknown) => error instanceof DirectClientError && error.kind === "network");
  const restarted = new ConnectionController();
  await assert.rejects(restarted.claimPairing(), (error: unknown) => error instanceof DirectClientError && error.code === "CLAIM_OUTCOME_AMBIGUOUS");
  assert.equal((await restarted.getState()).remoteCredentialPossiblyActive, true);
  assert.equal(Object.hasOwn(harness.data, CREDENTIAL_KEY), false);
  assert.equal(Object.hasOwn(harness.data, PENDING_PAIRING_KEY), true);
});

test("Disconnect revokes both old and prospective credentials after ambiguous rotation", async (context) => {
  const harness = browserHarness(activeConnection());
  installBrowser(context, harness);
  patchPairing(context, "rotate", async function () {
    throw new DirectClientError("network", "NETWORK_FAILURE", "rotation response lost");
  });
  const controller = new ConnectionController();
  await assert.rejects(controller.rotateCredential(), (error: unknown) => error instanceof DirectClientError && error.kind === "network");
  const pending = harness.data[PENDING_ROTATION_KEY] as { current: { rawCredential: string }; prospective: { rawCredential: string } };
  const revoked: string[] = [];
  patchPairing(context, "revoke", async function (credential) { revoked.push(credential); });
  await controller.disconnect();
  assert.deepEqual(new Set(revoked), new Set([pending.current.rawCredential, pending.prospective.rawCredential]));
  assert.equal(Object.hasOwn(harness.data, CREDENTIAL_KEY), false);
  assert.equal(Object.hasOwn(harness.data, PENDING_ROTATION_KEY), false);
});

test("credential mutation exclusion prevents Forget from racing an in-flight claim", async (context) => {
  const harness = browserHarness();
  installBrowser(context, harness);
  patchPairing(context, "request", async function (material) {
    return { requestId: material.requestId, approvalCode: "ABCDE-23456", expiresAt };
  });
  let resolveClaim!: (value: ReturnType<typeof publicDevice>) => void;
  patchPairing(context, "claim", async function () {
    return new Promise((resolve) => { resolveClaim = resolve; });
  });
  const controller = new ConnectionController();
  await controller.beginPair(apiBase);
  const claiming = controller.claimPairing();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(controller.forget(), (error: unknown) => error instanceof DirectClientError && error.code === "CREDENTIAL_ACTION_ACTIVE");
  const pending = harness.data[PENDING_PAIRING_KEY] as { prospective: { credentialId: string } };
  resolveClaim(publicDevice(pending.prospective.credentialId));
  assert.equal((await claiming).phase, "authorized_untested");
});

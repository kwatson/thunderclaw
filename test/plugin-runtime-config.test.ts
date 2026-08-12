import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  OpenClawPluginApi,
  OpenClawPluginHttpRouteHandler,
} from "openclaw/plugin-sdk/plugin-entry";
import plugin from "../packages/openclaw-plugin/index.js";
import { CompatibilityStore } from "../packages/openclaw-plugin/src/compatibility-store.js";
import {
  PairingRegistry,
  approvalCodeVerifier,
  claimCredentialVerifier,
  deviceCredentialVerifier,
} from "../packages/openclaw-plugin/src/pairing-registry.js";

const requestId = "runtime_pair_request_01";
const deviceId = "runtime_test_device_01";
const credentialId = "runtime_credential_01";
const deviceCredential = `${credentialId}.${"d".repeat(43)}`;
const claimCredential = "c".repeat(43);
const approvalCode = "ABCDEFG234";

function provisionDevice(stateDir: string): void {
  const registry = PairingRegistry.open(stateDir);
  registry.issue({
    requestId,
    deviceId,
    deviceName: "Runtime test device",
    credentialId,
    credentialVerifier: deviceCredentialVerifier(deviceCredential),
    claimVerifier: claimCredentialVerifier(claimCredential),
    approvalCodeVerifier: approvalCodeVerifier(approvalCode),
  });
  registry.approve(requestId, approvalCode);
  registry.claim(requestId, claimCredential);
}

function runtimeConfig(model: string): OpenClawPluginApi["config"] {
  return {
    agents: {
      defaults: { model: { primary: `provider/${model}` } },
      entries: { main: { default: true, name: model } },
    },
  } as OpenClawPluginApi["config"];
}

test("plugin entry reads only api.runtime.config.current and observes replacement snapshots", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "thunderclaw-plugin-config-test-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const snapshotA = runtimeConfig("model-a");
  const snapshotB = runtimeConfig("model-b");
  let current = snapshotA;
  let currentCalls = 0;
  let legacyConfigReads = 0;
  let handler: OpenClawPluginHttpRouteHandler | undefined;
  const registeredRoutes: Array<{ path: string; auth: string; match: string }> = [];
  const gatewayMethods: Array<{ name: string; scope: string | undefined }> = [];
  const api = {
    registrationMode: "full",
    pluginConfig: {},
    runtime: {
      version: "test",
      config: {
        current: () => {
          currentCalls += 1;
          return current;
        },
      },
      state: { resolveStateDir: () => stateDir },
      agent: {
        runEmbeddedAgent: async () => { throw new Error("model call must not run during discovery"); },
        resolveAgentWorkspaceDir: () => "/tmp/synthetic-workspace",
        resolveThinkingPolicy: () => ({ levels: [], defaultLevel: null }),
      },
    },
    registerHttpRoute: (route: { path: string; auth: string; match: string; handler: OpenClawPluginHttpRouteHandler }) => {
      registeredRoutes.push(route);
      if (route.path === "/thunderclaw/v1") handler = route.handler;
    },
    registerGatewayMethod: (name: string, _methodHandler: unknown, options?: { scope?: string }) => {
      gatewayMethods.push({ name, scope: options?.scope });
    },
    registerCli: () => {},
  } as unknown as OpenClawPluginApi;
  Object.defineProperty(api, "config", {
    configurable: true,
    get() {
      legacyConfigReads += 1;
      throw new Error("captured api.config must never be read");
    },
  });

  plugin.register?.(api);
  assert.ok(handler);
  assert.deepEqual(registeredRoutes.map(({ path, auth, match }) => ({ path, auth, match })), [
    { path: "/thunderclaw/pairing/v1", auth: "plugin", match: "prefix" },
    { path: "/thunderclaw/v1", auth: "plugin", match: "prefix" },
  ]);
  assert.deepEqual(gatewayMethods, [
    { name: "thunderclaw.pairing.status", scope: "operator.read" },
    { name: "thunderclaw.pairing.requests", scope: "operator.read" },
    { name: "thunderclaw.pairing.approve", scope: "operator.admin" },
    { name: "thunderclaw.pairing.deny", scope: "operator.admin" },
    { name: "thunderclaw.devices.list", scope: "operator.read" },
    { name: "thunderclaw.devices.revoke", scope: "operator.admin" },
  ]);
  assert.equal(currentCalls, 0, "registration must not capture a runtime config snapshot");
  assert.equal(legacyConfigReads, 0);
  provisionDevice(stateDir);

  const server = createServer((request, response) => { void handler!(request, response); });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/thunderclaw/v1`;
  const headers = { authorization: `Bearer ${deviceCredential}` };

  const first = await fetch(`${baseUrl}/agents?requestId=config-a`, { headers });
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { agents: Array<{ model: string }> }).agents[0]?.model, "model-a");
  assert.equal(currentCalls, 1, "agent discovery captures exactly one snapshot");

  current = snapshotB;
  const second = await fetch(`${baseUrl}/agents?requestId=config-b`, { headers });
  assert.equal(second.status, 200);
  assert.equal((await second.json() as { agents: Array<{ model: string }> }).agents[0]?.model, "model-b");
  assert.equal(currentCalls, 2, "the next operation must observe the replacement object");
  assert.equal(legacyConfigReads, 0);
  CompatibilityStore.open(stateDir).close();
  PairingRegistry.open(stateDir).close();
});

test("embedded probe nested plugin registration reuses the active process store", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "thunderclaw-plugin-nested-test-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const snapshot = runtimeConfig("model-a");
  const handlers: OpenClawPluginHttpRouteHandler[] = [];
  const gatewayMethods: string[] = [];
  let nestedRegistration = false;
  let primaryCalls = 0;
  let markNestedReady: (() => void) | undefined;
  const nestedReady = new Promise<void>((resolve) => { markNestedReady = resolve; });
  let releaseFirstPrimary: (() => void) | undefined;
  const firstPrimaryReleased = new Promise<void>((resolve) => { releaseFirstPrimary = resolve; });
  let api: OpenClawPluginApi;
  const runEmbeddedAgent = async (params: Parameters<OpenClawPluginApi["runtime"]["agent"]["runEmbeddedAgent"]>[0]) => {
    if (params.prompt.startsWith("This is a ThunderClaw compatibility probe")) {
      primaryCalls += 1;
      if (!nestedRegistration) {
        nestedRegistration = true;
        plugin.register?.(api);
        markNestedReady?.();
        await firstPrimaryReleased;
      }
      const nonce = params.prompt.match(/"nonce":"([^"]+)"/u)?.[1];
      assert.ok(nonce);
      return {
        payloads: [],
        meta: {
          durationMs: 1,
          finalAssistantRawText: JSON.stringify({ version: 1, nonce, status: "ok" }),
          agentMeta: { provider: "provider", model: "model-a" },
          toolSummary: { calls: 0, tools: [] },
        },
      } as never;
    }
    params.onExecutionPhase?.({ phase: "model_call_started" } as never);
    await new Promise<void>((resolve) => {
      if (params.abortSignal?.aborted) resolve();
      else params.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return {
      payloads: [],
      meta: {
        durationMs: 51,
        aborted: true,
        agentMeta: { provider: "provider", model: "model-a" },
        toolSummary: { calls: 0, tools: [] },
      },
    } as never;
  };
  api = {
    registrationMode: "full",
    pluginConfig: {},
    runtime: {
      version: "test",
      config: { current: () => snapshot },
      state: { resolveStateDir: () => stateDir },
      agent: {
        runEmbeddedAgent,
        resolveAgentWorkspaceDir: () => "/tmp/synthetic-workspace",
        resolveThinkingPolicy: () => ({ levels: [], defaultLevel: null }),
      },
    },
    registerHttpRoute: (route: { path: string; handler: OpenClawPluginHttpRouteHandler }) => {
      if (route.path === "/thunderclaw/v1") handlers.push(route.handler);
    },
    registerGatewayMethod: (name: string) => { gatewayMethods.push(name); },
    registerCli: () => {},
  } as unknown as OpenClawPluginApi;
  plugin.register?.(api);
  assert.equal(handlers.length, 1);
  assert.equal(gatewayMethods.length, 6);
  provisionDevice(stateDir);

  const server = createServer((request, response) => { void handlers.at(-1)!(request, response); });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const probe = (requestId: string, probeRunId: string) => fetch(`http://127.0.0.1:${address.port}/thunderclaw/v1/agents/probe`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${deviceCredential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocolVersion: 1,
      requestId,
      probeRunId,
      agentId: "main",
    }),
  });
  const firstPending = probe("nested-registration-request", "nested-registration-run");
  await nestedReady;
  assert.equal(handlers.length, 2, "the embedded run must actually re-register the plugin");
  assert.equal(gatewayMethods.length, 12, "nested registration must re-register operator administration");
  const overlap = await probe("nested-overlap-request", "nested-overlap-run");
  releaseFirstPrimary?.();
  const response = await firstPending;
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json() as { agent: { compatibility: { state: string } } }).agent.compatibility.state,
    "verified",
  );
  assert.equal(overlap.status, 400);
  assert.equal(
    (await overlap.json() as { error: { code: string } }).error.code,
    "PROBE_ALREADY_ACTIVE",
    "a replacement route must share process-wide active-probe exclusion with the in-flight route",
  );
  assert.equal(primaryCalls, 1, "overlap rejection must happen before another model call");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  CompatibilityStore.open(stateDir).close();
  PairingRegistry.open(stateDir).close();
});

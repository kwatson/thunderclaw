import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { discoverThunderClawAgents, type AgentProbeResult } from "../packages/openclaw-plugin/src/agents.js";
import { CompatibilityStore } from "../packages/openclaw-plugin/src/compatibility-store.js";
import { createAgentCompatibilityFingerprint } from "../packages/openclaw-plugin/src/compatibility-fingerprint.js";
import { runAgentCompatibilityProbe } from "../packages/openclaw-plugin/src/probe.js";
import { PairingRegistryAuthenticationError, type DeviceCapability } from "../packages/openclaw-plugin/src/pairing-registry.js";
import {
  createRouteOperationalState,
  createThunderClawRoute,
  getProcessRouteOperationalState,
  type RouteOptions,
} from "../packages/openclaw-plugin/src/route.js";

const allowDevice: RouteOptions["authenticateDevice"] = () => ({
  credentialId: "route-test-device",
}) as never;
const config = {
  agents: {
    defaults: { model: { primary: "deepseek/deepseek-v4-pro" } },
    entries: { main: { default: true, name: "main" } },
  },
} as OpenClawPluginApi["config"];

const composeBase = {
  protocolVersion: 1,
  requestId: "open-request-1",
  composeId: "compose-1",
  composeGeneration: 1,
  agentId: "main",
};

const transformRequest = {
  ...composeBase,
  requestId: "transform-request-1",
  runId: "run-1",
  action: "improve",
  instruction: "Make it concise.",
  contextHash: "context-hash",
  targetHash: "target-hash",
  document: {
    subject: "Synthetic test",
    recipients: ["person@example.test"],
    authoredText: "Original sentence.",
  },
  target: {
    targetId: "target-1",
    text: "Original sentence.",
    start: 0,
    end: 18,
  },
  limits: { maxOperations: 1, maxOutputCharacters: 4000 },
};

function messageRequest(suffix = "1") {
  return {
    protocolVersion: 1 as const,
    requestId: `message-request-${suffix}`,
    runId: `message-run-${suffix}`,
    agentId: "main",
    action: "translate" as const,
    sourceLanguage: null,
    targetLanguage: "English",
    messageHash: `message-hash-${suffix}`,
    document: { subject: "Bonjour", author: "sender@example.test", segments: [{ id: "segment-0", text: "Bonjour" }] },
    limits: { maxSegments: 10, maxOutputCharacters: 4000 },
  };
}

function messageEnvelope(request: ReturnType<typeof messageRequest>, text = "Hello"): string {
  return JSON.stringify({
    version: 1,
    requestId: request.requestId,
    messageHash: request.messageHash,
    action: request.action,
    detectedLanguage: "fr",
    targetLanguage: request.targetLanguage,
    segments: [{ id: "segment-0", text }],
    summary: null,
  });
}

function editEnvelopeFor(request: typeof transformRequest, text: string): string {
  return JSON.stringify({
    version: 1,
    requestId: request.requestId,
    composeGeneration: request.composeGeneration,
    contextHash: request.contextHash,
    targetHash: request.targetHash,
    operations: [{
      type: "replace_text_range",
      targetId: request.target.targetId,
      start: request.target.start,
      end: request.target.end,
      text,
    }],
    summary: "Synthetic edit.",
  });
}

function editEnvelope(text: string): string {
  return editEnvelopeFor(transformRequest, text);
}

function agentResult(text: string, aborted = false) {
  return {
    payloads: [],
    meta: {
      durationMs: 1,
      aborted,
      finalAssistantRawText: text,
      agentMeta: { provider: "deepseek", model: "deepseek-v4-pro" },
      toolSummary: { calls: 0, tools: [] },
    },
  } as never;
}

function agentResultWithVisibleText(rawText: string, visibleText: string) {
  return {
    payloads: [],
    meta: {
      durationMs: 1,
      finalAssistantRawText: rawText,
      finalAssistantVisibleText: visibleText,
      agentMeta: { provider: "deepseek", model: "deepseek-v4-pro" },
      toolSummary: { calls: 0, tools: [] },
    },
  } as never;
}

async function startComposeRoute(
  context: TestContext,
  runAgent: RouteOptions["runAgent"],
  overrides: Partial<RouteOptions> & { config?: OpenClawPluginApi["config"] } = {},
  seedCompatibility = true,
): Promise<string> {
  const selectedConfig = overrides.config ?? config;
  const { config: _testConfig, ...routeOverrides } = overrides;
  const compatibilityStore = await createCompatibilityStore(
    context,
    seedCompatibility ? selectedConfig : undefined,
  );
  const handler = createThunderClawRoute({
    authenticateDevice: allowDevice,
    runtimeVersion: "test",
    getConfig: routeOverrides.getConfig ?? (() => selectedConfig),
    sessionTtlMs: 60_000,
    maxRequestBytes: 64_000,
    listAgents: (currentConfig, probeResults) =>
      discoverThunderClawAgents(
        currentConfig,
        { resolveThinkingPolicy: () => ({ levels: [], defaultLevel: null }) },
        probeResults,
      ),
    probeAgent: async () => {
      throw new Error("probe should not run in compose repair tests");
    },
    compatibilityStore,
    createSessionManager: () => ({}) as never,
    resolveWorkspaceDir: () => "/tmp/synthetic-workspace",
    runAgent,
    ...routeOverrides,
  });
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}/thunderclaw/v1`;
}

function probeEvidence(agentId: string, configurationFingerprint: string): AgentProbeResult {
  return {
    agentId,
    configurationFingerprint,
    configuredProvider: "deepseek",
    configuredModel: "deepseek-v4-pro",
    observedProvider: "deepseek",
    observedModel: "deepseek-v4-pro",
    testedAt: "2026-08-08T00:00:00.000Z",
    state: "verified",
    checks: {
      credentials: "passed",
      structuredOutput: "passed",
      toolIsolation: "passed",
      cancellation: "passed",
      fallbacks: "not_applicable",
    },
    reason: "Restricted compatibility checks passed.",
  };
}

async function createCompatibilityStore(
  context: TestContext,
  seedConfig?: OpenClawPluginApi["config"],
): Promise<CompatibilityStore> {
  const stateDir = await mkdtemp(join(tmpdir(), "thunderclaw-route-test-"));
  const store = CompatibilityStore.open(stateDir);
  assert.equal(store.isAvailable, true);
  if (seedConfig) {
    const agents = discoverThunderClawAgents(
      seedConfig,
      { resolveThinkingPolicy: () => ({ levels: [], defaultLevel: null }) },
    );
    for (const agent of agents) {
      if (!agent.provider || !agent.model) continue;
      const fingerprint = createAgentCompatibilityFingerprint(seedConfig, agent.agentId);
      const result = {
        ...probeEvidence(agent.agentId, fingerprint),
        configuredProvider: agent.provider,
        configuredModel: agent.model,
        observedProvider: agent.provider,
        observedModel: agent.model,
      };
      store.startAttempt(`seed-${agent.agentId}`, agent.agentId, fingerprint);
      store.finishAttempt(`seed-${agent.agentId}`, agent.agentId, fingerprint, "completed", result);
    }
  }
  context.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  return store;
}

async function post(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("probe endpoint stores evidence returned by agent discovery", async (context) => {
  const probeResult: AgentProbeResult = {
    agentId: "main",
    configurationFingerprint: "",
    configuredProvider: "deepseek",
    configuredModel: "deepseek-v4-pro",
    observedProvider: "deepseek",
    observedModel: "deepseek-v4-pro",
    testedAt: "2026-08-05T00:00:00.000Z",
    state: "verified",
    checks: {
      credentials: "passed",
      structuredOutput: "passed",
      toolIsolation: "passed",
      cancellation: "passed",
      fallbacks: "not_applicable",
    },
    reason: "Restricted compatibility checks passed.",
  };
  const compatibilityStore = await createCompatibilityStore(context);
  const handler = createThunderClawRoute({
    authenticateDevice: allowDevice,
    runtimeVersion: "test",
    getConfig: () => config,
    sessionTtlMs: 60_000,
    maxRequestBytes: 64_000,
    listAgents: (currentConfig, probeResults) =>
      discoverThunderClawAgents(
        currentConfig,
        {
          resolveThinkingPolicy: () => ({ levels: [], defaultLevel: null }),
        },
        probeResults,
      ),
    compatibilityStore,
    probeAgent: async (_config, _agentId, configurationFingerprint) => ({
      ...probeResult,
      configurationFingerprint,
    }),
    createSessionManager: () => ({}) as never,
    resolveWorkspaceDir: () => "/tmp/synthetic-workspace",
    runAgent: async () => {
      throw new Error("compose agent should not run in this test");
    },
  });
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/thunderclaw/v1`;

  const probeResponse = await fetch(`${baseUrl}/agents/probe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocolVersion: 1,
      requestId: "probe-request-1",
      probeRunId: "probe-run-1",
      agentId: "main",
    }),
  });
  assert.equal(probeResponse.status, 200);
  const probeBody = await probeResponse.json() as {
    requestId: string;
    agent: { compatibility: { state: string } };
  };
  assert.equal(probeBody.requestId, "probe-request-1");
  assert.equal(probeBody.agent.compatibility.state, "verified");

  const listResponse = await fetch(`${baseUrl}/agents?requestId=list-request-1`, {
  });
  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.json() as {
    agents: Array<{ compatibility: { state: string; lastProbe: unknown } }>;
  };
  assert.equal(listBody.agents[0]?.compatibility.state, "verified");
  assert.deepEqual(listBody.agents[0]?.compatibility.lastProbe, {
    testedAt: probeResult.testedAt,
    observedProvider: "deepseek",
    observedModel: "deepseek-v4-pro",
  });
});

test("agent discovery uses the current replacement config and invalidates stale evidence", async (context) => {
  const initialConfig = config;
  let currentConfig = initialConfig;
  let modelCalls = 0;
  const baseUrl = await startComposeRoute(context, async () => {
    modelCalls += 1;
    return agentResult("unused");
  }, {
    config: initialConfig,
    getConfig: () => currentConfig,
  });
  const before = await fetch(`${baseUrl}/agents?requestId=list-before-replace`, {
  });
  const beforeBody = await before.json() as { agents: Array<{ model: string; compatibility: { state: string } }> };
  assert.equal(beforeBody.agents[0]?.model, "deepseek-v4-pro");
  assert.equal(beforeBody.agents[0]?.compatibility.state, "verified");

  currentConfig = {
    agents: {
      defaults: { model: { primary: "deepseek/replacement-model" } },
      entries: { main: { default: true, name: "Replacement" } },
    },
  } as OpenClawPluginApi["config"];
  const after = await fetch(`${baseUrl}/agents?requestId=list-after-replace`, {
  });
  const afterBody = await after.json() as { agents: Array<{ model: string; compatibility: { state: string } }> };
  assert.equal(afterBody.agents[0]?.model, "replacement-model");
  assert.equal(afterBody.agents[0]?.compatibility.state, "unverified");

  const blocked = await post(baseUrl, "/message/transform", messageRequest("stale-config"));
  assert.equal((await blocked.json() as { error: { code: string } }).error.code, "AGENT_NOT_COMPATIBLE");
  const blockedCompose = await post(baseUrl, "/compose/open", composeBase);
  assert.equal((await blockedCompose.json() as { error: { code: string } }).error.code, "AGENT_NOT_COMPATIBLE");
  assert.equal(modelCalls, 0);
});

test("unavailable runtime config fails closed before feature model calls", async (context) => {
  let modelCalls = 0;
  let listCalls = 0;
  let probeCalls = 0;
  let workspaceCalls = 0;
  const baseUrl = await startComposeRoute(context, async () => {
    modelCalls += 1;
    return agentResult("unused");
  }, {
    getConfig: () => { throw new Error("synthetic unavailable config"); },
    listAgents: () => {
      listCalls += 1;
      return [];
    },
    probeAgent: async () => {
      probeCalls += 1;
      throw new Error("probe must not run");
    },
    resolveWorkspaceDir: () => {
      workspaceCalls += 1;
      return "/tmp/should-not-resolve";
    },
  });
  const agents = await fetch(`${baseUrl}/agents?requestId=config-unavailable-list`, {
  });
  assert.equal(agents.status, 503);
  const message = await post(baseUrl, "/message/transform", messageRequest("config-unavailable"));
  assert.equal(message.status, 503);
  assert.equal((await message.json() as { error: { code: string } }).error.code, "CONFIG_UNAVAILABLE");
  const compose = await post(baseUrl, "/compose/open", composeBase);
  assert.equal(compose.status, 503);
  const probe = await post(baseUrl, "/agents/probe", {
    protocolVersion: 1,
    requestId: "config-unavailable-probe-request",
    probeRunId: "config-unavailable-probe-run",
    agentId: "main",
  });
  assert.equal(probe.status, 503);
  assert.deepEqual(
    { modelCalls, listCalls, probeCalls, workspaceCalls },
    { modelCalls: 0, listCalls: 0, probeCalls: 0, workspaceCalls: 0 },
    "a failed snapshot getter must precede every config-derived or model operation",
  );
});

test("successful probe responds from the same post-run config snapshot", async (context) => {
  const initialConfig = config;
  const replacementConfig = {
    agents: {
      defaults: { model: { primary: "deepseek/deepseek-v4-pro" } },
      entries: { main: { default: true, name: "Replacement Name" } },
    },
  } as OpenClawPluginApi["config"];
  let currentConfig = initialConfig;
  const baseUrl = await startComposeRoute(context, async () => agentResult("unused"), {
    config: initialConfig,
    getConfig: () => currentConfig,
    probeAgent: async (probeConfig, agentId, fingerprint) => {
      assert.equal(probeConfig, initialConfig);
      currentConfig = replacementConfig;
      return probeEvidence(agentId, fingerprint);
    },
  }, false);
  const response = await post(baseUrl, "/agents/probe", {
    protocolVersion: 1,
    requestId: "request-response-snapshot",
    probeRunId: "run-response-snapshot",
    agentId: "main",
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { agent: { displayName: string; compatibility: { state: string } } };
  assert.equal(body.agent.displayName, "Replacement Name");
  assert.equal(body.agent.compatibility.state, "verified");
});

test("process route state is normalized per state directory and isolated across directories", () => {
  const first = getProcessRouteOperationalState("/tmp/thunderclaw-route-state-a");
  assert.equal(first, getProcessRouteOperationalState("/tmp/thunderclaw-route-state-a/."));
  assert.notEqual(first, getProcessRouteOperationalState("/tmp/thunderclaw-route-state-b"));
});

test("product endpoints authenticate with their explicit device capabilities", async (context) => {
  const capabilities: DeviceCapability[] = [];
  const baseUrl = await startComposeRoute(context, async () => agentResult("unused"), {
    authenticateDevice: (_request, capability) => {
      capabilities.push(capability);
      return { credentialId: "capability-test-device" } as never;
    },
  });

  await fetch(`${baseUrl}/status`);
  await fetch(`${baseUrl}/agents?requestId=capability-list`);
  await post(baseUrl, "/agents/probe", {});
  await post(baseUrl, "/message/transform", {});
  await post(baseUrl, "/compose/open", {});
  await fetch(`${baseUrl}/unknown`);
  await fetch(`${baseUrl}/status`, { method: "PUT" });

  assert.deepEqual(capabilities, [
    "status:read",
    "agents:read",
    "agents:probe",
    "message:transform",
    "compose:transform",
    "status:read",
    "status:read",
  ]);
});

test("device authentication errors preserve the backend code with a sanitized 401", async (context) => {
  const baseUrl = await startComposeRoute(context, async () => agentResult("unused"), {
    authenticateDevice: () => {
      throw new PairingRegistryAuthenticationError("CREDENTIAL_REVOKED");
    },
  });
  const response = await fetch(`${baseUrl}/status`);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: { code: "CREDENTIAL_REVOKED", message: "device authentication failed" },
  });
});

test("paired devices cannot observe compose state or cancel message runs owned by another device", async (context) => {
  let markMessageStarted: (() => void) | undefined;
  const messageStarted = new Promise<void>((resolve) => { markMessageStarted = resolve; });
  let releaseMessage: (() => void) | undefined;
  const messageReleased = new Promise<void>((resolve) => { releaseMessage = resolve; });
  let messageCalls = 0;
  const baseUrl = await startComposeRoute(context, async (params) => {
    if (params.sessionId.startsWith("thunderclaw:message:")) {
      messageCalls += 1;
      if (messageCalls === 1) {
        markMessageStarted?.();
        await messageReleased;
      }
      return agentResult(messageEnvelope(messageRequest("device-isolation")));
    }
    return agentResult(editEnvelope("isolated compose"));
  }, {
    authenticateDevice: (request) => ({
      credentialId: String(request.headers["x-test-device"]),
    }) as never,
  });
  const postAs = (device: string, path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-device": device },
    body: JSON.stringify(body),
  });

  const openedA = await postAs("device-a", "/compose/open", composeBase);
  assert.equal(openedA.status, 201);
  const guessedClose = await postAs("device-b", "/compose/close", {
    ...composeBase,
    requestId: "device-b-guessed-close",
  });
  assert.equal((await guessedClose.json() as { error: { code: string } }).error.code, "COMPOSE_NOT_OPEN");
  const openedB = await postAs("device-b", "/compose/open", {
    ...composeBase,
    requestId: "device-b-open",
  });
  assert.equal(openedB.status, 201);
  assert.notEqual(
    (await openedA.json() as { sessionId: string }).sessionId,
    (await openedB.clone().json() as { sessionId: string }).sessionId,
  );
  assert.equal((await postAs("device-a", "/compose/close", composeBase)).status, 200);
  const stillOpenB = await postAs("device-b", "/compose/open", {
    ...composeBase,
    requestId: "device-b-still-open",
  });
  assert.equal(stillOpenB.status, 200);

  const message = messageRequest("device-isolation");
  const pendingA = postAs("device-a", "/message/transform", message);
  await messageStarted;
  const guessedCancel = await postAs("device-b", "/message/cancel", {
    protocolVersion: 1,
    requestId: "device-b-guessed-message-cancel",
    transformRequestId: message.requestId,
    runId: message.runId,
    messageHash: message.messageHash,
  });
  assert.equal((await guessedCancel.json() as { error: { code: string } }).error.code, "RUN_NOT_ACTIVE");
  assert.equal((await postAs("device-b", "/message/transform", message)).status, 200);
  releaseMessage?.();
  assert.equal((await pendingA).status, 200);
});

test("paired devices isolate active probe identity and persisted attempt identity", async (context) => {
  let markFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  let releaseFirst: (() => void) | undefined;
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const baseUrl = await startComposeRoute(context, async () => agentResult("unused"), {
    authenticateDevice: (request) => ({
      credentialId: String(request.headers["x-test-device"]),
    }) as never,
    probeAgent: async (_config, agentId, fingerprint) => {
      calls += 1;
      if (calls === 1) {
        markFirstStarted?.();
        await firstReleased;
      }
      return probeEvidence(agentId, fingerprint);
    },
  }, false);
  const postAs = (device: string, path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-device": device },
    body: JSON.stringify(body),
  });
  const probe = {
    protocolVersion: 1,
    requestId: "device-shared-probe-request",
    probeRunId: "device-shared-probe-run",
    agentId: "main",
  };

  const pendingA = postAs("device-a", "/agents/probe", probe);
  await firstStarted;
  const guessedCancel = await postAs("device-b", "/agents/probe/cancel", {
    ...probe,
    requestId: "device-b-guessed-probe-cancel",
  });
  assert.equal((await guessedCancel.json() as { error: { code: string } }).error.code, "PROBE_NOT_ACTIVE");
  assert.equal((await postAs("device-b", "/agents/probe", probe)).status, 200);
  const cancelA = await postAs("device-a", "/agents/probe/cancel", {
    ...probe,
    requestId: "device-a-probe-cancel",
  });
  assert.equal(cancelA.status, 202);
  releaseFirst?.();
  assert.equal((await pendingA).status, 400);
  await new Promise((resolve) => setImmediate(resolve));
});

test("maximum-length device and probe identities use a bounded persisted attempt key", async (context) => {
  const credentialId = "c".repeat(64);
  const probeRunId = "p".repeat(128);
  const baseUrl = await startComposeRoute(context, async () => agentResult("unused"), {
    authenticateDevice: () => ({ credentialId }) as never,
    probeAgent: async (_config, agentId, fingerprint) => probeEvidence(agentId, fingerprint),
  }, false);
  const response = await post(baseUrl, "/agents/probe", {
    protocolVersion: 1,
    requestId: "maximum-length-probe-request",
    probeRunId,
    agentId: "main",
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { probeRunId: string }).probeRunId, probeRunId);
});

test("replacement handlers share message, compose, cancellation, capacity, and tombstone state", async (context) => {
  const operationalState = createRouteOperationalState();
  let activeStarted: (() => void) | undefined;
  let activeKind: "message" | "compose" = "message";
  const started = () => new Promise<void>((resolve) => { activeStarted = resolve; });
  let waitForStart = started();
  let oldHandlerCalls = 0;
  let replacementHandlerCalls = 0;
  const oldBaseUrl = await startComposeRoute(context, async (params) => {
    oldHandlerCalls += 1;
    activeStarted?.();
    await new Promise<void>((resolve) => {
      if (params.abortSignal?.aborted) resolve();
      else params.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return agentResult("", true);
  }, {
    operationalState,
    maxActiveMessageRuns: 1,
  });
  const replacementBaseUrl = await startComposeRoute(context, async () => {
    replacementHandlerCalls += 1;
    return activeKind === "message"
      ? agentResult(messageEnvelope(messageRequest("unexpected")))
      : agentResult(editEnvelope("unexpected"));
  }, {
    operationalState,
    maxActiveMessageRuns: 1,
  });

  const message = messageRequest("shared-handler");
  const pendingMessage = post(oldBaseUrl, "/message/transform", message);
  await waitForStart;
  const capacity = await post(replacementBaseUrl, "/message/transform", messageRequest("shared-capacity"));
  assert.equal(capacity.status, 400);
  assert.equal((await capacity.json() as { error: { code: string } }).error.code, "RUN_ALREADY_ACTIVE");
  const messageCancel = await post(replacementBaseUrl, "/message/cancel", {
    protocolVersion: 1,
    requestId: "shared-message-cancel",
    transformRequestId: message.requestId,
    runId: message.runId,
    messageHash: message.messageHash,
  });
  assert.equal(messageCancel.status, 202);
  assert.equal((await pendingMessage).status, 400);

  const opened = await post(oldBaseUrl, "/compose/open", composeBase);
  assert.equal(opened.status, 201);
  const duplicate = await post(replacementBaseUrl, "/compose/open", {
    ...composeBase,
    requestId: "shared-duplicate-open",
  });
  assert.equal(duplicate.status, 200);
  assert.equal(
    (await duplicate.json() as { sessionId: string }).sessionId,
    (await opened.json() as { sessionId: string }).sessionId,
  );

  activeKind = "compose";
  waitForStart = started();
  const pendingCompose = post(oldBaseUrl, "/compose/transform", transformRequest);
  await waitForStart;
  const composeCancel = await post(replacementBaseUrl, "/compose/cancel", {
    ...composeBase,
    requestId: "shared-compose-cancel",
    runId: transformRequest.runId,
  });
  assert.equal(composeCancel.status, 202);
  assert.equal((await pendingCompose).status, 400);

  const close = await post(replacementBaseUrl, "/compose/close", {
    ...composeBase,
    requestId: "shared-compose-close",
  });
  assert.equal(close.status, 200);
  const repeatedClose = await post(oldBaseUrl, "/compose/close", {
    ...composeBase,
    requestId: "shared-compose-close-again",
  });
  assert.equal(repeatedClose.status, 200);
  const staleReopen = await post(replacementBaseUrl, "/compose/open", {
    ...composeBase,
    requestId: "shared-compose-stale-reopen",
  });
  assert.equal(staleReopen.status, 400);
  assert.equal((await staleReopen.json() as { error: { code: string } }).error.code, "STALE_COMPOSE_GENERATION");
  assert.equal(oldHandlerCalls, 2);
  assert.equal(replacementHandlerCalls, 0);
});

test("replacement handlers share probe capacity, exact cancellation, and late-settlement fencing", async (context) => {
  const multiAgentConfig = {
    agents: {
      defaults: { model: { primary: "deepseek/deepseek-v4-pro" } },
      entries: { main: { default: true }, other: {} },
    },
  } as OpenClawPluginApi["config"];
  const operationalState = createRouteOperationalState();
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let releaseLate: (() => void) | undefined;
  const lateSettlement = new Promise<void>((resolve) => { releaseLate = resolve; });
  let oldCalls = 0;
  let replacementCalls = 0;
  const oldBaseUrl = await startComposeRoute(context, async () => agentResult("unused"), {
    config: multiAgentConfig,
    operationalState,
    maxActiveProbes: 1,
    probeAgent: async () => {
      oldCalls += 1;
      markStarted?.();
      await lateSettlement;
      throw new Error("synthetic late cancellation settlement");
    },
  }, false);
  const replacementBaseUrl = await startComposeRoute(context, async () => agentResult("unused"), {
    config: multiAgentConfig,
    operationalState,
    maxActiveProbes: 1,
    probeAgent: async (_config, agentId, fingerprint) => {
      replacementCalls += 1;
      return probeEvidence(agentId, fingerprint);
    },
  }, false);

  const pending = post(oldBaseUrl, "/agents/probe", {
    protocolVersion: 1,
    requestId: "shared-probe-request",
    probeRunId: "shared-probe-run",
    agentId: "main",
  });
  await started;
  const capacity = await post(replacementBaseUrl, "/agents/probe", {
    protocolVersion: 1,
    requestId: "shared-probe-capacity-request",
    probeRunId: "shared-probe-capacity-run",
    agentId: "other",
  });
  assert.equal(capacity.status, 400);
  assert.equal((await capacity.json() as { error: { code: string } }).error.code, "PROBE_CAPACITY_EXCEEDED");
  assert.equal(replacementCalls, 0);

  const cancel = await post(replacementBaseUrl, "/agents/probe/cancel", {
    protocolVersion: 1,
    requestId: "shared-probe-cancel-request",
    probeRunId: "shared-probe-run",
    agentId: "main",
  });
  assert.equal(cancel.status, 202);
  assert.equal((await pending).status, 400);
  const stillFenced = await post(replacementBaseUrl, "/agents/probe", {
    protocolVersion: 1,
    requestId: "shared-probe-still-fenced-request",
    probeRunId: "shared-probe-still-fenced-run",
    agentId: "other",
  });
  assert.equal((await stillFenced.json() as { error: { code: string } }).error.code, "PROBE_CAPACITY_EXCEEDED");

  releaseLate?.();
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = await post(replacementBaseUrl, "/agents/probe", {
    protocolVersion: 1,
    requestId: "shared-probe-recovered-request",
    probeRunId: "shared-probe-recovered-run",
    agentId: "other",
  });
  assert.equal(recovered.status, 200);
  assert.equal(oldCalls, 1);
  assert.equal(replacementCalls, 1);
});

test("compose session cannot cross a replacement config object", async (context) => {
  const initialConfig = config;
  const replacementConfig = {
    agents: {
      defaults: { model: { primary: "deepseek/deepseek-v4-pro" } },
      entries: { main: { default: true, name: "same fingerprint" } },
    },
  } as OpenClawPluginApi["config"];
  let currentConfig = initialConfig;
  let calls = 0;
  const baseUrl = await startComposeRoute(context, async () => {
    calls += 1;
    return agentResult(editEnvelope("should not run"));
  }, {
    config: initialConfig,
    getConfig: () => currentConfig,
  });
  assert.equal((await post(baseUrl, "/compose/open", composeBase)).status, 201);
  currentConfig = replacementConfig;
  const response = await post(baseUrl, "/compose/transform", transformRequest);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "AGENT_CONFIGURATION_CHANGED");
  assert.equal(calls, 0);
  const close = await post(baseUrl, "/compose/close", { ...composeBase, requestId: "close-after-config-change" });
  assert.equal(close.status, 200);
});

test("duplicate compose open retires a replacement-bound generation and cannot reopen it", async (context) => {
  const initialConfig = config;
  const replacementConfig = {
    agents: {
      defaults: { model: { primary: "deepseek/deepseek-v4-pro" } },
      entries: { main: { default: true, name: "same fingerprint replacement" } },
    },
  } as OpenClawPluginApi["config"];
  let currentConfig = initialConfig;
  let calls = 0;
  const baseUrl = await startComposeRoute(context, async () => {
    calls += 1;
    return agentResult(editEnvelope("should not run"));
  }, {
    config: initialConfig,
    getConfig: () => currentConfig,
  });
  assert.equal((await post(baseUrl, "/compose/open", composeBase)).status, 201);
  currentConfig = replacementConfig;

  const duplicate = await post(baseUrl, "/compose/open", {
    ...composeBase,
    requestId: "duplicate-open-after-replacement",
  });
  assert.equal(duplicate.status, 400);
  assert.equal(
    (await duplicate.json() as { error: { code: string } }).error.code,
    "AGENT_CONFIGURATION_CHANGED",
  );

  const reopen = await post(baseUrl, "/compose/open", {
    ...composeBase,
    requestId: "reopen-retired-generation",
  });
  assert.equal(reopen.status, 400);
  assert.equal((await reopen.json() as { error: { code: string } }).error.code, "STALE_COMPOSE_GENERATION");

  for (const requestId of ["close-retired-generation", "close-retired-generation-again"]) {
    const close = await post(baseUrl, "/compose/close", { ...composeBase, requestId });
    assert.equal(close.status, 200);
    assert.equal((await close.json() as { closed: boolean }).closed, true);
  }
  assert.equal(calls, 0);
});

test("incompatible replacement retires the old compose session before compatibility lookup", async (context) => {
  const initialConfig = config;
  const replacementConfig = {
    agents: {
      defaults: { model: { primary: "deepseek/unverified-replacement" } },
      entries: { main: { default: true } },
    },
  } as OpenClawPluginApi["config"];
  let currentConfig = initialConfig;
  let calls = 0;
  const baseUrl = await startComposeRoute(context, async () => {
    calls += 1;
    return agentResult(editEnvelope("should not run"));
  }, {
    config: initialConfig,
    getConfig: () => currentConfig,
  });
  assert.equal((await post(baseUrl, "/compose/open", composeBase)).status, 201);
  currentConfig = replacementConfig;

  const transform = await post(baseUrl, "/compose/transform", transformRequest);
  assert.equal(transform.status, 400);
  assert.equal(
    (await transform.json() as { error: { code: string } }).error.code,
    "AGENT_CONFIGURATION_CHANGED",
  );
  const reopen = await post(baseUrl, "/compose/open", {
    ...composeBase,
    requestId: "reopen-after-incompatible-replacement",
  });
  assert.equal(reopen.status, 400);
  assert.equal((await reopen.json() as { error: { code: string } }).error.code, "STALE_COMPOSE_GENERATION");
  assert.equal(
    (await post(baseUrl, "/compose/close", { ...composeBase, requestId: "close-incompatible-replacement" })).status,
    200,
  );
  assert.equal(calls, 0);
});

test("mid-run replacement config discards compose and message results", async (context) => {
  const initialConfig = config;
  const replacementConfig = {
    agents: {
      defaults: { model: { primary: "deepseek/replacement-model" } },
      entries: { main: { default: true } },
    },
  } as OpenClawPluginApi["config"];
  let currentConfig = initialConfig;
  let release: (() => void) | undefined;
  let startedCount = 0;
  let markBothStarted: (() => void) | undefined;
  const bothStarted = new Promise<void>((resolve) => { markBothStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const message = messageRequest("replacement-mid-run");
  const baseUrl = await startComposeRoute(context, async (params) => {
    startedCount += 1;
    if (startedCount === 2) markBothStarted?.();
    await blocked;
    return params.runId === transformRequest.runId
      ? agentResult(editEnvelope("late compose"))
      : agentResult(messageEnvelope(message, "late message"));
  }, {
    config: initialConfig,
    getConfig: () => currentConfig,
  });
  assert.equal((await post(baseUrl, "/compose/open", composeBase)).status, 201);
  const compose = post(baseUrl, "/compose/transform", transformRequest);
  const messageRun = post(baseUrl, "/message/transform", message);
  await bothStarted;
  currentConfig = replacementConfig;
  release?.();
  for (const response of await Promise.all([compose, messageRun])) {
    const body = await response.json() as { error: { code: string } };
    assert.ok(body.error.code === "AGENT_NOT_COMPATIBLE" || body.error.code === "AGENT_CONFIGURATION_CHANGED");
  }
});

test("mid-repair compose replacement cannot cross config identity even with an unchanged fingerprint", async (context) => {
  const initialConfig = config;
  const replacementConfig = {
    agents: {
      defaults: { model: { primary: "deepseek/deepseek-v4-pro" } },
      entries: { main: { default: true, name: "Irrelevant display-name change" } },
    },
  } as OpenClawPluginApi["config"];
  assert.equal(
    createAgentCompatibilityFingerprint(initialConfig, "main"),
    createAgentCompatibilityFingerprint(replacementConfig, "main"),
    "the replacement intentionally changes no compatibility-relevant input",
  );
  let currentConfig = initialConfig;
  const calls: Parameters<RouteOptions["runAgent"]>[0][] = [];
  const baseUrl = await startComposeRoute(context, async (params) => {
    calls.push(params);
    assert.equal(params.config, initialConfig, "primary and repair must stay bound to snapshot A");
    if (calls.length === 1) {
      currentConfig = replacementConfig;
      return agentResult("malformed primary output");
    }
    return agentResult(editEnvelope("repair from snapshot A"));
  }, {
    config: initialConfig,
    getConfig: () => currentConfig,
  });
  assert.equal((await post(baseUrl, "/compose/open", composeBase)).status, 201);
  const unaffectedCompose = {
    ...composeBase,
    requestId: "open-unaffected-compose",
    composeId: "compose-unaffected",
  };
  assert.equal((await post(baseUrl, "/compose/open", unaffectedCompose)).status, 201);
  const response = await post(baseUrl, "/compose/transform", transformRequest);
  assert.equal(response.status, 400);
  assert.equal(
    (await response.json() as { error: { code: string } }).error.code,
    "AGENT_CONFIGURATION_CHANGED",
  );
  assert.equal(calls.length, 2);
  assert.equal(
    (await post(baseUrl, "/compose/close", { ...composeBase, requestId: "close-retired-compose" })).status,
    200,
    "retired compose close remains idempotent",
  );
  assert.equal(
    (await post(baseUrl, "/compose/close", { ...unaffectedCompose, requestId: "close-unaffected-compose" })).status,
    200,
    "identity-scoped retirement must not damage another compose session",
  );
});

test("workspace resolution and every model attempt share one operation snapshot", async (context) => {
  const snapshot = config;
  let workspaceConfig: OpenClawPluginApi["config"] | undefined;
  const message = messageRequest("snapshot-binding");
  const baseUrl = await startComposeRoute(context, async (params) => {
    assert.equal(params.config, snapshot);
    assert.equal(params.workspaceDir, "/tmp/snapshot-workspace");
    return agentResult(messageEnvelope(message));
  }, {
    config: snapshot,
    getConfig: () => snapshot,
    resolveWorkspaceDir: (currentConfig) => {
      workspaceConfig = currentConfig;
      return "/tmp/snapshot-workspace";
    },
  });
  assert.equal((await post(baseUrl, "/message/transform", message)).status, 200);
  assert.equal(workspaceConfig, snapshot);
});

test("stateless message repair stays on snapshot A while an irrelevant replacement becomes current", async (context) => {
  const snapshotA = config;
  const snapshotB = {
    agents: {
      defaults: { model: { primary: "deepseek/deepseek-v4-pro" } },
      entries: { main: { default: true, name: "New display name only" } },
    },
  } as OpenClawPluginApi["config"];
  assert.equal(
    createAgentCompatibilityFingerprint(snapshotA, "main"),
    createAgentCompatibilityFingerprint(snapshotB, "main"),
  );
  let currentConfig = snapshotA;
  const message = messageRequest("irrelevant-replacement-repair");
  const calls: Parameters<RouteOptions["runAgent"]>[0][] = [];
  const workspaceConfigs: OpenClawPluginApi["config"][] = [];
  const baseUrl = await startComposeRoute(context, async (params) => {
    calls.push(params);
    assert.equal(params.config, snapshotA);
    if (calls.length === 1) {
      currentConfig = snapshotB;
      return agentResult("malformed primary output");
    }
    return agentResult(messageEnvelope(message, "repaired without snapshot mixing"));
  }, {
    config: snapshotA,
    getConfig: () => currentConfig,
    resolveWorkspaceDir: (operationConfig) => {
      workspaceConfigs.push(operationConfig);
      return "/tmp/synthetic-workspace";
    },
  });
  const response = await post(baseUrl, "/message/transform", message);
  assert.equal(response.status, 200, "compatibility-irrelevant replacement does not stale a stateless result");
  assert.equal(calls.length, 2);
  assert.deepEqual(workspaceConfigs, [snapshotA]);
  assert.equal(calls[0]?.sessionManager, calls[1]?.sessionManager);
  assert.equal(calls[0]?.workspaceDir, calls[1]?.workspaceDir);
});

test("probe cancellation requires exact identity and fences a late successful completion", async (context) => {
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let releaseProbe: (() => void) | undefined;
  const released = new Promise<void>((resolve) => { releaseProbe = resolve; });
  const baseUrl = await startComposeRoute(context, async () => agentResult("unused"), {
    probeAgent: async (_config, agentId, fingerprint) => {
      markStarted?.();
      await released;
      return probeEvidence(agentId, fingerprint);
    },
  }, false);
  const request = {
    protocolVersion: 1,
    requestId: "probe-request-cancel",
    probeRunId: "probe-run-cancel",
    agentId: "main",
  };
  const invalidStart = await post(baseUrl, "/agents/probe", {
    ...request,
    requestId: request.probeRunId,
  });
  assert.equal((await invalidStart.json() as { error: { code: string } }).error.code, "INVALID_REQUEST");
  const pending = post(baseUrl, "/agents/probe", request);
  await started;
  const invalidCancel = await post(baseUrl, "/agents/probe/cancel", {
    ...request,
    requestId: request.probeRunId,
  });
  assert.equal((await invalidCancel.json() as { error: { code: string } }).error.code, "INVALID_REQUEST");
  const mismatch = await post(baseUrl, "/agents/probe/cancel", {
    ...request,
    requestId: "cancel-mismatch",
    probeRunId: "wrong-run",
  });
  assert.equal((await mismatch.json() as { error: { code: string } }).error.code, "PROBE_NOT_ACTIVE");
  const cancel = await post(baseUrl, "/agents/probe/cancel", {
    ...request,
    requestId: "cancel-exact",
  });
  assert.equal(cancel.status, 202);
  assert.deepEqual(await cancel.json(), {
    protocolVersion: 1,
    requestId: "cancel-exact",
    probeRunId: request.probeRunId,
    agentId: request.agentId,
    cancelled: true,
  });
  const cancelled = await pending;
  assert.equal((await cancelled.json() as { error: { code: string } }).error.code, "PROBE_CANCELLED");
  releaseProbe?.();
  await new Promise((resolve) => setImmediate(resolve));
  const listed = await fetch(`${baseUrl}/agents?requestId=list-after-cancel`, {
  });
  const listedBody = await listed.json() as { agents: Array<{ compatibility: { state: string } }> };
  assert.equal(listedBody.agents[0]?.compatibility.state, "unverified");
});

test("probe route enforces same-agent exclusion and the global cap", async (context) => {
  const multiAgentConfig = {
    agents: {
      defaults: { model: { primary: "deepseek/deepseek-v4-pro" } },
      entries: {
        one: { default: true },
        two: {},
        three: {},
      },
    },
  } as OpenClawPluginApi["config"];
  const baseUrl = await startComposeRoute(context, async () => agentResult("unused"), {
    config: multiAgentConfig,
    probeAgent: async (_config, agentId, fingerprint, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return probeEvidence(agentId, fingerprint);
    },
  }, false);
  const requestFor = (agentId: string) => ({
    protocolVersion: 1,
    requestId: `request-${agentId}`,
    probeRunId: `run-${agentId}`,
    agentId,
  });
  const first = post(baseUrl, "/agents/probe", requestFor("one"));
  const second = post(baseUrl, "/agents/probe", requestFor("two"));
  await new Promise((resolve) => setImmediate(resolve));
  const overlap = await post(baseUrl, "/agents/probe", { ...requestFor("one"), probeRunId: "run-one-overlap" });
  assert.equal((await overlap.json() as { error: { code: string } }).error.code, "PROBE_ALREADY_ACTIVE");
  const capacity = await post(baseUrl, "/agents/probe", requestFor("three"));
  assert.equal((await capacity.json() as { error: { code: string } }).error.code, "PROBE_CAPACITY_EXCEEDED");
  for (const agentId of ["one", "two"]) {
    assert.equal((await post(baseUrl, "/agents/probe/cancel", {
      ...requestFor(agentId),
      requestId: `cancel-${agentId}`,
    })).status, 202);
  }
  for (const response of await Promise.all([first, second])) {
    assert.equal((await response.json() as { error: { code: string } }).error.code, "PROBE_CANCELLED");
  }
});

test("mid-probe configuration changes supersede the attempt without committing evidence", async (context) => {
  const initialConfig = {
    agents: {
      defaults: { model: { primary: "deepseek/deepseek-v4-pro" } },
      entries: { main: { default: true } },
    },
  } as OpenClawPluginApi["config"];
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let currentConfig = initialConfig;
  const baseUrl = await startComposeRoute(context, async () => agentResult("unused"), {
    config: initialConfig,
    getConfig: () => currentConfig,
    probeAgent: async (_config, agentId, fingerprint) => {
      markStarted?.();
      await blocked;
      return probeEvidence(agentId, fingerprint);
    },
  }, false);
  const pending = post(baseUrl, "/agents/probe", {
    protocolVersion: 1,
    requestId: "request-superseded",
    probeRunId: "run-superseded",
    agentId: "main",
  });
  await started;
  currentConfig = {
    agents: {
      defaults: { model: { primary: "deepseek/changed-model" } },
      entries: { main: { default: true } },
    },
  } as OpenClawPluginApi["config"];
  release?.();
  const response = await pending;
  assert.equal((await response.json() as { error: { code: string } }).error.code, "PROBE_SUPERSEDED");
  const listed = await fetch(`${baseUrl}/agents?requestId=list-superseded`, {
  });
  const body = await listed.json() as { agents: Array<{ compatibility: { state: string } }> };
  assert.equal(body.agents[0]?.compatibility.state, "unverified");
});

test("probe hard deadline settles the request and exposes no late evidence", async (context) => {
  const baseUrl = await startComposeRoute(context, async () => agentResult("unused"), {
    probeDeadlineMs: 10,
    probeAgent: async () => new Promise<never>(() => undefined),
  }, false);
  const response = await post(baseUrl, "/agents/probe", {
    protocolVersion: 1,
    requestId: "request-deadline",
    probeRunId: "run-deadline",
    agentId: "main",
  });
  assert.equal(response.status, 408);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "PROBE_TIMEOUT");
  const listed = await fetch(`${baseUrl}/agents?requestId=list-deadline`, {
  });
  const body = await listed.json() as { agents: Array<{ compatibility: { state: string } }> };
  assert.equal(body.agents[0]?.compatibility.state, "unverified");
});

test("unexpected fallback in the cancellation check commits no compatibility evidence", async (context) => {
  let calls = 0;
  const baseUrl = await startComposeRoute(context, async () => agentResult("unused"), {
    probeAgent: (currentConfig, agentId, fingerprint, abortSignal) => runAgentCompatibilityProbe({
      agentId,
      configurationFingerprint: fingerprint,
      config: currentConfig,
      abortSignal,
      createSessionManager: () => ({}) as never,
      resolveWorkspaceDir: () => "/tmp/synthetic-workspace",
      runAgent: async (params) => {
        calls += 1;
        if (calls === 1) {
          const nonce = params.prompt.match(/"nonce":"([^"]+)"/)?.[1];
          return {
            payloads: [],
            meta: {
              durationMs: 1,
              finalAssistantRawText: JSON.stringify({ version: 1, nonce, status: "ok" }),
              agentMeta: { provider: "deepseek", model: "deepseek-v4-pro" },
              toolSummary: { calls: 0, tools: [] },
            },
          } as never;
        }
        params.onExecutionPhase?.({
          phase: "model_call_started",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          firstModelCallStarted: true,
        });
        await new Promise<void>((resolve) => params.abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
        return {
          payloads: [],
          meta: {
            durationMs: 1,
            aborted: true,
            executionTrace: { fallbackUsed: true },
          },
        } as never;
      },
    }),
  }, false);
  const response = await post(baseUrl, "/agents/probe", {
    protocolVersion: 1,
    requestId: "request-cancel-fallback",
    probeRunId: "run-cancel-fallback",
    agentId: "main",
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "PROBE_FAILED");
  assert.equal(calls, 2);

  const listed = await fetch(`${baseUrl}/agents?requestId=list-cancel-fallback`);
  const body = await listed.json() as { agents: Array<{ compatibility: { state: string; lastProbe: unknown } }> };
  assert.equal(body.agents[0]?.compatibility.state, "unverified");
  assert.equal(body.agents[0]?.compatibility.lastProbe, null);
});

test("probe deadline fences late evidence and retains capacity until an abort-ignoring runtime settles", async (context) => {
  const multiAgentConfig = {
    agents: {
      defaults: { model: { primary: "deepseek/deepseek-v4-pro" } },
      entries: { main: { default: true }, other: {} },
    },
  } as OpenClawPluginApi["config"];
  let calls = 0;
  let releaseFirst: (() => void) | undefined;
  const firstSettles = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const baseUrl = await startComposeRoute(context, async () => agentResult("unused"), {
    config: multiAgentConfig,
    maxActiveProbes: 1,
    probeDeadlineMs: 10,
    probeAgent: async (_config, agentId, fingerprint) => {
      calls += 1;
      if (calls === 1) {
        await firstSettles;
        return probeEvidence(agentId, fingerprint);
      }
      return probeEvidence(agentId, fingerprint);
    },
  }, false);
  const first = await post(baseUrl, "/agents/probe", {
    protocolVersion: 1,
    requestId: "request-stuck-deadline",
    probeRunId: "run-stuck-deadline",
    agentId: "main",
  });
  assert.equal(first.status, 408);

  const second = await post(baseUrl, "/agents/probe", {
    protocolVersion: 1,
    requestId: "request-after-deadline",
    probeRunId: "run-after-deadline",
    agentId: "other",
  });
  assert.equal(second.status, 400, "still-running model work must continue consuming bounded capacity");
  assert.equal((await second.json() as { error: { code: string } }).error.code, "PROBE_CAPACITY_EXCEEDED");
  assert.equal(calls, 1);

  releaseFirst?.();
  await new Promise((resolve) => setImmediate(resolve));
  const listed = await fetch(`${baseUrl}/agents?requestId=list-after-late-deadline`);
  const listedBody = await listed.json() as { agents: Array<{ agentId: string; compatibility: { state: string } }> };
  assert.equal(listedBody.agents.find((agent) => agent.agentId === "main")?.compatibility.state, "unverified");

  const recovered = await post(baseUrl, "/agents/probe", {
    protocolVersion: 1,
    requestId: "request-after-settlement",
    probeRunId: "run-after-settlement",
    agentId: "other",
  });
  assert.equal(recovered.status, 200, "capacity is released after the underlying model work settles");
  assert.equal(calls, 2);
});

test("transform repairs malformed output once in the same restricted session", async (context) => {
  const calls: Parameters<RouteOptions["runAgent"]>[0][] = [];
  const baseUrl = await startComposeRoute(context, async (params) => {
    calls.push(params);
    return calls.length === 1
      ? agentResult("This is not JSON.")
      : agentResult(editEnvelope("Revised sentence."));
  });

  assert.equal((await post(baseUrl, "/compose/open", composeBase)).status, 201);
  const response = await post(baseUrl, "/compose/transform", transformRequest);
  assert.equal(response.status, 200);
  const body = await response.json() as {
    result: { operations: Array<{ text: string }> };
    evidence: { repairAttempted: boolean };
  };
  assert.equal(body.result.operations[0]?.text, "Revised sentence.");
  assert.equal(body.evidence.repairAttempted, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.sessionId, calls[1]?.sessionId);
  assert.equal(calls[0]?.sessionManager, calls[1]?.sessionManager);
  assert.equal(calls[1]?.disableTools, true);
  assert.equal(calls[1]?.disableTrajectory, true);
  assert.equal(calls[0]?.thinkLevel, "low");
  assert.equal(calls[1]?.thinkLevel, "low");
  assert.equal(calls[0]?.trigger, "manual");
  assert.equal(calls[1]?.trigger, "manual");
  assert.match(calls[1]?.prompt ?? "", /bounded repair attempt 1 of 2/);
});

test("transform can recover on its second and final bounded repair", async (context) => {
  const calls: Parameters<RouteOptions["runAgent"]>[0][] = [];
  const baseUrl = await startComposeRoute(context, async (params) => {
    calls.push(params);
    return calls.length < 3 ? agentResult("Still not JSON.") : agentResult(editEnvelope("Recovered sentence."));
  });

  assert.equal((await post(baseUrl, "/compose/open", composeBase)).status, 201);
  const response = await post(baseUrl, "/compose/transform", transformRequest);
  assert.equal(response.status, 200);
  const body = await response.json() as { result: { operations: Array<{ text: string }> }; evidence: { repairAttempted: boolean } };
  assert.equal(body.result.operations[0]?.text, "Recovered sentence.");
  assert.equal(body.evidence.repairAttempted, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[2]?.runId, `${transformRequest.runId}:repair-2`);
  assert.match(calls[2]?.prompt ?? "", /bounded repair attempt 2 of 2/);
  assert.match(calls[2]?.prompt ?? "", /final permitted repair attempt/);
});

test("transform repairs paragraph prose when a rich instruction requires a bullet list", async (context) => {
  const request = {
    ...transformRequest,
    requestId: "transform-request-rich-bullets",
    runId: "run-rich-bullets",
    instruction: "convert to bullet list instead of paragraph",
    target: { ...transformRequest.target, selectionShape: "rich-blocks" as const },
  };
  const envelope = (blocks: unknown[]) => JSON.stringify({
    version: 1,
    requestId: request.requestId,
    composeGeneration: request.composeGeneration,
    contextHash: request.contextHash,
    targetHash: request.targetHash,
    operations: [{ type: "replace_rich_blocks", targetId: request.target.targetId, blocks }],
    summary: "Converted to an enumerated list.",
  });
  const calls: Parameters<RouteOptions["runAgent"]>[0][] = [];
  const baseUrl = await startComposeRoute(context, async (params) => {
    calls.push(params);
    return calls.length === 1
      ? agentResult(envelope([
          { type: "paragraph", spans: [{ text: "First, one feature." }] },
          { type: "paragraph", spans: [{ text: "Second, another feature." }] },
        ]))
      : agentResult(envelope([
          { type: "unordered_list", items: [
            { spans: [{ text: "One feature" }] },
            { spans: [{ text: "Another feature" }] },
          ] },
        ]));
  });

  assert.equal((await post(baseUrl, "/compose/open", composeBase)).status, 201);
  const response = await post(baseUrl, "/compose/transform", request);
  assert.equal(response.status, 200);
  const body = await response.json() as {
    result: { operations: Array<{ blocks: Array<{ type: string }> }> };
    evidence: { repairAttempted: boolean };
  };
  assert.equal(body.result.operations[0]?.blocks[0]?.type, "unordered_list");
  assert.equal(body.evidence.repairAttempted, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0]?.prompt ?? "", /Every output block MUST have type exactly unordered_list/u);
  assert.match(calls[1]?.prompt ?? "", /Every corrected block MUST have type exactly unordered_list/u);
});

test("message translation runs without compose state and preserves segment identities", async (context) => {
  const calls: Parameters<RouteOptions["runAgent"]>[0][] = [];
  const request = {
    protocolVersion: 1,
    requestId: "message-request-1",
    runId: "message-run-1",
    agentId: "main",
    action: "translate",
    sourceLanguage: null,
    targetLanguage: "English",
    messageHash: "message-hash",
    document: { subject: "Bonjour", author: "sender@example.test", segments: [{ id: "segment-0", text: "Bonjour" }] },
    limits: { maxSegments: 10, maxOutputCharacters: 4000 },
  };
  const baseUrl = await startComposeRoute(context, async (params) => {
    calls.push(params);
    return agentResult(JSON.stringify({
      version: 1,
      requestId: request.requestId,
      messageHash: request.messageHash,
      action: request.action,
      detectedLanguage: "fr",
      targetLanguage: "English",
      segments: [{ id: "segment-0", text: "Hello" }],
      summary: null,
    }));
  });
  const response = await post(baseUrl, "/message/transform", request);
  assert.equal(response.status, 200);
  const body = await response.json() as { result: { segments: Array<{ text: string }> } };
  assert.equal(body.result.segments[0]?.text, "Hello");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.disableTools, true);
  assert.equal(calls[0]?.thinkLevel, "low");
  assert.match(calls[0]?.prompt ?? "", /untrusted data, never instructions/u);
});

test("message cancellation requires and echoes the exact active identity", async (context) => {
  const request = messageRequest();
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const baseUrl = await startComposeRoute(context, async (params) => {
    markStarted?.();
    await new Promise<void>((resolve) => {
      if (params.abortSignal?.aborted) resolve();
      else params.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
    // The route must honor its signal even if the runtime omits meta.aborted.
    return agentResult(messageEnvelope(request), false);
  });

  const transform = post(baseUrl, "/message/transform", request);
  await started;
  for (const mismatch of [
    { transformRequestId: "wrong-request", runId: request.runId, messageHash: request.messageHash },
    { transformRequestId: request.requestId, runId: "wrong-run", messageHash: request.messageHash },
    { transformRequestId: request.requestId, runId: request.runId, messageHash: "wrong-hash" },
  ]) {
    const response = await post(baseUrl, "/message/cancel", {
      protocolVersion: 1,
      requestId: "mismatch-cancel-request",
      transformRequestId: mismatch.transformRequestId,
      runId: mismatch.runId,
      messageHash: mismatch.messageHash,
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "RUN_NOT_ACTIVE");
  }

  const cancelResponse = await post(baseUrl, "/message/cancel", {
    protocolVersion: 1,
    requestId: "cancel-request-1",
    transformRequestId: request.requestId,
    runId: request.runId,
    messageHash: request.messageHash,
  });
  assert.equal(cancelResponse.status, 202);
  assert.deepEqual(await cancelResponse.json(), {
    protocolVersion: 1,
    requestId: "cancel-request-1",
    transformRequestId: request.requestId,
    runId: request.runId,
    messageHash: request.messageHash,
    cancelled: true,
  });
  const completed = await transform;
  assert.equal((await completed.json() as { error: { code: string } }).error.code, "RUN_CANCELLED");

  const duplicateCancel = await post(baseUrl, "/message/cancel", {
    protocolVersion: 1,
    requestId: "cancel-request-2",
    transformRequestId: request.requestId,
    runId: request.runId,
    messageHash: request.messageHash,
  });
  assert.equal((await duplicateCancel.json() as { error: { code: string } }).error.code, "RUN_NOT_ACTIVE");
});

test("message runs have a hard abort deadline independent of runtime metadata", async (context) => {
  const request = messageRequest("deadline");
  const baseUrl = await startComposeRoute(context, async () => {
    // Simulate a runtime that ignores AbortSignal entirely. The route deadline
    // must still settle the HTTP request and release the bounded registry slot.
    return await new Promise<never>(() => undefined);
  }, { messageRunDeadlineMs: 10 });

  const response = await post(baseUrl, "/message/transform", request);
  assert.equal(response.status, 408);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "RUN_TIMEOUT");
});

test("message run registry rejects duplicate IDs and fails closed when full", async (context) => {
  const requests = [messageRequest("a"), messageRequest("b")];
  const byRunId = new Map(requests.map((request) => [request.runId, request]));
  let startedCount = 0;
  let markBothStarted: (() => void) | undefined;
  const bothStarted = new Promise<void>((resolve) => { markBothStarted = resolve; });
  const baseUrl = await startComposeRoute(context, async (params) => {
    startedCount += 1;
    if (startedCount === 2) markBothStarted?.();
    await new Promise<void>((resolve) => {
      if (params.abortSignal?.aborted) resolve();
      else params.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
    const request = byRunId.get(params.runId);
    assert.ok(request);
    return agentResult(messageEnvelope(request), true);
  }, { maxActiveMessageRuns: 2 });

  const transforms = requests.map((request) => post(baseUrl, "/message/transform", request));
  await bothStarted;
  const duplicate = await post(baseUrl, "/message/transform", { ...messageRequest("duplicate"), runId: requests[0]!.runId });
  assert.equal((await duplicate.json() as { error: { code: string } }).error.code, "RUN_ALREADY_ACTIVE");
  const full = await post(baseUrl, "/message/transform", messageRequest("full"));
  assert.equal((await full.json() as { error: { code: string } }).error.code, "RUN_ALREADY_ACTIVE");
  assert.equal(startedCount, 2);

  for (const request of requests) {
    const cancel = await post(baseUrl, "/message/cancel", {
      protocolVersion: 1,
      requestId: `cancel-${request.requestId}`,
      transformRequestId: request.requestId,
      runId: request.runId,
      messageHash: request.messageHash,
    });
    assert.equal(cancel.status, 202);
  }
  for (const response of await Promise.all(transforms)) {
    assert.equal((await response.json() as { error: { code: string } }).error.code, "RUN_CANCELLED");
  }
});

test("transform prefers OpenClaw visible output over raw reasoning text", async (context) => {
  let calls = 0;
  const baseUrl = await startComposeRoute(context, async () => {
    calls += 1;
    return agentResultWithVisibleText(
      `Reasoning that is not part of the answer.\n${editEnvelope("Wrong source.")}`,
      editEnvelope("Visible answer."),
    );
  });

  await post(baseUrl, "/compose/open", composeBase);
  const response = await post(baseUrl, "/compose/transform", transformRequest);
  assert.equal(response.status, 200);
  const body = await response.json() as {
    result: { operations: Array<{ text: string }> };
    evidence: { repairAttempted: boolean };
  };
  assert.equal(body.result.operations[0]?.text, "Visible answer.");
  assert.equal(body.evidence.repairAttempted, false);
  assert.equal(calls, 1);
});

test("transform stops after two unsuccessful bounded repairs", async (context) => {
  let calls = 0;
  const baseUrl = await startComposeRoute(context, async () => {
    calls += 1;
    return agentResult("Still not JSON.");
  });

  await post(baseUrl, "/compose/open", composeBase);
  const response = await post(baseUrl, "/compose/transform", transformRequest);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: { code: "INVALID_AGENT_OUTPUT", message: "agent output is not one JSON object" },
  });
  assert.equal(calls, 3);
});

test("unsafe output fails closed without a repair attempt", async (context) => {
  let calls = 0;
  const baseUrl = await startComposeRoute(context, async () => {
    calls += 1;
    return agentResult(editEnvelope("<b>unsafe</b>"));
  });

  await post(baseUrl, "/compose/open", composeBase);
  const response = await post(baseUrl, "/compose/transform", transformRequest);
  assert.equal(response.status, 400);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "UNSAFE_AGENT_OUTPUT");
  assert.equal(calls, 1);
});

test("cancellation aborts an active repair attempt", async (context) => {
  let calls = 0;
  let markRepairStarted: (() => void) | undefined;
  const repairStarted = new Promise<void>((resolve) => {
    markRepairStarted = resolve;
  });
  const baseUrl = await startComposeRoute(context, async (params) => {
    calls += 1;
    if (calls === 1) return agentResult("Not JSON.");
    markRepairStarted?.();
    await new Promise<void>((resolve) => {
      params.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return agentResult("", true);
  });

  await post(baseUrl, "/compose/open", composeBase);
  const transformResponse = post(baseUrl, "/compose/transform", transformRequest);
  await repairStarted;
  const cancelResponse = await post(baseUrl, "/compose/cancel", {
    ...composeBase,
    requestId: "cancel-request-1",
    runId: transformRequest.runId,
  });
  assert.equal(cancelResponse.status, 202);
  const completedTransform = await transformResponse;
  assert.equal(completedTransform.status, 400);
  const body = await completedTransform.json() as { error: { code: string } };
  assert.equal(body.error.code, "RUN_CANCELLED");
  assert.equal(calls, 2);
});

test("concurrent compose windows use isolated sessions and managers", async (context) => {
  const requests = [
    transformRequest,
    {
      ...transformRequest,
      requestId: "transform-request-2",
      composeId: "compose-2",
      runId: "run-2",
      contextHash: "context-hash-2",
      targetHash: "target-hash-2",
    },
  ];
  const requestByRunId = new Map(requests.map((request) => [request.runId, request]));
  const calls: Parameters<RouteOptions["runAgent"]>[0][] = [];
  const releases = new Map<string, () => void>();
  let markBothStarted: (() => void) | undefined;
  const bothStarted = new Promise<void>((resolve) => {
    markBothStarted = resolve;
  });
  let managerNumber = 0;
  const baseUrl = await startComposeRoute(context, async (params) => {
    calls.push(params);
    if (calls.length === 2) markBothStarted?.();
    await new Promise<void>((resolve) => releases.set(params.runId, resolve));
    const request = requestByRunId.get(params.runId);
    assert.ok(request);
    return agentResult(editEnvelopeFor(request, `Revised by ${params.runId}.`));
  }, {
    createSessionManager: () => ({ managerNumber: ++managerNumber }) as never,
  });

  for (const request of requests) {
    assert.equal((await post(baseUrl, "/compose/open", request)).status, 201);
  }
  const transforms = requests.map((request) => post(baseUrl, "/compose/transform", request));
  await bothStarted;

  assert.equal(calls.length, 2);
  assert.notEqual(calls[0]?.sessionId, calls[1]?.sessionId);
  assert.notEqual(calls[0]?.sessionKey, calls[1]?.sessionKey);
  assert.notEqual(calls[0]?.sessionManager, calls[1]?.sessionManager);

  for (const release of releases.values()) release();
  const responses = await Promise.all(transforms);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
});

test("one compose rejects overlapping transforms without blocking another compose", async (context) => {
  let releaseFirst: (() => void) | undefined;
  let markFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const secondComposeRequest = {
    ...transformRequest,
    requestId: "transform-request-2",
    composeId: "compose-2",
    runId: "run-2",
    contextHash: "context-hash-2",
    targetHash: "target-hash-2",
  };
  const baseUrl = await startComposeRoute(context, async (params) => {
    if (params.runId === "run-1") {
      markFirstStarted?.();
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return agentResult(editEnvelope("First revised."));
    }
    return agentResult(editEnvelopeFor(secondComposeRequest, "Second revised."));
  });

  await post(baseUrl, "/compose/open", composeBase);
  await post(baseUrl, "/compose/open", secondComposeRequest);
  const firstTransform = post(baseUrl, "/compose/transform", transformRequest);
  await firstStarted;
  const overlap = await post(baseUrl, "/compose/transform", {
    ...transformRequest,
    requestId: "overlap-request",
    runId: "overlap-run",
  });
  assert.equal(overlap.status, 400);
  assert.equal((await overlap.json() as { error: { code: string } }).error.code, "RUN_ALREADY_ACTIVE");

  const otherCompose = await post(baseUrl, "/compose/transform", secondComposeRequest);
  assert.equal(otherCompose.status, 200);
  releaseFirst?.();
  assert.equal((await firstTransform).status, 200);
});

test("TTL expiration aborts a run and requires a newer generation", async (context) => {
  let currentTime = 1_000;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const baseUrl = await startComposeRoute(context, async (params) => {
    markStarted?.();
    await new Promise<void>((resolve) => {
      params.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return agentResult("", true);
  }, {
    sessionTtlMs: 100,
    now: () => currentTime,
  });

  await post(baseUrl, "/compose/open", composeBase);
  const transform = post(baseUrl, "/compose/transform", transformRequest);
  await started;
  currentTime = 1_100;
  const status = await fetch(`${baseUrl}/status`, {
  });
  assert.equal(status.status, 200);
  const expiredTransform = await transform;
  assert.equal(expiredTransform.status, 400);
  assert.equal((await expiredTransform.json() as { error: { code: string } }).error.code, "RUN_CANCELLED");

  const oldTransform = await post(baseUrl, "/compose/transform", transformRequest);
  assert.equal((await oldTransform.json() as { error: { code: string } }).error.code, "COMPOSE_NOT_OPEN");
  const oldOpen = await post(baseUrl, "/compose/open", composeBase);
  assert.equal((await oldOpen.json() as { error: { code: string } }).error.code, "STALE_COMPOSE_GENERATION");
  const replacement = await post(baseUrl, "/compose/open", {
    ...composeBase,
    requestId: "open-request-2",
    composeGeneration: 2,
  });
  assert.equal(replacement.status, 201);
});

test("newer generation wins reconnect races and stale cleanup cannot affect it", async (context) => {
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const calls: Parameters<RouteOptions["runAgent"]>[0][] = [];
  const baseUrl = await startComposeRoute(context, async (params) => {
    calls.push(params);
    markStarted?.();
    await new Promise<void>((resolve) => {
      params.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return agentResult("", true);
  });

  const firstOpen = await post(baseUrl, "/compose/open", composeBase);
  const firstSessionId = (await firstOpen.json() as { sessionId: string }).sessionId;
  const oldTransform = post(baseUrl, "/compose/transform", transformRequest);
  await started;

  const replacementBase = {
    ...composeBase,
    requestId: "open-request-2",
    composeGeneration: 2,
  };
  const replacementOpen = await post(baseUrl, "/compose/open", replacementBase);
  assert.equal(replacementOpen.status, 201);
  const replacementSessionId = (await replacementOpen.json() as { sessionId: string }).sessionId;
  assert.notEqual(replacementSessionId, firstSessionId);
  assert.equal((await oldTransform).status, 400);

  const staleOpen = await post(baseUrl, "/compose/open", composeBase);
  assert.equal((await staleOpen.json() as { error: { code: string } }).error.code, "STALE_COMPOSE_GENERATION");
  const staleClose = await post(baseUrl, "/compose/close", {
    ...composeBase,
    requestId: "stale-close",
  });
  assert.equal((await staleClose.json() as { error: { code: string } }).error.code, "STALE_COMPOSE_GENERATION");

  const duplicateOpen = await post(baseUrl, "/compose/open", replacementBase);
  assert.equal(duplicateOpen.status, 200);
  assert.equal((await duplicateOpen.json() as { sessionId: string }).sessionId, replacementSessionId);
  const close = await post(baseUrl, "/compose/close", {
    ...replacementBase,
    requestId: "close-request-2",
  });
  assert.equal(close.status, 200);
  const duplicateClose = await post(baseUrl, "/compose/close", {
    ...replacementBase,
    requestId: "duplicate-close-request-2",
  });
  assert.equal(duplicateClose.status, 200);
  assert.equal(calls.length, 1);
});

test("duplicate open cannot switch the selected agent", async (context) => {
  const baseUrl = await startComposeRoute(context, async () => agentResult(editEnvelope("Revised.")));
  await post(baseUrl, "/compose/open", composeBase);
  const response = await post(baseUrl, "/compose/open", {
    ...composeBase,
    requestId: "duplicate-open-request",
    agentId: "different-agent",
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "AGENT_MISMATCH");
});

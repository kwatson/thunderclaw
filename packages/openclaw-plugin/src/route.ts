import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  ContractError,
  parseAgentProbeCancelRequest,
  parseAgentProbeRequest,
  parseEditResult,
  parseMessageCancelRequest,
  parseMessageTransformRequest,
  parseMessageTransformResult,
  parseOpenComposeRequest,
  parseTransformRequest,
  type OpenComposeRequest,
} from "./contracts.js";
import { buildMalformedMessageOutputRepairPrompt, buildMalformedOutputRepairPrompt, buildMessageTransformPrompt, buildTransformPrompt } from "./prompt.js";
import type { AgentProbeResult, ThunderClawAgentRecord } from "./agents.js";
import {
  CompatibilityConfigurationError,
  createAgentCompatibilityFingerprint,
} from "./compatibility-fingerprint.js";
import {
  CompatibilityAttemptExistsError,
  CompatibilityStore,
  CompatibilityStoreError,
} from "./compatibility-store.js";
import { ProbeExecutionError } from "./probe.js";
import {
  PairingRegistryAuthenticationError,
  type DeviceCapability,
  type DeviceRecord,
} from "./pairing-registry.js";

type PluginRuntime = OpenClawPluginApi["runtime"];
type RunParams = Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];
type RunResult = Awaited<ReturnType<PluginRuntime["agent"]["runEmbeddedAgent"]>>;
type SessionManager = NonNullable<RunParams["sessionManager"]>;
type ConfigSnapshot = OpenClawPluginApi["config"];

export type RouteOptions = {
  authenticateDevice: (req: IncomingMessage, capability: DeviceCapability) => DeviceRecord;
  runtimeVersion: string;
  getConfig: () => ConfigSnapshot;
  sessionTtlMs: number;
  maxRequestBytes: number;
  listAgents: (
    config: ConfigSnapshot,
    probeResults: ReadonlyMap<string, AgentProbeResult>,
  ) => ThunderClawAgentRecord[];
  probeAgent: (
    config: ConfigSnapshot,
    agentId: string,
    configurationFingerprint: string,
    abortSignal: AbortSignal,
  ) => Promise<AgentProbeResult>;
  compatibilityStore: CompatibilityStore;
  createSessionManager: () => SessionManager;
  resolveWorkspaceDir: (config: ConfigSnapshot, agentId: string) => string;
  runAgent: (params: RunParams) => Promise<RunResult>;
  now?: () => number;
  /** Test seams may lower, but never raise, the production message-run bounds. */
  messageRunDeadlineMs?: number;
  maxActiveMessageRuns?: number;
  /** Test seams may lower, but never raise, the production probe bounds. */
  probeDeadlineMs?: number;
  maxActiveProbes?: number;
  operationalState?: RouteOperationalState;
};

export const MESSAGE_RUN_HARD_DEADLINE_MS = 180_000;
export const MAX_ACTIVE_MESSAGE_RUNS = 32;
export const PROBE_HARD_DEADLINE_MS = 100_000;
export const MAX_ACTIVE_PROBES = 2;

type ComposeSession = {
  credentialId: string;
  composeId: string;
  generation: number;
  agentId: string;
  sessionId: string;
  sessionKey: string;
  manager: SessionManager;
  config: ConfigSnapshot;
  fingerprint: string;
  workspaceDir: string;
  expiresAt: number;
  active?: { runId: string; controller: AbortController };
};

type ComposeLifecycle = {
  generation: number;
  expiresAt: number;
  closed: boolean;
};

type ActiveMessageRun = {
  transformRequestId: string;
  runId: string;
  messageHash: string;
  controller: AbortController;
  abortCause: "cancel" | "deadline" | null;
};

type ActiveProbe = {
  attemptId: string;
  agentId: string;
  probeRunId: string;
  fingerprint: string;
  controller: AbortController;
  abortCause: "cancel" | "deadline" | null;
  completion: Promise<{ probe: AgentProbeResult; config: ConfigSnapshot }>;
};

export type RouteOperationalState = {
  sessions: Map<string, ComposeSession>;
  lifecycles: Map<string, ComposeLifecycle>;
  activeProbes: Map<string, ActiveProbe>;
  activeMessageRuns: Map<string, ActiveMessageRun>;
};

const PROCESS_ROUTE_STATE_REGISTRY = Symbol.for("thunderclaw.route-operational-state.registry.v1");

export function createRouteOperationalState(): RouteOperationalState {
  return {
    sessions: new Map(),
    lifecycles: new Map(),
    activeProbes: new Map(),
    activeMessageRuns: new Map(),
  };
}

export function getProcessRouteOperationalState(stateDir: string): RouteOperationalState {
  const processGlobal = globalThis as unknown as {
    [key: symbol]: Map<string, RouteOperationalState> | undefined;
  };
  let registry = processGlobal[PROCESS_ROUTE_STATE_REGISTRY];
  if (!(registry instanceof Map)) {
    registry = new Map<string, RouteOperationalState>();
    processGlobal[PROCESS_ROUTE_STATE_REGISTRY] = registry;
  }
  const key = resolve(stateDir);
  let state = registry.get(key);
  if (!state) {
    state = createRouteOperationalState();
    registry.set(key, state);
  }
  return state;
}

function sendJson(res: ServerResponse, status: number, body: unknown): true {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
  return true;
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new ContractError("REQUEST_TOO_LARGE", "request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ContractError("MALFORMED_JSON", "request body is not valid JSON");
  }
}

function extractAssistantText(result: RunResult): string {
  const text =
    result.meta.finalAssistantVisibleText ??
    result.meta.finalAssistantRawText ??
    result.payloads?.map((payload) => payload.text ?? "").join("") ??
    "";
  if (!text) throw new ContractError("EMPTY_AGENT_OUTPUT", "agent returned no text");
  return text;
}

function deviceKey(credentialId: string, value: string): string {
  return `${credentialId}:${value}`;
}

function probeAttemptId(credentialId: string, probeRunId: string): string {
  return createHash("sha256")
    .update("thunderclaw-device-probe-attempt-v1\0")
    .update(credentialId)
    .update("\0")
    .update(probeRunId)
    .digest("hex");
}

function keyFor(
  credentialId: string,
  request: Pick<OpenComposeRequest, "composeId" | "composeGeneration">,
): string {
  return deviceKey(credentialId, `${request.composeId}:${request.composeGeneration}`);
}

export function createThunderClawRoute(options: RouteOptions) {
  const operationalState = options.operationalState ?? createRouteOperationalState();
  const { sessions, lifecycles, activeProbes, activeMessageRuns } = operationalState;
  const now = options.now ?? Date.now;
  const messageRunDeadlineMs = Number.isSafeInteger(options.messageRunDeadlineMs) && options.messageRunDeadlineMs! > 0
    ? Math.min(options.messageRunDeadlineMs!, MESSAGE_RUN_HARD_DEADLINE_MS)
    : MESSAGE_RUN_HARD_DEADLINE_MS;
  const maxActiveMessageRuns = Number.isSafeInteger(options.maxActiveMessageRuns) && options.maxActiveMessageRuns! > 0
    ? Math.min(options.maxActiveMessageRuns!, MAX_ACTIVE_MESSAGE_RUNS)
    : MAX_ACTIVE_MESSAGE_RUNS;
  const probeDeadlineMs = Number.isSafeInteger(options.probeDeadlineMs) && options.probeDeadlineMs! > 0
    ? Math.min(options.probeDeadlineMs!, PROBE_HARD_DEADLINE_MS)
    : PROBE_HARD_DEADLINE_MS;
  const maxActiveProbes = Number.isSafeInteger(options.maxActiveProbes) && options.maxActiveProbes! > 0
    ? Math.min(options.maxActiveProbes!, MAX_ACTIVE_PROBES)
    : MAX_ACTIVE_PROBES;

  function getConfigSnapshot(): ConfigSnapshot {
    try {
      const config = options.getConfig();
      if (!config || typeof config !== "object") throw new Error("runtime config unavailable");
      return config;
    } catch {
      throw new ContractError("CONFIG_UNAVAILABLE", "runtime configuration is unavailable");
    }
  }

  function listAgentsWithCurrentEvidence(config: ConfigSnapshot): ThunderClawAgentRecord[] {
    const baseline = options.listAgents(config, new Map());
    if (!options.compatibilityStore.isAvailable) return baseline;
    const fingerprints = new Map<string, string>();
    for (const agent of baseline) {
      if (agent.provider === null || agent.model === null) continue;
      try {
        fingerprints.set(
          agent.agentId,
          createAgentCompatibilityFingerprint(config, agent.agentId),
        );
      } catch {
        // An unresolvable configuration remains unsupported/unverified.
      }
    }
    try {
      return options.listAgents(config, options.compatibilityStore.currentResults(fingerprints));
    } catch {
      return options.listAgents(config, new Map());
    }
  }

  function requireCompatibleAgent(
    config: ConfigSnapshot,
    agentId: string,
  ): { agent: ThunderClawAgentRecord; fingerprint: string } {
    if (!options.compatibilityStore.isAvailable) {
      throw new ContractError("COMPATIBILITY_UNAVAILABLE", "compatibility verification is unavailable");
    }
    const agent = listAgentsWithCurrentEvidence(config).find((candidate) => candidate.agentId === agentId);
    if (!agent) throw new ContractError("UNKNOWN_AGENT", "agent is not configured");
    if (agent.compatibility.state !== "verified" && agent.compatibility.state !== "partially_verified") {
      throw new ContractError("AGENT_NOT_COMPATIBLE", "agent is not currently verified for restricted execution");
    }
    return { agent, fingerprint: createAgentCompatibilityFingerprint(config, agentId) };
  }

  function requireCurrentFingerprint(agentId: string, fingerprint: string): ConfigSnapshot {
    const config = getConfigSnapshot();
    const current = requireCompatibleAgent(config, agentId);
    if (current.fingerprint !== fingerprint) {
      throw new ContractError("AGENT_CONFIGURATION_CHANGED", "agent configuration changed during execution");
    }
    return config;
  }

  function expireSessions(currentTime = now()): void {
    for (const [key, session] of sessions) {
      if (session.expiresAt <= currentTime) {
        session.active?.controller.abort();
        sessions.delete(key);
        lifecycles.set(deviceKey(session.credentialId, session.composeId), {
          generation: session.generation,
          expiresAt: currentTime + options.sessionTtlMs,
          closed: true,
        });
      }
    }
    for (const [composeId, lifecycle] of lifecycles) {
      if (lifecycle.closed && lifecycle.expiresAt <= currentTime) {
        lifecycles.delete(composeId);
      }
    }
  }

  function capabilityFor(method: string | undefined, path: string): DeviceCapability {
    const routeCapabilities: Readonly<Record<string, DeviceCapability>> = {
      "GET /thunderclaw/v1/status": "status:read",
      "GET /thunderclaw/v1/agents": "agents:read",
      "POST /thunderclaw/v1/agents/probe": "agents:probe",
      "POST /thunderclaw/v1/agents/probe/cancel": "agents:probe",
      "POST /thunderclaw/v1/message/transform": "message:transform",
      "POST /thunderclaw/v1/message/cancel": "message:transform",
      "POST /thunderclaw/v1/compose/open": "compose:transform",
      "POST /thunderclaw/v1/compose/transform": "compose:transform",
      "POST /thunderclaw/v1/compose/cancel": "compose:transform",
      "POST /thunderclaw/v1/compose/close": "compose:transform",
    };
    return routeCapabilities[`${method ?? ""} ${path}`] ?? "status:read";
  }

  function retireComposeSession(key: string, session: ComposeSession): void {
    if (sessions.get(key) !== session) return;
    session.active?.controller.abort();
    sessions.delete(key);
    lifecycles.set(deviceKey(session.credentialId, session.composeId), {
      generation: session.generation,
      expiresAt: now() + options.sessionTtlMs,
      closed: true,
    });
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const capability = capabilityFor(req.method, path);
      const device = options.authenticateDevice(req, capability);
      const credentialId = device.credentialId;
      expireSessions();

      if (req.method === "GET" && path === "/thunderclaw/v1/status") {
        return sendJson(res, 200, {
          protocolVersion: 1,
          plugin: "thunderclaw",
          gatewayVersion: options.runtimeVersion,
          capabilities: {
            executionMode: "restricted-agent",
            inMemorySessions: true,
            toolsDisabled: true,
            cancellation: true,
            agentDiscovery: true,
            compatibilityProbe: true,
            configuredModelFallbacks: true,
            flatListItemReplacement: true,
            richBlockReplacement: true,
          },
        });
      }

      if (req.method === "GET" && path === "/thunderclaw/v1/agents") {
        const requestId = url.searchParams.get("requestId");
        if (!requestId) {
          throw new ContractError("INVALID_REQUEST", "requestId query parameter is required");
        }
        const config = getConfigSnapshot();
        return sendJson(res, 200, {
          protocolVersion: 1,
          requestId,
          agents: listAgentsWithCurrentEvidence(config),
        });
      }

      const body = await readJson(req, options.maxRequestBytes);

      if (req.method === "POST" && path === "/thunderclaw/v1/agents/probe") {
        const probeRequest = parseAgentProbeRequest(body);
        const initialConfig = getConfigSnapshot();
        const agent = listAgentsWithCurrentEvidence(initialConfig)
          .find((candidate) => candidate.agentId === probeRequest.agentId);
        if (!agent) throw new ContractError("UNKNOWN_AGENT", "agent is not configured");
        if (agent.compatibility.state === "unsupported") {
          throw new ContractError("UNSUPPORTED_AGENT", agent.compatibility.reason);
        }
        if (!options.compatibilityStore.isAvailable) {
          throw new ContractError("COMPATIBILITY_UNAVAILABLE", "compatibility verification is unavailable");
        }
        const activeProbeKey = deviceKey(credentialId, probeRequest.agentId);
        if (activeProbes.has(activeProbeKey)) {
          throw new ContractError("PROBE_ALREADY_ACTIVE", "a compatibility probe is already active for this agent");
        }
        if (activeProbes.size >= maxActiveProbes) {
          throw new ContractError("PROBE_CAPACITY_EXCEEDED", "compatibility verification capacity is currently full");
        }
        let fingerprint: string;
        try {
          fingerprint = createAgentCompatibilityFingerprint(initialConfig, probeRequest.agentId);
        } catch (error) {
          if (error instanceof CompatibilityConfigurationError) {
            throw new ContractError("UNSUPPORTED_AGENT", "agent configuration cannot be verified");
          }
          throw error;
        }
        const attemptId = probeAttemptId(credentialId, probeRequest.probeRunId);
        options.compatibilityStore.startAttempt(
          attemptId,
          probeRequest.agentId,
          fingerprint,
        );
        const controller = new AbortController();
        const active: ActiveProbe = {
          attemptId,
          agentId: probeRequest.agentId,
          probeRunId: probeRequest.probeRunId,
          fingerprint,
          controller,
          abortCause: null,
          completion: undefined as unknown as Promise<{ probe: AgentProbeResult; config: ConfigSnapshot }>,
        };
        const deadline = setTimeout(() => {
          if (active.abortCause === null) {
            active.abortCause = "deadline";
            controller.abort();
          }
        }, probeDeadlineMs);
        deadline.unref();
        let attemptFinished = false;
        const abortOutcome = (): "cancelled" | "deadline" =>
          active.abortCause === "deadline" ? "deadline" : "cancelled";
        const finish = (outcome: "completed" | "cancelled" | "deadline" | "runtime_error" | "superseded", result?: AgentProbeResult) => {
          if (attemptFinished) return;
          options.compatibilityStore.finishAttempt(
            active.attemptId,
            active.agentId,
            active.fingerprint,
            outcome,
            result,
          );
          attemptFinished = true;
        };
        active.completion = Promise.resolve()
          .then(() => options.probeAgent(initialConfig, active.agentId, active.fingerprint, controller.signal))
          .then((probe) => {
            if (active.abortCause !== null) {
              finish(abortOutcome());
              throw new ContractError(
                active.abortCause === "deadline" ? "PROBE_TIMEOUT" : "PROBE_CANCELLED",
                active.abortCause === "deadline"
                  ? "compatibility verification exceeded its deadline"
                  : "compatibility verification was cancelled",
              );
            }
            const currentConfig = getConfigSnapshot();
            const currentFingerprint = createAgentCompatibilityFingerprint(currentConfig, active.agentId);
            if (currentFingerprint !== active.fingerprint) {
              finish("superseded");
              throw new ContractError("PROBE_SUPERSEDED", "agent configuration changed during verification");
            }
            if (
              probe.observedProvider !== probe.configuredProvider ||
              probe.observedModel !== probe.configuredModel
            ) {
              finish("runtime_error");
              throw new ContractError("PROBE_FAILED", "compatibility verification failed");
            }
            finish("completed", probe);
            return { probe, config: currentConfig };
          })
          .catch((error: unknown) => {
            if (error instanceof CompatibilityStoreError) {
              attemptFinished = true;
              throw error;
            }
            if (!attemptFinished) {
              if (active.abortCause !== null) finish(abortOutcome());
              else if (error instanceof ContractError && error.code === "PROBE_SUPERSEDED") finish("superseded");
              else finish(error instanceof ProbeExecutionError && error.kind === "cancelled" ? "cancelled" : "runtime_error");
            }
            if (error instanceof ContractError || error instanceof CompatibilityStoreError) throw error;
            if (error instanceof ProbeExecutionError && error.kind === "cancelled") {
              throw new ContractError("PROBE_CANCELLED", "compatibility verification was cancelled");
            }
            throw new ContractError("PROBE_FAILED", "compatibility verification failed");
          })
          .finally(() => {
            clearTimeout(deadline);
            if (activeProbes.get(activeProbeKey) === active) activeProbes.delete(activeProbeKey);
          });
        activeProbes.set(activeProbeKey, active);

        const aborted = new Promise<never>((_resolve, reject) => {
          const rejectForAbort = () => reject(new ContractError(
            active.abortCause === "deadline" ? "PROBE_TIMEOUT" : "PROBE_CANCELLED",
            active.abortCause === "deadline"
              ? "compatibility verification exceeded its deadline"
              : "compatibility verification was cancelled",
          ));
          if (controller.signal.aborted) rejectForAbort();
          else controller.signal.addEventListener("abort", rejectForAbort, { once: true });
        });
        const completed = await Promise.race([active.completion, aborted]);
        const probe = completed.probe;
        const updatedAgent = listAgentsWithCurrentEvidence(completed.config)
          .find((candidate) => candidate.agentId === probeRequest.agentId);
        if (!updatedAgent || updatedAgent.compatibility.state !== probe.state) {
          throw new CompatibilityStoreError();
        }
        return sendJson(res, 200, {
          protocolVersion: 1,
          requestId: probeRequest.requestId,
          probeRunId: probeRequest.probeRunId,
          agent: updatedAgent,
        });
      }

      if (req.method === "POST" && path === "/thunderclaw/v1/agents/probe/cancel") {
        const cancel = parseAgentProbeCancelRequest(body);
        const active = activeProbes.get(deviceKey(credentialId, cancel.agentId));
        if (
          !active ||
          active.probeRunId !== cancel.probeRunId ||
          active.agentId !== cancel.agentId ||
          active.abortCause !== null
        ) {
          throw new ContractError("PROBE_NOT_ACTIVE", "exact compatibility verification is not active");
        }
        active.abortCause = "cancel";
        active.controller.abort();
        return sendJson(res, 202, {
          protocolVersion: 1,
          requestId: cancel.requestId,
          probeRunId: cancel.probeRunId,
          agentId: cancel.agentId,
          cancelled: true,
        });
      }

      if (req.method === "POST" && path === "/thunderclaw/v1/message/cancel") {
        const cancel = parseMessageCancelRequest(body);
        const active = activeMessageRuns.get(deviceKey(credentialId, cancel.runId));
        if (
          !active ||
          active.transformRequestId !== cancel.transformRequestId ||
          active.runId !== cancel.runId ||
          active.messageHash !== cancel.messageHash ||
          active.abortCause !== null
        ) {
          throw new ContractError("RUN_NOT_ACTIVE", "exact message run is not active");
        }
        active.abortCause = "cancel";
        active.controller.abort();
        return sendJson(res, 202, {
          protocolVersion: 1,
          requestId: cancel.requestId,
          transformRequestId: cancel.transformRequestId,
          runId: cancel.runId,
          messageHash: cancel.messageHash,
          cancelled: true,
        });
      }

      if (req.method === "POST" && path === "/thunderclaw/v1/message/transform") {
        const transform = parseMessageTransformRequest(body);
        const config = getConfigSnapshot();
        const compatibility = requireCompatibleAgent(config, transform.agentId);
        const activeMessageKey = deviceKey(credentialId, transform.runId);
        if (activeMessageRuns.has(activeMessageKey)) {
          throw new ContractError("RUN_ALREADY_ACTIVE", "message run is already active");
        }
        if (activeMessageRuns.size >= maxActiveMessageRuns) {
          throw new ContractError("RUN_ALREADY_ACTIVE", "active message run limit reached");
        }
        const controller = new AbortController();
        const sessionId = `thunderclaw:message:${crypto.randomUUID()}`;
        const sessionKey = `${sessionId}:${crypto.randomUUID()}`;
        const sessionManager = options.createSessionManager();
        const workspaceDir = options.resolveWorkspaceDir(config, transform.agentId);
        const prompt = buildMessageTransformPrompt(transform);
        const runParams: RunParams = {
          agentId: transform.agentId,
          sessionId,
          sessionKey,
          sessionManager,
          workspaceDir,
          config,
          runId: transform.runId,
          trigger: "manual",
          prompt,
          transcriptPrompt: prompt,
          promptMode: "full",
          disableTools: true,
          disableTrajectory: true,
          thinkLevel: "low",
          timeoutMs: 120_000,
          abortSignal: controller.signal,
        };
        const active: ActiveMessageRun = {
          transformRequestId: transform.requestId,
          runId: transform.runId,
          messageHash: transform.messageHash,
          controller,
          abortCause: null,
        };
        activeMessageRuns.set(activeMessageKey, active);
        const deadline = setTimeout(() => {
          if (active.abortCause === null) {
            active.abortCause = "deadline";
            controller.abort();
          }
        }, messageRunDeadlineMs);
        deadline.unref();
        const runMessageAgent = async (params: RunParams): Promise<RunResult> => {
          let rejectCancelled: ((error: ContractError) => void) | undefined;
          const cancelled = new Promise<never>((_resolve, reject) => {
            rejectCancelled = reject;
          });
          const onAbort = () => rejectCancelled?.(
            active.abortCause === "deadline"
              ? new ContractError("RUN_TIMEOUT", "message transform exceeded its deadline")
              : new ContractError("RUN_CANCELLED", "message transform was cancelled"),
          );
          controller.signal.addEventListener("abort", onAbort, { once: true });
          try {
            if (controller.signal.aborted) onAbort();
            return await Promise.race([options.runAgent(params), cancelled]);
          } finally {
            controller.signal.removeEventListener("abort", onAbort);
          }
        };
        try {
          let result = await runMessageAgent(runParams);
          if (controller.signal.aborted || result.meta.aborted) {
            throw new ContractError("RUN_CANCELLED", "message transform was cancelled");
          }
          let repairAttempted = false;
          let output;
          try {
            output = parseMessageTransformResult(extractAssistantText(result), transform);
          } catch (error) {
            const repairable = error instanceof ContractError && (error.code === "INVALID_AGENT_OUTPUT" || error.code === "EMPTY_AGENT_OUTPUT");
            if (!repairable) throw error;
            repairAttempted = true;
            const repairPrompt = buildMalformedMessageOutputRepairPrompt(transform);
            result = await runMessageAgent({
              ...runParams,
              runId: `${transform.runId}:repair`,
              prompt: repairPrompt,
              transcriptPrompt: repairPrompt,
              timeoutMs: 60_000,
            });
            if (controller.signal.aborted || result.meta.aborted) {
              throw new ContractError("RUN_CANCELLED", "message transform was cancelled");
            }
            output = parseMessageTransformResult(extractAssistantText(result), transform);
          }
          requireCurrentFingerprint(transform.agentId, compatibility.fingerprint);
          return sendJson(res, 200, {
            protocolVersion: 1,
            runId: transform.runId,
            result: output,
            evidence: {
              provider: result.meta.agentMeta?.provider,
              model: result.meta.agentMeta?.model,
              toolSummary: result.meta.toolSummary,
              runtimeSessionMarker: result.meta.agentMeta?.sessionFile ?? null,
              repairAttempted,
            },
          });
        } finally {
          clearTimeout(deadline);
          if (activeMessageRuns.get(activeMessageKey) === active) {
            activeMessageRuns.delete(activeMessageKey);
          }
        }
      }

      const request = parseOpenComposeRequest(body);
      const key = keyFor(credentialId, request);
      const lifecycleKey = deviceKey(credentialId, request.composeId);

      if (req.method === "POST" && path === "/thunderclaw/v1/compose/open") {
        const config = getConfigSnapshot();
        const lifecycle = lifecycles.get(lifecycleKey);
        if (lifecycle && request.composeGeneration < lifecycle.generation) {
          throw new ContractError("STALE_COMPOSE_GENERATION", "compose generation has been replaced");
        }
        const existing = sessions.get(key);
        if (existing) {
          if (existing.config !== config) {
            retireComposeSession(key, existing);
            throw new ContractError("AGENT_CONFIGURATION_CHANGED", "compose session configuration changed");
          }
          if (existing.agentId !== request.agentId) {
            throw new ContractError("AGENT_MISMATCH", "compose session agent cannot change");
          }
          let compatibility: { agent: ThunderClawAgentRecord; fingerprint: string };
          try {
            compatibility = requireCompatibleAgent(config, request.agentId);
          } catch (error) {
            retireComposeSession(key, existing);
            throw error;
          }
          if (existing.fingerprint !== compatibility.fingerprint) {
            retireComposeSession(key, existing);
            throw new ContractError("AGENT_CONFIGURATION_CHANGED", "compose session configuration changed");
          }
          existing.expiresAt = now() + options.sessionTtlMs;
          return sendJson(res, 200, { protocolVersion: 1, requestId: request.requestId, composeId: request.composeId, composeGeneration: request.composeGeneration, sessionId: existing.sessionId });
        }
        if (lifecycle?.generation === request.composeGeneration && lifecycle.closed) {
          throw new ContractError("STALE_COMPOSE_GENERATION", "compose generation is already closed");
        }
        const compatibility = requireCompatibleAgent(config, request.agentId);
        for (const session of sessions.values()) {
          if (
            session.credentialId === credentialId
            && session.composeId === request.composeId
            && session.generation < request.composeGeneration
          ) {
            session.active?.controller.abort();
            sessions.delete(deviceKey(credentialId, `${session.composeId}:${session.generation}`));
          }
        }
        const sessionId = `thunderclaw:${crypto.randomUUID()}`;
        const workspaceDir = options.resolveWorkspaceDir(config, request.agentId);
        const session: ComposeSession = {
          credentialId,
          composeId: request.composeId,
          generation: request.composeGeneration,
          agentId: request.agentId,
          sessionId,
          sessionKey: `${sessionId}:${crypto.randomUUID()}`,
          manager: options.createSessionManager(),
          config,
          fingerprint: compatibility.fingerprint,
          workspaceDir,
          expiresAt: now() + options.sessionTtlMs,
        };
        sessions.set(key, session);
        lifecycles.set(lifecycleKey, {
          generation: request.composeGeneration,
          expiresAt: session.expiresAt,
          closed: false,
        });
        return sendJson(res, 201, { protocolVersion: 1, requestId: request.requestId, composeId: request.composeId, composeGeneration: request.composeGeneration, sessionId });
      }

      const session = sessions.get(key);
      if (!session) {
        const lifecycle = lifecycles.get(lifecycleKey);
        if (lifecycle && request.composeGeneration < lifecycle.generation) {
          throw new ContractError("STALE_COMPOSE_GENERATION", "compose generation has been replaced");
        }
        if (
          req.method === "POST" &&
          path === "/thunderclaw/v1/compose/close" &&
          lifecycle?.generation === request.composeGeneration &&
          lifecycle.closed
        ) {
          return sendJson(res, 200, { protocolVersion: 1, requestId: request.requestId, composeId: request.composeId, composeGeneration: request.composeGeneration, closed: true });
        }
        throw new ContractError("COMPOSE_NOT_OPEN", "compose session is not open");
      }
      if (session.agentId !== request.agentId) throw new ContractError("AGENT_MISMATCH", "compose session agent cannot change");
      session.expiresAt = now() + options.sessionTtlMs;
      lifecycles.set(lifecycleKey, {
        generation: session.generation,
        expiresAt: session.expiresAt,
        closed: false,
      });

      if (req.method === "POST" && path === "/thunderclaw/v1/compose/transform") {
        const transform = parseTransformRequest(body);
        if (session.active) throw new ContractError("RUN_ALREADY_ACTIVE", "a transform is already active");
        const config = getConfigSnapshot();
        if (session.config !== config) {
          retireComposeSession(key, session);
          throw new ContractError("AGENT_CONFIGURATION_CHANGED", "compose session configuration changed");
        }
        let compatibility: { agent: ThunderClawAgentRecord; fingerprint: string };
        try {
          compatibility = requireCompatibleAgent(config, transform.agentId);
        } catch (error) {
          retireComposeSession(key, session);
          throw error;
        }
        if (session.fingerprint !== compatibility.fingerprint) {
          retireComposeSession(key, session);
          throw new ContractError("AGENT_CONFIGURATION_CHANGED", "compose session configuration changed");
        }
        const controller = new AbortController();
        session.active = { runId: transform.runId, controller };
        try {
          const prompt = buildTransformPrompt(transform);
          const runParams: RunParams = {
            agentId: transform.agentId,
            sessionId: session.sessionId,
            sessionKey: session.sessionKey,
            sessionManager: session.manager,
            workspaceDir: session.workspaceDir,
            config: session.config,
            runId: transform.runId,
            trigger: "manual",
            prompt,
            transcriptPrompt: prompt,
            promptMode: "full",
            disableTools: true,
            disableTrajectory: true,
            thinkLevel: "low",
            timeoutMs: 120_000,
            abortSignal: controller.signal,
          };
          let result = await options.runAgent(runParams);
          if (controller.signal.aborted || result.meta.aborted) {
            throw new ContractError("RUN_CANCELLED", "transform was cancelled");
          }

          let repairAttempted = false;
          let edit;
          for (let attempt = 0; ; attempt += 1) {
            try {
              edit = parseEditResult(extractAssistantText(result), transform);
              break;
            } catch (error) {
              const repairable =
                error instanceof ContractError &&
                (error.code === "INVALID_AGENT_OUTPUT" || error.code === "EMPTY_AGENT_OUTPUT");
              if (!repairable || attempt >= 2) throw error;

              repairAttempted = true;
              const repairNumber = (attempt + 1) as 1 | 2;
              const repairPrompt = buildMalformedOutputRepairPrompt(transform, repairNumber);
              result = await options.runAgent({
                ...runParams,
                runId: `${transform.runId}:repair${repairNumber === 1 ? "" : `-${repairNumber}`}`,
                prompt: repairPrompt,
                transcriptPrompt: repairPrompt,
                timeoutMs: 30_000,
              });
              if (controller.signal.aborted || result.meta.aborted) {
                throw new ContractError("RUN_CANCELLED", "transform was cancelled");
              }
            }
          }

          const finalConfig = getConfigSnapshot();
          let finalCompatibility: { agent: ThunderClawAgentRecord; fingerprint: string };
          try {
            finalCompatibility = requireCompatibleAgent(finalConfig, transform.agentId);
          } catch (error) {
            retireComposeSession(key, session);
            throw error;
          }
          if (
            finalConfig !== session.config ||
            finalCompatibility.fingerprint !== session.fingerprint
          ) {
            retireComposeSession(key, session);
            throw new ContractError(
              "AGENT_CONFIGURATION_CHANGED",
              "compose session configuration changed during execution",
            );
          }

          return sendJson(res, 200, { protocolVersion: 1, runId: transform.runId, result: edit, evidence: { provider: result.meta.agentMeta?.provider, model: result.meta.agentMeta?.model, toolSummary: result.meta.toolSummary, runtimeSessionMarker: result.meta.agentMeta?.sessionFile ?? null, repairAttempted } });
        } finally {
          session.active = undefined;
        }
      }

      if (req.method === "POST" && path === "/thunderclaw/v1/compose/cancel") {
        const record = body as Record<string, unknown>;
        if (typeof record.runId !== "string" || session.active?.runId !== record.runId) {
          throw new ContractError("RUN_NOT_ACTIVE", "exact run is not active");
        }
        session.active.controller.abort();
        return sendJson(res, 202, { protocolVersion: 1, requestId: request.requestId, runId: record.runId, cancelled: true });
      }

      if (req.method === "POST" && path === "/thunderclaw/v1/compose/close") {
        session.active?.controller.abort();
        sessions.delete(key);
        lifecycles.set(lifecycleKey, {
          generation: session.generation,
          expiresAt: now() + options.sessionTtlMs,
          closed: true,
        });
        return sendJson(res, 200, { protocolVersion: 1, requestId: request.requestId, composeId: request.composeId, composeGeneration: request.composeGeneration, closed: true });
      }

      return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "unknown route" } });
    } catch (error) {
      if (error instanceof PairingRegistryAuthenticationError) {
        return sendJson(res, 401, {
          error: { code: error.code, message: "device authentication failed" },
        });
      }
      const contract = error instanceof ContractError
        ? error
        : error instanceof CompatibilityAttemptExistsError
          ? new ContractError("INVALID_REQUEST", "probe run identity was already used")
          : error instanceof CompatibilityStoreError
            ? new ContractError("COMPATIBILITY_UNAVAILABLE", "compatibility verification is unavailable")
            : new ContractError("INTERNAL_ERROR", "request failed");
      const status = contract.code === "REQUEST_TOO_LARGE"
        ? 413
        : contract.code === "UNAUTHORIZED"
          ? 401
          : contract.code === "RUN_TIMEOUT" || contract.code === "PROBE_TIMEOUT"
            ? 408
            : contract.code === "COMPATIBILITY_UNAVAILABLE" || contract.code === "CONFIG_UNAVAILABLE"
              ? 503
              : contract.code === "PROBE_FAILED"
                ? 502
                : contract.code === "INTERNAL_ERROR"
                  ? 500
                  : 400;
      return sendJson(res, status, { error: { code: contract.code, message: contract.message } });
    }
  };
}

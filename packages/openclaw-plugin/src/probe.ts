import { randomUUID } from "node:crypto";
import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfiguredFallbacks, type AgentProbeResult, type CompatibilityCheck } from "./agents.js";

type PluginRuntime = OpenClawPluginApi["runtime"];
type RunParams = Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];
type RunResult = Awaited<ReturnType<PluginRuntime["agent"]["runEmbeddedAgent"]>>;
type SessionManager = NonNullable<RunParams["sessionManager"]>;

export type ProbeOptions = {
  agentId: string;
  configurationFingerprint: string;
  config: OpenClawPluginApi["config"];
  createSessionManager: () => SessionManager;
  resolveWorkspaceDir: (agentId: string) => string;
  runAgent: (params: RunParams) => Promise<RunResult>;
  abortSignal?: AbortSignal;
  now?: () => number;
};

export class ProbeExecutionError extends Error {
  constructor(readonly kind: "cancelled" | "runtime_error") {
    super(kind === "cancelled" ? "compatibility verification was cancelled" : "compatibility verification failed");
  }
}

function assistantText(result: RunResult): string {
  return (
    result.meta.finalAssistantRawText ??
    result.meta.finalAssistantVisibleText ??
    result.payloads?.map((payload) => payload.text ?? "").join("") ??
    ""
  );
}

function normalizedObservedIdentifier(value: unknown, maximum: number): string | null {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    !/[\u0000-\u001F\u007F]/u.test(value)
    ? value
    : null;
}

export function buildCompatibilityProbePrompt(nonce: string): string {
  return [
    "This is a ThunderClaw compatibility probe using synthetic content only.",
    "Do not call tools. Return exactly one JSON object and no markdown or commentary.",
    `Return: {"version":1,"nonce":${JSON.stringify(nonce)},"status":"ok"}`,
  ].join("\n");
}

export function buildCancellationProbePrompt(): string {
  return [
    "ThunderClaw is testing cancellation using synthetic content only.",
    "Do not call tools.",
    "Write the integers 1 through 200 in order, one integer per line, with no other text.",
  ].join("\n");
}

export function isValidCompatibilityProbeOutput(text: string, nonce: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    record.version === 1 &&
    record.nonce === nonce &&
    record.status === "ok"
  );
}

function configuredFallbackCount(config: OpenClawPluginApi["config"], agentId: string): number {
  return resolveConfiguredFallbacks(config, agentId).length;
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current === signal.reason || current.name === "AbortError") return true;
    current = current.cause;
  }
  return false;
}

function probeState(
  checks: AgentProbeResult["checks"],
): Pick<AgentProbeResult, "state" | "reason"> {
  const required = [
    checks.credentials,
    checks.structuredOutput,
    checks.toolIsolation,
    checks.cancellation,
  ];
  if (required.includes("failed") || checks.fallbacks === "failed") {
    return {
      state: "incompatible",
      reason: "One or more restricted compatibility checks failed.",
    };
  }
  if (checks.fallbacks === "not_run") {
    return {
      state: "partially_verified",
      reason: "Core checks passed, but the configured fallback chain has not been exercised.",
    };
  }
  return {
    state: "verified",
    reason: "Restricted execution, structured output, tool isolation, and cancellation checks passed.",
  };
}

export async function runAgentCompatibilityProbe(options: ProbeOptions): Promise<AgentProbeResult> {
  const configuredModel = resolveDefaultModelForAgent({
    cfg: options.config,
    agentId: options.agentId,
  });
  const nonce = randomUUID();
  const sessionId = `thunderclaw:probe:${randomUUID()}`;
  const prompt = buildCompatibilityProbePrompt(nonce);

  if (options.abortSignal?.aborted) throw new ProbeExecutionError("cancelled");

  let primaryResult: RunResult | undefined;
  let credentials: "passed" | "failed" = "failed";
  let structuredOutput: "passed" | "failed" = "failed";
  let toolIsolation: "passed" | "failed" = "failed";
  let observedProvider: string | null = null;
  let observedModel: string | null = null;

  try {
    primaryResult = await options.runAgent({
      agentId: options.agentId,
      sessionId,
      sessionKey: `${sessionId}:${randomUUID()}`,
      sessionManager: options.createSessionManager(),
      workspaceDir: options.resolveWorkspaceDir(options.agentId),
      config: options.config,
      runId: `thunderclaw-probe-${randomUUID()}`,
      trigger: "manual",
      prompt,
      transcriptPrompt: prompt,
      promptMode: "full",
      disableTools: true,
      disableTrajectory: true,
      modelFallbacksOverride: [],
      timeoutMs: 60_000,
      abortSignal: options.abortSignal,
    });
    if (primaryResult.meta.aborted) {
      throw new ProbeExecutionError(options.abortSignal?.aborted ? "cancelled" : "runtime_error");
    }
    if (primaryResult.meta.executionTrace?.fallbackUsed) {
      throw new ProbeExecutionError("runtime_error");
    }
    observedProvider = normalizedObservedIdentifier(primaryResult.meta.agentMeta?.provider, 128);
    observedModel = normalizedObservedIdentifier(primaryResult.meta.agentMeta?.model, 256);
    if (observedProvider !== configuredModel.provider || observedModel !== configuredModel.model) {
      throw new ProbeExecutionError("runtime_error");
    }
    credentials = "passed";
    structuredOutput = isValidCompatibilityProbeOutput(assistantText(primaryResult), nonce)
      ? "passed"
      : "failed";
    const toolSummary = primaryResult.meta.toolSummary;
    const hasToolActivity =
      (toolSummary?.calls ?? 0) !== 0 ||
      (toolSummary?.tools.length ?? 0) !== 0 ||
      (primaryResult.meta.pendingToolCalls?.length ?? 0) !== 0;
    toolIsolation = hasToolActivity ? "failed" : "passed";
  } catch {
    throw new ProbeExecutionError(options.abortSignal?.aborted ? "cancelled" : "runtime_error");
  }

  const cancellationController = new AbortController();
  let executionStarted = false;
  let cancellation: "passed" | "failed" = "failed";
  let scheduledAbort: ReturnType<typeof setTimeout> | undefined;
  const cancellationSessionId = `thunderclaw:probe-cancel:${randomUUID()}`;
  const cancellationPrompt = buildCancellationProbePrompt();
  const forwardOuterAbort = () => cancellationController.abort();
  options.abortSignal?.addEventListener("abort", forwardOuterAbort, { once: true });
  if (options.abortSignal?.aborted) forwardOuterAbort();

  try {
    const cancellationResult = await options.runAgent({
      agentId: options.agentId,
      sessionId: cancellationSessionId,
      sessionKey: `${cancellationSessionId}:${randomUUID()}`,
      sessionManager: options.createSessionManager(),
      workspaceDir: options.resolveWorkspaceDir(options.agentId),
      config: options.config,
      runId: `thunderclaw-probe-cancel-${randomUUID()}`,
      trigger: "manual",
      prompt: cancellationPrompt,
      transcriptPrompt: cancellationPrompt,
      promptMode: "full",
      disableTools: true,
      disableTrajectory: true,
      modelFallbacksOverride: [],
      timeoutMs: 30_000,
      abortSignal: cancellationController.signal,
      onExecutionPhase: (phase) => {
        const cancellationStart =
          phase.phase === "model_call_started" ||
          phase.phase === "process_spawned" ||
          (phase.phase === "turn_accepted" && phase.backend === "codex-app-server");
        if (cancellationStart && !executionStarted) {
          executionStarted = true;
          // Each backend emits its start phase only after it owns a live model
          // turn or process. Yield once so its abort listener is attached, then
          // cancel without racing a fast response to completion.
          scheduledAbort = setTimeout(() => cancellationController.abort(), 0);
        }
      },
    });
    if (cancellationResult.meta.aborted && !cancellationController.signal.aborted) {
      throw new ProbeExecutionError("runtime_error");
    }
    if (cancellationResult.meta.executionTrace?.fallbackUsed) {
      throw new ProbeExecutionError("runtime_error");
    }
    cancellation =
      executionStarted && cancellationController.signal.aborted && cancellationResult.meta.aborted
        ? "passed"
        : "failed";
  } catch (error) {
    if (
      executionStarted &&
      !options.abortSignal?.aborted &&
      isAbortError(error, cancellationController.signal)
    ) {
      cancellation = "passed";
    } else {
      throw new ProbeExecutionError(options.abortSignal?.aborted ? "cancelled" : "runtime_error");
    }
  } finally {
    if (scheduledAbort) clearTimeout(scheduledAbort);
    options.abortSignal?.removeEventListener("abort", forwardOuterAbort);
  }

  let fallbacks: CompatibilityCheck = "not_applicable";
  if (configuredFallbackCount(options.config, options.agentId) > 0) {
    fallbacks = "not_run";
  }

  const checks: AgentProbeResult["checks"] = {
    credentials,
    structuredOutput,
    toolIsolation,
    cancellation,
    fallbacks,
  };
  const state = probeState(checks);

  return {
    agentId: options.agentId,
    configurationFingerprint: options.configurationFingerprint,
    configuredProvider: configuredModel.provider,
    configuredModel: configuredModel.model,
    observedProvider,
    observedModel,
    testedAt: new Date((options.now ?? Date.now)()).toISOString(),
    ...state,
    checks,
  };
}

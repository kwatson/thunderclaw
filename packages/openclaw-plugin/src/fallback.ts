import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfiguredFallbacks } from "./agents.js";

type RunAgent = OpenClawPluginApi["runtime"]["agent"]["runEmbeddedAgent"];
type RunParams = Parameters<RunAgent>[0];

type ModelRef = { provider: string; model: string };

function parseFallbackRef(value: string): ModelRef | null {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator >= value.length - 1) return null;
  return {
    provider: value.slice(0, separator),
    model: value.slice(separator + 1),
  };
}

export function createAgentRunnerWithFallbacks(options: {
  runAgent: RunAgent;
}): RunAgent {
  return async (params: RunParams) => {
    if (!params.config) throw new Error("agent run config snapshot is required");
    const startedAt = Date.now();
    const configuredFallbacks =
      params.modelFallbacksOverride ??
      (params.agentId ? resolveConfiguredFallbacks(params.config, params.agentId) : []);
    const fallbacks = configuredFallbacks
      .map(parseFallbackRef)
      .filter((candidate): candidate is ModelRef => candidate !== null);

    let lastError: unknown;
    for (let attempt = 0; attempt <= fallbacks.length; attempt += 1) {
      if (params.abortSignal?.aborted) throw lastError ?? new Error("agent run aborted");
      const remainingTimeoutMs = Math.max(0, params.timeoutMs - (Date.now() - startedAt));
      if (remainingTimeoutMs === 0) {
        throw lastError ?? new Error("agent model fallback timeout exhausted");
      }
      const fallback = attempt > 0 ? fallbacks[attempt - 1] : undefined;
      try {
        const result = await options.runAgent({
          ...params,
          ...(fallback
            ? {
                provider: fallback.provider,
                model: fallback.model,
                runId: `${params.runId}:fallback-${attempt}`,
              }
            : {}),
          // ThunderClaw owns the outer candidate loop so each embedded attempt
          // has one unambiguous model and one caller-owned session boundary.
          modelFallbacksOverride: [],
          timeoutMs: remainingTimeoutMs,
        });
        if (!fallback) return result;
        return {
          ...result,
          meta: {
            ...result.meta,
            executionTrace: {
              ...result.meta.executionTrace,
              winnerProvider: result.meta.agentMeta?.provider ?? fallback.provider,
              winnerModel: result.meta.agentMeta?.model ?? fallback.model,
              fallbackUsed: true,
            },
          },
        };
      } catch (error) {
        lastError = error;
        if (params.abortSignal?.aborted) throw error;
      }
    }

    throw lastError ?? new Error("agent model fallback chain was empty");
  };
}

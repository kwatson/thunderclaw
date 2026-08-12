import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentEffectiveModelPrimary,
  resolveAgentIdentity,
  resolveDefaultAgentId,
  resolveDefaultModelForAgent,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export type AgentCompatibilityState =
  | "unverified"
  | "partially_verified"
  | "verified"
  | "incompatible"
  | "unsupported";

export type CompatibilityCheck = "passed" | "failed" | "not_run" | "not_applicable";

export type AgentProbeResult = {
  agentId: string;
  configurationFingerprint: string;
  configuredProvider: string;
  configuredModel: string;
  observedProvider: string | null;
  observedModel: string | null;
  testedAt: string;
  state: Extract<AgentCompatibilityState, "partially_verified" | "verified" | "incompatible">;
  checks: {
    credentials: Exclude<CompatibilityCheck, "not_run" | "not_applicable">;
    structuredOutput: Exclude<CompatibilityCheck, "not_run" | "not_applicable">;
    toolIsolation: Exclude<CompatibilityCheck, "not_run" | "not_applicable">;
    cancellation: Exclude<CompatibilityCheck, "not_run" | "not_applicable">;
    fallbacks: CompatibilityCheck;
  };
  reason: string;
};

export type ThunderClawAgentRecord = {
  agentId: string;
  displayName: string;
  isDefault: boolean;
  provider: string | null;
  model: string | null;
  reasoning: {
    defaultLevel: string | null;
    levels: Array<{ id: string; label: string }>;
  };
  compatibility: {
    state: AgentCompatibilityState;
    executionMode: "restricted-agent";
    usesPersonality: true;
    usesMemory: true;
    toolsDisabled: true;
    checks: {
      configuration: "passed" | "failed";
      credentials: CompatibilityCheck;
      structuredOutput: CompatibilityCheck;
      toolIsolation: CompatibilityCheck;
      cancellation: CompatibilityCheck;
      fallbacks: CompatibilityCheck;
    };
    lastProbe: Pick<AgentProbeResult, "testedAt" | "observedProvider" | "observedModel"> | null;
    reason: string;
  };
};

type AgentRuntime = Pick<
  OpenClawPluginApi["runtime"]["agent"],
  "resolveThinkingPolicy"
>;

export function resolveConfiguredFallbacks(
  config: OpenClawPluginApi["config"],
  agentId: string,
): string[] {
  const model = resolveAgentConfig(config, agentId)?.model;
  return typeof model === "object" && Array.isArray(model.fallbacks)
    ? [...model.fallbacks]
    : [];
}

export function discoverThunderClawAgents(
  config: OpenClawPluginApi["config"],
  runtime: AgentRuntime,
  probeResults: ReadonlyMap<string, AgentProbeResult> = new Map(),
): ThunderClawAgentRecord[] {
  const defaultAgentId = resolveDefaultAgentId(config);

  return listAgentIds(config).map((agentId) => {
    const agentConfig = resolveAgentConfig(config, agentId);
    const identity = resolveAgentIdentity(config, agentId);

    let provider: string | null = null;
    let model: string | null = null;
    try {
      const resolved = resolveDefaultModelForAgent({ cfg: config, agentId });
      provider = resolved.provider || null;
      model = resolved.model || null;
    } catch {
      const primary = resolveAgentEffectiveModelPrimary(config, agentId);
      if (primary) {
        const separator = primary.indexOf("/");
        if (separator > 0 && separator < primary.length - 1) {
          provider = primary.slice(0, separator);
          model = primary.slice(separator + 1);
        }
      }
    }

    const configured = provider !== null && model !== null;
    const candidateProbe = probeResults.get(agentId);
    const probe =
      configured &&
      candidateProbe?.configuredProvider === provider &&
      candidateProbe.configuredModel === model
        ? candidateProbe
        : undefined;
    const thinkingPolicy = configured
      ? runtime.resolveThinkingPolicy({ provider, model })
      : { levels: [], defaultLevel: null };

    return {
      agentId,
      displayName: agentConfig?.name ?? identity?.name ?? agentId,
      isDefault: agentId === defaultAgentId,
      provider,
      model,
      reasoning: {
        defaultLevel: thinkingPolicy.defaultLevel ?? null,
        levels: thinkingPolicy.levels.map((level) => ({
          id: level.id,
          label: level.label,
        })),
      },
      compatibility: {
        state: probe?.state ?? (configured ? "unverified" : "unsupported"),
        executionMode: "restricted-agent",
        usesPersonality: true,
        usesMemory: true,
        toolsDisabled: true,
        checks: {
          configuration: configured ? "passed" : "failed",
          credentials: probe?.checks.credentials ?? "not_run",
          structuredOutput: probe?.checks.structuredOutput ?? "not_run",
          toolIsolation: probe?.checks.toolIsolation ?? "not_run",
          cancellation: probe?.checks.cancellation ?? "not_run",
          fallbacks: probe?.checks.fallbacks ?? "not_run",
        },
        lastProbe: probe
          ? {
              testedAt: probe.testedAt,
              observedProvider: probe.observedProvider,
              observedModel: probe.observedModel,
            }
          : null,
        reason:
          probe?.reason ??
          (configured
            ? "Run the restricted compatibility probe before enabling this agent for production use."
            : "The agent has no resolvable provider/model configuration."),
      },
    };
  });
}

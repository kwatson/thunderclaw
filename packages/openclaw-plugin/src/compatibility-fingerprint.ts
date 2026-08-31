import { createHash } from "node:crypto";
import {
  resolveDefaultModelForAgent,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfiguredFallbacks } from "./agents.js";

export const RESTRICTED_EXECUTION_POLICY_VERSION = "restricted-agent-v1";
export const COMPATIBILITY_PROBE_VERSION = "nonce-json-abort-v2";
export const COMPATIBILITY_CONTRACT_VERSION = "4-rich-list-intent";
export const PINNED_OPENCLAW_COMPATIBILITY_VERSION = "2026.7.2-beta.7";

export class CompatibilityConfigurationError extends Error {
  constructor() {
    super("agent configuration is unsupported for compatibility verification");
  }
}

function boundedIdentifier(value: string, maximum: number): string {
  if (value.length < 1 || value.length > maximum || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new CompatibilityConfigurationError();
  }
  return value;
}

function splitModelReference(reference: string): { provider: string; model: string } {
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) {
    throw new CompatibilityConfigurationError();
  }
  return {
    provider: boundedIdentifier(reference.slice(0, separator), 128),
    model: boundedIdentifier(reference.slice(separator + 1), 256),
  };
}

function safeEndpoint(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (value.length > 2048) throw new CompatibilityConfigurationError();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CompatibilityConfigurationError();
  }
  // User info, query strings, and fragments can contain credential material.
  // Refuse them rather than hashing a possible secret or silently omitting a
  // compatibility-relevant endpoint component.
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new CompatibilityConfigurationError();
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

function boundedStringArray(value: readonly string[] | undefined): string[] | null {
  if (value === undefined) return null;
  if (value.length > 32) throw new CompatibilityConfigurationError();
  return value.map((entry) => boundedIdentifier(entry, 128));
}

function safeTransport(params: Record<string, unknown> | undefined): "sse" | "websocket" | "auto" | null {
  const transport = params?.transport;
  return transport === "sse" || transport === "websocket" || transport === "auto"
    ? transport
    : null;
}

function executionRouteProjection(
  config: OpenClawPluginApi["config"],
  reference: { provider: string; model: string },
): unknown {
  const provider = config.models?.providers?.[reference.provider];
  if (!provider) return null;
  const legacyProviderContext = provider as typeof provider & {
    contextWindow?: number;
    contextTokens?: number;
  };
  const model = provider.models.find((candidate) => candidate.id === reference.model);
  const compat = model?.compat;
  // Credential material and secret-reference identity are deliberately absent.
  // The pinned public config/runtime API exposes no non-secret credential
  // generation/version that could invalidate evidence without hashing secrets.
  return {
    provider: {
      baseUrl: safeEndpoint(provider.baseUrl),
      api: provider.api ?? null,
      authMode: provider.auth ?? null,
      contextWindow: legacyProviderContext.contextWindow ?? null,
      contextTokens: legacyProviderContext.contextTokens ?? null,
      maxTokens: provider.maxTokens ?? null,
      timeoutSeconds: provider.timeoutSeconds ?? null,
      region: provider.region ? boundedIdentifier(provider.region, 128) : null,
      injectNumCtxForOpenAICompat: provider.injectNumCtxForOpenAICompat ?? null,
      agentRuntimeId: provider.agentRuntime?.id ?? null,
      authHeader: provider.authHeader ?? null,
      allowPrivateNetwork: provider.request?.allowPrivateNetwork ?? null,
      transport: safeTransport(provider.params),
    },
    model: model
      ? {
          api: model.api ?? null,
          baseUrl: safeEndpoint(model.baseUrl),
          reasoning: model.reasoning,
          input: [...model.input],
          contextWindow: model.contextWindow,
          contextTokens: model.contextTokens ?? null,
          maxTokens: model.maxTokens,
          agentRuntimeId: model.agentRuntime?.id ?? null,
          transport: safeTransport(model.params),
          compat: compat
            ? {
                supportsTools: compat.supportsTools ?? null,
                supportsJsonSchemaResponseFormat: compat.supportsJsonSchemaResponseFormat ?? null,
                supportsStrictMode: compat.supportsStrictMode ?? null,
                maxTokensField: compat.maxTokensField ?? null,
                requiresStringContent: compat.requiresStringContent ?? null,
                strictMessageKeys: compat.strictMessageKeys ?? null,
                toolSchemaProfile: compat.toolSchemaProfile ?? null,
                unsupportedToolSchemaKeywords: boundedStringArray(compat.unsupportedToolSchemaKeywords),
                toolCallArgumentsEncoding: compat.toolCallArgumentsEncoding ?? null,
                requiresOpenAiAnthropicToolPayload: compat.requiresOpenAiAnthropicToolPayload ?? null,
              }
            : null,
        }
      : null,
  };
}

export function createAgentCompatibilityFingerprint(
  config: OpenClawPluginApi["config"],
  agentId: string,
): string {
  const primary = resolveDefaultModelForAgent({ cfg: config, agentId });
  const fallbacks = resolveConfiguredFallbacks(config, agentId);
  if (fallbacks.length > 8) throw new CompatibilityConfigurationError();
  const models = [
    {
      provider: boundedIdentifier(primary.provider, 128),
      model: boundedIdentifier(primary.model, 256),
    },
    ...fallbacks.map(splitModelReference),
  ];
  const canonical = {
    agentId: boundedIdentifier(agentId, 128),
    models,
    executionRoutes: models.map((reference) => executionRouteProjection(config, reference)),
    restrictedExecutionPolicyVersion: RESTRICTED_EXECUTION_POLICY_VERSION,
    probeVersion: COMPATIBILITY_PROBE_VERSION,
    compatibilityContractVersion: COMPATIBILITY_CONTRACT_VERSION,
    openClawCompatibilityVersion: PINNED_OPENCLAW_COMPATIBILITY_VERSION,
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

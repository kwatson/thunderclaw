import { DirectClientError } from "./direct-client-contract.js";

export type ProviderId = "openai" | "openrouter" | "deepseek" | "fireworks" | "ollama" | "lmstudio" | "custom";
export type ReasoningEffort = "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const DEFAULT_MAX_RESPONSE_TOKENS = 16_384;
// Application guardrail, not a claim about any model's supported token limit.
export const MAX_RESPONSE_TOKENS = 131_072;
const ALL_REASONING_EFFORTS: readonly ReasoningEffort[] = Object.freeze(["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const DEEPSEEK_REASONING_EFFORTS: readonly ReasoningEffort[] = Object.freeze(["default", "none", "low", "high", "max"]);
const FIREWORKS_REASONING_EFFORTS: readonly ReasoningEffort[] = Object.freeze(["default", "none", "low", "medium", "high", "xhigh", "max"]);
const LOCAL_REASONING_EFFORTS: readonly ReasoningEffort[] = Object.freeze(["default", "none", "low", "medium", "high"]);
/** Request formats supported by the provider adapter; individual models may support fewer levels. */
export function reasoningEffortsForProvider(provider: ProviderId): readonly ReasoningEffort[] {
  return provider === "deepseek" ? DEEPSEEK_REASONING_EFFORTS : provider === "fireworks" ? FIREWORKS_REASONING_EFFORTS : provider === "ollama" || provider === "lmstudio" ? LOCAL_REASONING_EFFORTS : ALL_REASONING_EFFORTS;
}
/** Fireworks model, router, and deployment IDs are entered manually for this preset. */
export function supportsModelDiscovery(provider: ProviderId): boolean { return provider !== "fireworks"; }
export type InferenceConfiguration = Readonly<{
  provider: ProviderId;
  apiBase: string;
  model: string;
  outputMode: "json_schema" | "json_object";
  writingStyle: string;
  maxResponseTokens?: number;
  reasoningEffort?: ReasoningEffort;
}>;

export const PROVIDER_PRESETS = Object.freeze([
  { id: "openai", label: "OpenAI", apiBase: "https://api.openai.com/v1", outputMode: "json_schema", requiresKey: true },
  { id: "openrouter", label: "OpenRouter", apiBase: "https://openrouter.ai/api/v1", outputMode: "json_schema", requiresKey: true },
  { id: "deepseek", label: "DeepSeek", apiBase: "https://api.deepseek.com", outputMode: "json_object", requiresKey: true },
  { id: "fireworks", label: "Fireworks AI", apiBase: "https://api.fireworks.ai/inference/v1", outputMode: "json_schema", requiresKey: true },
  { id: "ollama", label: "Ollama", apiBase: "http://127.0.0.1:11434/v1", outputMode: "json_schema", requiresKey: false },
  { id: "lmstudio", label: "LM Studio", apiBase: "http://127.0.0.1:1234/v1", outputMode: "json_schema", requiresKey: false },
  { id: "custom", label: "Custom", apiBase: "", outputMode: "json_schema", requiresKey: false },
] as const);

function invalid(message: string): never {
  throw new DirectClientError("configuration", "INVALID_INFERENCE_CONFIGURATION", message);
}

/** Only canonical base URLs may be extended with the two fixed inference routes. */
export function canonicalizeInferenceBase(input: unknown): Readonly<{
  apiBase: string; origin: string; permissionPattern: string; protocol: "http:" | "https:"; hostname: string;
}> {
  if (typeof input !== "string" || !input || input.length > 2_048 || /[\s\\%?#\u0000-\u001F\u007F]/u.test(input)) {
    return invalid("Enter a canonical inference API base URL without a query or fragment.");
  }
  const match = /^(https?):\/\/([^/]+)(\/.*)?$/iu.exec(input);
  if (!match || match[2].includes("@")) invalid("Use HTTPS, or HTTP with an explicit loopback address, without credentials.");
  const protocol = `${match[1].toLowerCase()}:` as "http:" | "https:";
  const authority = match[2];
  const authorityMatch = /^(\[[^\]]+\]|[^:]+)(?::([0-9]+))?$/u.exec(authority);
  if (!authorityMatch) invalid("The API authority is invalid.");
  const rawHost = authorityMatch[1].toLowerCase();
  const port = authorityMatch[2];
  if (port !== undefined && (!/^[1-9][0-9]{0,4}$/u.test(port) || Number(port) > 65_535)) invalid("The API port is invalid.");
  if (rawHost === "localhost" || rawHost.endsWith(".localhost")) invalid("Use 127.0.0.1 or [::1] explicitly instead of localhost.");
  if (rawHost.endsWith(".") || /(?:^|\.)xn--/u.test(rawHost)) invalid("Use a canonical ASCII hostname.");
  if (rawHost.startsWith("[")) {
    if (rawHost !== "[::1]") invalid("Only canonical IPv6 loopback is supported.");
  } else if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(rawHost)) {
    invalid("The API hostname is invalid.");
  }
  if (protocol === "http:" && rawHost !== "127.0.0.1" && rawHost !== "[::1]") invalid("HTTP is allowed only for 127.0.0.1 or [::1].");
  const path = (match[3] ?? "").replace(/\/$/u, "");
  if (path && (!/^\/(?:[A-Za-z0-9_-]+\/?)+$/u.test(path) || path.includes("//"))) invalid("Use a canonical API base path.");
  let url: URL;
  try { url = new URL(`${protocol}//${authority}${path}`); } catch { return invalid("The API base URL is invalid."); }
  if (url.hostname !== rawHost || url.pathname !== (path || "/")) invalid("Use a canonical hostname and API base path.");
  return Object.freeze({ apiBase: `${url.origin}${path}`, origin: url.origin, permissionPattern: `${protocol}//${rawHost}/*`, protocol, hostname: rawHost });
}

export function validateInferenceConfiguration(input: unknown, options: { allowLegacyThinking?: boolean } = {}): InferenceConfiguration {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Choose an inference provider and model.");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["provider", "apiBase", "model", "outputMode", "writingStyle", "thinking", "maxResponseTokens", "reasoningEffort"].includes(key))) invalid("The inference configuration contains unknown fields.");
  if (!PROVIDER_PRESETS.some((preset) => preset.id === value.provider)) invalid("Choose a supported inference provider.");
  if (typeof value.model !== "string" || !value.model.trim() || value.model !== value.model.trim() || value.model.length > 256 || /[\u0000-\u001F\u007F]/u.test(value.model)) invalid("Enter a model ID of at most 256 characters.");
  if (value.outputMode !== "json_schema" && value.outputMode !== "json_object") invalid("Choose a structured output mode.");
  if (value.provider === "deepseek" && value.outputMode !== "json_object") invalid("DeepSeek requires JSON object compatibility mode.");
  if (Object.hasOwn(value, "thinking") && !options.allowLegacyThinking) invalid("Save a supported thinking level instead of the obsolete thinking setting.");
  if (value.thinking !== undefined && value.thinking !== "disabled" && value.thinking !== "enabled") invalid("Choose a supported thinking mode.");
  if (value.thinking !== undefined && value.reasoningEffort !== undefined) invalid("Choose one thinking setting.");
  const provider = value.provider as ProviderId;
  const reasoningEffort = value.reasoningEffort !== undefined ? value.reasoningEffort : (provider === "deepseek" ? value.thinking === "enabled" ? "high" : "none" : "default");
  if (!reasoningEffortsForProvider(provider).includes(reasoningEffort as ReasoningEffort)) invalid("Choose a thinking level supported by this provider.");
  const maxResponseTokens = value.maxResponseTokens === undefined ? DEFAULT_MAX_RESPONSE_TOKENS : value.maxResponseTokens;
  if (!Number.isSafeInteger(maxResponseTokens) || (maxResponseTokens as number) < 1 || (maxResponseTokens as number) > MAX_RESPONSE_TOKENS) invalid("Response token limit must be a whole number from 1 to 131072.");
  if (typeof value.writingStyle !== "string" || value.writingStyle.length > 4_000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value.writingStyle)) invalid("Writing style must contain at most 4,000 characters.");
  return Object.freeze({ provider: value.provider as ProviderId, apiBase: canonicalizeInferenceBase(value.apiBase).apiBase, model: value.model, outputMode: value.outputMode, writingStyle: value.writingStyle,
    maxResponseTokens: maxResponseTokens as number, reasoningEffort: reasoningEffort as ReasoningEffort });
}

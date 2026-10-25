import * as C from "./direct-client-contract.js";
import * as V from "./direct-client-validators.js";
import { canonicalizeInferenceBase, DEFAULT_MAX_RESPONSE_TOKENS, PROVIDER_PRESETS, validateInferenceConfiguration, type InferenceConfiguration } from "./inference-provider.js";
import { bindComposeOutput, bindMessageOutput, composeOutputSchema, inferenceMessages, messageOutputSchema } from "./inference-output.js";

export const CONFIGURED_MODEL_ID = "configured-model";
export const INFERENCE_FAILURE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  INFERENCE_OUTPUT_LIMIT: "The model reached its response-token limit before finishing. Increase Response token limit or reduce the thinking level in settings, then try again. No changes were applied.",
  INFERENCE_REFUSAL: "The model declined this request. Rephrase the instruction or choose another model. No changes were applied.",
  INFERENCE_CONTENT_FILTER: "The provider filtered this response. Review the selected content or choose another model. No changes were applied.",
  EMPTY_INFERENCE_OUTPUT: "The model returned no usable content. Check the thinking level and response-token limit, then test the connection again.",
  INVALID_INFERENCE_JSON: "The provider returned invalid JSON. Check the model’s structured-output mode and test the connection again.",
  INVALID_INFERENCE_OUTPUT: "The model’s result did not match the required structure. Check structured-output support or choose another model. No changes were applied.",
  INFERENCE_TRANSLATION_COUNT: "The translation did not preserve every message segment. Try a higher response-token limit or another model. No changes were applied.",
  RESPONSE_TOO_LARGE: "The provider’s response exceeded ThunderClaw’s response-size limit. Select less text or reduce the response-token limit.",
  INFERENCE_SETTINGS_REJECTED: "The provider rejected the request settings. Check the model’s response-token limit, thinking level and structured-output mode, then test again.",
  INFERENCE_CONTEXT_LIMIT: "The request exceeded the model’s context limit. Select less text or reduce the response-token limit, then try again.",
});
/** Never forward provider exception messages or arbitrary error codes to user interfaces. */
export function inferenceFailureMessage(code: string): string | undefined {
  return Object.hasOwn(INFERENCE_FAILURE_MESSAGES, code) ? INFERENCE_FAILURE_MESSAGES[code] : undefined;
}

const MAX_TIMEOUT_MS = 180_000;
const encoder = new TextEncoder();
type ActiveRun = { controller: AbortController; requestId: string; composeId?: string; generation?: number; messageHash?: string };
type ClientOptions = { fetchImpl?: typeof fetch; permissionCheck?: () => Promise<boolean>; timeoutMs?: number };

function failure(kind: C.DirectClientErrorKind, code: string, message: string): never { throw new C.DirectClientError(kind, code, inferenceFailureMessage(code) ?? message); }
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) failure("cancellation", "RUN_CANCELLED", "The inference request was cancelled.");
}
/** Inspect only fixed error-code literals; never retain or echo remote messages or parameter names. */
async function httpFailureCode(response: Response, signal: AbortSignal): Promise<string> {
  const fallback = response.status === 400 || response.status === 422 ? "INFERENCE_SETTINGS_REJECTED" : "INFERENCE_HTTP_ERROR";
  if (![400, 422].includes(response.status) || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json" || !response.body) {
    void response.body?.cancel().catch(() => {}); return fallback;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      aborted(signal);
      const { value, done } = await reader.read();
      aborted(signal);
      if (done) break;
      length += value.byteLength;
      if (length > 16_384) { cancel(); return fallback; }
      chunks.push(value);
    }
    const buffer = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
    if (!body || typeof body !== "object" || Array.isArray(body)) return fallback;
    const error = (body as Record<string, unknown>).error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return fallback;
    const code = (error as Record<string, unknown>).code;
    if (typeof code === "string" && ["context_length_exceeded", "context_window_exceeded", "maximum_context_length_exceeded"].includes(code)) return "INFERENCE_CONTEXT_LIMIT";
    return fallback;
  } catch { aborted(signal); return fallback; }
  finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}
function reasoningParameters(configuration: InferenceConfiguration): Record<string, unknown> {
  const effort = configuration.reasoningEffort ?? "default";
  if (effort === "default") return {};
  if (configuration.provider === "deepseek") return effort === "none" ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled" }, reasoning_effort: effort };
  if (configuration.provider === "openrouter") return { reasoning: effort === "none" ? { enabled: false } : { effort } };
  return { reasoning_effort: effort };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) failure("contract", "INVALID_INFERENCE_RESPONSE", "The inference server returned an invalid response.");
  return value as Record<string, unknown>;
}

/** Background-owned stateless inference. All edit identities are bound locally. */
export class InferenceClient implements C.ThunderClawDirectClient {
  readonly binding: C.ConnectionBinding;
  readonly configuration: InferenceConfiguration;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #permissionCheck: () => Promise<boolean>;
  readonly #timeoutMs: number;
  readonly #composes = new Map<string, number>();
  readonly #closed = new Map<string, number>();
  readonly #active = new Map<string, ActiveRun>();

  constructor(configuration: InferenceConfiguration, apiKey: string, binding: C.ConnectionBinding, options: ClientOptions = {}) {
    this.configuration = validateInferenceConfiguration(configuration);
    const endpoint = canonicalizeInferenceBase(this.configuration.apiBase);
    if (binding.apiBase !== endpoint.apiBase || binding.origin !== endpoint.origin || binding.permissionId !== endpoint.permissionPattern
      || !Number.isSafeInteger(binding.epoch) || binding.epoch < 0 || binding.credential.mode !== "device_credential" || !binding.credential.credentialId) {
      failure("configuration", "INVALID_CONNECTION_BINDING", "The inference connection binding is invalid.");
    }
    if (typeof apiKey !== "string" || apiKey.length > 4_096 || /[\u0000-\u0020\u007F]/u.test(apiKey)) failure("configuration", "INVALID_API_KEY", "The API key contains invalid characters.");
    if (PROVIDER_PRESETS.find(({ id }) => id === configuration.provider)?.requiresKey && !apiKey) failure("configuration", "API_KEY_REQUIRED", "This provider requires an API key.");
    const timeoutMs = options.timeoutMs ?? MAX_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) failure("configuration", "INVALID_TIMEOUT", "The inference deadline is invalid.");
    this.binding = Object.freeze({ ...binding, credential: Object.freeze({ ...binding.credential }) });
    this.#apiKey = apiKey;
    // Gecko's native fetch checks its receiver; calling it as a client member fails.
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#permissionCheck = options.permissionCheck ?? (async () => true);
    this.#timeoutMs = timeoutMs;
  }

  private bound<T>(value: T): C.BoundCompletion<T> { return Object.freeze({ binding: this.binding, value }); }
  private selected(agentId: string): void {
    if (agentId !== CONFIGURED_MODEL_ID) failure("capability", "UNKNOWN_MODEL", "Choose the configured model.");
  }
  private agent(): C.AgentRecord {
    return {
      agentId: CONFIGURED_MODEL_ID, displayName: this.configuration.model, isDefault: true,
      provider: this.configuration.provider, model: this.configuration.model, reasoning: { defaultLevel: null, levels: [] },
      compatibility: {
        state: "verified", executionMode: "restricted-agent", usesPersonality: true, usesMemory: true, toolsDisabled: true,
        checks: { configuration: "passed", credentials: "passed", structuredOutput: "passed", toolIsolation: "passed", cancellation: "passed", fallbacks: "not_applicable" },
        lastProbe: { testedAt: new Date().toISOString(), observedProvider: this.configuration.provider, observedModel: this.configuration.model },
        reason: "Local compatibility adapter for the configured model; use Test connection to check remote support. Every generated result is validated locally.",
      },
    };
  }
  async hello(options?: C.DirectCallOptions): Promise<C.BoundCompletion<C.GatewayStatus>> {
    aborted(options?.signal);
    return this.bound({ protocolVersion: 1, plugin: "thunderclaw", gatewayVersion: "standalone", capabilities: { compose: true, message: true, standalone: true, flatListItemReplacement: true, richBlockReplacement: true } });
  }
  status(options?: C.DirectCallOptions) { return this.hello(options); }
  async listAgents(requestId: string, options?: C.DirectCallOptions): Promise<C.BoundCompletion<C.AgentListResponse>> {
    aborted(options?.signal);
    return this.bound({ protocolVersion: 1, requestId: V.validateListAgentsRequestId(requestId), agents: [this.agent()] });
  }
  async probeAgent(input: C.AgentProbeRequest, options?: C.DirectCallOptions): Promise<C.BoundCompletion<C.AgentProbeResponse>> {
    const request = V.validateAgentProbeRequest(input); aborted(options?.signal); this.selected(request.agentId);
    return this.bound({ protocolVersion: 1, requestId: request.requestId, probeRunId: request.probeRunId, agent: this.agent() });
  }
  async cancelAgentProbe(input: C.CancelAgentProbeRequest, options?: C.DirectCallOptions): Promise<C.BoundCompletion<C.CancelAgentProbeResponse>> {
    const request = V.validateCancelAgentProbeRequest(input); aborted(options?.signal); this.selected(request.agentId);
    return this.bound({ ...request, cancelled: true });
  }
  async openCompose(input: C.OpenComposeRequest, options?: C.DirectCallOptions): Promise<C.BoundCompletion<C.OpenComposeResponse>> {
    const request = V.validateOpenComposeRequest(input); aborted(options?.signal); this.selected(request.agentId);
    const current = this.#composes.get(request.composeId);
    if (request.composeGeneration <= (this.#closed.get(request.composeId) ?? 0) || (current !== undefined && request.composeGeneration < current)) failure("contract", "STALE_COMPOSE_GENERATION", "This compose snapshot is stale.");
    if (current !== undefined && current !== request.composeGeneration) this.abortCompose(request.composeId, current);
    this.#composes.set(request.composeId, request.composeGeneration);
    return this.bound({ protocolVersion: 1, requestId: request.requestId, composeId: request.composeId, composeGeneration: request.composeGeneration, sessionId: `local-${request.composeId}-${request.composeGeneration}` });
  }
  private abortCompose(composeId: string, generation: number): void {
    for (const run of this.#active.values()) if (run.composeId === composeId && run.generation === generation) run.controller.abort();
  }
  async closeCompose(input: C.OpenComposeRequest, options?: C.DirectCallOptions): Promise<C.BoundCompletion<C.CloseComposeResponse>> {
    const request = V.validateOpenComposeRequest(input); aborted(options?.signal); this.selected(request.agentId);
    this.abortCompose(request.composeId, request.composeGeneration);
    if (this.#composes.get(request.composeId) === request.composeGeneration) this.#composes.delete(request.composeId);
    this.#closed.set(request.composeId, Math.max(this.#closed.get(request.composeId) ?? 0, request.composeGeneration));
    return this.bound({ protocolVersion: 1, requestId: request.requestId, composeId: request.composeId, composeGeneration: request.composeGeneration, closed: true });
  }
  private evidence(): C.RunEvidence {
    return { provider: this.configuration.provider, model: this.configuration.model, runtimeSessionMarker: null, repairAttempted: false };
  }
  async transformCompose(input: C.TransformComposeRequest, options?: C.DirectCallOptions): Promise<C.BoundCompletion<C.TransformComposeResponse>> {
    const request = V.validateTransformComposeRequest(input); this.selected(request.agentId);
    if (this.#composes.get(request.composeId) !== request.composeGeneration) failure("contract", "COMPOSE_NOT_OPEN", "Open the current compose snapshot before generating.");
    if ([...this.#active.values()].some((run) => run.composeId === request.composeId && run.generation === request.composeGeneration)) failure("contract", "RUN_ALREADY_ACTIVE", "A generation is already active for this compose window.");
    const run = { controller: new AbortController(), requestId: request.requestId, composeId: request.composeId, generation: request.composeGeneration };
    return this.run(request.runId, run, options, async (signal) => {
      const value = await this.complete(request, composeOutputSchema(request), signal);
      if (this.#composes.get(request.composeId) !== request.composeGeneration) failure("contract", "STALE_COMPOSE_GENERATION", "This compose snapshot is stale.");
      return this.bound(bindComposeOutput(value, request, this.evidence()));
    });
  }
  async transformMessage(input: C.TransformMessageRequest, options?: C.DirectCallOptions): Promise<C.BoundCompletion<C.TransformMessageResponse>> {
    const request = V.validateTransformMessageRequest(input); this.selected(request.agentId);
    const run = { controller: new AbortController(), requestId: request.requestId, messageHash: request.messageHash };
    return this.run(request.runId, run, options, async (signal) => this.bound(bindMessageOutput(await this.complete(request, messageOutputSchema(request), signal), request, this.evidence())));
  }
  async cancelComposeRun(input: C.CancelComposeRequest, options?: C.DirectCallOptions): Promise<C.BoundCompletion<C.CancelComposeResponse>> {
    const request = V.validateCancelComposeRequest(input); aborted(options?.signal); this.selected(request.agentId);
    const run = this.#active.get(request.runId);
    if (run?.composeId === request.composeId && run.generation === request.composeGeneration) run.controller.abort();
    return this.bound({ protocolVersion: 1, requestId: request.requestId, runId: request.runId, cancelled: true });
  }
  async cancelMessageTransform(input: C.CancelMessageRequest, options?: C.DirectCallOptions): Promise<C.BoundCompletion<C.CancelMessageResponse>> {
    const request = V.validateCancelMessageRequest(input); aborted(options?.signal);
    const run = this.#active.get(request.runId);
    if (run?.messageHash === request.messageHash && run.requestId === request.transformRequestId) run.controller.abort();
    return this.bound({ ...request, cancelled: true });
  }
  private async run<T>(runId: string, run: ActiveRun, options: C.DirectCallOptions | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#active.has(runId)) failure("contract", "RUN_ALREADY_ACTIVE", "This generation is already active.");
    this.#active.set(runId, run);
    try { return await this.scope(work, options, run.controller); }
    finally { if (this.#active.get(runId) === run) this.#active.delete(runId); }
  }
  /** Races the entire operation, including permission, fetch and body reads, against cancellation/deadline. */
  private async scope<T>(work: (signal: AbortSignal) => Promise<T>, options?: C.DirectCallOptions, controller = new AbortController()): Promise<T> {
    aborted(options?.signal);
    let timedOut = false;
    const cancel = () => controller.abort();
    options?.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    let rejectAbort!: (reason: unknown) => void;
    const onAbort = () => rejectAbort(new C.DirectClientError(timedOut ? "timeout" : "cancellation", timedOut ? "INFERENCE_TIMEOUT" : "RUN_CANCELLED", timedOut ? "The inference request exceeded its time limit." : "The inference request was cancelled."));
    const cancellation = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    controller.signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (controller.signal.aborted) onAbort();
      return await Promise.race([cancellation, Promise.resolve().then(() => { aborted(controller.signal); return work(controller.signal); })]);
    } catch (error) {
      if (error instanceof C.DirectClientError) {
        const message = inferenceFailureMessage(error.code);
        if (message) throw new C.DirectClientError(error.kind, error.code, message, error.status);
        throw error;
      }
      return failure("network", "INFERENCE_NETWORK_ERROR", "Unable to contact the inference server.");
    } finally {
      clearTimeout(timer); options?.signal?.removeEventListener("abort", cancel); controller.signal.removeEventListener("abort", onAbort);
    }
  }
  private async request(path: "/chat/completions" | "/models", body: unknown | undefined, signal: AbortSignal): Promise<unknown> {
    if (!await this.#permissionCheck()) failure("permission", "HOST_PERMISSION_REQUIRED", "Allow access to the configured inference server.");
    aborted(signal);
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && encoder.encode(serialized).byteLength > C.DIRECT_CLIENT_MAX_REQUEST_BYTES) failure("contract", "REQUEST_TOO_LARGE", "The selected content exceeds the inference request limit.");
    const headers = new Headers({ Accept: "application/json" });
    if (serialized !== undefined) headers.set("Content-Type", "application/json");
    if (this.#apiKey) headers.set("Authorization", `Bearer ${this.#apiKey}`);
    const url = `${this.configuration.apiBase}${path}`;
    const response = await this.#fetch(url, { method: serialized === undefined ? "GET" : "POST", headers, body: serialized, signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    if (signal.aborted) void response.body?.cancel().catch(() => {});
    aborted(signal);
    if (response.redirected || (response.url && response.url !== url) || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => {});
      failure("contract", "INFERENCE_REDIRECT_REJECTED", "The inference server attempted an unexpected redirect.");
    }
    if (!response.ok) {
      const code = await httpFailureCode(response, signal);
      const kind = response.status === 401 ? "authentication" : response.status === 403 ? "permission" : response.status === 429 ? "rate_limit" : "backend";
      throw new C.DirectClientError(kind, code, inferenceFailureMessage(code) ?? "The inference server rejected the request.", response.status);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") { void response.body?.cancel().catch(() => {}); failure("contract", "INVALID_INFERENCE_RESPONSE", "The inference server did not return JSON."); }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > C.DIRECT_CLIENT_MAX_RESPONSE_BYTES)) { void response.body?.cancel().catch(() => {}); failure("contract", "RESPONSE_TOO_LARGE", "The inference response exceeds its size limit."); }
    if (!response.body) failure("contract", "EMPTY_INFERENCE_OUTPUT", "The inference server returned an empty response.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    const cancelReader = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancelReader, { once: true });
    try {
      while (true) {
        aborted(signal);
        const { value, done } = await reader.read();
        aborted(signal);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > C.DIRECT_CLIENT_MAX_RESPONSE_BYTES) { cancelReader(); failure("contract", "RESPONSE_TOO_LARGE", "The inference response exceeds its size limit."); }
        chunks.push(value);
      }
    } finally { signal.removeEventListener("abort", cancelReader); reader.releaseLock(); }
    const buffer = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)); }
    catch { failure("contract", "INVALID_INFERENCE_JSON", "The inference server returned invalid JSON."); }
  }
  private async complete(request: C.TransformComposeRequest | C.TransformMessageRequest, schema: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const responseFormat = this.configuration.outputMode === "json_schema"
      ? { type: "json_schema", json_schema: { name: "thunderclaw_content", strict: true, schema } }
      : { type: "json_object" };
    const envelope = record(await this.request("/chat/completions", {
      model: this.configuration.model, stream: false, n: 1,
      messages: inferenceMessages(request, schema, this.configuration.writingStyle), response_format: responseFormat,
      ...(this.configuration.provider === "openai" ? { store: false, max_completion_tokens: this.configuration.maxResponseTokens ?? DEFAULT_MAX_RESPONSE_TOKENS } : { max_tokens: this.configuration.maxResponseTokens ?? DEFAULT_MAX_RESPONSE_TOKENS }),
      ...reasoningParameters(this.configuration),
      ...(this.configuration.provider === "openrouter" ? { provider: { require_parameters: true, allow_fallbacks: false } } : {}),
    }, signal));
    if (!Array.isArray(envelope.choices) || envelope.choices.length !== 1 || envelope.error !== undefined) failure("contract", "INVALID_INFERENCE_RESPONSE", "The inference server returned an invalid completion.");
    const choice = record(envelope.choices[0]);
    if (choice.finish_reason === "length") failure("contract", "INFERENCE_OUTPUT_LIMIT", "The model reached its response limit before finishing. No changes were applied.");
    if (choice.finish_reason === "content_filter") failure("contract", "INFERENCE_CONTENT_FILTER", "The provider filtered the response.");
    const message = record(choice.message);
    if (message.refusal != null) failure("contract", "INFERENCE_REFUSAL", "The model declined the request.");
    if (choice.finish_reason !== "stop" || message.role !== "assistant" || message.function_call != null
      || (message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0))) {
      failure("contract", "INCOMPLETE_INFERENCE_OUTPUT", "The model refused or did not complete a safe structured result.");
    }
    if (message.content == null || (typeof message.content === "string" && !message.content.trim())) failure("contract", "EMPTY_INFERENCE_OUTPUT", "The model returned no content.");
    if (typeof message.content !== "string") failure("contract", "INVALID_INFERENCE_OUTPUT", "The model returned unsupported content.");
    try { return JSON.parse(message.content); }
    catch { failure("contract", "INVALID_INFERENCE_JSON", "The model returned invalid JSON content."); }
  }
  async listModels(options?: C.DirectCallOptions): Promise<string[]> {
    return this.scope(async (signal) => {
      const envelope = record(await this.request("/models", undefined, signal));
      if (!Array.isArray(envelope.data) || envelope.data.length > 5_000) failure("contract", "INVALID_MODEL_LIST", "The inference server returned an invalid model list.");
      const models = envelope.data.map((item) => record(item).id);
      if (models.some((id) => typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 256 || /[\u0000-\u001F\u007F]/u.test(id))) failure("contract", "INVALID_MODEL_LIST", "The inference server returned an invalid model ID.");
      return [...new Set(models as string[])].sort();
    }, options);
  }
  async testConnection(options?: C.DirectCallOptions): Promise<void> {
    // These bounded samples contain no user email and exercise both operation families.
    const compose: C.TransformComposeRequest = { protocolVersion: 1, requestId: "test-compose", runId: "test-compose", agentId: CONFIGURED_MODEL_ID, composeId: "test", composeGeneration: 1, action: "proofread", contextHash: "test", targetHash: "test", document: { subject: "", recipients: [], authoredText: "Hello." }, target: { targetId: "test", text: "Hello.", start: 0, end: 6 }, limits: { maxOperations: 1, maxOutputCharacters: 1_000 } };
    const message: C.TransformMessageRequest = { protocolVersion: 1, requestId: "test-message", runId: "test-message", agentId: CONFIGURED_MODEL_ID, action: "translate", sourceLanguage: "English", targetLanguage: "French", messageHash: "test", document: { subject: "", author: "", segments: [{ id: "one", text: "Hello." }, { id: "two", text: "Thank you." }] }, limits: { maxSegments: 2, maxOutputCharacters: 1_000 } };
    await this.scope(async (signal) => {
      bindComposeOutput(await this.complete(compose, composeOutputSchema(compose), signal), compose, this.evidence());
      bindMessageOutput(await this.complete(message, messageOutputSchema(message), signal), message, this.evidence());
    }, options);
  }
}

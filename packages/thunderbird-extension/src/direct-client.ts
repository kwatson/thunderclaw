import {
  classifyBackendError,
  DIRECT_OPERATION_SPECS,
  DirectClientError,
  sameConnectionBinding,
  type AgentListResponse,
  type AgentProbeRequest,
  type AgentProbeResponse,
  type BoundCompletion,
  type CancelComposeRequest,
  type CancelComposeResponse,
  type CancelAgentProbeRequest,
  type CancelAgentProbeResponse,
  type CancelMessageRequest,
  type CancelMessageResponse,
  type ClientAuthentication,
  type CloseComposeResponse,
  type ConnectionBinding,
  type DirectCallOptions,
  type DirectOperation,
  type GatewayStatus,
  type OpenComposeRequest,
  type OpenComposeResponse,
  type ThunderClawDirectClient,
  type TransformComposeRequest,
  type TransformComposeResponse,
  type TransformMessageRequest,
  type TransformMessageResponse,
} from "./direct-client-contract.js";
import {
  validateCancelComposeRequest,
  validateAgentProbeRequest,
  validateAgentProbeResponse,
  validateCancelAgentProbeRequest,
  validateCancelAgentProbeResponse,
  validateAgentListResponse,
  validateCancelComposeResponse,
  validateCancelMessageRequest,
  validateCancelMessageResponse,
  validateCloseComposeResponse,
  validateGatewayStatus,
  validateListAgentsRequestId,
  validateOpenComposeRequest,
  validateOpenComposeResponse,
  validateTransformComposeRequest,
  validateTransformComposeResponse,
  validateTransformMessageRequest,
  validateTransformMessageResponse,
} from "./direct-client-validators.js";
import { canonicalizeApiBase } from "./endpoint-policy.js";

type Fetch = typeof fetch;

function configuration(code: string, message: string): never {
  throw new DirectClientError("configuration", code, message);
}

function validateConstruction(binding: ConnectionBinding, authentication: ClientAuthentication): URL {
  if (!sameConnectionBinding(binding, { ...binding, credential: authentication.binding })) {
    configuration("AUTHENTICATION_BINDING_MISMATCH", "authentication does not match the connection binding");
  }
  let apiBase: URL;
  try {
    const canonical = canonicalizeApiBase(binding.apiBase);
    if (canonical.apiBase !== binding.apiBase || canonical.origin !== binding.origin || canonical.permissionPattern !== binding.permissionId) {
      return configuration("INVALID_API_BASE", "the configured ThunderClaw API base is not canonical");
    }
    apiBase = new URL(canonical.apiBase);
  } catch {
    return configuration("INVALID_API_BASE", "the configured ThunderClaw API base is invalid");
  }
  return apiBase;
}

function retryAfterMilliseconds(headers: Headers): number | null {
  const value = headers.get("retry-after");
  if (value === null) return null;
  if (/^\d+$/u.test(value)) return Math.min(Number(value) * 1000, Number.MAX_SAFE_INTEGER);
  const deadline = Date.parse(value);
  return Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : null;
}

function safeBackendErrorMessage(kind: DirectClientError["kind"]): string {
  switch (kind) {
    case "authentication": return "ThunderClaw authentication was rejected.";
    case "permission": return "ThunderClaw does not have permission to complete this request.";
    case "capability": return "This ThunderClaw operation is not available.";
    case "rate_limit": return "ThunderClaw is temporarily rate limited. Try again later.";
    case "cancellation": return "The ThunderClaw operation was cancelled.";
    case "contract": return "ThunderClaw returned a response that does not match the expected contract.";
    case "backend": return "ThunderClaw could not complete the request.";
    case "configuration": return "ThunderClaw is not configured correctly.";
    case "network": return "The OpenClaw Gateway is unavailable.";
    case "timeout": return "The ThunderClaw request timed out.";
  }
}

function object(value: unknown, label: string, status: number | null = null): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DirectClientError("contract", "INVALID_BACKEND_RESPONSE", `${label} must be an object`, status);
  }
  return value as Record<string, unknown>;
}

function parseStructuredError(value: unknown, response: Response): DirectClientError {
  const envelope = object(value, "error response", response.status);
  const error = object(envelope.error, "error", response.status);
  if (typeof error.code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code) || typeof error.message !== "string" || error.message.length === 0 || error.message.length > 1_000 || /[\u0000-\u001F\u007F]/u.test(error.message)) {
    return new DirectClientError("contract", "INVALID_BACKEND_RESPONSE", "ThunderClaw returned an invalid error response", response.status);
  }
  const kind = classifyBackendError(error.code, response.status);
  return new DirectClientError(kind, error.code, safeBackendErrorMessage(kind), response.status, retryAfterMilliseconds(response.headers));
}

function cancelResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // Response disposal is best-effort; the location failure remains authoritative.
  }
}

async function readLimitedResponse(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && !/^(?:0|[1-9][0-9]*)$/u.test(declared)) {
    try { await response.body?.cancel(); } catch { /* Best-effort response disposal. */ }
    throw new DirectClientError("contract", "INVALID_BACKEND_RESPONSE", "ThunderClaw returned an invalid Content-Length", response.status);
  }
  if (declared !== null && Number(declared) > maximum) {
    try { await response.body?.cancel(); } catch { /* The declared size failure remains authoritative. */ }
    throw new DirectClientError("contract", "BACKEND_RESPONSE_TOO_LARGE", "ThunderClaw response is too large", response.status);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) {
        try {
          await reader.cancel();
        } catch {
          // The size failure remains authoritative even if stream cancellation fails.
        }
        throw new DirectClientError("contract", "BACKEND_RESPONSE_TOO_LARGE", "ThunderClaw response is too large", response.status);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJson(bytes: Uint8Array, status: number): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DirectClientError("contract", "INVALID_BACKEND_UTF8", "ThunderClaw returned invalid UTF-8", status);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DirectClientError("contract", "INVALID_BACKEND_JSON", "ThunderClaw returned malformed JSON", status);
  }
}

export class BrowserThunderClawDirectClient implements ThunderClawDirectClient {
  readonly binding: ConnectionBinding;

  constructor(
    binding: ConnectionBinding,
    private readonly authentication: ClientAuthentication,
    private readonly fetchImpl: Fetch = fetch,
    private readonly credentialLifecycleRejected?: (code: "CREDENTIAL_EXPIRED" | "CREDENTIAL_REVOKED") => void | Promise<void>,
  ) {
    this.binding = Object.freeze({ ...binding, credential: Object.freeze({ ...binding.credential }) });
    validateConstruction(this.binding, authentication);
  }

  private async call(operation: DirectOperation, query: URLSearchParams | null, body: unknown, options: DirectCallOptions | undefined): Promise<unknown> {
    const spec = DIRECT_OPERATION_SPECS[operation];
    if (!spec.implementedByCurrentPlugin) throw new DirectClientError("capability", "OPERATION_NOT_IMPLEMENTED", `${operation} is not implemented by the current ThunderClaw plugin`);
    const url = new URL(`${this.binding.apiBase}${spec.path}`);
    if (query) url.search = query.toString();
    if (url.origin !== this.binding.origin || !url.pathname.startsWith("/thunderclaw/v1/")) configuration("ROUTE_OUTSIDE_API_BASE", "request route is outside the configured API base");

    let encodedBody: string | undefined;
    if (body !== undefined) {
      try {
        encodedBody = JSON.stringify(body);
      } catch {
        throw new DirectClientError("contract", "INVALID_REQUEST", "request cannot be encoded as JSON");
      }
      if (new TextEncoder().encode(encodedBody).byteLength > spec.maxRequestBytes) throw new DirectClientError("contract", "REQUEST_TOO_LARGE", "ThunderClaw request is too large");
    }

    const controller = new AbortController();
    const abortState: { cause: "caller" | "timeout" | null } = {
      cause: options?.signal?.aborted === true ? "caller" : null,
    };
    const abortFromCaller = () => {
      if (abortState.cause === null) abortState.cause = "caller";
      controller.abort();
    };
    options?.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (abortState.cause === "caller") controller.abort();
    const timeout = setTimeout(() => {
      if (abortState.cause === null) abortState.cause = "timeout";
      controller.abort();
    }, spec.timeoutMs);
    const abortError = (): DirectClientError => abortState.cause === "timeout"
      ? new DirectClientError("timeout", "REQUEST_TIMEOUT", "ThunderClaw request timed out")
      : new DirectClientError("cancellation", "REQUEST_ABORTED", "ThunderClaw request was cancelled");
    const aborted = new Promise<never>((_resolve, reject) => {
      if (abortState.cause === null) controller.signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
    const headers = new Headers({ accept: "application/json" });
    if (encodedBody !== undefined) headers.set("content-type", "application/json");
    let authenticationOpen = true;
    let authorized = false;
    try {
      if (abortState.cause !== null) throw abortError();
      const authorization = (async () => {
        try {
          await this.authentication.authorize({
            setBearerCredential: (credential) => {
              if (!authenticationOpen || abortState.cause !== null) return;
              if (authorized) configuration("INVALID_AUTHENTICATION", "authentication attempted to set more than one credential");
              if (typeof credential !== "string" || credential.length === 0 || /[\r\n]/u.test(credential)) configuration("INVALID_AUTHENTICATION", "authentication supplied an invalid credential");
              headers.set("authorization", `Bearer ${credential}`);
              authorized = true;
            },
          });
        } catch (error) {
          if (error instanceof DirectClientError) throw error;
          throw new DirectClientError("authentication", "CREDENTIAL_UNAVAILABLE", "ThunderClaw authentication is unavailable");
        }
        if (!authorized) throw new DirectClientError("authentication", "CREDENTIAL_UNAVAILABLE", "ThunderClaw authentication is unavailable");
      })();
      await Promise.race([authorization, aborted]);
      authenticationOpen = false;
      if (abortState.cause !== null) throw abortError();
      // Thunderbird's native fetch rejects when invoked as an object method
      // with the direct-client instance as its receiver. Preserve the injected
      // Fetch seam, but call the function unbound just like global fetch.
      const fetchRequest = this.fetchImpl;
      const response = await fetchRequest(url.href, {
        method: spec.method,
        headers,
        body: encodedBody,
        redirect: "manual",
        signal: controller.signal,
      });
      if ((response.status >= 300 && response.status <= 399) || response.redirected || response.type === "opaqueredirect" || response.url !== url.href) {
        cancelResponseBody(response);
        throw new DirectClientError("contract", "REDIRECT_REJECTED", "ThunderClaw rejected an unexpected response location", response.status);
      }
      const bytes = await readLimitedResponse(response, spec.maxResponseBytes);
      const parsed = parseJson(bytes, response.status);
      if (!response.ok) throw parseStructuredError(parsed, response);
      return parsed;
    } catch (error) {
      if (error instanceof DirectClientError) {
        if ((error.code === "CREDENTIAL_EXPIRED" || error.code === "CREDENTIAL_REVOKED") && this.credentialLifecycleRejected) {
          try { await this.credentialLifecycleRejected(error.code); } catch { /* The authoritative lifecycle rejection remains primary. */ }
        }
        throw error;
      }
      if (abortState.cause !== null) throw abortError();
      throw new DirectClientError("network", "NETWORK_FAILURE", "The OpenClaw Gateway is unavailable");
    } finally {
      authenticationOpen = false;
      clearTimeout(timeout);
      options?.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private complete<T>(value: T): BoundCompletion<T> {
    return { binding: this.binding, value };
  }

  async hello(options?: DirectCallOptions): Promise<BoundCompletion<GatewayStatus>> {
    return this.complete(validateGatewayStatus(await this.call("hello", null, undefined, options)));
  }

  async status(options?: DirectCallOptions): Promise<BoundCompletion<GatewayStatus>> {
    return this.complete(validateGatewayStatus(await this.call("status", null, undefined, options)));
  }

  async listAgents(requestId: string, options?: DirectCallOptions): Promise<BoundCompletion<AgentListResponse>> {
    const validatedRequestId = validateListAgentsRequestId(requestId);
    const query = new URLSearchParams({ requestId: validatedRequestId });
    return this.complete(validateAgentListResponse(await this.call("agents.list", query, undefined, options), validatedRequestId));
  }

  async probeAgent(request: AgentProbeRequest, options?: DirectCallOptions): Promise<BoundCompletion<AgentProbeResponse>> {
    const validated = validateAgentProbeRequest(request);
    return this.complete(validateAgentProbeResponse(await this.call("agents.probe", null, validated, options), validated));
  }

  async cancelAgentProbe(request: CancelAgentProbeRequest, options?: DirectCallOptions): Promise<BoundCompletion<CancelAgentProbeResponse>> {
    const validated = validateCancelAgentProbeRequest(request);
    return this.complete(validateCancelAgentProbeResponse(await this.call("agents.probe.cancel", null, validated, options), validated));
  }

  async openCompose(request: OpenComposeRequest, options?: DirectCallOptions): Promise<BoundCompletion<OpenComposeResponse>> {
    const validated = validateOpenComposeRequest(request);
    return this.complete(validateOpenComposeResponse(await this.call("compose.open", null, validated, options), validated));
  }

  async transformCompose(request: TransformComposeRequest, options?: DirectCallOptions): Promise<BoundCompletion<TransformComposeResponse>> {
    const validated = validateTransformComposeRequest(request);
    return this.complete(validateTransformComposeResponse(await this.call("compose.transform", null, validated, options), validated));
  }

  async cancelComposeRun(request: CancelComposeRequest, options?: DirectCallOptions): Promise<BoundCompletion<CancelComposeResponse>> {
    const validated = validateCancelComposeRequest(request);
    return this.complete(validateCancelComposeResponse(await this.call("compose.cancel", null, validated, options), validated));
  }

  async closeCompose(request: OpenComposeRequest, options?: DirectCallOptions): Promise<BoundCompletion<CloseComposeResponse>> {
    const validated = validateOpenComposeRequest(request);
    return this.complete(validateCloseComposeResponse(await this.call("compose.close", null, validated, options), validated));
  }

  async transformMessage(request: TransformMessageRequest, options?: DirectCallOptions): Promise<BoundCompletion<TransformMessageResponse>> {
    const validated = validateTransformMessageRequest(request);
    return this.complete(validateTransformMessageResponse(await this.call("message.transform", null, validated, options), validated));
  }

  async cancelMessageTransform(request: CancelMessageRequest, options?: DirectCallOptions): Promise<BoundCompletion<CancelMessageResponse>> {
    const validated = validateCancelMessageRequest(request);
    return this.complete(validateCancelMessageResponse(await this.call("message.cancel", null, validated, options), validated));
  }
}

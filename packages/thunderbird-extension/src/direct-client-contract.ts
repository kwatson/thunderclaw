/**
 * Browser-compatible protocol and ownership contract for the background-owned
 * ThunderClaw direct client. This module deliberately performs no I/O.
 */

export const THUNDERCLAW_PROTOCOL_VERSION = 1 as const;
export const THUNDERCLAW_PLUGIN_ID = "thunderclaw" as const;
export const DIRECT_CLIENT_MAX_REQUEST_BYTES = 256_000;
export const DIRECT_CLIENT_MAX_RESPONSE_BYTES = 1_048_576;
export const CONNECTION_CLEANUP_TIMEOUT_MS = 10_000;

export type DirectOperation =
  | "hello"
  | "status"
  | "agents.list"
  | "agents.probe"
  | "agents.probe.cancel"
  | "compose.open"
  | "compose.transform"
  | "compose.cancel"
  | "compose.close"
  | "message.transform"
  | "message.cancel";

export type DirectOperationSpec = Readonly<{
  method: "GET" | "POST";
  path: `/${string}`;
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  /** False means the v1 client contract is reserved but the plugin route is a gate. */
  implementedByCurrentPlugin: boolean;
}>;

/** Fixed paths are relative to a canonical `/thunderclaw/v1` API base. */
export const DIRECT_OPERATION_SPECS = {
  hello: { method: "GET", path: "/status", timeoutMs: 10_000, maxRequestBytes: 0, maxResponseBytes: 65_536, implementedByCurrentPlugin: true },
  status: { method: "GET", path: "/status", timeoutMs: 10_000, maxRequestBytes: 0, maxResponseBytes: 65_536, implementedByCurrentPlugin: true },
  "agents.list": { method: "GET", path: "/agents", timeoutMs: 15_000, maxRequestBytes: 0, maxResponseBytes: 262_144, implementedByCurrentPlugin: true },
  "agents.probe": { method: "POST", path: "/agents/probe", timeoutMs: 195_000, maxRequestBytes: 65_536, maxResponseBytes: 262_144, implementedByCurrentPlugin: true },
  "agents.probe.cancel": { method: "POST", path: "/agents/probe/cancel", timeoutMs: 10_000, maxRequestBytes: 65_536, maxResponseBytes: 65_536, implementedByCurrentPlugin: true },
  "compose.open": { method: "POST", path: "/compose/open", timeoutMs: 15_000, maxRequestBytes: DIRECT_CLIENT_MAX_REQUEST_BYTES, maxResponseBytes: 65_536, implementedByCurrentPlugin: true },
  "compose.transform": { method: "POST", path: "/compose/transform", timeoutMs: 195_000, maxRequestBytes: DIRECT_CLIENT_MAX_REQUEST_BYTES, maxResponseBytes: DIRECT_CLIENT_MAX_RESPONSE_BYTES, implementedByCurrentPlugin: true },
  "compose.cancel": { method: "POST", path: "/compose/cancel", timeoutMs: 10_000, maxRequestBytes: 65_536, maxResponseBytes: 65_536, implementedByCurrentPlugin: true },
  "compose.close": { method: "POST", path: "/compose/close", timeoutMs: 10_000, maxRequestBytes: 65_536, maxResponseBytes: 65_536, implementedByCurrentPlugin: true },
  "message.transform": { method: "POST", path: "/message/transform", timeoutMs: 195_000, maxRequestBytes: DIRECT_CLIENT_MAX_REQUEST_BYTES, maxResponseBytes: DIRECT_CLIENT_MAX_RESPONSE_BYTES, implementedByCurrentPlugin: true },
  "message.cancel": { method: "POST", path: "/message/cancel", timeoutMs: 10_000, maxRequestBytes: 65_536, maxResponseBytes: 65_536, implementedByCurrentPlugin: true },
} as const satisfies Record<DirectOperation, DirectOperationSpec>;

export type ComposeIdentity = {
  composeId: string;
  composeGeneration: number;
  agentId: string;
};

export type OpenComposeRequest = ComposeIdentity & { protocolVersion: 1; requestId: string };

export type RichTextSpan = { text: string; marks?: Array<"bold" | "italic" | "underline"> };
export type RichBlock =
  | { type: "paragraph"; spans: RichTextSpan[] }
  | { type: "unordered_list" | "ordered_list"; items: Array<{ spans: RichTextSpan[] }> };

export type TransformComposeRequest = ComposeIdentity & {
  protocolVersion: 1;
  requestId: string;
  runId: string;
  action: "improve" | "proofread" | "shorten" | "tone" | "translate" | "summarize" | "ask";
  instruction?: string | null;
  contextHash: string;
  targetHash: string;
  document: { subject: string; recipients: string[]; authoredText: string; quotedText?: string };
  target: { targetId: string; text: string; start: number; end: number;
    selectionShape?: "text-range" | "flat-list-items" | "rich-blocks"; items?: string[] };
  limits: { maxOperations: number; maxOutputCharacters: number };
};

export type EditResult = {
  version: 1;
  requestId: string;
  composeGeneration: number;
  contextHash: string;
  targetHash: string;
  operations: Array<
    | { type: "replace_text_range"; targetId: string; start: number; end: number; text: string; items?: never }
    | { type: "replace_flat_list_items"; targetId: string; items: string[]; text?: never }
    | { type: "replace_rich_blocks"; targetId: string; blocks: RichBlock[]; text?: never; items?: never }
  >;
  summary: string;
};

export type TransformMessageRequest = {
  protocolVersion: 1;
  requestId: string;
  runId: string;
  agentId: string;
  action: "translate" | "summarize";
  sourceLanguage?: string | null;
  targetLanguage?: string | null;
  messageHash: string;
  document: { subject: string; author: string; segments: Array<{ id: string; text: string }> };
  limits: { maxSegments: number; maxOutputCharacters: number };
};

export type MessageTransformResult = {
  version: 1;
  requestId: string;
  messageHash: string;
  action: "translate" | "summarize";
  detectedLanguage: string | null;
  targetLanguage: string | null;
  segments: Array<{ id: string; text: string }>;
  summary: { title: string; bullets: string[] } | null;
};

export type GatewayStatus = {
  protocolVersion: 1;
  plugin: "thunderclaw";
  gatewayVersion: string;
  capabilities: Record<string, boolean | string>;
};

export type AgentRecord = {
  agentId: string;
  displayName: string;
  isDefault: boolean;
  provider: string | null;
  model: string | null;
  reasoning: { defaultLevel: string | null; levels: Array<{ id: string; label: string }> };
  compatibility: {
    state: "unverified" | "partially_verified" | "verified" | "incompatible" | "unsupported";
    executionMode: "restricted-agent";
    usesPersonality: true;
    usesMemory: true;
    toolsDisabled: true;
    checks: {
      configuration: "passed" | "failed";
      credentials: "passed" | "failed" | "not_run" | "not_applicable";
      structuredOutput: "passed" | "failed" | "not_run" | "not_applicable";
      toolIsolation: "passed" | "failed" | "not_run" | "not_applicable";
      cancellation: "passed" | "failed" | "not_run" | "not_applicable";
      fallbacks: "passed" | "failed" | "not_run" | "not_applicable";
    };
    lastProbe: {
      testedAt: string;
      observedProvider: string | null;
      observedModel: string | null;
    } | null;
    reason: string;
  };
};

export type AgentListResponse = { protocolVersion: 1; requestId: string; agents: AgentRecord[] };
export type AgentProbeRequest = { protocolVersion: 1; requestId: string; probeRunId: string; agentId: string };
export type AgentProbeResponse = { protocolVersion: 1; requestId: string; probeRunId: string; agent: AgentRecord };
export type CancelAgentProbeRequest = AgentProbeRequest;
export type CancelAgentProbeResponse = { protocolVersion: 1; requestId: string; probeRunId: string; agentId: string; cancelled: true };
export type OpenComposeResponse = { protocolVersion: 1; requestId: string; composeId: string; composeGeneration: number; sessionId: string };
export type RunEvidence = {
  provider?: string;
  model?: string;
  toolSummary?: unknown;
  runtimeSessionMarker: string | null;
  repairAttempted: boolean;
};
export type TransformComposeResponse = { protocolVersion: 1; runId: string; result: EditResult; evidence: RunEvidence };
export type CancelComposeRequest = OpenComposeRequest & { runId: string };
export type CancelComposeResponse = { protocolVersion: 1; requestId: string; runId: string; cancelled: true };
export type CloseComposeResponse = { protocolVersion: 1; requestId: string; composeId: string; composeGeneration: number; closed: true };
export type TransformMessageResponse = { protocolVersion: 1; runId: string; result: MessageTransformResult; evidence: RunEvidence };
export type CancelMessageRequest = { protocolVersion: 1; requestId: string; transformRequestId: string; runId: string; messageHash: string };
export type CancelMessageResponse = { protocolVersion: 1; requestId: string; transformRequestId: string; runId: string; messageHash: string; cancelled: true };

export const DIRECT_CLIENT_ERROR_KINDS = [
  "configuration",
  "permission",
  "authentication",
  "capability",
  "network",
  "timeout",
  "cancellation",
  "rate_limit",
  "backend",
  "contract",
] as const;

export type DirectClientErrorKind = (typeof DIRECT_CLIENT_ERROR_KINDS)[number];

const AUTHENTICATION_BACKEND_CODES = new Set([
  "UNAUTHORIZED",
  "AUTHENTICATION_REQUIRED",
  "AUTHENTICATION_FAILED",
  "INVALID_CREDENTIAL",
  "CREDENTIAL_EXPIRED",
  "CREDENTIAL_REVOKED",
]);
const PERMISSION_BACKEND_CODES = new Set(["PERMISSION_DENIED", "INSUFFICIENT_PERMISSION", "FORBIDDEN"]);
const RATE_LIMIT_BACKEND_CODES = new Set(["RATE_LIMITED", "RATE_LIMIT_EXCEEDED"]);
const CANCELLATION_BACKEND_CODES = new Set(["RUN_CANCELLED", "CANCELLED", "PROBE_CANCELLED"]);
const TIMEOUT_BACKEND_CODES = new Set(["RUN_TIMEOUT", "PROBE_TIMEOUT"]);
const CAPABILITY_BACKEND_CODES = new Set(["UNKNOWN_AGENT", "UNSUPPORTED_AGENT", "NOT_FOUND", "PROBE_ALREADY_ACTIVE", "PROBE_CAPACITY_EXCEEDED"]);
const CONTRACT_BACKEND_CODES = new Set([
  "INVALID_REQUEST",
  "REQUEST_TOO_LARGE",
  "MALFORMED_JSON",
  "UNSUPPORTED_PROTOCOL",
  "AGENT_MISMATCH",
  "RUN_ALREADY_ACTIVE",
  "RUN_NOT_ACTIVE",
  "COMPOSE_NOT_OPEN",
  "INVALID_AGENT_OUTPUT",
  "UNSAFE_AGENT_OUTPUT",
  "EMPTY_AGENT_OUTPUT",
  "OUTPUT_TOO_LARGE",
  "INVALID_BACKEND_RESPONSE",
  "UNSAFE_BACKEND_RESPONSE",
  "STALE_OR_MISMATCHED_RESULT",
  "STALE_COMPOSE_GENERATION",
  "PROBE_NOT_ACTIVE",
  "PROBE_SUPERSEDED",
]);

/** Classifies only a validated structured plugin code/status, never fetch text. */
export function classifyBackendError(code: string, status: number): DirectClientErrorKind {
  if (AUTHENTICATION_BACKEND_CODES.has(code) || code.startsWith("AUTH_")) return "authentication";
  if (PERMISSION_BACKEND_CODES.has(code)) return "permission";
  if (RATE_LIMIT_BACKEND_CODES.has(code) || status === 429) return "rate_limit";
  if (TIMEOUT_BACKEND_CODES.has(code)) return "timeout";
  if (CANCELLATION_BACKEND_CODES.has(code) || code.startsWith("CANCEL_")) return "cancellation";
  if (CAPABILITY_BACKEND_CODES.has(code)) return "capability";
  if (CONTRACT_BACKEND_CODES.has(code) || code.startsWith("STALE_")) return "contract";
  return "backend";
}

export class DirectClientError extends Error {
  constructor(
    readonly kind: DirectClientErrorKind,
    readonly code: string,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "DirectClientError";
  }
}

/** Safe identity only; credential material must never be used as a binding ID. */
export type CredentialBinding = Readonly<{
  mode: "device_credential";
  credentialId: string;
}>;

export type AuthorizationHeaderWriter = {
  /** The writer consumes the value immediately and must not expose or log it. */
  setBearerCredential(credential: string): void;
};

/**
 * Implementations and consumers belong to the extension background only.
 * This shape exposes neither a credential getter nor a storage key.
 */
type ClientAuthenticationBase = Readonly<{
  binding: CredentialBinding;
  developmentOnly: boolean;
  authorize(writer: AuthorizationHeaderWriter): Promise<void>;
}>;

export type DeviceCredentialAuthentication = ClientAuthenticationBase & Readonly<{
  binding: CredentialBinding & { mode: "device_credential" };
  developmentOnly: false;
}>;

export type ClientAuthentication = DeviceCredentialAuthentication;

export type ConnectionBinding = Readonly<{
  apiBase: string;
  origin: string;
  credential: CredentialBinding;
  permissionId: string;
  epoch: number;
}>;

export type BoundCompletion<T> = Readonly<{ binding: ConnectionBinding; value: T }>;
export type DirectCallOptions = Readonly<{ signal?: AbortSignal }>;

/**
 * Aborting a call stops only the local HTTP operation. Explicit cancel/close
 * methods are separate server lifecycle operations and use fresh signals.
 */
export interface ThunderClawDirectClient {
  readonly binding: ConnectionBinding;
  hello(options?: DirectCallOptions): Promise<BoundCompletion<GatewayStatus>>;
  status(options?: DirectCallOptions): Promise<BoundCompletion<GatewayStatus>>;
  listAgents(requestId: string, options?: DirectCallOptions): Promise<BoundCompletion<AgentListResponse>>;
  probeAgent(request: AgentProbeRequest, options?: DirectCallOptions): Promise<BoundCompletion<AgentProbeResponse>>;
  cancelAgentProbe(request: CancelAgentProbeRequest, options?: DirectCallOptions): Promise<BoundCompletion<CancelAgentProbeResponse>>;
  openCompose(request: OpenComposeRequest, options?: DirectCallOptions): Promise<BoundCompletion<OpenComposeResponse>>;
  transformCompose(request: TransformComposeRequest, options?: DirectCallOptions): Promise<BoundCompletion<TransformComposeResponse>>;
  cancelComposeRun(request: CancelComposeRequest, options?: DirectCallOptions): Promise<BoundCompletion<CancelComposeResponse>>;
  closeCompose(request: OpenComposeRequest, options?: DirectCallOptions): Promise<BoundCompletion<CloseComposeResponse>>;
  transformMessage(request: TransformMessageRequest, options?: DirectCallOptions): Promise<BoundCompletion<TransformMessageResponse>>;
  cancelMessageTransform(request: CancelMessageRequest, options?: DirectCallOptions): Promise<BoundCompletion<CancelMessageResponse>>;
}

export function nextConnectionEpoch(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0 || current === Number.MAX_SAFE_INTEGER) {
    throw new DirectClientError("configuration", "INVALID_CONNECTION_EPOCH", "connection epoch cannot be advanced");
  }
  return current + 1;
}

export function sameConnectionBinding(left: ConnectionBinding, right: ConnectionBinding): boolean {
  return left.epoch === right.epoch
    && left.apiBase === right.apiBase
    && left.origin === right.origin
    && left.permissionId === right.permissionId
    && left.credential.mode === right.credential.mode
    && left.credential.credentialId === right.credential.credentialId;
}

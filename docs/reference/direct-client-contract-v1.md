# Direct-client contract v1

The Thunderbird background owns the direct ThunderClaw client, its
authentication object, connection binding, sessions, jobs, and completions.
Popup, compose, and message-display code receive only validated product data;
they never receive an endpoint credential, authorization header, client, or
transport error internals.

`packages/thunderbird-extension/src/direct-client-contract.ts` freezes the
protocol-v1 request and response shapes, fixed route map, operation budgets,
authentication boundary, error taxonomy, and connection binding. `hello`
becomes a compatibility alias for the plugin `/status` route; transport
wrappers are not part of the direct protocol.

Response validators must reconstruct the declared public shapes field by
field. They must enforce every identity and safety field—including complete
agent compatibility evidence—and must not preserve unvalidated properties by
spreading backend objects into validated results.

## Agent verification operations

Agent verification is explicit and never triggered by status, discovery, or an
ordinary feature call. `POST /agents/probe` accepts exactly
`protocolVersion`, a fresh `requestId`, a fresh `probeRunId`, and `agentId`.
It has a 195-second client deadline, a 64 KiB request limit, and a 256 KiB
response limit. Its terminal response must echo both IDs and return a complete
`AgentRecord`; the validator reconstructs that record field by field and
requires its `agentId` to match the request.

`POST /agents/probe/cancel` accepts the same four fields. The cancel operation
uses a fresh `requestId` while preserving the exact active `probeRunId` and
`agentId`. Its response echoes all three identities and `cancelled: true`. A
local abort only stops waiting and never substitutes for this server cancel.
The cancel deadline is 10 seconds and both request and response are limited to
64 KiB. Neither model-calling probe POST nor cancel is automatically retried.

## Epoch and abort rules

A connection binding consists of the canonical API base and origin, a safe
credential identifier, the granted permission identifier, and a monotonically
increasing epoch. Every client, compose session, message job, and completion
captures the complete binding. The background accepts a completion only when
its binding still exactly matches the current binding.

An endpoint, credential, or permission change first increments the epoch and
synchronously invalidates old UI effects. Cleanup then uses only the captured
old client, with a 10-second total budget, for best-effort server cancel,
compose close, and (once pairing exists) credential revoke. Only afterward are
the old credential and permission cleared. Cleanup is never retargeted to the
new client or origin, and cleanup failure does not make an old completion
current again.

Aborting a request is local transport cancellation. It does not stand in for a
server cancel or compose close acknowledgement. Timeout is distinct from user
cancellation in the normalized error taxonomy.

## Error semantics

An opaque browser `fetch` failure maps to `network`. That category includes
DNS, TCP, TLS, and certificate failures because Thunderbird does not reliably
expose enough information to distinguish them. The client must not infer
`permission` or authentication from an opaque fetch rejection. `permission`
is reserved for an explicit browser permission preflight (introduced with A2)
or a validated structured plugin permission code.

After validating a structured plugin error envelope, v1 maps codes as follows:

- `UNAUTHORIZED`, explicit authentication/credential codes, and `AUTH_*` map
  to `authentication`.
- Explicit permission codes map to `permission`.
- HTTP 429 or an explicit rate-limit code maps to `rate_limit`.
- `RUN_CANCELLED`, `CANCELLED`, and `CANCEL_*` map to `cancellation`.
- `UNKNOWN_AGENT`, `UNSUPPORTED_AGENT`, `NOT_FOUND`, and
  `PROBE_ALREADY_ACTIVE` map to `capability`. Probe capacity exhaustion also
  maps to `capability`.
- Request, protocol, lifecycle, stale-identity, and invalid/unsafe/oversized
  agent-result codes map to `contract`. The frozen list includes
  `INVALID_REQUEST`, `REQUEST_TOO_LARGE`, `MALFORMED_JSON`,
  `UNSUPPORTED_PROTOCOL`, `STALE_*`, `AGENT_MISMATCH`,
  `RUN_ALREADY_ACTIVE`, `RUN_NOT_ACTIVE`, `COMPOSE_NOT_OPEN`,
  `INVALID_AGENT_OUTPUT`, `UNSAFE_AGENT_OUTPUT`, `EMPTY_AGENT_OUTPUT`, and
  `OUTPUT_TOO_LARGE`. Exact probe cancellation misses and superseded probe
  results are contract failures.
- `PROBE_CANCELLED` maps to `cancellation`; `PROBE_TIMEOUT` maps to `timeout`.
  `PROBE_FAILED`, `COMPATIBILITY_UNAVAILABLE`, `INTERNAL_ERROR`, and every
  unknown validated code map to `backend`.

Backend error messages are untrusted data. They are never returned to UI code,
logged, or surfaced verbatim. Only the validated code and status participate
in classification; each user-visible error uses a locally authored message.

## Authentication boundary

Authentication is injected through a background-only writer that can consume
a bearer credential but cannot read it back. Bindings contain only a safe
credential ID, never credential material. The temporary narrow static token is
removed. The only authentication variant is a paired per-device credential
whose raw bearer remains in background-only extension custody. The contract
supplies no manual token input, development authentication variant, credential
getter, fallback, import path, or hidden production switch.

## Known routes

All direct-client operations map to implemented plugin routes. Explicit
displayed-message cancellation uses `POST /message/cancel` with the exact
transform request, run, and message identities. It remains distinct from a
local fetch abort, which only stops the browser from waiting.

# Inference and local lifecycle contract

The extension background owns credentials, transport, configuration, connection
bindings, and jobs. Settings accept user configuration; feature pages and email
scripts receive validated product data rather than a key or network client.

## Network requests

`inference-provider.ts` owns presets and configuration validation;
`inference-client.ts` owns the compatible-API transport. Generation sends a
nonstreaming `POST /chat/completions` beneath the configured base. Model discovery
uses `GET /models`. Both require the exact configured endpoint binding and host
permission. Reject redirects and omit cookies. There are no network compose
sessions or dedicated server cancellation routes.

A generation contains the selected model, one fixed system message, one JSON user
message, the configured output format and token/reasoning parameters. Models get
no callable tools. Request formats vary by provider; see
[response controls](../inference-prompts.md#response-limit-and-thinking).

## Local identity and validation

`direct-client-contract.ts` and existing local product types supply lifecycle and
validation primitives. Some names retain historical terminology; the inference
adapter implements that local interface without sending its old route map to a
server. Models return only content. The background binds validated content back
to locally owned request/run/session/segment identities.

The connection binding includes canonical API base/origin, a safe credential ID,
host permission identity, and monotonically increasing epoch. Jobs capture the
binding; configuration/credential/permission changes retire old jobs and previews.
Compose generation, selection/target hash, authored-context hash, local recipient,
header, and attachment state must still match before Apply. Message translations
must match the captured message and exact segment count/order. Independent
editor/display validators remain authoritative at mutation time.

Unknown fields and invalid, unsafe, truncated, oversized, or stale output fail
closed. JSON Schema and JSON object modes share the same local validation.
Supported output types are plain replacement text, flat list-item strings,
allowlisted rich blocks, summaries, and segment translations. See the
[product contract](../product-contract.md) for bounds on editable structure.

## Cancellation and safe errors

Cancellation aborts fetch and invalidates the invocation. It does not establish
remote cancellation or prevent provider billing. Deadlines and user cancellation
are distinct outcomes. No automatic generation retry or endpoint/model fallback
occurs.

`INFERENCE_FAILURE_MESSAGES` in `inference-client.ts` owns recognized safe
user-facing messages. Known token exhaustion, refusal, content-filter, empty,
invalid-JSON/shape, segment-count, response-size, context-limit, and rejected-setting
failures have specific messages. Unknown provider text is not displayed or logged;
network, authentication, permission, and rate-limit failures use normalized local
categories. Never treat an opaque fetch failure as proof of a particular TLS,
permission, or authentication cause.

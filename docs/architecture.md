# ThunderClaw architecture

ThunderClaw connects directly to a user-configured OpenAI-compatible inference
endpoint. It requires no companion backend, native helper, or agent framework.

```text
Thunderbird snapshot -> background-owned inference client -> selected endpoint/model
                    <- bounded, validated JSON content
Thunderbird Preview -> Apply -> Undo -> normal Send
```

## Ownership and authority

Thunderbird owns capture, DOM eligibility, mutation, postconditions, rollback, and Undo. Model output never reaches an HTML parser. Models cannot send mail or change recipients, attachments, headers, or the selected endpoint. The current Thunderbird snapshot is authoritative.

The background owns provider configuration, credential access, host permissions, trusted prompts, transport, response parsing, strict payload validation, and local jobs. Request/run identities, connection epoch, compose generation, target offsets, target/context hashes, and document state remain locally bound to each invocation. Configuration changes retire outstanding jobs and previews. Models return content, not authorization metadata. Translation output is bound to the exact captured segments before the independent message-display validator sees it.

The existing local compose lifecycle and product types retain some legacy protocol terminology as compatibility plumbing. Open/close/cancel operations are local lifecycle operations. The shipped entry point includes only the standalone inference graph.

## Inference boundary

One configured provider and model are active. Presets cover OpenAI, OpenRouter, DeepSeek, Ollama, LM Studio, and custom compatible servers. Configuration contains a canonical API base, model, structured-output mode, response-token limit, thinking level, and optional writing style. Provider differences are explicit; there is no automatic endpoint/model fallback.

Calls use nonstreaming Chat Completions with bounded JSON output. JSON Schema is preferred where supported; JSON-object mode accommodates DeepSeek and compatible servers. Both modes use the same local product validation. Model names and API errors are untrusted data. Reject tool calls, refusals, truncation, invalid shapes, oversize output, and stale completions.

Remote endpoints require HTTPS. HTTP is restricted to explicit loopback addresses. Build only fixed models/chat-completions routes under the configured base, reject redirects, and omit cookies. Host permissions do not replace exact application-level origin/path checks.

## Credentials and context

Keys persist locally by default so normal restarts do not require re-entry. Public connection state reveals only whether a key is saved. Keys never belong in content-script messages, diagnostics, synchronization, or exported settings. Local persistence is not an encrypted vault. Endpoint changes require explicit key handling rather than reusing the previous endpoint's key.

Compose inference uses selected text and authored draft context, without recipient addresses or quoted history. Reading inference uses eligible visible message segments. Complete local compose fingerprints still include recipients, headers, and attachment metadata to reject stale results without transmitting those fields.

## Cancellation and compatibility

Cancellation aborts local transport and invalidates the invocation; the provider may continue processing or charging. A successful connection test demonstrates a bounded synthetic operation, not all model behavior or privacy guarantees. A loopback endpoint can itself forward to a cloud model. OpenRouter is a routing service, so its upstream selection follows the user's provider settings.

Provider compatibility regressions do not automatically create product releases. Keep deterministic contract, lifecycle and DOM tests; qualify representative real providers and exact XPI bytes before release. See [compatibility](compatibility.md), [testing](testing.md), and the [roadmap](roadmap.md) for coverage and remaining qualification.

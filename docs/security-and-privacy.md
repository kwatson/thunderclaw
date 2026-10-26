# ThunderClaw security and privacy

## Trust boundaries

ThunderClaw trusts Thunderbird and its installed extension code to capture and
edit mail safely. Email bodies, signatures, quoted text, user preferences,
provider replies/errors, and model output are untrusted data. The chosen endpoint
and any upstream model provider receive the content necessary for an action and
have their own retention, privacy, and billing policies.

The project operates no inference or analytics service. A local API address can
still route to hosted models. OpenRouter can route to upstream providers. Choose
a connection appropriate for your mail. See the [privacy policy](privacy-policy.md)
for what is transmitted and stored, including Fireworks data handling.

## Model authority and prompt injection

Fixed system instructions describe one action and its bounded output schema.
Email, custom instructions, language values, and writing preferences are serialized
as user data. They cannot replace application rules or grant authority. Prompt
rules reduce risk but do not guarantee a model will resist malicious instructions
or produce a faithful edit. A plausible but misleading result can still pass
structural validation; review it before accepting it.

Models receive no callable tools. They cannot send mail, choose recipients,
change headers or attachments, select a different endpoint, or supply HTML for
insertion. The background validates the output, then local capture/display/editor
boundaries independently validate typed product operations. Unknown fields,
unsafe structures, mismatched segment counts, oversize responses, refusals,
truncation, and stale completions fail closed. Partial results are not applied.

Request/run identity, connection epochs, compose generations, target/context
hashes, and message identities bind each result locally. Models return content,
not authorization metadata. Preview, Apply, Undo, and normal Send remain separate
user decisions. Configuration changes invalidate outstanding work. Undo is
rejected when intervening edits make exact restoration unsafe.

## Credentials and local persistence

Users supply their own API key when required. The background stores credentials
in extension-origin IndexedDB scoped to the exact provider and canonical API
base URL. Settings accept key entry but public connection state exposes only
whether a key is saved. Keys do not belong in email scripts, feature messages,
diagnostics, synchronized storage, exported settings, source, or artifacts.

Keys persist across Thunderbird restarts. Local profile storage is not an
encrypted vault or operating-system keychain. Device/profile compromise or an
exposed backup can reveal keys. Use provider-side restrictions where available
and revoke compromised keys at the provider. Forgetting local settings does not
revoke a key remotely. Changing an endpoint never silently sends its former key
to the new address.

## Network boundary

Remote API bases require HTTPS. HTTP is allowed only for explicit `127.0.0.1`
or `[::1]`; `localhost` aliases are not accepted. Canonicalization rejects unsafe
URL forms. The background constructs only fixed models and Chat Completions
routes beneath the configured base, checks host permission, omits cookies, and
rejects redirects. No automatic endpoint/model fallback or generation retry runs.

Thunderbird's host permission patterns can be broader than an exact API path or
port. The application therefore enforces its own endpoint/credential scope in
addition to browser permission checks. Saved configuration and key changes require
an explicit synthetic test. Permission loss and connection changes invalidate
work from the old binding.

Requests and replies have byte limits and deadlines as well as a configured
response-token budget. Cancellation aborts transport and invalidates local work;
it cannot promise remote processing or billing stops. Timeout is distinct from
user cancellation. Safe local error messages distinguish recognized output-limit,
filtering, refusal, invalid-JSON, and context/settings failures without showing raw
provider text or mail.

## Data lifetime and residual risks

Snapshots, previews, and jobs are held in memory for the active workflow.
ThunderClaw does not intentionally retain prompt/completion history or telemetry.
The endpoint may retain requests independently. Avoid copying mail, keys, raw
provider replies, or populated settings into bug reports and test evidence.

[Prompt evaluation](inference-prompts.md#evaluation-and-security-limits) and
[testing](testing.md) distinguish deterministic boundary checks from real-model
quality and native-platform evidence. A valid result or successful test is not a
privacy or accuracy guarantee. Report vulnerabilities privately through the
[security policy](../SECURITY.md).

# ThunderClaw architecture

## System shape

ThunderClaw has exactly two installable components:

```text
Thunderbird MailExtension
    -> background-owned direct HTTP(S) client
    -> paired credential and fixed /thunderclaw routes
ThunderClaw OpenClaw plugin
    -> selected configured OpenClaw agent
    -> strict JSON result
Thunderbird Preview -> Apply -> Undo -> normal Send
```

There is no companion executable, native helper, Native Messaging host,
privileged host registration, alternate transport, or OpenClaw fork. Remote
origins require HTTPS. Cleartext HTTP is allowed only for canonical
`127.0.0.1` and `[::1]` loopback endpoints.

Both components live in this repository under `packages/`, but they remain
separate installables with no shared runtime dependency. Independent request and
response validators on each side of the fixed HTTP boundary are exercised
against common conformance fixtures.

## Ownership

### Thunderbird extension

The extension owns:

- capture of the authoritative compose or displayed-message snapshot;
- feature UI and locally authored error text;
- selection and DOM eligibility;
- Preview construction without draft mutation;
- Apply, postcondition validation, rollback, and Undo;
- reversible message translation and separate summary rendering; and
- the final Send decision through Thunderbird's normal UI.

Only Thunderbird mutates message or compose DOM. Model values never reach an
HTML parser or an unrestricted HTML insertion surface.

### Extension background

The background owns:

- endpoint canonicalization and runtime host permission;
- background-only custody of the paired device credential;
- direct transport, deadlines, response-size limits, and redirect rejection;
- connection epochs and retirement of old work;
- compose/message job coordination and explicit cancellation; and
- independent reconstruction and validation of plugin responses.

Popup, compose, and message-display contexts receive validated product data,
not credentials, authorization headers, client objects, or backend error text.

### OpenClaw plugin

The plugin owns:

- fixed product and pairing routes;
- compatible-agent discovery and explicit verification;
- caller-owned, compose-scoped in-memory sessions;
- tools-disabled and trajectory-disabled embedded-agent execution;
- prompts, cancellation, bounded repair, and configured model fallbacks;
- strict request and result contracts; and
- the plugin-owned pairing registry and `openclaw thunderclaw` administration.

Agent, model, provider, provider credential, fallback, and reasoning defaults
remain OpenClaw configuration. ThunderClaw may select a compatible configured
agent but does not duplicate provider settings in Thunderbird.

## Authoritative state and lifecycle

The current Thunderbird snapshot is authoritative. Agent session history can
help refine a suggestion, but it never replaces the snapshot used for request,
target, and stale-result validation.

Every operation retains the identities needed for its scope, including request
ID, run ID, compose generation, target ID, context hash, target hash, selected
agent, and connection binding. Endpoint, permission, or credential changes
advance the connection epoch and make prior work ineligible for publication or
Apply. Cleanup uses the captured old client and can never be retargeted to the
new connection.

Compose windows use separate random session IDs, session keys, and in-memory
managers. A repair or configured fallback attempt keeps the same manager,
configuration snapshot, cancellation signal, and total time budget. Closing,
expiry, replacement, or retirement aborts active work and removes the manager.

## Review boundary

These remain separate decisions:

1. Generate and receive a Preview.
2. Review the proposed change.
3. Apply the change to the validated target.
4. Optionally Undo the applied change.
5. Use Thunderbird's ordinary Send action.

The model cannot combine or bypass these decisions.

## Persistent state

The extension persists connection configuration, installation identity, and a
narrow paired credential in background-only profile storage. A local profile
compromise can expose that credential; encryption with a key in the same
profile would not create a separate security boundary.

The plugin stores pairing metadata and domain-separated verifiers—not raw
device or claim secrets—in a plugin-owned SQLite registry. Email content,
recipients, headers, attachments, model responses, and provider or Gateway
credentials do not belong in that registry.

Embedded transformation transcripts are held in caller-owned memory and are
not deliberately written as ordinary OpenClaw session transcripts. OpenClaw
may retain content-free operational lifecycle telemetry. Installed Gateway
plugins and hooks remain part of the trusted execution boundary; see
[`security-and-privacy.md`](security-and-privacy.md).

## Architectural invariants

- Never patch or fork OpenClaw core.
- Never add an operating-system helper or alternate transport.
- Never let the model send mail or modify recipients, headers, or attachments.
- Never insert model-produced HTML.
- Never give Thunderbird a provider credential or broad Gateway token.
- Never infer agent compatibility from catalog presence alone.
- Never merge Generate, Apply, Undo, and Send into one action.
- Never weaken exact identity, hash, generation, size, and stale-result checks.

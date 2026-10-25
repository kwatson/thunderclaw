# ThunderClaw privacy policy

Development policy for the standalone extension, October 24, 2026. The policy attached to an older released version remains available at its release tag. Enter the final reviewed policy text in the Thunderbird Add-ons privacy-policy field before publication.

ThunderClaw provides user-initiated writing and reading assistance in Thunderbird. The project does not operate an inference server or analytics service. The extension connects directly to the endpoint selected by the user. That endpoint and any upstream model provider have their own privacy, retention, and billing terms.

## Data sent

When you request a compose action, ThunderClaw sends the selected target, visible authored draft context, chosen action, custom instruction, and applicable writing preferences. It does not send recipient addresses, attachment contents, arbitrary headers, or extracted quoted history through compose inference. It reads additional local state to detect stale results before applying an edit.

Reading actions send eligible visible message text, including visible signatures and quoted history, and useful subject context. They do not fetch unrelated messages or attachment contents. Connection tests send synthetic text rather than your mail; listing models and testing may contact the configured provider, and a generation test may incur provider charges.

Operational requests identify the selected model and desired output format. Request/run ownership, selection offsets, and stale-result identity are maintained locally. API keys are transmitted only as authentication to their explicitly configured endpoint. Redirects and automatic endpoint/model fallback are rejected.

## Local data

The extension saves provider configuration, model, writing preferences, language settings, and credentials in the local Thunderbird profile. Credentials persist across restarts, are not synchronized, and are not included in public connection state, exports, or diagnostics. This is local profile storage, not a claim of encrypted-at-rest or operating-system-keychain protection. Protect your device and profile backups; revoke a compromised key through its provider.

Email snapshots, previews, and jobs are held in memory for the active workflow. ThunderClaw does not intentionally retain a prompt/completion history or send telemetry. Provider-side logging is governed by the provider's policies.

## User controls and limitations

Change or remove a saved connection/key in settings. Local removal does not revoke a provider key or old OpenClaw device remotely. Changing configuration invalidates work from the former connection. Cancel discards local results and aborts the request, but cannot guarantee that a remote server stops processing or charging.

A loopback server can forward requests to cloud services. OpenRouter may route to an upstream provider. Choose the model/server configuration appropriate for your data. ThunderClaw does not silently switch your connection.

Models cannot send email or change recipients, attachments, or headers. Compose edits require Preview and Apply, with stale-state checks and Undo. Reading translations are reversible and summaries are displayed separately.

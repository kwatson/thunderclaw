# ThunderClaw security and privacy

## Trust boundaries

ThunderClaw treats email, quoted history, signatures, model output, backend
errors, endpoint responses, and device-provided labels as untrusted input.

The trusted boundary includes:

- Thunderbird and the installed ThunderClaw extension;
- the configured OpenClaw Gateway and ThunderClaw plugin;
- other enabled Gateway plugins and hooks with access to agent-run events;
- the selected configured agent and its workspace context; and
- the configured model provider.

Invoking an action sends the relevant email text and any selected agent context
that OpenClaw supplies to the configured provider. Onboarding and user-facing
privacy copy must disclose this.

## Model authority

The model cannot send mail, directly mutate Thunderbird, select recipients,
change headers or attachments, or return HTML for insertion. Model-callable
OpenClaw tools and trajectory are disabled. Results pass strict plugin and
extension validation and remain proposals until explicit Apply.

Every result is bound to exact request, run, connection, generation, agent,
message/compose, target, context, and hash identities. Unknown fields,
oversized bodies, stale results, unsafe structures, and mismatched identities
fail closed.

## Credentials

The extension contains no provider credential or broad OpenClaw Gateway token.
The raw paired per-device credential is generated and retained by the
Thunderbird background context. UI contexts receive only safe identifiers and
validated product data.

A Thunderbird-profile compromise may expose the device credential. The
mitigations are narrow capabilities, per-device identity, fixed expiry,
rotation, independent revocation, Disconnect, and Forget. Reversible
encryption with a key stored in the same profile is not treated as an
independent security boundary.

The plugin stores only domain-separated verifiers for uniformly random
high-entropy device and claim secrets. Email bodies, recipients, headers,
attachments, provider/Gateway credentials, raw device credentials, and claim
secrets never belong in the pairing registry.

## Pairing registry

The plugin-owned SQLite registry is the supported persistence boundary for an
archive-installed plugin. It uses private plugin state, strict schema and
bounded fields, transactional state changes, integrity checks, WAL, full
synchronous durability, foreign keys, secure deletion, bounded busy waits, and
fail-closed schema/filesystem validation.

On tested POSIX systems, directories and database files are restricted to
private modes and unsafe symlink/non-regular/hard-link shapes are rejected.
POSIX modes are not a Windows ACL guarantee. Windows ACL, reparse-point,
junction, antivirus, locking, atomic-replacement, backup/restore, restart, and
upgrade behavior remain explicit platform qualification requirements.

OpenClaw backups can contain broad state and must be handled as sensitive even
when the registry itself contains only verifiers and metadata. Supported
backup/restore creates and verifies a coherent isolated database; copying a
live SQLite file without its transactional context is not a portability
procedure.

## Network boundary

Remote endpoints require HTTPS. Cleartext HTTP is limited to canonical
`127.0.0.1` and `[::1]`; `localhost` aliases are not accepted as equivalent.
Endpoint canonicalization, fixed-route confinement, manual redirect rejection,
response-size limits, deadlines, and runtime host-permission checks apply at
the background boundary.

Thunderbird host permission is origin-pattern based and can be broader in port
and path than the product routes. ThunderClaw compensates by canonicalizing the
configured origin and allowing the client to call only its fixed route map.
Permission acquisition, retention, revocation, denial, endpoint change, and
certificate failure are release-qualified behaviors.

## Ambient OpenClaw hooks

Caller-owned sessions, disabled tools, and disabled trajectory do not disable
OpenClaw's global plugin-hook runner. A `before_prompt_build` handler can receive
prompt and prepared-message content. The pinned environment's `memory-core`
handler returned without standing-intent matching because ThunderClaw labels
compose and probe runs with `trigger: "manual"`, but it remains trusted code
with technical access.

ThunderClaw can guarantee its own ephemeral manager and model tool policy; it
cannot claim that arbitrary installed Gateway hooks cannot observe or modify
email content. A deployment needing stronger separation must use a controlled
Gateway profile. Hook behavior must be re-audited for each supported OpenClaw
release and material plugin-set change because dynamic registrations are not
reliably represented by inventory counts.

## Persistence and telemetry

ThunderClaw does not deliberately persist normal email prompts, model output,
or transformation transcripts in OpenClaw session state. Qualification scans
Gateway state, logs, SQLite sidecars, and retained artifacts for synthetic
content and secret canaries.

The pinned runtime may retain opaque session/run identifiers as content-free
operational lifecycle telemetry. Production privacy documentation and
retention policy must distinguish this metadata from email or model content.

## Threat/control summary

| Threat | Required control | Residual qualification |
| --- | --- | --- |
| Network interception or redirect | HTTPS remotely; canonical loopback exception; redirects rejected | Remote certificate-failure matrix |
| Prompt injection from email | Email is delimited as untrusted data; tools disabled; strict output contracts | Provider/model regression testing |
| Model overreach | No send/header/attachment/HTML authority; Preview before Apply | UI and DOM boundary tests |
| Stale mutation | Exact generations, epochs, identities, and hashes | Concurrency and delayed-completion tests |
| Credential theft | Background custody, narrow scope, rotation/revocation/expiry | Windows profile and permission qualification |
| Registry theft/corruption | Verifiers only, private files, integrity/schema checks, fail closed | Windows and hostile-filesystem matrix |
| Ambient Gateway plugin access | Disclosed trust boundary and repeatable hook audit | Re-audit every supported runtime/plugin set |
| Secret leakage in evidence | In-memory secrets, redaction, content scans, sensitive artifact handling | Release-environment review |

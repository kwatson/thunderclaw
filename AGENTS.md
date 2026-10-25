# Project agent instructions

## Project identity

This project is named **ThunderClaw**. Use `ThunderClaw` in user-facing text
and `thunderclaw` in package names, routes, environment variables,
Docker resources, and generated artifacts.

## Runtime and verification

This project uses `mise` for managed runtimes. In non-interactive shells, run
Node.js and package tools with `mise exec --`.

For ordinary changes, run:

```text
mise exec -- npm test
mise exec -- npm run typecheck
```

When changing the Thunderbird extension, also run:

```text
mise exec -- npm run build:extension
```

## Repository layout

- `packages/thunderbird-extension/`: Thunderbird extension source and icons
- `test/`: deterministic unit, contract, lifecycle, and boundary tests
- `e2e/`: real Thunderbird and protected qualification tooling
- `fixtures/`: cross-boundary conformance fixtures
- `scripts/`: build and repeatable qualification entry points
- `docs/`: evergreen product, protocol, security, release, and brand material
- `docs/roadmap.md`: the authoritative unfinished priority list

The background and Thunderbird mutation boundaries independently validate product
data. Use conformance fixtures; do not collapse their validation responsibilities.

## Product and architecture invariants

- ThunderClaw is a standalone Thunderbird MailExtension that calls a user-configured
  OpenAI-compatible inference endpoint. Do not add a mandatory relay, native helper,
  agent framework, or core application patch. Retained legacy source is not part
  of the standalone runtime.
- Thunderbird owns message and compose DOM mutation. Never insert
  model-produced HTML, let a model send mail, or let it change recipients,
  attachments, or headers.
- Inference uses the explicitly configured endpoint/model, stateless requests,
  disabled model-callable tools, and strict JSON validation. The current Thunderbird
  snapshot is authoritative; request/run/hash identities remain locally owned.
- Preserve separate Generate/Preview, Apply, Undo, and normal Send decisions.
- Treat email as untrusted input. Preserve request and run identity,
  generation, target/context hashes, output limits, exact segment IDs, and
  stale-result validation on both sides of the boundary.
- Provider configuration and persistent user-supplied API keys belong to the extension
  background. Bind keys to the configured endpoint; never synchronize or expose them
  to email scripts, diagnostics, or public settings. Do not claim local storage is encrypted.
- Keep the stable extension ID `thunderclaw@addons.thunderbird.net` unless a
  planned migration updates every dependent boundary.

## Local state and sensitive data

Persistent local state under `.spike/`, populated environment files, generated
`build/` output, and retained qualification evidence are ignored but may contain credentials,
message content, and environment details.

- Do not print, commit, document, copy, or package populated values.
- Do not delete, recreate, or overwrite ignored state unless the task
  explicitly requires a clean environment.
- Inspect running services before restarting them; avoid destructive Compose
  commands and restart only the service required by the change.
- Use synthetic data in tests and sanitize retained evidence.

## Distribution

Before creating tags, publishing, approving release jobs, or recovering a failed
release, read `docs/release.md` and `docs/release-operations.md`. Use the
repo-owned skill at `docs/skills/thunderclaw-release-operations/SKILL.md` for
release operations; it routes to those authoritative documents.

Internal automation, publishing-tool, test-harness, documentation, and skill
changes do not require a product version bump, tag, or release. Validate them
with ordinary CI, executable workflow regressions, or a sandbox as appropriate.
For recovery, establish the publication stage from evidence before choosing an
action. Preserve qualified bytes and immutable public release identity.

Only the standalone Thunderbird extension is published. Its manifest version,
component-scoped root changelog entry, `thunderbird-extension-vX.Y.Z` tag, and
GitHub release identify one XPI and one allowlisted Mozilla reviewer source ZIP.
Build candidates once, record their digests, qualify those exact bytes, and
promote them without rebuilding. No companion artifact belongs to this release
path. Preserve historical releases, immutable tags, retained validation tools, and
private local state during separately scoped legacy cleanup.

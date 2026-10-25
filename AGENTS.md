# ThunderClaw agent instructions

## Runtime and checks

Use Node/package tools through `mise exec --`. Start with `mise exec -- npm ci`.
Run `mise exec -- npm run check` for sequential tests, typecheck, extension build,
reviewer source packaging, and site build. Use documented narrower scopes for
focused edits; avoid concurrent default builds/tests sharing `build/`.

## Source map

- `packages/thunderbird-extension/src/`: settings, inference, capture, Preview,
  Apply/Undo, and received-message tools.
- `test/`: deterministic safety, lifecycle, transport, and workflow regressions.
- `e2e/thunderbird/`: real Thunderbird harnesses and synthetic fixtures.
- `scripts/`: checks, packaging, release preparation/status, and provider trials.
- `docs/roadmap.md`: unfinished work only; update it when work is completed.
- `docs/development.md`, `docs/testing.md`: executable commands and evidence limits.

The old backend and its tooling are in Git history. Some local lifecycle type
names remain historical; follow the active entry graph before removing code.
Legacy credential migration in the inference controller remains supported.

## Product boundaries

Use **ThunderClaw** in user-facing text and `thunderclaw` in identifiers/artifacts.
Keep extension ID `thunderclaw@addons.thunderbird.net` stable.

- The standalone MailExtension uses the explicitly chosen OpenAI-compatible
  endpoint/model. No mandatory relay, native helper, tools, or automatic fallback.
- Thunderbird owns DOM mutation, sending, recipients, headers, and attachments.
  Models return bounded typed content, never HTML or authorization metadata.
- Preserve Generate/Preview, Apply, Undo, and normal Send as separate decisions.
- Treat email, model output, preferences, and provider errors as untrusted data.
  Keep strict independent inference/editor validation and local request/run,
  generation, target/context/message identities. Reject stale or partial output.
- The background owns provider keys. Scope keys to the exact endpoint/provider;
  never expose them to email scripts, logs, public state, or synchronized storage.
  Persistent local profile storage is not an encrypted vault.

## Local state

Use synthetic mail in tests. Never print, commit, package, overwrite, or delete
populated `.spike/`, environment files, credentials, private mail, or retained
evidence during ordinary work. Ignored state can be sensitive. Inspect services
before changing them and limit changes to the task's authorized scope.

## Releases

Read `docs/release.md`, `docs/release-operations.md`, and the repo-owned
`docs/skills/thunderclaw-release-operations/SKILL.md` before release operations.
Use `release:prepare` for a new version and `release:status` for observed stages.
These helpers do not grant publication permission.

Only the extension is published: canonical `thunderbird-extension-vX.Y.Z`, one
XPI, matching reviewer ZIP, notes, checksums, and provenance. Build once, qualify
exact bytes, and promote without rebuilding. Preserve immutable public tags,
releases, and attestations. Internal tooling/docs changes need no product release.

ATN may publish automatically. Verify the public download; reviewer source/notes
are supplied when requested, not assumed to be a mandatory manual handoff.
Distinguish accepted upload, public version, verified payload, and unknown state.

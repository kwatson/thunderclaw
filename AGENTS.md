# Project agent instructions

## Project identity

This project is named **ThunderClaw**. Use `ThunderClaw` in user-facing text
and `thunderclaw` in package names, plugin IDs, routes, environment variables,
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

- `packages/openclaw-plugin/`: OpenClaw plugin and package metadata
- `packages/thunderbird-extension/`: Thunderbird extension source and icons
- `test/`: deterministic unit, contract, lifecycle, and boundary tests
- `e2e/`: real Thunderbird and protected qualification tooling
- `fixtures/`: cross-boundary conformance fixtures
- `scripts/`: build and repeatable qualification entry points
- `docs/`: evergreen product, protocol, security, release, and brand material
- `docs/roadmap.md`: the authoritative unfinished priority list

The two components are independently packaged. Do not add a shared runtime
contract library across their HTTP boundary; use independent validators and
shared conformance fixtures.

## Product and architecture invariants

- ThunderClaw is a Thunderbird MailExtension that calls a separately installed
  OpenClaw plugin over fixed HTTP(S) routes. Do not add a native helper,
  alternate transport, or OpenClaw core patch.
- Thunderbird owns message and compose DOM mutation. Never insert
  model-produced HTML, let a model send mail, or let it change recipients,
  attachments, or headers.
- OpenClaw runs use the selected compatible configured agent, isolated
  in-memory sessions, disabled model-callable tools and trajectory, and strict
  JSON contracts. The current Thunderbird snapshot is authoritative.
- Preserve separate Generate/Preview, Apply, Undo, and normal Send decisions.
- Treat email as untrusted input. Preserve request and run identity,
  generation, target/context hashes, output limits, exact segment IDs, and
  stale-result validation on both sides of the boundary.
- The extension may hold only its narrow paired ThunderClaw credential for the
  configured origin. Provider, model, agent, and provider-key configuration
  belongs to OpenClaw.
- Keep the stable extension ID `thunderclaw@addons.thunderbird.net` unless a
  planned migration updates every dependent boundary.

## Local state and sensitive data

The Docker test Gateway is defined by `compose.spike.yaml`. Persistent local
state under `.spike/`, populated environment files, generated `build/` output,
and retained qualification evidence are ignored but may contain credentials,
message content, and environment details.

- Do not print, commit, document, copy, or package populated values.
- Do not delete, recreate, or overwrite ignored state unless the task
  explicitly requires a clean environment.
- Inspect running services before restarting them; avoid destructive Compose
  commands and restart only the service required by the change.
- Use synthetic data in tests and sanitize retained evidence.

## Distribution

The OpenClaw plugin and Thunderbird extension release independently. A plugin
release produces one npm-style archive; an extension release produces one XPI
and one allowlisted Mozilla reviewer source archive. Each component owns its
version, component-scoped entry in the root changelog, tag, and GitHub release.
Build candidate artifacts once, record their digests, qualify those exact bytes
with the cryptographically pinned last-published counterpart, and promote them
without rebuilding.

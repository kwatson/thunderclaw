# ThunderClaw development

## Runtime

This repository uses `mise` for managed runtimes. Invoke Node.js and package
tools through it in non-interactive shells:

```text
mise current
mise exec -- npm ci
mise exec -- npm test
mise exec -- npm run typecheck
mise exec -- npm run build
```

Do not install or upgrade a system runtime to work around an inactive `mise`
shim. Runtime-version changes must be deliberate repository changes.

## Local OpenClaw environment

The Docker test Gateway is defined by `compose.spike.yaml` and pinned to the
supported OpenClaw version. Persistent state is under
`.spike/thunderclaw-openclaw/`; generated integration evidence is under
`.spike/evidence/` and `build/`. The Gateway cache is isolated under
`.spike/thunderclaw-openclaw-cache/`, and Compose runs the test services with
the invoking host user's numeric identity so private bind-mounted state remains
writable on local and hosted runners. These paths are ignored but are not
disposable.

Copy `.env.example` to `.env.openclaw.local` and supply the required provider
secret. Never print, commit, document, or place populated values in artifacts.

Inspect before changing the environment:

```text
docker compose -f compose.spike.yaml ps
docker compose -f compose.spike.yaml logs --tail=100 gateway
```

Do not use volume-removing Compose commands during ordinary work. Restart only
the Gateway when the plugin runtime changes.

Provider, model, agent, and Gateway operator configuration remains local
OpenClaw state and must not be copied into documentation or artifacts. A broad
Gateway operator token is not a ThunderClaw product-route credential and must
never be placed in Thunderbird.

## Build the extension

```text
mise exec -- npm run build:extension
```

Build output belongs under `build/`. The stable extension ID is
`thunderclaw@addons.thunderbird.net` and must not change without a planned
migration across every dependent boundary.

## Build and install the plugin

Create the exact archive and inspect the running environment before install:

```text
mise exec -- npm run pack:plugin
docker compose -f compose.spike.yaml ps
docker compose -f compose.spike.yaml logs --tail=100 gateway
```

Install the archive name printed by `npm pack`, restart only the Gateway, and
verify discovery and full runtime status:

```text
docker compose -f compose.spike.yaml exec -T gateway \
  node openclaw.mjs plugins install --force --accept-capabilities \
    npm-pack:/workspace/thunderclaw/build/ARCHIVE_NAME.tgz
docker compose -f compose.spike.yaml restart gateway
docker compose -f compose.spike.yaml exec -T gateway \
  node openclaw.mjs plugins inspect thunderclaw --runtime --json
docker compose -f compose.spike.yaml exec -T gateway \
  node openclaw.mjs thunderclaw status --json
```

The pairing qualification harness provides controlled install recovery and is
preferred when the pairing lifecycle is in scope. A direct installation should
use its deployment's supported plugin update procedure.

## Repository map

- `packages/thunderbird-extension/`: Thunderbird UI, capture, validation,
  Preview, Apply, Undo, pairing, message translation, summaries, and shipping
  icon derivatives
- `packages/openclaw-plugin/`: OpenClaw plugin routes, sessions, prompts, agent
  compatibility, fallbacks, pairing, and contracts
- `test/`: fast deterministic unit, contract, lifecycle, and boundary tests
- `e2e/thunderbird/`: real Thunderbird harnesses and fixtures
- `e2e/qualification/`: exact-artifact real-agent qualification tooling
- `scripts/`: builds and repeatable environment/qualification entry points
- `docs/`: evergreen product, engineering, security, release, protocol, and
  brand-source documentation

The root workspace coordinates checks and releases, but each installable has
its own package metadata. Do not add a runtime contract package shared by the
extension and plugin; keep independent validators and exercise them against
the shared conformance fixtures.

# ThunderClaw

ThunderClaw brings OpenClaw-powered writing and reading assistance into desktop
Thunderbird while keeping Thunderbird—and the user—in control of the message.
It can improve selected draft text, produce narrowly typed rich content,
summarize messages, and translate visible message text.

## Product boundary

ThunderClaw has exactly two installable components:

1. a Thunderbird MailExtension; and
2. a separately installed ThunderClaw OpenClaw plugin.

The extension calls fixed plugin HTTP(S) routes directly. There is no native
helper, Native Messaging host, alternate transport, or OpenClaw core patch.

Thunderbird owns capture, Preview, Apply, Undo, message-display changes, and
the ordinary Send action. The model cannot send mail, change recipients or
attachments, or provide HTML for insertion. OpenClaw owns configured agents,
models, providers, and provider credentials.

See [`docs/architecture.md`](docs/architecture.md) and
[`docs/product-contract.md`](docs/product-contract.md) for the complete
boundary.

## Capabilities

Compose actions support Improve, Proofread, Shorten, Tone, Translate,
Summarize, and custom instructions. Generate produces a non-mutating Preview;
Apply changes only the validated target; Undo restores the accepted prior
state. Stale results fail closed.

Thunderbird 128 and newer support selected-text transformations. Qualified
Thunderbird 153 and newer selections additionally support:

- same-kind flat unordered and ordered list rewriting;
- conversion of complete supported paragraph selections into typed lists; and
- typed paragraphs, flat lists, and bold, italic, or underlined spans.

Message display supports a separate plain-text summary card and reversible
translation of visible text nodes without replacing the message's HTML
structure. The exact eligibility and fail-closed rules are in
[`docs/product-contract.md`](docs/product-contract.md).

## Repository layout

ThunderClaw is a monorepo so cross-boundary contracts and release qualification
can be reviewed together while the two products remain independently packaged:

- `packages/openclaw-plugin/`: the OpenClaw plugin package;
- `packages/thunderbird-extension/`: extension source and shipping icons;
- `test/`: shared contract and component tests;
- `e2e/`: real Thunderbird and protected release qualification tooling;
- `scripts/`: deterministic build and qualification entry points;
- `fixtures/`: cross-boundary conformance fixtures; and
- `docs/`: product, protocol, security, release, and brand source material.

Runtime contracts are intentionally validated independently on each side of the
HTTP boundary. Shared fixtures test conformance without adding a shared runtime
package that could hide compatibility mistakes.

## Distribution and versioning

Each release commit produces two installable artifacts and one reviewer source
archive:

- an npm-style `.tgz` containing `@thunderclaw/openclaw-plugin`, published
  through ClawHub;
- a signed `.xpi` published through Thunderbird Add-ons; and
- an allowlisted source archive for Mozilla review, with reproducible build
  instructions and everything needed to inspect generated extension code.

The plugin and extension use the same release version. Release automation builds
the artifacts once, records their digests, qualifies those exact bytes, and
promotes them without rebuilding. See [`docs/release.md`](docs/release.md).

## Installation and pairing

Thunderbird receives a narrow paired per-device credential, never a provider
credential or broad Gateway token. The user starts pairing in Thunderbird; an
OpenClaw operator approves the matching request with:

```text
openclaw thunderclaw
```

The user then explicitly claims the approval in Thunderbird. Installation,
pairing, rotation, Disconnect, Forget, and recovery guidance is in
[`docs/installation-and-pairing.md`](docs/installation-and-pairing.md).

## Development

This repository uses Node.js through `mise`:

```text
mise exec -- npm ci
mise exec -- npm test
mise exec -- npm run typecheck
mise exec -- npm run build
```

Local Gateway setup and plugin lifecycle instructions are in
[`docs/development.md`](docs/development.md). Test and qualification lanes are
documented in [`docs/testing.md`](docs/testing.md).

## Documentation

- [`docs/architecture.md`](docs/architecture.md): component ownership and data flow
- [`docs/product-contract.md`](docs/product-contract.md): supported behavior and review boundaries
- [`docs/compatibility.md`](docs/compatibility.md): supported runtimes and upgrade policy
- [`docs/security-and-privacy.md`](docs/security-and-privacy.md): trust, credentials, disclosure, and residual risks
- [`docs/installation-and-pairing.md`](docs/installation-and-pairing.md): installation and operator/user pairing
- [`docs/development.md`](docs/development.md): development environment and plugin updates
- [`docs/testing.md`](docs/testing.md): test layers and qualification matrices
- [`docs/release.md`](docs/release.md): artifact acceptance and publication policy
- [`docs/roadmap.md`](docs/roadmap.md): unfinished work only
- [`docs/brand/`](docs/brand/): brand specification, sources, licensing, and provenance
- [`docs/reference/`](docs/reference/): normative protocol contracts

## Contributing, security, and license

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development and pull-request
guidance and [`SECURITY.md`](SECURITY.md) for private vulnerability reporting.
Community participation is governed by
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

Code, documentation, and project-owned assets are licensed under the
[Apache License 2.0](LICENSE). The ThunderClaw name, logo, and character are
also covered by the separate [`TRADEMARKS.md`](TRADEMARKS.md) policy.


<p align="center">
  <img src="docs/brand/assets/raster/thunderclaw-character-transparent-512.png" width="180" alt="ThunderClaw character">
</p>

<h1 align="center">ThunderClaw</h1>

<p align="center">
  <strong>OpenClaw-powered writing and reading assistance for Thunderbird.</strong>
  <br>
  Your inbox, your decisions, your control.
</p>

<p align="center">
  <a href="https://github.com/kwatson/thunderclaw/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/kwatson/thunderclaw/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg"></a>
  <a href="docs/compatibility.md"><img alt="Thunderbird 128+" src="https://img.shields.io/badge/Thunderbird-128%2B-0A84FF?logo=thunderbird&logoColor=white"></a>
  <a href="https://github.com/kwatson/thunderclaw/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/kwatson/thunderclaw?display_name=tag&amp;label=release"></a>
</p>

<p align="center">
  <a href="#what-it-can-do">Features</a> ·
  <a href="#how-it-stays-safe">Safety</a> ·
  <a href="docs/installation-and-pairing.md">Installation</a> ·
  <a href="docs/development.md">Development</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

> [!NOTE]
> **OpenClaw requirement:** ThunderClaw supports OpenClaw from
> `2026.7.2-beta.7` through the `2026.9.2` release line. See the
> [compatibility policy](docs/compatibility.md) for details.

## AI assistance without handing over your inbox

ThunderClaw brings useful writing and reading tools into desktop Thunderbird
while keeping Thunderbird—and you—in charge. A model can propose an edit,
summary, or translation. It cannot send mail, silently rewrite a message, or
change recipients, attachments, or headers.

Every compose change follows the same deliberate flow:

**Generate → Preview → Apply → Undo**

The current Thunderbird content remains authoritative throughout. Results are
validated on both sides of the connection, and stale results fail closed.

## See it in action

Preview a writing improvement before choosing whether to apply it to the draft:

<p align="center">
  <img src="site/assets/screenshots/compose-preview.png" width="900" alt="ThunderClaw showing an improved email in a preview beside a Thunderbird compose window">
</p>

Reading tools keep generated results separate from the original message and
make them easy to dismiss or reverse.

<table>
  <tr>
    <td width="50%" align="center"><strong>Summarize a message</strong></td>
    <td width="50%" align="center"><strong>Translate in place</strong></td>
  </tr>
  <tr>
    <td width="50%"><img src="site/assets/screenshots/message-summary.png" alt="ThunderClaw displaying a summary above the original Thunderbird message"></td>
    <td width="50%"><img src="site/assets/screenshots/message-translation.png" alt="ThunderClaw displaying a French translation with a control to restore the original message"></td>
  </tr>
</table>

## What it can do

| In the composer | In a received message |
| --- | --- |
| Improve, proofread, shorten, or change tone | Create a separate plain-text summary card |
| Translate or summarize selected draft text | Reversibly translate visible message text |
| Follow a custom writing instruction | Preserve the message's original HTML structure |
| Preview before applying and undo afterward | Leave the original message untouched |

Thunderbird 128 and newer support plain selected-text transformations.
Qualified Thunderbird 153 and newer selections can also preserve or produce
narrowly typed rich content: paragraphs, flat lists, and bold, italic, or
underlined spans. Unsupported shapes are rejected rather than guessed at.

See the [product contract](docs/product-contract.md) for exact capability and
eligibility rules.

## Data sent to OpenClaw

ThunderClaw sends email content only after you invoke a writing, translation,
or summary action:

- **Compose actions** send the selected target, the entire visible authored
  draft body, extracted quoted message history, subject, and To/Cc/Bcc
  recipients.
- **Message actions** send the entire visible rendered message body—including
  visible quoted history and signatures—plus its subject and author.

ThunderClaw does not send attachment contents, hidden message content, or
message headers other than those listed above through its transformation
routes. The content passes through the OpenClaw Gateway you configure to the
selected agent and configured model provider. Configured fallback providers
and hooks installed in that Gateway may also process it. ThunderClaw's
developer operates no service that receives this content.

Read the full [privacy policy](docs/privacy-policy.md) before use.

## How it stays safe

Email is untrusted input, so ThunderClaw is intentionally narrow by design.

- **Thunderbird owns every mutation.** Models return strictly validated data,
  never HTML to insert into a message.
- **Sending stays ordinary and manual.** ThunderClaw cannot invoke Send or
  alter recipients, attachments, or headers.
- **Model runs are isolated.** The selected compatible OpenClaw agent runs with
  in-memory sessions, model-callable tools disabled, and trajectory disabled.
- **Results are bound to their context.** Request identity, generation, target
  hashes, context hashes, output limits, and segment IDs prevent stale or
  misplaced changes.
- **Credentials stay scoped.** Thunderbird stores only its narrow paired
  ThunderClaw credential—never provider keys or a broad Gateway token.
- **The boundary is reviewable.** The extension and plugin communicate only
  over fixed HTTP(S) routes, with independent validators on each side.

Read the full [security and privacy model](docs/security-and-privacy.md) and
[architecture](docs/architecture.md).

## Architecture

ThunderClaw has exactly two independently packaged components:

```mermaid
flowchart LR
    U["You in Thunderbird"] -->|"Generate / Preview / Apply / Undo"| T["Thunderbird MailExtension"]
    T -->|"Fixed HTTP(S) routes<br>strict JSON contracts"| P["ThunderClaw OpenClaw plugin"]
    P -->|"Restricted, isolated run"| A["Your configured compatible agent"]
    T -.->|"Only Thunderbird mutates<br>message and compose DOM"| M["Mail content"]
```

There is no native helper, Native Messaging host, alternate transport, or
OpenClaw core patch. Provider, model, agent, and provider-key configuration
remain in OpenClaw.

ThunderClaw does not keep its own provider allowlist. It uses OpenClaw as the
model router and applies the same runtime capability probe to every configured
provider. DeepSeek is the current paid release-qualification baseline, not the
only supported backend; see the [compatibility policy](docs/compatibility.md).

## Installation and pairing

ThunderClaw supports OpenClaw from `2026.7.2-beta.7` through the `2026.9.2`
release line. See the [compatibility policy](docs/compatibility.md) before
installing.

Install the current compatible pair: Thunderbird extension `0.1.2` and
OpenClaw plugin `0.1.6`:

1. Install **ThunderClaw** from its
   [Thunderbird Add-ons listing](https://addons.thunderbird.net/en-US/thunderbird/addon/thunderclaw/).
2. Install and enable the
   [`@thunderclaw/openclaw-plugin` package on ClawHub](https://clawhub.ai/thunderclaw/plugins/openclaw-plugin)
   on the OpenClaw host:

   ```bash
   openclaw plugins install --accept-capabilities clawhub:@thunderclaw/openclaw-plugin
   openclaw plugins enable thunderclaw
   openclaw gateway restart
   ```

   `--accept-capabilities` records the OpenClaw operator's approval of the
   plugin's declared capabilities. It is separate from approving a Thunderbird
   device during ThunderClaw pairing.

ThunderClaw lists the agents already configured in OpenClaw; it does not create
one while installing or pairing. Using `main` is fully supported. A dedicated
agent is optional when separate mail personality, workspace, memory, or model
configuration is desirable—not a required security boundary. See
[installation and pairing](docs/installation-and-pairing.md#choose-an-openclaw-agent)
for the tradeoffs and setup command.

Thunderbird initiates pairing and displays a short approval code. An
authenticated OpenClaw operator approves the matching request with:

```text
openclaw thunderclaw
```

The user then explicitly claims that approval in Thunderbird. Approval and
claim are separate decisions; neither happens automatically. See
[installation and pairing](docs/installation-and-pairing.md) for the complete
flow and [development](docs/development.md) for running from source today.

## Development

ThunderClaw uses Node.js through [`mise`](https://mise.jdx.dev/):

```bash
mise exec -- npm ci
mise exec -- npm test
mise exec -- npm run typecheck
mise exec -- npm run build
```

The monorepo keeps both sides of the boundary reviewable together while
packaging them independently:

```text
packages/openclaw-plugin/         OpenClaw plugin and package metadata
packages/thunderbird-extension/   Thunderbird extension source and icons
test/                             Unit, contract, lifecycle, and boundary tests
e2e/                              Real Thunderbird and qualification tooling
fixtures/                         Cross-boundary conformance fixtures
scripts/                          Build and qualification entry points
docs/                             Product, protocol, security, and release docs
```

Shared fixtures test conformance, but each component independently validates
the runtime contract across the HTTP boundary. Start with the
[development guide](docs/development.md), [testing guide](docs/testing.md), and
[contribution guide](CONTRIBUTING.md).

## Project status

ThunderClaw `v0.1.0` is the first public release and is available from
[Thunderbird Add-ons](https://addons.thunderbird.net/en-US/thunderbird/addon/thunderclaw/)
and [ClawHub](https://clawhub.ai/thunderclaw/plugins/openclaw-plugin). The
[roadmap](docs/roadmap.md) is the authoritative list of unfinished work and
post-release hardening.

Bug reports, documentation improvements, tests, and focused code changes are
welcome. For substantial behavior, protocol, dependency, or UI changes, please
open an issue before investing in an implementation.

## Documentation

- [Architecture](docs/architecture.md) — component ownership and data flow
- [Product contract](docs/product-contract.md) — supported behavior and review boundaries
- [Compatibility](docs/compatibility.md) — supported runtimes and upgrade policy
- [Security and privacy](docs/security-and-privacy.md) — trust, credentials, disclosure, and residual risks
- [Privacy policy](docs/privacy-policy.md) — ATN-ready data practices and listing disclosure collateral
- [Installation and pairing](docs/installation-and-pairing.md) — installation and operator/user pairing
- [Development](docs/development.md) — development environment and plugin updates
- [Testing](docs/testing.md) — test layers and qualification matrices
- [Release process](docs/release.md) — artifact acceptance and publication policy
- [Protocol reference](docs/reference/) — normative boundary contracts
- [Brand](docs/brand/) — assets, specification, licensing, and provenance

## Community and license

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request and
use [SECURITY.md](SECURITY.md) for private vulnerability reports. Community
participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

Code, documentation, and project-owned assets are licensed under the
[Apache License 2.0](LICENSE). The ThunderClaw name, logo, and character are
also covered by the [trademark policy](TRADEMARKS.md).

---

<p align="center">
  <strong>Want safer AI assistance in Thunderbird?</strong><br>
  Star ThunderClaw to follow the journey—and help more Thunderbird users find it. ⚡
</p>

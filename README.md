<p align="center">
  <img src="docs/brand/assets/raster/thunderclaw-character-transparent-512.png" width="180" alt="ThunderClaw character">
</p>

<h1 align="center">ThunderClaw</h1>

<p align="center">
  <strong>AI writing and reading assistance for Thunderbird, using your chosen provider or local model.</strong>
  <br>
  Your inbox, your decisions, your control.
</p>

<p align="center">
  <a href="https://github.com/kwatson/thunderclaw/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/kwatson/thunderclaw/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg"></a>
  <a href="docs/compatibility.md"><img alt="Thunderbird 128+" src="https://img.shields.io/badge/Thunderbird-128%2B-0A84FF?logo=thunderbird&logoColor=white"></a>
</p>

<p align="center">
  <a href="#what-it-can-do">Features</a> ·
  <a href="#how-it-stays-safe">Safety</a> ·
  <a href="docs/installation.md">Installation</a> ·
  <a href="docs/development.md">Development</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

> Install ThunderClaw from [Thunderbird Add-ons](https://addons.thunderbird.net/en-US/thunderbird/addon/thunderclaw/). The standalone extension connects directly to your chosen provider or local model.

## AI assistance without handing over your inbox

ThunderClaw brings useful writing and reading tools into desktop Thunderbird
while keeping Thunderbird—and you—in charge. A model can propose an edit,
summary, or translation. It cannot send mail, silently rewrite a message, or
change recipients, attachments, or headers.

Every compose change follows the same deliberate flow:

**Generate → Preview → Apply → Undo**

The current Thunderbird content remains authoritative throughout. Results are
validated in the background and at the Thunderbird editing boundary, and stale results fail closed.

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

## Your inference connection

ThunderClaw connects directly to OpenAI, OpenRouter,
DeepSeek, Ollama, LM Studio, or a custom OpenAI-compatible endpoint. Choose the
endpoint and model in settings, provide a key if needed, grant host access,
save, and run the synthetic connection test. Keys are remembered locally across
restarts. They are not synchronized or an encrypted vault.

Compose requests send the selected text and authored draft context, without
recipient addresses or extracted quoted history. Reading requests send eligible
visible message segments. Local state fingerprints still detect changes to
recipients, headers, attachments and the captured text before Apply. Read the
[privacy policy](docs/privacy-policy.md) for details.

A loopback endpoint can itself forward to hosted models. OpenRouter may route
to an upstream provider. ThunderClaw never silently changes your configured
endpoint or model. The project operates no inference or analytics service.

## How it stays safe

- Thunderbird owns DOM changes, validation, rollback, and Undo. Models return
  bounded typed data; model HTML is never inserted.
- Sending remains manual. Models cannot change recipients, headers, or attachments.
- Request/run identity, generations, target/context hashes, connection epochs,
  output limits and exact segment mapping reject stale or misplaced changes.
- The background owns credentials, prompts and transport. Settings and feature
  messages are restricted to their trusted extension pages.
- HTTPS is required remotely; explicit loopback HTTP is supported. Redirects
  and automatic endpoint/model fallback are rejected.

See [architecture](docs/architecture.md) and [security and privacy](docs/security-and-privacy.md).

## Installation

Install from [Thunderbird Add-ons](https://addons.thunderbird.net/en-US/thunderbird/addon/thunderclaw/), then open ThunderClaw settings. Choose a provider,
load or enter a model, save your key and connection, grant host access, and click
**Test connection**. Your key stays saved across restarts.

For local development, build the XPI from this checkout and install it through
Thunderbird’s **Add-ons and Themes → gear menu → Install Add-on From File**.
See [installation and connection setup](docs/installation.md) for provider
presets, local servers, troubleshooting, and upgrade guidance. Installing a newer
XPI updates the existing add-on; uninstalling first is unnecessary.

The response limit defaults to **16,384 tokens**. Thinking defaults to **Off** for
DeepSeek and **Model default** elsewhere. Both are configurable; model support
varies. See [response controls](docs/inference-prompts.md#response-limit-and-thinking).

## Development

ThunderClaw uses Node.js through [`mise`](https://mise.jdx.dev/):

```bash
mise exec -- npm ci
mise exec -- npm run check
```

The main source and verification paths are:

```text
packages/thunderbird-extension/   Extension source, settings, and icons
test/                             Deterministic unit and boundary tests
e2e/thunderbird/                   Real Thunderbird harnesses and fixtures
fixtures/                         Conformance fixtures
scripts/                          Build, packaging, and qualification tools
docs/                             Product, engineering, security, and release docs
```

Start with the [development guide](docs/development.md),
[testing guide](docs/testing.md), and [contribution guide](CONTRIBUTING.md).
The [roadmap](docs/roadmap.md) tracks unfinished qualification and hardening.
Bug reports, documentation improvements, tests, and focused changes are welcome.

## Documentation

- [Architecture](docs/architecture.md) — component ownership and data flow
- [Product contract](docs/product-contract.md) — supported behavior and review boundaries
- [Compatibility](docs/compatibility.md) — supported runtimes and upgrade policy
- [Security and privacy](docs/security-and-privacy.md) — trust, credentials, disclosure, and residual risks
- [Privacy policy](docs/privacy-policy.md) — ATN-ready data practices and listing disclosure collateral
- [Installation and connection setup](docs/installation.md) — providers, keys, local servers, and troubleshooting
- [Development](docs/development.md) — build environment and local extension trials
- [Testing](docs/testing.md) — test layers and qualification matrices
- [Release process](docs/release.md) — artifact acceptance and publication policy
- [Inference boundary](docs/reference/inference-boundary.md) — transport, local identity, validation, and safe errors
- [Prompts and formatting](docs/inference-prompts.md) — action rules, response limits, and thinking
- [Upgrade guide](docs/upgrading.md) — existing installations and retained review behavior
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

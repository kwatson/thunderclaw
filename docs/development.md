# ThunderClaw development

ThunderClaw is a Thunderbird MailExtension. Its background connects directly to
a user-configured inference API; ordinary development needs no backend service.

## Runtime and checks

Install the runtime pinned in `.mise.toml` using [mise](https://mise.jdx.dev/).
Use the managed runtime in non-interactive shells:

```text
mise install
mise exec -- npm ci
mise exec -- npm run check
```

The default check runs tests, typecheck, extension build, reviewer-source packaging,
and site build sequentially. Run `mise exec -- npm run check -- --help` for narrower scopes.
The extension build uses esbuild and the system `zip` tool. It writes
`build/thunderclaw-extension.xpi`. The stable extension ID is
`thunderclaw@addons.thunderbird.net`. Do not change it without a planned migration.
Build output is ignored and can contain sensitive test evidence; handle it with
care. Avoid building into the default output directory concurrently with tests.

To produce the allowlisted reviewer source archive:

```text
mise exec -- npm run pack:source
```

[Source review](../SOURCE_REVIEW.md) describes the reproducible build. Internal
changes and documentation updates do not require a product version or release.

## Try a local build

Install the XPI from **Add-ons and Themes → gear menu → Install Add-on From File**.
Use a disposable Thunderbird profile and synthetic email for development. Open
settings, choose an endpoint/model, save, grant host access, and test the connection.
See [installation](installation.md) for the full flow and provider defaults.

Use your own provider account or a compatible local server for model trials.
Never put keys into source files, command arguments, screenshots, test fixtures,
or retained logs. A successful synthetic connection test is a bounded check;
it does not prove language quality, prompt-injection resistance, or all model
capabilities.

## Source map

| Location | Responsibility |
| --- | --- |
| `packages/thunderbird-extension/src/` | Settings, background inference, capture, Preview, Apply, Undo, and reading tools |
| `test/` | Deterministic contracts, lifecycle, credential, transport, prompt, and DOM tests |
| `e2e/thunderbird/` | Real Thunderbird harnesses and synthetic API fixtures |
| `fixtures/` | Shared conformance examples |
| `scripts/` | Builds, packaging, workflow checks, and qualification entry points |
| `docs/` | Current product, engineering, security, release, and brand guidance |

Start with `inference-provider.ts`, `inference-connection-controller.ts`,
`credential-store.ts`, `inference-client.ts`, and `inference-output.ts` for the
connection path. Capture and editor code remain responsible for local state and
safe mutations. Some internal lifecycle types retain older terminology; they do
not imply network sessions or a separately installed backend.

Retired backend source and tooling are available in Git history.
Do not delete or overwrite populated ignored state such as `.spike/`, local
environment files, or qualification evidence while making ordinary changes.

## Change boundaries

Keep credentials and network requests in the background. Treat email, user
preferences, model output, model labels, and provider errors as untrusted input.
Preserve strict output validation, local request/target bindings, separate Preview
and Apply, stale-result rejection, and verified Undo. Models must never send
mail, change recipients/headers/attachments, or supply HTML for insertion.

Read [architecture](architecture.md), [product behavior](product-contract.md),
[security](security-and-privacy.md), and [testing](testing.md) before changing these
boundaries. For a release, follow the [release policy](release.md) and
[operations runbook](release-operations.md); a local build is not a published or
qualified release.

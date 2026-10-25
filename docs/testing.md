# ThunderClaw testing and qualification

## Standard checks

Use the managed runtime:

```text
mise exec -- npm run check
```

When changing extension source, also run:

```text
mise exec -- npm run build:extension
```

For reviewer-source/build changes, run `mise exec -- npm run pack:source` and
verify clean-source reproduction as described in [source review](../SOURCE_REVIEW.md)
and the [release policy](release.md). Run builds and deterministic tests
sequentially when they share the default `build/` directory.

## What each layer proves

| Layer | Coverage | Limits |
| --- | --- | --- |
| Deterministic tests | Prompt assembly, strict contracts, provider mappings, credentials, permissions, races, lifecycle, stale results, DOM/Undo rules, workflow guards | Mocked responses do not establish real-model quality or provider availability |
| Real Thunderbird with a synthetic API fixture | Built XPI installation, settings, model picker, key persistence/restart, capture, Preview, Apply, Undo/Redo, and eligible rich formatting | Bounded pinned versions and disposable profile configuration |
| Live model trials | Request acceptance, faithful transformations, translations, formatting, injection evaluations | Model/server/version-specific evidence; never universal compatibility |
| Release qualification | Checksummed build-once XPI, Linux/Windows Thunderbird gates, reviewer-source reproduction, protected promotion and public signed-XPI verification | Successful upload alone does not mean marketplace review is complete |

The native fixture HTTP regression runs when Python 3 is available and reports a
skip otherwise. Native Thunderbird trials require Python; hosted lanes provide it.

Use synthetic email and test accounts. Never use a real inbox or retained provider
keys in public CI. Retired backend source and harnesses are available in Git history.

## CI and exact-candidate Thunderbird trials

Ordinary pull-request and main CI runs the **Tests, types, and packages** check.
Documentation-only changes keep that required context without full checks.
Source/tooling changes run tests and typechecks; extension/build inputs also build
the XPI and reviewer source. **Signoffs** is the separate DCO check.

Expensive trials run when a maintainer dispatches **CI** with **Run expensive
pre-release qualification** enabled (`release_qualification`), and in the tagged
release workflow. Ordinary pull requests/main pushes do not trigger native trials.
Manual CI builds one candidate, records its digest, and passes verified copies to
Linux and Windows Thunderbird 153.0.3. Failure evidence uses synthetic content.

For local Docker trials, first build or obtain the intended XPI, then name it
explicitly:

```text
THUNDERCLAW_E2E_XPI=/absolute/path/to/thunderclaw-extension.xpi   mise exec -- npm run test:e2e:thunderbird
```

The default local matrix is Thunderbird 128.14.0esr and 153.0.3; set
`THUNDERCLAW_E2E_VERSIONS` to one of those pins to narrow it. The runner validates
and stages identical candidate bytes and never builds the XPI implicitly. It
uses disposable profiles and an isolated synthetic compatible-API fixture.
Evidence goes under `build/e2e/thunderbird/` unless a different artifact root is
explicitly configured. Do not treat that output as disposable when investigating
a failure; copy only sanitized evidence for reports.

The native harness currently disables remote extension-document isolation in its
disposable profiles so Marionette can address options/popups. It therefore does
not establish behavior under every default browser isolation configuration.
Hosted macOS compose automation is deferred. Additional platform smoke, upgrade,
permission/certificate, and default-isolation coverage belongs in the
[compatibility policy](compatibility.md) and [roadmap](roadmap.md).

## Behavioral acceptance

Before accepting an extension candidate, check the relevant supported paths:

- Save/reopen/restart settings; preserve scoped keys without exposing them to
  feature contexts; reject old jobs after connection or permission changes.
- Explicit model choice and synthetic connection testing; no automatic fallback.
- Plain actions and supported list/rich capture, including original emphasis in
  the request; Preview, Apply, rollback, Undo/Redo, and newer-edit rejection.
- Received-message summaries and translations, automatic source detection, exact
  segment mapping, restoration, and navigation/cancellation races.
- Clear safe failures for token exhaustion, refusals, invalid structures,
  unsupported settings, network/authentication failures, and stale output.

Qualify actual old-release-to-candidate upgrades separately;
never claim old authentication or remote revocation behavior applies to current
provider keys.

## Reusable synthetic provider trials

Run `mise exec -- npm run test:provider` for deterministic trials using the real
inference adapter with an injected synthetic transport. It covers action families,
supported structures, a long segmented newsletter translation with automatic
source detection, and a truncated response rejected with the output-limit error.
This is a protocol regression, not evidence of model translation quality.

Live calls are opt-in. Use `--live`, a provider/API base/model, and an API-key file
outside the repository if needed. For example:

```text
mise exec -- npm run test:provider -- --live --provider deepseek --api-base https://api.deepseek.com --model YOUR_MODEL_ID --api-key-file /absolute/private/key-file --case received-newsletter-translate-auto
```

The key file path is permitted; the raw key never belongs in arguments, logs,
fixtures, or screenshots. Trials use generated synthetic content and report
bounded metadata, never private mail or raw model replies. Hosted providers can
charge for explicit live trials. Keep deterministic, native-fixture, and live-model
evidence distinct. See `mise exec -- npm run test:provider -- --help` for supported options.

## Live provider evaluation

Use a reviewer-owned key and synthetic messages. Record endpoint implementation,
model ID, output mode, response/thinking settings, artifact digest, and bounded
result metadata. Keep keys out of argv, logs, fixtures, archives, and screenshots.
Do not log raw prompts/completions or private endpoint details.

Exercise short edits, long translations, all actions, supported rich structures,
and malicious instructions inside source text. JSON Schema and JSON object modes
must receive the same strict local validation. Check meaning, names, numbers,
conditions, and formatting separately from schema validity. Repeat representative
hosted and local model trials; a passing synthetic connection test cannot prove
all models or actions. See the [prompt evaluation checklist](inference-prompts.md).

## Publication evidence

The [release policy](release.md) owns blocking gates. Qualification must name the
exact candidate; promotion reuses those bytes. ATN can publish automatically.
Verify public download metadata and its payload; provide source/testing notes when
requested. Identical public bytes reuse qualification evidence; changed signature
packaging requires verified payload correspondence and public-artifact smoke. Keep artifact/source digests, runtime
versions, and bounded check results in CI artifacts and provenance. Do not
accumulate private or per-run evidence in evergreen documentation.

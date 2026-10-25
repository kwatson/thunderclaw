# Standalone inference migration

The standalone ThunderClaw extension replaces mandatory OpenClaw integration with user-configured OpenAI-compatible inference. This is a product migration, not recovery of the immutable plugin 0.1.24 publication. No existing release tag, archive, attestation, or ignored local Gateway state may be replaced.

## Scope

Keep the ThunderClaw name, artwork, repository, stable extension ID, compose actions, message translation/summary, existing Thunderbird eligibility gates, DOM validation, rollback, Preview/Apply/Undo and normal Send. Add OpenAI, OpenRouter, DeepSeek, Ollama, LM Studio and custom presets; one active connection/model; persistent credentials; writing style; model discovery/manual entry; synthetic connection testing.

Keep background inference separate from DOM mutation. Use locally owned request/run/generation/hash identity and strict content-only model payloads. Provider endpoints are configured explicitly, with no automatic cross-provider fallback. Persist keys locally without claiming encryption or synchronizing them.

## Verification and release gates

The default `npm run build` builds only the standalone extension; `build:legacy` retains the combined maintenance build. Ordinary development requires `mise exec -- npm test`, `mise exec -- npm run typecheck`, and `mise exec -- npm run build:extension`. Test packaging/source reproduction independently. Deterministic tests must cover safe plain/list/rich output, exact segment mapping, malformed/refused/truncated/oversized responses, redirect/origin confinement, cancellation and late completion, connection/key changes, migration and IPC trust.

Before release, qualify the exact XPI in real Thunderbird, including upgrading an existing installation, persistent credentials across restarts, content-context isolation, host permission changes, compose Apply/Undo and message Original/Translation. Run synthetic real-provider checks for each supported preset and representative model/schema combination. A passing mocked test is not live-provider or native-GUI qualification.

The new extension release must not depend on ClawHub, an OpenClaw version, or a paired plugin counterpart. Preserve build-once/qualify-exact-bytes/promotion and reviewer-source reproduction. The plugin admission, publishing, recovery and closeout workflows and their dedicated tooling are retired. Legacy runtime source, local validation and the root development OpenClaw dependency remain during migration; they are not runtime requirements of the standalone XPI.

## Retirement

Keep legacy plugin source/tests and historical evidence during transition. The plugin publishing/admission workflows and dedicated automation are retired. The user authorized disabling those live workflows and removing obsolete GitHub admission requirements. Retire any remaining unused publishing credentials separately after checking their consumers. Preserve prior release documentation in Git history and immutable release tags. Existing device revocation is an explicit user/admin action, not an automatic provider-key migration.

## Verified development candidate — October 24, 2026

The standalone 0.2.0 candidate XPI SHA-256 is
`07c5dba40c9a51ec5fa9fe205b621a25c74d275c04de759721bda498c98cb6c9`.
All 529 deterministic tests, type checks, and extension build passed. A clean
installation of dependencies from the allowlisted reviewer source archive
reproduced those exact XPI bytes. Astra reviewed the implementation and the
native-integration corrections with no remaining actionable findings.

Two fresh-profile Linux Thunderbird trials passed on each pinned version:
128.14.0esr and 153.0.3. Both versions exercised a saved synthetic API key,
options reopening with a blank password field, clean process shutdown/restart,
retrieval of the remembered key, authenticated synthetic connection testing,
and plain compose Preview/Apply/Undo. Version153 additionally exercised typed
rich list/paragraph previews, application, and native Undo restoration. The
fixture runs without external network access; these are real Thunderbird and
local compatible-API checks, not live hosted-provider inference qualification.

Remaining before publication: representative hosted and local model generation,
message-view GUI and old-release upgrade qualification, platform coverage and
ATN review/publication. No real provider credentials were used, no marketplace
release was published, and no live legacy automation settings were changed.

### Model discovery follow-up

The revised development XPI SHA-256 is
`748b9d07a1cdb40a0588525328e6681012af61c87ee54271e8bf95db4238b361`.
Discovery now renders a visible model picker, inline loading/progress and safe,
actionable errors. Required keys are checked before permission/network calls;
saved-key reuse still requires the exact provider and endpoint. Explicit model
selection and manual entry remain available without saving first.

All 535 deterministic tests and type checks passed; Astra found no actionable
issues. Two fresh-profile trials on each pinned Thunderbird128/153 version
selected the DeepSeek preset against an authenticated loopback fixture, loaded
models with an empty model field, explicitly chose the visible result, then
saved/tested/restarted and exercised the existing compose/Undo checks. These
trials do not claim generation against the hosted DeepSeek service.

### Single-click model picker

The styled-picker candidate XPI SHA-256 is
`2c5bd6a54e95c6c9a140282e8d57ca107658cc634f860a77d0692ad6e72ace0e`.
The model picker uses a form-styled combobox with keyboard navigation and
explicit selection. Pointer and mouse presses retain focus until option-click
selection completes. Astra reviewed both interaction paths with no actionable
findings. Real WebDriver pointer move/down/up trials on Thunderbird128 and153
(two fresh profiles each) verified one-click opening and one-click selection,
matching computed form-field fonts/colors/borders/radius, and the existing
credential-restart and compose/Undo flows. Chrome/content pointer coordinates
are measured through mouse movement, without an extra activation click.

### Action prompts and original formatting — development 0.2.2

The 0.2.2 candidate XPI SHA-256 is
`3db3cbc0e391f04f206233224c738dec7bb09207f2dab0099b8710d58d166183`.
It uses selected-action prompts with user instructions and writing preferences
kept in JSON data, and carries validated original rich blocks through capture,
target hashing, and inference. See [inference prompts](inference-prompts.md) for
the behavior and evaluation limits. Source-language Auto-detect remains the
received-translation default.

All 553 deterministic tests, type checks, and the extension build passed. Astra
reviewed the prompt and formatting changes with no actionable findings. Two fresh
profiles on each pinned Thunderbird version (128.14.0esr and 153.0.3) passed the
existing settings, synthetic credential persistence, and plain compose checks.
Both version153 profiles additionally passed source-formatting transport and
preservation checks: the compatible-API fixture rejected missing or changed
original bold/italic/underline spans, returned a small edit preserving the marks,
and the real editor verified Preview nonmutation, exact Apply, surrounding node
identity, Undo, and Redo. Existing paragraph/list transformation cases also passed.
These network-isolated fixture trials verify the application path, not hosted or
local model faithfulness or resistance to prompt injection.

### DeepSeek newsletter regression — development 0.2.3

The 0.2.3 candidate XPI SHA-256 is
`11f75706a33605e5543e347f51f67f85cb75aae16c726b0ef406934b139bd350`.
DeepSeek thinking now defaults off and has a saved, provider-specific switch.
Earlier DeepSeek connection-test receipts are invalidated while the scoped key
is preserved. Save changed settings and test the connection before generating.
Response-limit failures have a specific, content-free message; incomplete results
remain rejected without automatic retries or partial application.

A live Flash comparison used 74 text nodes extracted from a privately supplied
HTML newsletter, automatic source detection, and an English target. The earlier
prompt completed with 7,872 generation tokens, including 6,159 reasoning tokens.
The 0.2.2 prompt reached the 8,192-token cap with 8,024 reasoning tokens and failed
before completing the translation. With thinking explicitly disabled, the fixed
client passed three consecutive requests, returning all 74 strings in roughly
1,700 generation tokens each. These requests used decoded HTML text extraction,
not native Thunderbird rendering. No private email or credential was added to
source, public fixtures, logs, or candidate archives.

All 564 deterministic tests and type checks passed; Astra found no actionable
issues. Synthetic regressions cover a 74-segment newsletter, saved thinking
choices and migration, non-DeepSeek isolation, response-limit reporting, and
rejection of partial results. Live translation success on this sample does not
establish general model faithfulness or prompt-injection resistance.

Two fresh-profile native trials passed on each pinned Thunderbird version,
including the default-off control, authenticated fixture requests requiring
thinking disabled, settings reopening, credential restart, and existing editor
checks. The first version153 run lost its virtual display during one profile's
restart; a fresh isolated version153 run passed both trials. Failed and repeated
trial evidence is retained separately. These native trials used synthetic data.

### Response controls — development 0.2.4

The 0.2.4 candidate XPI SHA-256 is
`e9cc8096aa3564e50d906df44e704a34a3d3eadd478765ac62d093164e2c2a7b`.
Response tokens default to 16,384 and are configurable within the application's
1–131,072 range. Provider-specific thinking selectors replace the DeepSeek-only
switch; legacy choices and keys migrate while older test receipts require
retesting. Model-default choices omit reasoning parameters, and individual
models/servers may support only a subset of requested levels. See
[response controls](inference-prompts.md#response-limit-and-thinking).

All 575 deterministic tests, type checks, and the extension build passed. Astra
review found no actionable issues. Two fresh-profile native trials passed on each
pinned Thunderbird version, verifying the 16,384 default, saved/reopened controls,
DeepSeek thinking off, scoped key restart, and existing editor/Undo flows. The
synthetic compatible-API fixture requires both settings in completion requests.

Live DeepSeek Flash checks passed a synthetic translation with Low thinking and
the private newsletter's 74 extracted segments with the new default and thinking
off. A deliberately one-token synthetic request returned a length termination
and the specific increase-limit/reduce-thinking error, without accepting partial
output. The private source and key remain outside repository artifacts. Other
providers' mappings were checked against official documentation and deterministic
fixtures; this does not claim hosted/local-model qualification for every preset.

### GitHub automation retirement — October 24, 2026

Nine OpenClaw/ClawHub admission, qualification, publication, recovery and closeout
workflows, fifty dedicated script/declaration files, and seventeen dedicated test
files are removed from the standalone source. Active project workflows are CI,
DCO, Pages, extension release and ATN submission. Ordinary CI no longer builds or
integrates the plugin; explicit extension qualification retains exact-XPI Linux
and Windows trials. The extension publisher verifies reviewed tag ancestry before
running tagged runtime configuration or dependency scripts.

With the user's authorization, all nine retired workflow IDs were independently
verified disabled on GitHub, and `OPENCLAW_AUTOPILOT_ENABLED` was set to `false`.
Main's ruleset now requires only `Tests, types, and packages` and `Signoffs`; all
other rules were compared and preserved. The release environment admits only
extension tags. ATN admits extension tags and reviewed-main manual dispatches,
with its existing approval rules preserved. No public release, tag, attestation,
state branch, or local Gateway data was removed. Repository workflow/code cleanup
still needs to be merged; live workflow disabling already stops new admissions.

All 484 remaining tests, type checks, build/source packaging, pinned-action and
shell regressions, and actionlint 1.7.12 passed. Astra found no actionable issues,
including in the tag-trust ordering follow-up. The extension XPI remains identical
to the 0.2.4 candidate (`e9cc8096aa3564e50d906df44e704a34a3d3eadd478765ac62d093164e2c2a7b`);
automation-only cleanup does not require another product version. Legacy runtime
source and local development dependencies remain for separate retirement. No
marketplace publication or new tag was exercised as a cleanup test.

# ThunderClaw release operations

Use this runbook to diagnose or recover the plugin release flow. The
[release policy](release.md) defines the requirements; the
[autopilot design](openclaw-autopilot.md) defines admission and durable state;
the [upgrade runbook](openclaw-upgrade-runbook.md) covers manual qualification.
Historical lessons and evidence are in the
[0.1.16 incident record](incidents/2026-10-06-openclaw-plugin-0.1.16.md),
[completed 0.1.18 recovery](incidents/2026-10-11-openclaw-plugin-0.1.18.md), and
[October 11 operations audit](incidents/2026-10-11-release-operations-audit.md).
Run commands from the verified `kwatson/thunderclaw` checkout. Respect the
current user's task and existing authorization; this document grants none.

## Establish the stage before acting

Inspect the exact component tag, source commit, original run and attempt,
qualification results, GitHub release, ClawHub submission result, public version,
and counterpart baseline. Read `state.json` on
`automation/openclaw-autopilot-state`; do not edit or delete that branch by hand.
A failed overall run does not mean every stage failed, and a green upload job
does not by itself prove public completion.

Start with the read-only status command:

```text
mise exec -- node scripts/release-status.mjs
mise exec -- node scripts/release-status.mjs --json
```

It reads `kwatson/thunderclaw` through the authenticated GitHub CLI, discovers
workflow metadata, and reports the active reservation, source, exact
qualification run/attempt/jobs and retained result digest, qualified archive
digest, original release and publisher runs, allowlisted accepted-attempt
fields, baseline PR and current main checks, ruleset requirements, and live
automation settings. Public completion uses the existing archive/provenance
and ClawHub verifiers plus GitHub attestation verification bound to the exact
source tag/commit. Historical unpublished-tag runs are shown separately from
the authenticated current source. Their failure does not invalidate a later
verified publication.

`verified-complete` requires durable completion, authenticated qualification,
public bytes/source/notes/clean scans, merged matching baseline, and green PR
and main checks. Automation settings are reported separately: a finished
release can be verified while its controller is paused. `unknown` means
required evidence is missing, expired, ambiguous, inaccessible, or invalid;
it never establishes public absence or permits a retry. `blocked` respects
blocked/cancelled durable state. Unknown and blocked reports exit nonzero.
The command makes no release mutations and emits neither logs nor backend
error text. Each external operation has a deadline and history pagination is
bounded; exceeding that inspection bound reports unknown.

Retained candidate archives expire after 14 days; qualification `result.json`
currently has 90-day retention. The status command can use public release
bytes after candidate expiration, but it reports unknown if the authenticated
result is unavailable or expired. Preserve required immutable evidence before
its retention ends; durable `complete` is not a substitute. A missing GitHub
release response similarly does not prove an unpublished tag is safe to remove.

| Evidence | Next action |
| --- | --- |
| No candidate yet; state is `observed` | Check immutable upstream identities and observation times. Wait for the one-hour observation window. |
| Prepared or qualifying candidate, no tag | Follow the exact active request and gate results. Hourly reconciliation consumes completed evidence if its callback failed. Avoid duplicate dispatches. |
| Candidate became stale because main advanced | Reconciliation creates a fresh reservation with the same unchanged upstream identity and reruns qualification. This differs from a failed-gate retry. |
| State authorized a tag, but the exact tag ref is absent | Reconciliation creates only the already-authorized annotated identity. Existing refs are verified and never moved. |
| Structured `retryable` or `blocked` qualification | Inspect the failure evidence. Use the documented explicit recovery input where applicable; a new reservation reruns all gates. |
| Cancelled qualification or publisher | Treat cancellation as intentional. Resume only with explicit operator direction; elapsed time is not authorization. |
| Tag exists, GitHub release not yet published | Inspect successful and failed jobs before retrying. Reruns use the tag's old workflow; a fix on main does not modify that workflow. Preserve any existing candidate bytes and check for public attestations. |
| Qualified GitHub release exists; ClawHub has no confirmed submission | Authenticate the original gates, archive, provenance, and attestation. Use reviewed publication recovery with the existing tag and original release run ID. |
| ClawHub accepted an attempt; version is not public yet | Track that attempt and public verification. Do not upload again just because the scan is slow. |
| Exact version is public, source and scans match, download digest matches | Finish baseline closeout. Do not republish to make historical failed runs green. |
| Baseline PR merged but durable state is `closeout-open` | Inspect the completion callback. The controller has a merged-closeout recovery path; re-running it for the exact OpenClaw version can finish the state without building another release. |
| Baseline merged and CI green; durable state `complete` | Verify automation remains enabled, synchronize main, and report completion with evidence links. Remove only confirmed finished candidate branches; preserve the state branch and release tags. |

Public artifacts and attestations make the version immutable. Correcting the
publishing implementation can promote the existing verified archive without a
new product version. Changing the product archive requires a new version.
The narrow unpublished-tag exception in `release.md` requires explicit
maintainer authorization and absence checks; automation never moves tags.

## Recovery entry points

For an unpublished tag workflow rejected at startup or failing qualification before publication, the narrowly scoped
operator tool can audit the unpublished-tag exception:

```text
mise exec -- node scripts/recover-unpublished-openclaw-tag.mjs audit <failed-run-id>
```

Keep automation paused while repairing and reviewing the workflow. Restore
the unshipped compatibility candidate's generated metadata to the last-published
baseline in that repair PR. The audit requires exactly one completed startup
failure with zero jobs, or a completed qualification failure with both publication
paths skipped and successful lane selection and candidate validation. It also requires
the exact active annotated tag, no GitHub release,
no attestation for the qualified digest, no marketplace version, and no publisher
run for the tag. Missing or ambiguous absence evidence blocks recovery.

Only after explicit maintainer authorization under `release.md`, remove that
exact unpublished tag using its audited object SHA as a lease. The tool never
deletes or moves tags. From clean reviewed main, re-enable automation and run:

```text
mise exec -- node scripts/recover-unpublished-openclaw-tag.mjs apply <failed-run-id>
```

Application repeats the external absence checks, requires the tag to be absent,
revalidates the unchanged upstream identity, and appends a compare-and-swap
recovery intent to durable state. Dispatch the controller for the same OpenClaw
version. A fresh reservation regenerates the same unpublished plugin version,
builds new bytes once, and reruns all gates; old candidates cannot be promoted.
This exception cannot recover cancellation, failed publication, ambiguous job evidence,
or a public artifact. Qualification failures require fresh bytes and every gate again.

For an automatic reservation whose qualified GitHub release already exists,
dispatch **Complete existing OpenClaw plugin publication** on reviewed `main`
with `tag` and the original `release_run_id`. It authenticates the original
release, skips uploading an already fully verified ClawHub version, and records
the counterpart closeout. It cannot build or create a GitHub release.

If the publisher frozen into an older tag is defective, rerunning it repeats
that implementation. An authorized manual recovery may dispatch the current
reviewed **Publish OpenClaw plugin to ClawHub** workflow on `main`, with the
existing `tag` and `release_lane=manual`. Its required `clawhub` environment
approval remains in place. Verify that the environment allows this recovery ref;
do not broaden other environments or inject a static token into the automatic
lane. Product source, canonical notes, archive, and attestation still come from
the original release; reviewed transport and public-verification scripts come
from the publisher workflow commit. This does not prove the automatic OIDC lane.

Before dispatching either recovery, inspect active runs and retained submission
results so that an accepted pending submission is not duplicated. Controller recovery dispatches reviewed main finalization, with bounded
infrastructure retries and explicit `retry_publication` for other failed
finalizers. Publisher cancellation and known rejection stop immediately.
Accepted or ambiguous uploads authorize only further public verification;
waiting and verification share a bounded per-run budget. Retained pending evidence
permits hourly read-only reconciliation beyond that budget; terminal integrity
failures and cancellations still require operator intervention. See [unfinished work](roadmap.md)
for remaining live negative-case sandbox validation. Automatic tag-bound OIDC
publication and closeout succeeded for 0.1.18; this does not prove every failure
or the next new-upstream scheduled admission path.

## ClawHub evidence and waiting

- A submission result with an attempt ID and pending status proves acceptance,
  not publication. Inspect its attempt status when authorized access is
  available, and retain only sanitized evidence.
- A shared `openclaw/clawhub` Actions batch is not evidence for our package
  unless its diagnostics identify the exact package, version, or attempt.
- Missing annotations or unavailable live logs do not establish acceptance.
  Distinguish permanent rejection from ambiguous client/network failure.
- Scans can take 30 minutes or longer. Public verification currently allows
  60 minutes, the publisher job 75 minutes, and the finalizer job 90 minutes.
  Timeout does not cancel an accepted ClawHub submission. Public requests have
  individual deadlines; permanent identity or byte mismatches fail immediately.
- Require canonical notes, source repository/tag/commit, clean scan state,
  exact archive size and SHA-256, and the corresponding GitHub attestation.
  The public verifier accepts the exact short tag or full `refs/tags/` form;
  automatic submission must use the full ref matching its OIDC identity.

## Failure patterns and regression coverage

| Symptom | Cause or diagnostic | Prevention |
| --- | --- | --- |
| Trusted-publisher source-ref rejection | Short tag was submitted while OIDC identified `refs/tags/<tag>` | Full ref for automatic submission; executable publisher tests cover accepted, rejected, and ambiguous responses in `test/release-workflow.test.ts`. |
| npm 12 pack output breaks an array parser | OpenClaw's npm shadows managed tooling, or an upstream pack consumer sees a package-keyed object | Use the initiating managed npm for builds; audit all pack callers and normalize npm 11/12 metadata with exact package/version/path checks. The plugin packer still assumes managed npm 11; review it before upgrading that major. |
| Failure reporter rejects missing native matrix jobs | GitHub skipped the matrix before expansion | Accept exactly one terminal skipped literal matrix placeholder, rejecting duplicates, mixed expanded jobs, and nonterminal evidence. |
| Pairing reports `fetch failed` around thirty seconds after restart | Startup readiness window had insufficient margin | Pairing readiness now has a two-minute deadline and five-second HTTP probes. Assertions remain blocking; inspect safe timing/container evidence before retrying. Repeated identical boundaries call for diagnosis rather than another blind rerun. |
| Legacy branch-protection API returns 404 for main | Protection may be configured through repository rulesets | Inspect active rulesets and required checks before concluding main is unprotected. |
| Recovery repeats a repaired defect | Workflow rerun executes immutable old tag code | Use reviewed recovery tooling with the same qualified bytes; never assume main changes update an old run. |
| `not a git repository` or runtime command missing | Jobs do not inherit another job's checkout or runtime setup | Give each job the prerequisites it actually uses; bind `GH_REPO` where repository discovery is unavailable. Workflow regressions cover recovery/result job setup. |
| Environment rejects `refs/pull/.../merge` | A pull-request event supplies a synthetic ref to a main-only environment | The completion callback uses `pull_request_target` on closed events, trusted main checkout, and exact merged-PR/baseline checks. Never execute PR head code with its mutation token. |
| All product trials pass, cleanup fails | Compose still needs the populated environment file | Stop ephemeral services before deleting credentials; an EXIT trap guarantees deletion. Executable cleanup regression is in `test/openclaw-autopilot-workflow.test.ts`. |
| Thunderbird cannot open its display before tests | Host/container X11 display collision | Randomize isolated displays, retain startup evidence, and retry only the classified startup failure once. Never retry failed product assertions as startup failures. |
| Native lock test fails only on a busy runner | Tight wall-clock upper bound measured scheduler delay | Assert the configured SQLite busy timeout directly and retain bounded timing tolerance. Do not increase the product timeout to fix a test. |
| Release tests fail only with automation enabled | Test inherits rollout environment unexpectedly | Exercise enabled automation in CI; tests that require absent settings explicitly clear and restore them. Do not pause production as a test workaround. |
| Candidate result rejected despite passing gates | Branch/request/attempt or machinery fingerprint differs | Bind exact evidence and reservation suffix; repairs before publication require fresh authorization and gates, not relaxed verification. |

## Validate internal changes without a release

Startup diagnostics are JSONL records retained under
`build/qualification-diagnostics/**/diagnostics.jsonl` and uploaded even when
qualification fails. Records allowlist the phase/outcome, elapsed time, probe
count, error category, Node/npm versions, and container running/exit/OOM state.
They exclude URLs, exception messages, Gateway output, environment, credentials,
and mail. Initial Gateway readiness and pairing restart readiness use bounded
probes. Startup failures remain failures; diagnostic collection does not retry
or waive failed product assertions. Use these records before cleanup makes
the isolated container unavailable.

Run ordinary tests and typecheck through `mise exec --`. For workflow changes,
check pinned actions and shell syntax, run executable regression cases, and use
actionlint when available. Use credential-free rehearsal for candidate generation
and classification. That rehearsal does not prove live GitHub event propagation,
environment admission, or ClawHub OIDC publication; those need isolated sandbox
evidence or the next genuine qualified release. Never create a production version
solely to exercise automation.

The credential-free release rehearsal now exercises seven additional synthetic
negative cases through production admission/state logic: lost dispatch response
rediscovery, protected-environment denial, cancelled qualification, dispatch
against changed main, merge tree/revision races, denied/cancelled finalizers,
and repeated closeout. Run it with:

```text
mise exec -- node scripts/rehearse-release-operations.mjs
```

These regressions prove local decision behavior, not GitHub environment
enforcement or cancellation event propagation. Read-only live probes on
`chore/release-operations-hardening` separately confirmed protected environment
denial before any runner step and operator cancellation after the harmless
waiting step started. See the [audit](incidents/2026-10-11-release-operations-audit.md)
for exact runs. Dispatch `validate-release-automation.yml` on a non-main branch
with `sandbox_probe=environment-denial` or `cancellation`; the latter requires
cancelling only the exact authenticated synthetic run. Verify run/job evidence
with `scripts/verify-release-sandbox-probe.mjs`; denial also requires the exact
GitHub protection-rule annotation. These probes cannot create tags or publish
and do not change environment rules. Other live negative paths remain unproved.

## Completion and handoff

Retain the original qualification/release run, successful publisher/finalizer
runs, GitHub release, public ClawHub version verification, and baseline PR.
Report what was actually exercised: manual recovery is not an end-to-end test of
automatic publishing. Require green baseline CI and signoffs as well as durable `complete`; GitHub
merge controls and the shared completion verifier enforce CI, signoffs, and
release-automation validation across every completion entry point. Inspect live settings
rather than assuming this document proves their configuration. Do not claim a
completion notification was sent unless a real notification exists.
Keep sensitive configuration and provider credentials out of logs and documents.

### Automatic tag qualification reuse

Automatic plugin tag promotion verifies the complete recorded pre-tag run and
all eight successful jobs, exact source/tree, reservation/request/attempt, result
digest, reserved machinery, and downloaded plugin and pinned counterpart bytes.
The integration and protected pair jobs retain a sanitized verification receipt
instead of rerunning the same full trials. Authentication failure blocks release.
Manual plugin releases, extension releases, and pre-tag qualification still run
the complete trials. A future genuine release must confirm this new promotion
path live; never create a product version just to exercise it.

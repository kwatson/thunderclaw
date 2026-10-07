# ThunderClaw release operations

Use this runbook to diagnose or recover the plugin release flow. The
[release policy](release.md) defines the requirements; the
[autopilot design](openclaw-autopilot.md) defines admission and durable state;
the [upgrade runbook](openclaw-upgrade-runbook.md) covers manual qualification.
Historical lessons and evidence are in the
[0.1.16 incident record](incidents/2026-10-06-openclaw-plugin-0.1.16.md).
Run commands from the verified `kwatson/thunderclaw` checkout. Respect the
current user's task and existing authorization; this document grants none.

## Establish the stage before acting

Inspect the exact component tag, source commit, original run and attempt,
qualification results, GitHub release, ClawHub submission result, public version,
and counterpart baseline. Read `state.json` on
`automation/openclaw-autopilot-state`; do not edit or delete that branch by hand.
A failed overall run does not mean every stage failed, and a green upload job
does not by itself prove public completion.

| Evidence | Next action |
| --- | --- |
| No candidate yet; state is `observed` | Check immutable upstream identities and observation times. Wait for the six-hour observation window. |
| Prepared or qualifying candidate, no tag | Follow the exact active request and gate results. Avoid duplicate dispatches. |
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
waiting and verification share a bounded budget. See [unfinished work](roadmap.md)
for live sandbox and automatic OIDC validation still required.

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
  Timeout does not cancel an accepted ClawHub submission.
- Require canonical notes, source repository/tag/commit, clean scan state,
  exact archive size and SHA-256, and the corresponding GitHub attestation.
  The public verifier accepts the exact short tag or full `refs/tags/` form;
  automatic submission must use the full ref matching its OIDC identity.

## Failure patterns and regression coverage

| Symptom | Cause or diagnostic | Prevention |
| --- | --- | --- |
| Trusted-publisher source-ref rejection | Short tag was submitted while OIDC identified `refs/tags/<tag>` | Full ref for automatic submission; executable publisher tests cover accepted, rejected, and ambiguous responses in `test/release-workflow.test.ts`. |
| Recovery repeats a repaired defect | Workflow rerun executes immutable old tag code | Use reviewed recovery tooling with the same qualified bytes; never assume main changes update an old run. |
| `not a git repository` or runtime command missing | Jobs do not inherit another job's checkout or runtime setup | Give each job the prerequisites it actually uses; bind `GH_REPO` where repository discovery is unavailable. Workflow regressions cover recovery/result job setup. |
| Environment rejects `refs/pull/.../merge` | A pull-request event supplies a synthetic ref to a main-only environment | The completion callback uses `pull_request_target` on closed events, trusted main checkout, and exact merged-PR/baseline checks. Never execute PR head code with its mutation token. |
| All product trials pass, cleanup fails | Compose still needs the populated environment file | Stop ephemeral services before deleting credentials; an EXIT trap guarantees deletion. Executable cleanup regression is in `test/openclaw-autopilot-workflow.test.ts`. |
| Thunderbird cannot open its display before tests | Host/container X11 display collision | Randomize isolated displays, retain startup evidence, and retry only the classified startup failure once. Never retry failed product assertions as startup failures. |
| Native lock test fails only on a busy runner | Tight wall-clock upper bound measured scheduler delay | Assert the configured SQLite busy timeout directly and retain bounded timing tolerance. Do not increase the product timeout to fix a test. |
| Release tests fail only with automation enabled | Test inherits rollout environment unexpectedly | Exercise enabled automation in CI; tests that require absent settings explicitly clear and restore them. Do not pause production as a test workaround. |
| Candidate result rejected despite passing gates | Branch/request/attempt or machinery fingerprint differs | Bind exact evidence and reservation suffix; repairs before publication require fresh authorization and gates, not relaxed verification. |

## Validate internal changes without a release

Run ordinary tests and typecheck through `mise exec --`. For workflow changes,
check pinned actions and shell syntax, run executable regression cases, and use
actionlint when available. Use credential-free rehearsal for candidate generation
and classification. That rehearsal does not prove live GitHub event propagation,
environment admission, or ClawHub OIDC publication; those need isolated sandbox
evidence or the next genuine qualified release. Never create a production version
solely to exercise automation.

## Completion and handoff

Retain the original qualification/release run, successful publisher/finalizer
runs, GitHub release, public ClawHub version verification, and baseline PR.
Report what was actually exercised: manual recovery is not an end-to-end test of
automatic publishing. Require green baseline CI and signoffs as well as durable `complete`; GitHub
merge controls and completion checks enforce both checks. Inspect live settings
rather than assuming this document proves their configuration. Do not claim a
completion notification was sent unless a real notification exists.
Keep sensitive configuration and provider credentials out of logs and documents.

# Release operations audit: 2026-10-11

Scope: this chat's ThunderClaw work on October 11, 2026 (America/Los_Angeles).
Evidence was checked against merged changes, Actions runs, public verifiers,
durable state, and current repository settings. The original recommendations
are preserved below; the implementation follow-up distinguishes added behavior
from remaining live validation.

## Outcome and confidence

ThunderClaw plugin 0.1.18 is published for OpenClaw 2026.10.1. The extension
remains independently published at 0.1.2. The automatic publisher used the
qualified tag and tokenless OIDC lane, verified public bytes/source/notes/clean
scan, and automatically merged the counterpart baseline. Durable state reached
`complete`, revision 23; final main CI and release-automation validation passed.

The corrected automatic publication path has now worked in production. Initial
recovery required operator dispatch and explicit maintainer approval to replace
an unpublished failed tag. This does not prove a new upstream release will be
admitted solely by the hourly schedule, or all cancellation, race, environment
rejection, and lost-response paths. Those remain separate validation work.

Verified settings: controller workflow active, `OPENCLAW_AUTOPILOT_ENABLED=true`,
main ruleset requires PRs/tests/signoffs/release validation with no bypass actors,
and component tag creation/update/deletion rulesets are active. Automatic mutation
and pre-merge qualification environments allow `main`; automatic ClawHub and
protected tag qualification environments allow `openclaw-plugin-v*`. Manual
publishing environments retain reviewer requirements. Main protection is a
ruleset: a 404 from the legacy branch-protection endpoint is not evidence that
main is unprotected.

## Changes and interventions

| Work | Evidence | Result |
| --- | --- | --- |
| Preserve the user's eight-file observation-window patch during initial repairs, then commit it when requested | Local commit `b437c2a`, subsequently included in [PR 49](https://github.com/kwatson/thunderclaw/pull/49) | Six-hour soak reduced to one hour; docs, workflow descriptions, and state regressions agree |
| Fix nested artifact-test npm selection and skipped native matrix evidence | [PR 45](https://github.com/kwatson/thunderclaw/pull/45), `9c07204` | Use the initiating managed npm; classify exactly one terminal skipped unexpanded matrix without accepting ambiguous/missing platform evidence |
| Normalize npm archive metadata for provider staging and preflight | [PR 47](https://github.com/kwatson/thunderclaw/pull/47), `0bfec08` | Accept npm 11 arrays and npm 12 package-keyed objects; require exact package/version and safe archive filename; retain integrity checks |
| Qualify first compatibility candidate | [PR 48](https://github.com/kwatson/thunderclaw/pull/48), `88a949d` | Pre-tag gates passed, but its tagged release failed restart readiness |
| Repair readiness and prepare audited unpublished recovery | [PR 49](https://github.com/kwatson/thunderclaw/pull/49), `6f6fbea` | Two-minute readiness deadline, five-second HTTP probes, content-free container state on failure; strict qualification-failure recovery with every public-absence check |
| Apply explicitly approved unpublished-tag recovery | [Failed release, attempts 1–3](https://github.com/kwatson/thunderclaw/actions/runs/38158337152) | Repeat absence audit, delete only audited tag object using a lease, restore baseline metadata, create fresh reservation and candidate; never promote the failed authorization |
| Qualify and publish fresh candidate | [PR 50](https://github.com/kwatson/thunderclaw/pull/50), `5146bb5` | All gates passed and the controller merged/tagged automatically |
| Close out published counterpart baseline | [PR 51](https://github.com/kwatson/thunderclaw/pull/51), `050ddf3` | Published plugin digest/size pinned for subsequent extension qualification; automatic closeout complete |

Automation was paused during repairs and restored after review. Superseded
candidate PRs 44 and 46 were closed. Each repair changing trusted machinery
received a fresh reservation. No product runtime code, extension release,
public historical version, transport, or execution security boundary was changed.
Existing ignored local service/state was preserved; local integration used
isolated temporary containers and synthetic configuration.

## Root causes and what worked

1. OpenClaw's transitive npm could shadow the managed npm on lifecycle PATH.
   npm 12 also changed `pack --json` output. These were separate problems:
   selecting the intended build tool does not eliminate the need to normalize
   upstream tooling output at provider/preflight boundaries. Disposable real
   npm 12 reproductions verified both repairs, alongside deterministic tests.
2. GitHub reports a literal skipped matrix placeholder when prerequisite jobs
   fail before expansion. The failure reporter originally rejected that valid
   failure evidence instead of recording the real deterministic failure.
3. Gateway restart readiness allowed only thirty one-second polling attempts.
   Old failures occurred around that boundary; main CI sometimes passed around
   28 seconds. The successful repaired tag run took about 32 seconds for each
   restart/persistence sequence. This supports inadequate startup tolerance;
   original cleanup discarded the logs, so the original internal Gateway cause
   cannot be reconstructed conclusively.
4. A tag freezes workflow and harness code. Fixing main cannot repair a rerun
   at the old tag. Explicit unpublished-tag recovery was therefore necessary
   after repeated failures, with no new product version manufactured.

Final regression suite: 459 tests and typecheck passed. New cases cover npm
output identity/path rejection, matrix ambiguity, startup beyond thirty seconds,
bounded permanent/hung readiness failures, and strict unpublished recovery.
Exact-byte, pinned-counterpart, credential, cross-platform, real Thunderbird,
and protected real-agent gates remained blocking.

## Improvements, in priority order

1. **One read-only release status command.** Collect durable phase/reservation,
   exact source/run/attempt, latest jobs, qualified digest, publication attempt,
   public verification, baseline PR/CI, controller settings, and permitted next
   action. Discover workflows from repository/API metadata; do not guess names.
   Report ruleset protection rather than relying on the legacy endpoint.
   Never print credentials, configuration, mail, or broad container logs.
2. **Retain structured startup evidence.** Record allowlisted phase, elapsed
   startup time, probe count, HTTP/network error category, exit/OOM state, and
   tool versions in a bounded sanitized artifact. Current diagnostics provide
   container state, but cleanup still removes most detailed startup evidence.
   Classify only demonstrated startup/infrastructure failures for bounded retry;
   never retry or waive failed product assertions as startup failures.
3. **Inventory every consumer of changed upstream tooling.** When npm format
   drift appears, audit all pack callers immediately. Keep managed build tooling
   explicit; use one strict metadata adapter for applicable boundaries. The
   actual plugin packer remains intentionally tied to managed npm 11's array
   output; review that assumption before upgrading the managed npm major.
4. **Evaluate duplicate post-tag trials.** Fresh pre-tag qualification took
   about ten minutes and tag publication/closeout about fifteen more. Repeating
   integration and real-agent trials after tagging added time and introduced
   a failure after immutable workflow identity had been selected. Consider
   promoting authenticated pre-tag evidence only after proving exact archive,
   source tree, counterpart, gate, request/attempt, and trusted machinery binding.
   Removing a gate without preserving coverage is not an acceptable shortcut.
5. **Make operator recovery limitations visible.** Current unpublished recovery
   requires exactly one original release run for the tag and exact job names.
   A second failed replacement or renamed job will stop for review. Surface this
   in status output and test any future extension without weakening absence,
   cancellation, identity, or explicit tag-replacement authorization checks.
6. **Finish live negative-case sandbox coverage.** Normal App event propagation,
   tag dispatch/OIDC publication, and closeout succeeded today. Environment
   rejection, merge races, lost external responses, cancellation, and repeated
   closeout still need the targeted live evidence listed in the roadmap.
7. **Keep communication tied to milestones.** State whether the blocker is a
   failed gate, startup, approval, an accepted scan, or closeout. A one-hour soak
   is not a one-hour release promise: discovery runs hourly at minute 17, then
   requires a full hour after first observation plus revalidation, qualification,
   and marketplace processing; GitHub scheduling can also be delayed.

## What would have helped this agent

The repository's stage decision tree, exact-byte verifiers, explicit recovery
policy, and deterministic tests were useful. Missing items were a consolidated
status view, npm consumer inventory, preserved timing diagnostics, and a closed
incident record linked from the runbook.

I should have audited every npm pack consumer at the first format failure,
rather than discovering provider staging only after the first repair. After the
same thirty-second failure repeated, moving directly to the measured readiness
repair would have avoided the third failed release attempt. Looking up workflow
filenames first would also have avoided irrelevant 404s. The completion record
and runbook lessons now make those facts available to the next agent.

## Implementation follow-up

The subsequent maintenance change implements the consolidated read-only
`scripts/release-status.mjs` command with human and `--json` output. It discovers
actual workflow metadata, authenticates the exact qualification attempt and
retained result digest, verifies public GitHub archive/provenance/attestation
and ClawHub bytes/source/notes/scans using existing verifiers, and checks the
baseline PR/main CI and live controller settings. Unknown or ambiguous
evidence fails closed. Unexpected backend names, statuses, refs and errors are
masked; only allowlisted publisher attempt fields are retained in output.
A read-only check against 0.1.18 verified completion and correctly reported the
temporary repair pause separately. This was observation, not another release.

Sanitized JSONL startup diagnostics now retain phases, timings/probe counts,
error categories, runtime versions, and container exit/OOM state across cleanup.
Gateway readiness has a bounded startup harness alongside the existing bounded
pairing restart harness. Diagnostic collection never retries a failed product
assertion, prints raw logs, or relaxes a gate.

The npm inventory confirms distinct responsibilities: managed npm 11 builds
the plugin, while provider staging and upstream preflight normalize npm 11/12
metadata. The actual plugin packager is intentionally unchanged; changing a
packaging input in an internal-only maintenance PR would affect automatic
candidate classification. Review and qualify that assumption as part of a
future managed npm major upgrade.

Seven new local release-control regressions exercise lost dispatch response
rediscovery, environment denial, cancellation, changed-main dispatch, merge
races, denied/cancelled finalizers, and repeated closeout. These use synthetic
records with production verifiers/state transitions. Read-only live
environment-denial and cancellation probes are recorded below. Fresh upstream scheduled admission
also remains unproven by this maintenance work.

Authenticated pre-tag integration and protected-pair reuse is implemented for the
automatic plugin lane, with exact archive/source/counterpart/request/attempt
and trusted machinery proof required. It must not reuse manual plugin or
extension qualification. Regression and maintenance CI evidence for that change belongs
in its maintenance PR rather than retroactively in the 0.1.18 release record.

Candidate artifact retention is 14 days; qualification results currently have
90-day retention. Public archives can replace the expired candidate download
for a completed release, but missing result evidence makes status unknown.
The status command surfaces both original historical runs and the current
authenticated source run. Recovery still requires the runbook's exactly-one
original-run audit, affirmative public absence, and explicit maintainer
authorization; historical completion never authorizes another tag replacement.

## Completion evidence

- [Fresh full qualification](https://github.com/kwatson/thunderclaw/actions/runs/38165044046)
- [Automatic merge/tag controller](https://github.com/kwatson/thunderclaw/actions/runs/38165738916)
- [Successful component release and finalizer](https://github.com/kwatson/thunderclaw/actions/runs/38165832450)
- [Successful automatic tokenless publisher](https://github.com/kwatson/thunderclaw/actions/runs/38166552764)
- [Automatic durable closeout](https://github.com/kwatson/thunderclaw/actions/runs/38166943869)
- [Final main CI](https://github.com/kwatson/thunderclaw/actions/runs/38166944195)
- [GitHub release](https://github.com/kwatson/thunderclaw/releases/tag/openclaw-plugin-v0.1.18)
- [Public ClawHub package](https://clawhub.ai/thunderclaw/plugins/openclaw-plugin)

Qualified/public archive SHA-256:
`7ca9115e25adea035b57e58fe59bb89ea97b9b35f74a739fce047428c3ac35cf`.
Size: 108496 bytes. Published source: `5146bb55d52369f4fbc4dc9b06365bfa47c6c12a`.


## Maintenance validation

[PR #52](https://github.com/kwatson/thunderclaw/pull/52) implements these internal
repairs without changing product versions, archives, or tags. Local verification
passed 483 tests, type checking, pinned actionlint, shell syntax, and the
published-plugin scope comparison (no unreleased product findings).

Read-only GitHub probes used source
`99e11d7a334c3d1c911c4af8d26d41edd5e34892` on
`chore/release-operations-hardening`, both attempt 1:

- [Environment denial](https://github.com/kwatson/thunderclaw/actions/runs/38168492431)
  failed as intended: the exact protected-environment job executed zero steps,
  and GitHub recorded the branch-protection rejection annotation.
- [Cancellation](https://github.com/kwatson/thunderclaw/actions/runs/38168550942)
  was cancelled as intended after its harmless waiting step started.

The evidence verifier binds repository, branch, commit, workflow/event, attempt,
terminal result, exact job, and scenario-specific observations. These probes
created no tags, submitted no versions, referenced no secrets, and changed no
environment rules. Their expected failure/cancellation does not represent a
production release failure. Lost App responses, merge races, and finalizer
interruption are locally tested but still lack live isolated GitHub evidence.
The new qualification-reuse path likewise awaits the next genuine release for
live end-to-end confirmation.

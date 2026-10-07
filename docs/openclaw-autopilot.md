# OpenClaw compatibility autopilot

ThunderClaw automatically prepares, qualifies, and publishes routine OpenClaw
compatibility releases. The automatic lane is intentionally narrow: it may
change compatibility metadata only, and every ThunderClaw qualification gate
must pass. Anything outside that policy stops before publication and enters the
manual release lane.

The controller performs lightweight discovery at minute 17 every hour. The
six-hour window still begins at first observation, and a fresh observation must
confirm unchanged upstream identities before qualification. Polling and soak
are separate controls; GitHub scheduling delays can extend either handoff.
Unchanged/current releases skip dependency installation and qualification.
An explicitly dispatched run may expedite an already observed release after a
fresh unchanged observation. The waiver payload and durable history bind the
first and second observation timestamps and exact immutable identity hash; a
reason alone is never sufficient. That one-release override waives only the remaining
clock time, is recorded as advisory evidence in durable state, and does not
waive identity, compatibility, qualification, publication, or verification
gates. Scheduled runs cannot use the override.

## Upstream admission policy

The controller considers only a stable release from the official
`openclaw/openclaw` repository after a 6-hour soak. At discovery and again
immediately before tagging it records and verifies the exact:

- OpenClaw release tag and commit;
- `openclaw` npm package SHA-512 integrity;
- qualified provider package name, version, and SHA-512 integrity; and
- Linux/AMD64 container digest.

Those identities must be present, internally consistent, and unchanged through
the soak and qualification window. A missing, inconsistent, replaced, or
withdrawn required artifact blocks the automatic lane.

Git tag or commit signature status and upstream CI waivers are retained as
evidence but are not ThunderClaw compatibility gates. ThunderClaw qualifies its
own narrow integration against the exact published packages and image; it does
not certify the whole upstream release. Required SDK entrypoints and every
ThunderClaw test and qualification lane remain blocking and cannot be waived.

## Permitted compatibility change

The generator starts from the current protected `main` tree and produces a
deterministic plugin patch release. The classifier independently regenerates
the expected result and permits only field-level changes for:

- the OpenClaw qualification ledger;
- the root OpenClaw development dependency and its regenerated lock data;
- the plugin version and exact qualified compatibility range;
- one canonical component changelog entry; and
- delimited generated compatibility statements in documentation and the site.

An allowlisted filename is not an allowlisted arbitrary edit. Added package
scripts, lifecycle hooks, dependencies, overrides, exports, symlinks, file-mode
changes, Compose behavior, runtime source, workflows, release tooling,
qualification harnesses, tests, fixtures, or contracts force the manual lane.
The published plugin anchors product inputs; reviewed `main` supplies the
controller and publishing implementation. `scripts/classify-change-scope.mjs`
compares the published plugin tag with the reservation base and rejects
unreleased plugin, compatibility, dependency, and packaging inputs. Reviewed
workflow, publishing, test, qualification-harness, documentation, and counterpart
closeout changes may intervene without a plugin version bump. Extension-only
changes do not invalidate plugin provenance: qualification still uses the
cryptographically pinned published extension, not the extension source on main.
Unknown files conservatively affect both products.

This exemption applies to changes already on reviewed main before a reservation.
The automatic candidate itself remains restricted to independently regenerated
compatibility edits. Runtime or machinery edits inside that candidate still
force the manual lane. The scope policy participates in the reserved verifier
digest; controller, classifier, qualification and publication fingerprints must
remain unchanged throughout an active reservation. An automation repair cannot
reuse an old reservation's authorization with different machinery. The ordered machinery paths are maintained once in
`scripts/release-automation-fingerprint.mjs`, which also fingerprints itself.
Every admission stage uses that definition. The original
one-use foundation rules remain historical migration evidence, not a requirement
to release the plugin after every controller repair.

## State machine and candidate lifecycle

Short workflow invocations advance a durable, compare-and-swap release record:

```text
observed -> ready -> prepared -> qualifying -> qualified -> merged -> tagged
     -> github-published -> clawhub-verified
     -> closeout-open -> complete
```

An independently classified pre-gate binding or infrastructure failure enters
`retryable`; an explicit retry first re-collects the upstream identity and must
match the stored reservation and evidence digest. A cancelled qualification
enters `cancelled`, and a test or qualification-gate failure enters `blocked`.
Cancelled runs remain terminal. A blocked gate requires operator review and an
explicit `retry_blocked_failure` dispatch. This verifies the unchanged upstream
identity, records the failed run and evidence digest, and creates a fresh
reservation on trusted main. Every gate must pass again; no gate is waived.

An unpublished completed qualification can likewise be restarted explicitly
after a controller repair with `restart_completed_qualification`; the controller
authenticates its active request and completed run before replacing the reservation.
Hourly reconciliation also consumes already completed qualification results
through the same authenticated verifier as completion callbacks. Losing a
callback does not require rerunning successful qualification. If main moves
before dispatch admission, only evidence that no product gate started permits
a fresh reservation. A qualified candidate made stale by a main change has a
separate recovery path; it does not masquerade as a failed product gate.
Fresh reservations regenerate the candidate and rerun every qualification gate.

Tag authorization is recorded before the external ref mutation. Reconciliation
creates only that already-authorized annotated tag when the exact ref is absent,
and verifies its immutable identity when present. API errors are not absence,
and existing refs are never moved or replaced.

Waiting for the soak, a qualification result, or closeout is represented as an explicit
pause with its reason instead of being described as active work. The controller
never holds a workflow concurrency lock while waiting for a tag-triggered
workflow.

The record lives on the protected `automation/openclaw-autopilot-state`
branch. Only the narrowly scoped automation App may update it, and every write
uses a compare-and-swap lease against the previously verified commit. Promotion
and completion use the shared `persist-openclaw-release-state.mjs` writer, which
authenticates the parent snapshot, validates the intent, checks the live pause
switch, and preserves idempotent replay and competing-writer leases.

For automatic candidates, qualification builds the plugin archive once and uses
the pinned published extension, including the Linux extension trial. After the
qualified tree is merged, an authorized annotated component tag starts the
release workflow. Its automatic lane downloads that exact qualified archive and
checks its reserved digest instead of rebuilding it. Tagged archive integration,
exact-pair real-agent qualification, secret scan, checksums, provenance, and
GitHub publication continue to verify those bytes. Manual releases build once
from the tag. The tagged integration and pair checks remain deliberate release
gates; this change does not remove product coverage. For the automatic lane it then
uses the narrow App to dispatch the dedicated ClawHub publisher at the exact
protected tag; the dispatched workflow promotes and publicly verifies the same
GitHub release bytes. Neither workflow rebuilds between gates.

Before tagging, a failure produces no release. A failed tag workflow leaves an
unpublished immutable tag for the documented recovery procedure; automation
never moves or deletes it. Once an artifact, attestation, or marketplace record
is public, changed bytes require a new component version. Retrying idempotent
verification or promotion of the same verified bytes does not.

## Trust and credentials

The automatic lane is selected only by an unprivileged verifier that binds the
active durable reservation, trusted controller version, qualified source tree,
workflow run and attempt, required job conclusions, counterpart digest, and
expected tag. A branch name, workflow input, tag message, or candidate-committed
manifest is never sufficient authorization.

Qualification runs on fresh workers with only a dedicated, limited provider
credential and an ephemeral Gateway token. Pull-request code never receives the
GitHub App, GitHub release, or ClawHub authority. Mutation jobs run separately
and execute no candidate-derived scripts. Publication jobs receive only their
stage-specific permissions.

GitHub environments provide reviewer, secret, and ref controls; they do not
restrict access to a workflow identity. Automatic publication therefore also
depends on protected App-only release tags, reviewed workflow paths, the
unprivileged automatic-lane verifier, and exact OIDC claims for repository,
environment, and workflow identity. ClawHub does not model a tag-pattern claim,
so the dispatched publisher independently requires its workflow to run at the
exact qualified protected tag and commit.

Store the App private key only in the `openclaw-autopilot-mutation` environment,
restricted to `main`, and the `autopilot-closeout` environment, restricted to
`main` and plugin release tags. The manual `clawhub` environment also allows
`main` for reviewed recovery and retains its required human reviewer. Automatic
release and ClawHub environments remain restricted to plugin tags. The automatic ClawHub environment must contain no static
publisher token; its trusted publisher accepts only the exact repository,
`publish-clawhub.yml` workflow, and `clawhub-auto` environment claims. The
App installation and automatic publication jobs need Actions read permission.
They re-read the exact `.github/workflows/openclaw-autopilot.yml` controller's
state through the repository workflow API immediately before every state write,
branch or tag write, issue or pull-request mutation, workflow dispatch/rerun,
merge, provenance attestation, GitHub release, ClawHub publish, and closeout
mutation in the automatic lane. Only the exact workflow path and `active` state
permit a mutation. Missing, unreadable, malformed, or disabled workflows fail
closed. Disable the controller in GitHub Actions (or `gh workflow disable
openclaw-autopilot.yml`) to pause running automation at its next mutation
boundary. This does not interrupt an API call already in flight.

`OPENCLAW_AUTOPILOT_ENABLED=true` is also required when an automatic job starts.
Set it to `false` to stop admitting new jobs and skip quiet scheduled discovery;
it is a rollout setting, not the live pause switch for jobs already running.
Before enabling, verify that both the narrow App token and publication job token
can read the exact workflow API endpoint. GitHub's repository-variable API needs
a separate Variables permission that these credentials do not have; do not
expand privileges or treat an unreadable variable as enabled.

## Closeout and notifications

After public ClawHub verification, the controller verifies the GitHub release,
attestation, public source identity, artifact digest and size, and scan state.
It then opens or updates a deterministic one-file counterpart-baseline pull
request. The release is complete only when that change is merged and green.

Qualification and publisher dispatches probe exact request/title, workflow,
ref, and source identity before repeating a mutation. Reviewed-main recovery
uses the existing qualified GitHub archive instead of rerunning frozen tag
machinery. It waits for active recovery, allows at most three automatic recovery
dispatches for timed-out/startup failures, and requires explicit
`retry_publication` for other completed failed or cancelled finalizers. A
cancelled original release needs separate operator recovery. No missing archive
is rebuilt by the finalizer.

A completed failed publisher is classified from its exact run and retained
submission evidence. Cancellation or permanent rejection stops immediately;
accepted or ambiguous submission resumes only public verification, not upload.
Publisher waiting and recovery verification share an 80-minute budget within
its 90-minute job; a late failure gets only the remaining verification budget.
An exhausted budget retains authenticated waiting evidence for hourly read-only
verification, even after the infrastructure retry budget is exhausted. A retained
terminal integrity failure still stops recovery; acceptance does not override it.
Individual public requests and response bodies have deadlines, and permanent
source, notes, digest, or scan failures fail immediately. An exact public version is checked before any publisher dispatch.

All three completion entry points use one shared closeout verifier. Closeout
requires successful CI, signoffs, and release-automation validation in addition
to exact PR/head/tree, a one-file merge, and the exact recorded merged baseline. GitHub required checks enforce merge admission, and
the completion callback is idempotent for the same recorded merge. Workflow
summaries show stage and recovery decisions. Policy failures can create a
deduplicated issue; a separate completion notification service is not implemented.
Public verification, baseline CI, and durable completion are all required before
reporting success. Consult [release operations](release-operations.md) for the
recovery decision tree and [roadmap](roadmap.md) for remaining sandbox validation.

## Credential-free rehearsal

The repository provides a non-mutating rehearsal that creates an isolated
working tree, strips mutation and publication credentials from child processes,
prepares the candidate, independently regenerates and classifies the lockfile,
runs the full deterministic tests and typecheck, packages and validates the
candidate, calculates the real controller/qualification/release fingerprints,
and evaluates pre-tag trust-anchor admission:

```text
mise exec -- npm run rehearse:openclaw-autopilot -- \
  --baseline /path/to/first-observation.json \
  --preflight /path/to/fresh-unchanged-observation.json
```

For a foundation, a blocked automatic classification is retained in the report
for human review rather than converted to automatic success. `--soak-waived
true` changes only this disposable rehearsal and is not release
authorization. The durable controller separately requires two distinct bound
observations before it records a waiver. The rehearsal performs no push,
dispatch, issue, pull-request, tag, release, attestation, or marketplace call.

## Historical foundation release and rollout

The autopilot is enabled in stages: dry-run discovery and classification,
generated pull requests, automatic qualification and merge, nonpublishing tag
rehearsal, GitHub publication, then ClawHub publication and automatic closeout.
Live sandbox evidence must confirm App-triggered events, environment denial,
OIDC claims, merge races, durable-state transitions, collision handling, and
recovery after lost external responses before the corresponding mutation is
enabled.

The `openclaw-autopilot-foundation.json` record permits exactly the human-reviewed
`0.1.11` / OpenClaw `2026.9.6` foundation migration from the published `0.1.10`
anchor. It requires the `foundation` lane, which uses the manual release and
ClawHub environments. After exact publication, a separately reviewed one-file
counterpart closeout must advance the baseline to `0.1.11`; the manifest then
becomes intrinsically unusable because its source-anchor equality no longer
holds. The same manifest pins the exact pre-foundation durable reservation at
revision 16. Only after source and counterpart both prove the exact foundation
target may discovery roll that obsolete record into a new reservation for a
strictly later OpenClaw release; no state-branch edit or deletion is needed.
Subsequent automatic classifications compare against the current published
plugin trust anchor. The autopilot cannot authorize its own foundation.

After a later reviewed plugin release advances the published anchor, retirement
still requires the exact original foundation closeout in that successor tag's
Git ancestry. The current plugin version and qualification must agree with the
published successor, and only the manifest-pinned reservation may be retired.
A later counterpart pin without that historical closeout does not qualify.
Discovery checks out full history to verify this proof without editing or
deleting durable state.

The foundation instructions above are historical migration requirements, not a
reason to pause an already admitted successor or publish tooling repairs. Live
rollout state must be checked in GitHub; historical/manual success does not prove
the corrected automatic publisher end to end.

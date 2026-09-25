# OpenClaw compatibility autopilot

ThunderClaw automatically prepares, qualifies, and publishes routine OpenClaw
compatibility releases. The automatic lane is intentionally narrow: it may
change compatibility metadata only, and every ThunderClaw qualification gate
must pass. Anything outside that policy stops before publication and enters the
manual release lane.

The controller polls at minute 17 every six hours. Together with the two
unchanged observations required by the policy, this preserves the 24-hour soak
while bounding the normal discovery delay after that soak to about six hours.
An explicitly dispatched run may expedite an already observed release after a
fresh unchanged observation. The waiver payload and durable history bind the
first and second observation timestamps and exact immutable identity hash; a
reason alone is never sufficient. That one-release override waives only the remaining
clock time, is recorded as advisory evidence in durable state, and does not
waive identity, compatibility, qualification, publication, or verification
gates. Scheduled runs cannot use the override.

## Upstream admission policy

The controller considers only a stable release from the official
`openclaw/openclaw` repository after a 24-hour soak. At discovery and again
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
The previous published plugin and the reviewed autopilot implementation are the
recurring-release trust anchors. Automation may bridge a published trust anchor
only through deterministic counterpart closeout. Broader controller or policy
changes require the explicit one-use foundation manifest, the exact declared
source and target releases, the normal human-reviewed release environments, and
a reviewed counterpart closeout. A foundation release is never reclassified as
automatic.

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
Neither cancelled nor gate-failure state can use automation recovery. Waiting
for the soak, a qualification result, or closeout is represented as an explicit
pause with its reason instead of being described as active work. The controller
never holds a workflow concurrency lock while waiting for a tag-triggered
workflow.

The record lives on the protected `automation/openclaw-autopilot-state`
branch. Only the narrowly scoped automation App may update it, and every write
uses a compare-and-swap lease against the previously verified commit.

Pre-tag packages are disposable qualification inputs. After the qualified tree
is merged, an authorized annotated component tag starts the release workflow.
That workflow builds the authoritative candidate once and passes those exact
bytes through integration, exact-pair real-agent qualification, secret scan,
checksums, provenance, and GitHub publication. For the automatic lane it then
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
plugin release tags. The automatic ClawHub environment must contain no static
publisher token; its trusted publisher accepts only the exact repository,
`publish-clawhub.yml` workflow, and `clawhub-auto` environment claims. The
App installation and automatic publication jobs must be able to read repository
Actions variables; verify that their token can read the exact repository
variable endpoint before enabling a rollout stage. The
`OPENCLAW_AUTOPILOT_ENABLED` variable is fetched from the live repository
Actions-variable API immediately before every state write, branch or tag write,
issue or pull-request mutation, workflow dispatch/rerun, merge, provenance
attestation, GitHub release, ClawHub publish, and closeout mutation in the
automatic lane. A missing,
unreadable, malformed, or non-`true` value fails closed. The value captured when
a job started is used only to skip quiet scheduled work; it never authorizes a
mutation. Turning the live value off prevents the next boundary rather than
interrupting an API call already in flight.

## Closeout and notifications

After public ClawHub verification, the controller verifies the GitHub release,
attestation, public source identity, artifact digest and size, and scan state.
It then opens or updates a deterministic one-file counterpart-baseline pull
request. The release is complete only when that change is merged and green.

Every external mutation is probed before retrying. Qualification and publisher
dispatches use exact request/title, workflow commit, ref, and source identity;
a lost response is probed before any retry, and cancellation is not silently
redispatched. An exact already-recorded
tag, artifact, marketplace version, or counterpart identity is success; the
same version with different identity is a hard failure. Unchanged transient
failures remain quiet, policy exceptions update one fingerprinted issue, and a
completed release emits one concise notification with its evidence links.

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

## Foundation release and rollout

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
Subsequent automatic classifications compare against the published `0.1.11`
trust anchor. The autopilot cannot authorize its own foundation.

Keep `OPENCLAW_AUTOPILOT_ENABLED=false` while merging and releasing the
foundation. Enable later stages only after the credential-free rehearsal and
the documented sandbox checks succeed.

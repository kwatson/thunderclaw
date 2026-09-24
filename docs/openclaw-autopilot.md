# OpenClaw compatibility autopilot

ThunderClaw automatically prepares, qualifies, and publishes routine OpenClaw
compatibility releases. The automatic lane is intentionally narrow: it may
change compatibility metadata only, and every ThunderClaw qualification gate
must pass. Anything outside that policy stops before publication and enters the
manual release lane.

The controller polls at minute 17 every six hours. Together with the two
unchanged observations required by the policy, this preserves the 24-hour soak
while bounding the normal discovery delay after that soak to about six hours.

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
recurring-release trust anchors.

## State machine and candidate lifecycle

Short workflow invocations advance a durable, compare-and-swap release record:

```text
idle -> reserved -> pr-open -> qualified -> merged -> tagged
     -> candidate-qualified -> github-published -> clawhub-verified
     -> closeout-open -> complete
```

Any pre-publication policy failure may enter `exception`. A later invocation
resumes the recorded version and state before discovering another release. The
controller never holds a workflow concurrency lock while waiting for a
tag-triggered workflow.

The record lives on the protected `automation/openclaw-autopilot-state`
branch. Only the narrowly scoped automation App may update it, and every write
uses a compare-and-swap lease against the previously verified commit.

Pre-tag packages are disposable qualification inputs. After the qualified tree
is merged, an authorized annotated component tag starts the release workflow.
That workflow builds the authoritative candidate once and passes those exact
bytes through integration, exact-pair real-agent qualification, secret scan,
checksums, provenance, GitHub publication, ClawHub publication, and public
verification. It never rebuilds between gates.

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
unprivileged automatic-lane verifier, and exact OIDC or external-broker claims
for repository, environment, tag ref, and workflow identity.

Store the App private key only in the `openclaw-autopilot-mutation` and
`autopilot-closeout` environments, both restricted to protected `main` and the
plugin release tags. The automatic ClawHub environment must contain no static
publisher token; its broker must accept only the exact repository, workflow,
environment, and protected tag claims. The `OPENCLAW_AUTOPILOT_ENABLED`
variable is checked at every mutation boundary; turning it off prevents the
next mutation rather than interrupting an API call already in flight.

## Closeout and notifications

After public ClawHub verification, the controller verifies the GitHub release,
attestation, public source identity, artifact digest and size, and scan state.
It then opens or updates a deterministic one-file counterpart-baseline pull
request. The release is complete only when that change is merged and green.

Every external mutation is probed before retrying. An exact already-recorded
tag, artifact, marketplace version, or counterpart identity is success; the
same version with different identity is a hard failure. Unchanged transient
failures remain quiet, policy exceptions update one fingerprinted issue, and a
completed release emits one concise notification with its evidence links.

## Rollout

The autopilot is enabled in stages: dry-run discovery and classification,
generated pull requests, automatic qualification and merge, nonpublishing tag
rehearsal, GitHub publication, then ClawHub publication and automatic closeout.
Live sandbox evidence must confirm App-triggered events, environment denial,
OIDC claims, merge races, durable-state transitions, collision handling, and
recovery after lost external responses before the corresponding mutation is
enabled.

The first release containing this machinery is a manually reviewed foundation
release. Subsequent automatic classifications compare against that published
trust anchor; the autopilot cannot authorize its own initial installation.

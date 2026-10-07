# OpenClaw upgrade runbook

This is the manual and exception sequence for qualifying and publishing a
ThunderClaw OpenClaw compatibility release. Routine metadata-only releases use
the [`OpenClaw compatibility autopilot`](openclaw-autopilot.md). For a stalled
existing release, first follow [release operations](release-operations.md). The safety and
exact-byte requirements in [`release.md`](release.md) remain authoritative.
These steps never make a newer OpenClaw version compatible merely because its
version or types look similar.

## 1. Collect upstream evidence without changing the repository

Start from a clean `main` checkout with locked dependencies installed. Run the
read-only preflight for the proposed stable version:

```text
mise exec -- npm ci
mkdir -p build
mise exec -- npm run --silent preflight:openclaw-upgrade -- --version YYYY.M.PATCH \
  > build/openclaw-upgrade-preflight.json
```

The report records the npm package and provider integrity, upstream tag and
commit identity and signature status, multi-platform image identity, exact
Linux/AMD64 image digest, required SDK entrypoints, declaration hashes that
changed, and the repository surfaces affected by the bump. It deliberately records
`compatibilityDecision: "not-made"`.

Stop and investigate before editing support metadata if a required artifact is
missing, inconsistent, replaced, or withdrawn; a required export disappeared;
or an SDK declaration changed incompatibly. Unsigned upstream Git identities
and upstream CI waivers are evidence, not automatic blockers. Type
compatibility is necessary but not sufficient: inspect changes to backup,
plugin installation, configuration, Gateway, CLI, agent execution, session,
hook, and state behavior as well.

## 2. Prepare the compatibility change

For an automatic release, the controller starts only after the official stable
release has soaked for 6 hours and the exact upstream identities remain
unchanged. It runs the versioned generator and independently verifies the
resulting field-level diff. Continue manually below only for an exception or a
change outside that policy.

Update the single evidence ledger in `openclaw-qualification.json` first. It
records the API floor, proposed stable version, supported range, next excluded
release floor, immutable Linux/AMD64 container digest, npm integrities, provider
identity, and verified upstream tag commit.

Apply those values to the active package, runtime, CI, test, documentation, and
website surfaces reported by preflight. Update the plugin component version and
add its component-scoped `CHANGELOG.md` entry. Regenerate the lockfile through
the managed runtime; do not edit integrity records by hand.

Run the drift detector before any expensive qualification:

```text
mise exec -- npm install
mise exec -- npm run verify:openclaw-qualification
```

The detector must agree with package metadata, lockfile version and integrity,
container and provider pins, compatibility range, CI label, runtime assertions,
and current user-facing support statements. Historical changelog entries are
intentionally outside this check.

## 3. Qualify locally

Build a disposable pre-tag test archive, then exercise the pinned fresh-state
integration:

```text
mise exec -- npm test
mise exec -- npm run typecheck
mise exec -- npm run pack:plugin
THUNDERCLAW_OPENCLAW_PLUGIN_TGZ=/absolute/path/to/candidate.tgz \
  mise exec -- npm run test:integration:openclaw
```

This includes pairing issuance, approval and claim, authentication, rotation,
revocation, restart persistence, secret scanning, and supported OpenClaw
backup/restore. The provider package is downloaded to a local archive, checked
against the ledger's exact SHA-512 integrity, and installed from those verified
bytes while registry access is forced offline. Recovery accepts a database
alone, database plus WAL, or
database plus WAL and SHM; it rejects incomplete, duplicate, unsafe, linked, or
non-private SQLite file sets.

This manually built local archive has no release provenance. The manual
component-tag workflow builds the authoritative candidate once and passes those
exact bytes through every release gate. The automatic lane instead retains and
reuses its authenticated pre-tag qualified archive; it does not promote an
arbitrary local build.

For an autopilot candidate or foundation migration, also run the isolated,
credential-free cross-stage rehearsal with the original and fresh observations:

```text
mise exec -- npm run rehearse:openclaw-autopilot -- \
  --baseline build/openclaw-upgrade-first-observation.json \
  --preflight build/openclaw-upgrade-preflight.json
```

The report must name the expected OpenClaw/plugin pair, report
`externalMutations: 0`, record independent automatic classification, and
identify release admission before any merge or tag. A foundation rehearsal may
show a blocked automatic classification; its findings are part of the required
human review and must not be suppressed. Do not supply GitHub App, GitHub write,
provider, Gateway, or marketplace credentials. A rehearsal-only
`--soak-waived true` is not durable authorization.

If an upstream behavior change requires a material plugin runtime change, stop
the compatibility-only release and review that change independently. If the
new OpenClaw version requires a new Thunderbird extension, stop and plan the
two independently versioned releases and their exact counterpart order.

## 4. Run pre-release CI

Push the reviewed compatibility commit to `main`. Manually dispatch **CI** on
that exact commit with **Run expensive pre-release qualification** enabled.
Wait for every ordinary, pinned OpenClaw, Linux/Windows real-Thunderbird, and
native Windows/macOS gate to finish successfully. A normal push does not run
all expensive lanes.

Do not tag a commit that failed this run. Correct it on `main`, repeat local
checks as appropriate, and dispatch a new pre-release run.

### One-time 0.1.11 foundation migration

The automation changes after `openclaw-plugin-v0.1.10` are intentionally too
broad for recurring automatic admission. Keep the repository rollout variable
`OPENCLAW_AUTOPILOT_ENABLED=false`. Review the strict
`openclaw-autopilot-foundation.json` source anchor and exact `0.1.11` /
OpenClaw `2026.9.6` target, the full candidate diff, the rehearsal report, and
the complete pre-release CI run. The tag workflow must classify the tag as
`foundation`, never `automatic`; both publication environments require the
normal human approvals.

Before any later sandbox enablement, confirm that the narrowly installed
autopilot App and the automatic publication jobs can read the live controller
workflow endpoint with their existing Actions read permission. Only its exact
path and `active` state authorize a mutation. Disable the controller workflow
in GitHub Actions to pause already running jobs before their next mutation;
setting the rollout variable to `false` stops new jobs. Verify this permission
check before enabling discovery.

After publication and public verification, use the manual command in section 6
to open a one-file counterpart-baseline change for `0.1.11`. Merge that closeout
and verify CI before considering any automatic release. Because the committed
baseline then no longer equals the manifest's `0.1.10` source anchor, the
foundation authorization cannot be replayed for another release. Do not edit
or delete the existing revision-16 durable state. At the first strictly later
OpenClaw discovery, the controller may roll it over only after independently
verifying its manifest-pinned identity and the completed `0.1.11` source and
counterpart closeout.

## 5. Tag and promote the exact candidate

Create and push the annotated component tag only after the pre-release run is
green:

```text
git tag -a openclaw-plugin-vX.Y.Z -m "ThunderClaw OpenClaw plugin X.Y.Z"
git push origin openclaw-plugin-vX.Y.Z
```

The release workflow pauses at three protected environments in sequence:

1. `release-qualification` permits exact-artifact real-agent qualification.
2. `release` permits provenance attestation and GitHub release creation.
3. `clawhub` permits publication and public catalog verification.

Review the completed jobs and candidate identity before approving each gate.
An approval authorizes only the pending job and does not waive a failed check.
Do not rebuild, replace, or locally republish the candidate. Once any public
artifact, attestation, or marketplace record exists, corrections require a new
component version.

## 6. Verify publication and advance the counterpart pin

Require the workflow to verify the public ClawHub record against the GitHub
release's name, version, source tag and commit, scan state, and artifact digest.
Then update the counterpart ledger from the published GitHub release:

```text
mise exec -- npm run update:counterpart -- \
  --tag openclaw-plugin-vX.Y.Z \
  --repository kwatson/thunderclaw
```

The updater resolves the tag to its commit, downloads the complete release,
requires the exact asset set, verifies checksums and provenance, derives the
artifact name, size, and SHA-256 from the downloaded bytes, and refuses a
same-version or backward baseline change. Review and commit only the resulting
`counterpart-baselines.json` change.

Finally run the ordinary checks, push the baseline commit, and wait for its CI
run to pass. Confirm that `main` is synchronized and clean. Retain links to the
pre-release run, release run, GitHub release, and ClawHub record in the release
handoff.

For an automatic-lane failure, inspect its structured durable disposition.
Only `retryable` pre-gate evidence may use the explicit
`retry_pre_gate_failure` dispatch option, which collects a fresh upstream
identity before creating a new reservation. `blocked` gate failures and
`cancelled` runs require operator review. After repairing a blocked failure,
dispatch the controller with the exact version and `retry_blocked_failure=true`
to rerun every gate under a new reservation. Close the superseded candidate PR.
Cancelled runs remain terminal. Do not edit the state branch or convert reason
text into recovery proof.

If qualification completed but a controller repair requires a fresh candidate,
use `restart_completed_qualification=true` for the exact active version. The
controller authenticates the unique completed run for the active request before
starting a fresh reservation on trusted main. Running and cancelled runs cannot
use this option, and every gate must run again before publication.

After the protected-tag release has passed every qualification gate and created
its GitHub release, publication repairs do not require another candidate, build,
tag, or version. Run **Complete existing OpenClaw plugin publication** on `main`
with the existing `tag` and original `release_run_id`. This is the same finalizer
used by new automatic releases. It authenticates the original protected-tag run
and its successful gates, checks the published archive against the active
reservation and provenance, and verifies the original GitHub attestation before
resuming the exact-tag ClawHub publisher and counterpart closeout. A cancelled
publisher still requires an explicit operator retry. The resume workflow cannot
build artifacts or create a GitHub release.

ClawHub checks can take more than 30 minutes. Public verification waits up to
60 minutes; the publisher job allows 75 minutes and the finalizer allows
90 minutes for submission and runner delays. The submission result is retained
before waiting, so an operator can inspect its attempt ID during a slow scan.
A verification timeout does not cancel ClawHub's pending submission and does
not justify a new product tag or release.

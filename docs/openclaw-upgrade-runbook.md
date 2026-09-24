# OpenClaw upgrade runbook

This is the manual and exception sequence for qualifying and publishing a
ThunderClaw OpenClaw compatibility release. Routine metadata-only releases use
the [`OpenClaw compatibility autopilot`](openclaw-autopilot.md). The safety and
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
release has soaked for 24 hours and the exact upstream identities remain
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

This local archive is not the immutable release candidate and has no release
provenance. The component-tag workflow builds the authoritative candidate once
from the tagged commit and passes those exact bytes through every release gate.

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

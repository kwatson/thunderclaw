# ThunderClaw release policy

## Published release

ThunderClaw `v0.1.1` is available from the
[GitHub release](https://github.com/kwatson/thunderclaw/releases/tag/v0.1.1).
The preceding `v0.1.0` release remains available from
[ClawHub](https://clawhub.ai/thunderclaw/plugins/openclaw-plugin), and
[Thunderbird Add-ons](https://addons.thunderbird.net/en-US/thunderbird/addon/thunderclaw/).
The GitHub release contains the qualified plugin archive, XPI, Mozilla reviewer
source archive, checksums, and provenance. Marketplace installations use the
corresponding published channel artifacts.

## Release artifacts

A ThunderClaw release produces:

1. one npm-style OpenClaw plugin `.tgz` for ClawHub;
2. one Thunderbird `.xpi` for Thunderbird Add-ons; and
3. one allowlisted source archive for Mozilla extension review.

The plugin and extension carry the same release version. Their package
manifests, extension manifest, release tag, and release notes must agree before
publication.

The installable artifacts must be built once from the release commit, hashed,
qualified as those exact bytes, and promoted without rebuilding. The source
archive is generated from an explicit allowlist and includes the committed
source, lockfile, build configuration, and reproducible instructions Mozilla
reviewers need to inspect generated extension code. It excludes dependencies,
build output, local state, credentials, and qualification evidence.

Create all three deliverables from a clean release checkout with:

```text
mise exec -- npm ci
mise exec -- npm run pack:release
```

The reviewer archive stages [`SOURCE_REVIEW.md`](../SOURCE_REVIEW.md) as its
root `README.md` build guide.

## GitHub release workflow

Repository administrators must create a GitHub Actions environment named
`release`, add the required human reviewers, and restrict deployment to
release tags. The current repository environment requires approval from
`kwatson`, permits that sole release maintainer to approve a run they started,
and accepts only `v*` tags. The workflow grants write permissions only to the
job behind that environment. All build and qualification jobs remain
read-only.

Prepare a release on `main` after updating all four manifest version
declarations, their four `package-lock.json` mirrors, and the matching
`CHANGELOG.md` section. The following commands locally validate the metadata,
create an annotated tag, and push only that tag (replace `v0.1.0` with the
intended version):

```bash
git switch main
git pull --ff-only origin main
release_tag=v0.1.0
release_notes=$(mktemp)
rm "$release_notes"
mise exec -- node scripts/release-metadata.mjs \
  --tag "$release_tag" \
  --notes-output "$release_notes"
rm "$release_notes"
git tag --annotate "$release_tag" --message "ThunderClaw ${release_tag#v}"
git push origin "$release_tag"
```

A maintainer with tag signing configured may use `git tag --sign` instead.

The tag workflow deliberately triggers broadly on `v*`, then fails unless the
tag is canonical `vX.Y.Z`, its commit is contained in `origin/main`, matches the
root package, both component packages, and Thunderbird manifest, and has
exactly one non-empty changelog section. Do not move or reuse a published tag.

The workflow builds the three artifacts once, scans their unpacked contents
with a version-and-digest-pinned secret scanner, records SHA-256 checksums and
build provenance, qualifies the downloaded plugin and XPI bytes on Linux and
Windows without rebuilding them, and runs the native filesystem/security gate
on Apple Silicon macOS. It also rebuilds the XPI from the downloaded reviewer
source archive and compares its complete unpacked entry set and contents with
the candidate. After those gates and `release` environment approval, it creates
a GitHub release whose notes are the matching changelog section and attaches:

- `thunderclaw-openclaw-plugin-X.Y.Z.tgz`;
- `thunderclaw-thunderbird-X.Y.Z.xpi`;
- `thunderclaw-thunderbird-source-X.Y.Z.zip`;
- `SHA256SUMS`; and
- `release-provenance.json`.

GitHub also records attestations for the three distributable archives. The
workflow then calls the protected marketplace workflow. Its ClawHub job
publishes the exact qualified plugin archive and waits for definitive catalog
visibility. Its Thunderbird Add-ons job submits the exact qualified XPI and
waits for ATN validation. Neither job rebuilds a release artifact.

ATN's supported API does not provide reviewer-source or reviewer-note upload.
After its protected job succeeds, a maintainer must attach the matching source
archive and reviewer instructions in the ATN Developer Hub before expecting
review or public availability. The workflow reports this required handoff
instead of incorrectly claiming that the add-on is published.

No operating-system package or helper is part of the release graph.

## Release acceptance

ThunderClaw uses a risk-based release standard appropriate to a small project.
The protected tag workflow is the blocking technical gate. A release may be
approved when all of its jobs pass and the maintainer has reviewed the
candidate metadata, checksums, provenance, and known limitations.

Active day-to-day use on Windows and macOS supplies practical desktop smoke
evidence in addition to the hosted native and real-Thunderbird lanes. While a
release workflow waits for approval, the maintainer may optionally install its
exact candidate XPI on either active Thunderbird installation and repeat
Generate, Preview, Apply, and Undo. This is a useful final confidence check,
not a second exhaustive blocking matrix.

An upgrade from a preceding public ThunderClaw release is not applicable to
`v0.1.0`. Its accepted XPI becomes the immutable baseline for upgrade testing
on the next release.

### Blocking automated checks

- Clean dependency install, tests, typecheck, and extension build pass.
- XPI and plugin package contain only expected runtime files and no source maps,
  development credentials, untracked runtime dependencies, or dynamic-code
  surprises.
- The Mozilla source archive is allowlisted, secret-scanned, and can reproduce
  the reviewed extension build using its documented commands.
- Artifact hashes and build provenance are recorded.
- The exact artifacts—not a source-adjacent rebuild—pass qualification.
- Pinned Thunderbird 153 deterministic E2E passes; run the opt-in Thunderbird
  128 compatibility lane when a change touches the 128-specific boundary.
- Native Windows, macOS, and Linux profile/filesystem behavior passes, including
  Windows ACL/reparse-point and macOS POSIX mode/link checks.
- The exact supported OpenClaw version and commit are recorded.
- Plugin install/update/recovery, discovery, activation, CLI, full status,
  fixed routes, and paired authentication pass.
- Gateway state/log and artifact scans find no synthetic email/result or raw
  credential canaries outside explicitly permitted evidence.
- Request, approval, Claim, replay rejection, expiry, rate limits, wrong-code,
  rotation, concurrent races, revocation, and restart persistence pass.
- Corrupt/hostile filesystem, migration, backup-before-migrate, backup/restore,
  and failure recovery pass on supported platforms.
- Ambiguous mutation outcomes never report false success or trigger unsafe
  automatic retry.

### Documentation and privacy

- Installation, pairing, compatibility, recovery, and the full Thunderbird
  Add-ons privacy policy match the exact artifacts. The policy effective date
  and monitored privacy contact are filled, its full text is entered directly
  in the listing's privacy-policy field, and its listing-ready summary appears
  in the add-on description.
- Marketplace, README, and website screenshots reflect the accepted XPI and
  use synthetic mail and connection data. They expose no real endpoint,
  approval code, device identifier, account detail, or message content.
- Users are told that relevant email and selected OpenClaw agent context go to
  the configured provider and that installed Gateway hooks are trusted code.
- Local profile credential custody and residual compromise risk are disclosed.
- No internal endpoint, token, populated configuration, or sensitive evidence
  is included in public artifacts or documentation.

### Post-release hardening

Broader same-profile upgrade, restart, permission, credential-lifecycle,
Disconnect/Forget, compose/message, remote HTTPS failure, and shell/Docker/SSH
CLI matrices improve repeatability and regression detection. They are tracked
in [`roadmap.md`](roadmap.md); they were not blockers for `v0.1.0` and remain
post-release hardening work. This scope choice does not weaken product
fail-closed behavior or permit a failed blocking workflow job to be waived.

## CI design for the public repository

The public repository should implement these layers:

- `ci`: secretless unit tests, typecheck, deterministic builds, artifact
  inspection, and documentation checks on pull requests and main;
- `openclaw-compat`: pinned version on main and release candidates, plus
  scheduled/manual surveillance of newer OpenClaw releases;
- `real-agent-qualification`: protected manual/release-candidate environment;
- `release-qualification`: build-once artifact promotion and all blocking
  Linux/container gates;
- GitHub-hosted Windows and macOS native qualification first, with a controlled
  ephemeral self-hosted runner only where hosted infrastructure demonstrably
  cannot reproduce required Thunderbird/OpenClaw/profile behavior; and
- published-artifact smoke tests after marketplace publication.

Prefer hosted Linux for secretless and container-faithful work. Use self-hosted
workers only for behavior that cannot be faithfully covered on hosted runners.
Windows and macOS assurance must be described honestly: hosted checks provide
bounded repeatable evidence, while active use provides practical smoke
evidence. Neither is described as an exhaustive desktop lifecycle matrix.
Unsupported platforms should not become accidental permanent release blockers;
platform support is an explicit product decision.

## Publication

The protected marketplace workflow can be invoked by a qualified tag workflow
or manually for an existing GitHub release. Manual dispatch supports retrying
one channel without rebuilding or resubmitting the other. It downloads the
GitHub release assets, verifies their recorded hashes and provenance, checks
the packaged versions, and stages those same bytes for both channel jobs.

Create protected GitHub environments named `clawhub` and
`thunderbird-addons`, require a maintainer approval on each, and restrict them
to release tags and the default branch. Configure:

- `CLAWHUB_TOKEN` in the `clawhub` environment for automatic tag-triggered
  publishing and for promotion of a historical release whose tag predates the
  marketplace workflow. A manual `workflow_dispatch` from a release tag that
  already contains this workflow may instead use ClawHub OIDC after
  `@thunderclaw/openclaw-plugin` trusts repository `kwatson/thunderclaw`,
  workflow `marketplace-publish.yml`, and environment `clawhub`. OIDC binds
  source provenance to the dispatch ref and SHA, so a dispatch from `main`
  must not relabel an older release artifact as coming from the current commit.
- `ATN_JWT_ISSUER` and `ATN_JWT_SECRET` in the `thunderbird-addons`
  environment, using credentials created by the ATN publisher account.

The OpenClaw plugin is packed as an npm-style archive and that exact `.tgz` is
submitted to ClawHub. The exact qualified `.xpi` is submitted to Thunderbird
Add-ons; its matching reviewer source archive remains the explicit ATN handoff
described below.

### Thunderbird Add-ons submission

CI uses ATN's authenticated v4 signing/submission endpoint to upload the
listed XPI and poll validation. It cannot attach source code or private
reviewer notes because ATN exposes those fields only through its
session-authenticated Developer Hub. After CI succeeds, open the submitted
version and attach the exact `thunderclaw-thunderbird-source-X.Y.Z.zip` from
the same GitHub release, then add the reviewer instructions. Do not upload a
locally rebuilt archive.

The listing and each submitted version must:

- upload the exact qualified XPI and attach its matching reviewer source
  archive; the source archive is required because the XPI contains generated
  bundles, and it must accompany every submitted version;
- paste the full text of [`privacy-policy.md`](privacy-policy.md) directly into
  the listing privacy-policy field and include its marked listing summary in
  the public description;
- use the dedicated screenshot fields for the approved synthetic screenshots,
  and keep homepage and support URLs in their dedicated fields rather than the
  description;
- list the compose and displayed-message entry points, the separately
  installed OpenClaw requirement, and the manual Generate/Preview/Apply/Undo
  control model; and
- provide private reviewer testing instructions for installing the matching
  OpenClaw plugin, configuring a compatible agent/provider, pairing, and
  exercising compose and message actions. Explain that remote endpoints require
  HTTPS and that unencrypted HTTP is accepted only for canonical `127.0.0.1`
  or `[::1]` endpoints on the same computer, after explicit permission and
  pairing with a scoped credential. This documents the narrow loopback design
  for review without claiming a policy exception that ATN has not published.

If reviewers need credentials, provide only dedicated temporary test
credentials through ATN's private reviewer field. Never place credentials,
endpoint secrets, or real mail in public listing text. After signing and
approval, download the ATN-signed XPI and smoke-test that distributed file.

### ClawHub publication

ClawHub requires a publisher owner matching the npm package scope. Before
publication, confirm that the publishing account controls the `thunderclaw`
owner for `@thunderclaw/openclaw-plugin`. The protected job validates the
candidate with a commit-pinned ClawHub CLI and publishes the exact GitHub
release `.tgz` with explicit source attribution. OIDC trusted publication
inherits the existing package owner from its trusted-publisher configuration
and must not pass `--owner`; token-authenticated manual publication selects the
`thunderclaw` owner explicitly. A manual local dry run remains useful when
changing publication metadata:

```bash
release_tag=vX.Y.Z
release_version=${release_tag#v}
release_commit=$(git rev-list --max-count=1 "$release_tag")
plugin_archive=thunderclaw-openclaw-plugin-${release_version}.tgz
validation_root=$(mktemp -d)
tar -xzf "$plugin_archive" -C "$validation_root"
clawhub package validate "$validation_root/package"
clawhub package publish "$plugin_archive" \
  --family code-plugin \
  --owner thunderclaw \
  --source-repo https://github.com/kwatson/thunderclaw \
  --source-ref "$release_tag" \
  --source-commit "$release_commit" \
  --dry-run
```

Review the resolved name, version, file count, source tag, and commit. Repeat
the same command without `--dry-run` to perform the authorized publication;
do not allow the CLI to repack a source folder in place of the qualified
archive. A new release may remain out of normal install surfaces until ClawHub
finishes its automated security checks and verification. Once visible, install
it through its public catalog identifier and verify the reported version and
scan status.

Channel requirements are maintained by
[ClawHub package publishing](https://docs.openclaw.ai/clawhub/publishing),
[Thunderbird Add-ons](https://addons.thunderbird.net/), and
[Mozilla's source-code submission policy](https://extensionworkshop.com/documentation/publish/source-code-submission/).
Re-check them for each release; repository policy may be stricter but must not
contradict the current channel requirements.

Publication uses protected environments, least-privilege credentials or OIDC
trusted publishing where supported, immutable artifact promotion, approval
gates, and post-publication verification.

Publishing jobs must never rebuild release bytes. A held or failed marketplace
publication cannot be bypassed by publishing different artifacts under the
same version. Release notes describe user-visible changes and known limits;
raw test transcripts and sensitive evidence remain in protected retention.

## Upstream surveillance

Scheduled compatibility work may detect a new Thunderbird or OpenClaw release,
but it never updates support automatically. It opens or updates a qualification
task with discovered versions and evidence. A human-reviewed change updates
pins, reruns the full required matrix, and only then changes
[`compatibility.md`](compatibility.md).

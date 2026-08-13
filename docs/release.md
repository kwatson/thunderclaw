# ThunderClaw release policy

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

GitHub also records attestations for the three distributable archives. A
GitHub release does not publish to ClawHub or Thunderbird Add-ons. Their first
submissions remain manual bootstrap operations using these exact qualified
bytes; later marketplace automation remains future work.

No operating-system package or helper is part of the release graph.

## Blocking acceptance matrix

### Source and artifact

- Clean dependency install, tests, typecheck, and extension build pass.
- XPI and plugin package contain only expected runtime files and no source maps,
  development credentials, untracked runtime dependencies, or dynamic-code
  surprises.
- The Mozilla source archive is allowlisted, secret-scanned, and can reproduce
  the reviewed extension build using its documented commands.
- Artifact hashes and build provenance are recorded.
- The exact artifacts—not a source-adjacent rebuild—pass qualification.

### Thunderbird

- Pinned Thunderbird 153 deterministic E2E passes; run the opt-in Thunderbird
  128 compatibility lane when a change touches the 128-specific boundary.
- Upgrade from the preceding accepted extension passes in one retained profile.
- Compose text, supported rich behavior, message summary/translation,
  stale-result, permission, cancellation, Apply/Undo/Redo, Draft, and SMTP/MIME
  matrices pass.
- Native Windows, macOS, and Linux profile/filesystem behavior passes, including
  Windows ACL/reparse-point and macOS POSIX mode/link checks.
- Windows and macOS optional host permission, restart, upgrade, rotation,
  revocation, Disconnect, Forget, compose, and message behavior pass.
- The supported remote HTTPS endpoint passes normal and certificate-failure
  paths without weakened trust.

### OpenClaw and plugin

- The exact supported OpenClaw version and commit are recorded.
- Public SDK requirements and package exports are inspected.
- Plugin install/update/recovery, discovery, activation, CLI, full status,
  fixed routes, and paired authentication pass.
- Synthetic compatibility and exact-artifact real-agent matrices pass.
- Session isolation, repair, fallback, cancellation, concurrency, expiry,
  configuration invalidation, and hook audits pass.
- Gateway state/log and artifact scans find no synthetic email/result or raw
  credential canaries outside explicitly permitted evidence.

### Pairing and recovery

- Request, approval, Claim, replay rejection, expiry, rate limits, wrong-code,
  rotation, concurrent races, revocation, and restart persistence pass.
- Guided and headless CLI paths—including `--code-stdin`—pass in direct shell,
  Docker TTY/non-TTY, and supported SSH use.
- Corrupt/hostile filesystem, migration, backup-before-migrate, backup/restore,
  and failure recovery pass on supported platforms.
- Ambiguous mutation outcomes never report false success or trigger unsafe
  automatic retry.

### Documentation and privacy

- Installation, pairing, compatibility, privacy disclosure, and recovery docs
  match the exact artifacts.
- Users are told that relevant email and selected OpenClaw agent context go to
  the configured provider and that installed Gateway hooks are trusted code.
- Local profile credential custody and residual compromise risk are disclosed.
- No internal endpoint, token, populated configuration, or sensitive evidence
  is included in public artifacts or documentation.

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
Windows and macOS assurance must be described honestly rather than implied by
Linux success or manual use. A bounded native-filesystem pass is not a full
Thunderbird lifecycle pass. Unsupported platforms should not become accidental
permanent release blockers; platform support is an explicit product decision.

## Publication

Thunderbird Add-ons and ClawHub require an initial human/bootstrap publication.
The OpenClaw plugin is packed as an npm-style archive and that exact `.tgz` is
submitted to ClawHub. The exact qualified `.xpi`, plus the matching reviewer
source archive when requested, is submitted to Thunderbird Add-ons.

Channel requirements are maintained by
[ClawHub package publishing](https://docs.openclaw.ai/clawhub/publishing),
[Thunderbird Add-ons](https://addons.thunderbird.net/), and
[Mozilla's source-code submission policy](https://extensionworkshop.com/documentation/publish/source-code-submission/).
Re-check them for each release; repository policy may be stricter but must not
contradict the current channel requirements.

Subsequent updates should use protected environments, least-privilege
credentials or OIDC trusted publishing where supported, immutable artifact
promotion, approval gates, and post-publication verification.

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

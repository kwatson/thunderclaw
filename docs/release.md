# ThunderClaw release policy

ThunderClaw ships a standalone Thunderbird extension. Only the extension XPI and
matching reviewer source are published. Historical releases, tags, and attestations
remain intact. Retired backend source and tooling are available in Git history.

## Product and internal changes

Shipped extension behavior or installed metadata requires an extension version and
component-scoped changelog entry. Internal workflow, documentation, test-harness,
and publishing-tool changes do not require a product version bump, tag, or release.
Validate them with ordinary CI and executable workflow regressions. Never create a
production version merely to test automation.

Ordinary pull-request and main CI runs deterministic tests, type checks, and
extension packaging when relevant inputs change. Documentation-only changes still
report the required CI context. Unknown paths conservatively qualify the extension.
Expensive Linux and Windows Thunderbird qualification is explicitly requested
through CI's `release_qualification` dispatch input and runs for tagged releases.
Standalone CI and release jobs require no companion backend or paired artifact.

## Active workflows

| Workflow | Purpose |
| --- | --- |
| `ci.yml` | Ordinary checks and explicit pre-release Thunderbird qualification |
| `dco.yml` | Contributor sign-offs |
| `pages.yml` | Product website deployment |
| `release.yml` | Exact-byte extension qualification and protected GitHub release |
| `publish-thunderbird-addons.yml` | Protected ATN submission and public verification |

The required main checks are **Tests, types, and packages** and **Signoffs**.
Workflow regressions run in ordinary CI.
Changes to external GitHub settings require authorization from the current task.
Keep main pull-request admission, release approvals, restricted credentials, and
immutable historical tag protections. The `release` environment admits extension
tags only. `thunderbird-addons` admits those tags and reviewed `main` dispatches
for exact-existing-release recovery and metadata verification; its approval
requirement remains in place.

## Version and tag authority

The extension manifest and workspace package own the version. The root package is
development orchestration metadata. Release notes come from exactly one nonempty
matching `Thunderbird extension [X.Y.Z]` section in the root changelog.

Only canonical `thunderbird-extension-vX.Y.Z` tags can enter the publication
pipeline. The tag must resolve to a reviewed commit contained in main. Other
tag formats, branches, and channel mismatches cannot dispatch a new publication.

Once a version has a public artifact, GitHub release, or attestation, its tag,
source identity and qualified bytes are immutable. A correction to published
product code requires a new product version. A transport repair does not permit
rebuilding, relabeling, or replacing an existing qualified release.

## Build once and qualify exact bytes

From the tagged source, the build job runs tests and type checks, builds one XPI,
and creates one allowlisted reviewer source ZIP. It records SHA-256 checksums,
artifact sizes, canonical notes, source identity, and provenance, and scans the
unpacked release contents for secrets. It uploads that immutable candidate once.

Linux and Windows Thunderbird qualification download and verify those bytes.
Reviewer-source qualification installs locked dependencies in an isolated extracted
source directory, rebuilds the extension there, and compares its XPI byte for byte
with the candidate. Reproduction is a verification step, not replacement of the
candidate. A rebuilt or guessed candidate cannot substitute for the qualified XPI.

All required jobs must succeed before the protected `release` environment can
attest and create the GitHub release. Action references and downloaded tools remain
cryptographically pinned. Promotion downloads the qualified artifacts and verifies
their checksums; it does not rebuild them.

## ATN submission and completion

The protected `thunderbird-addons` job accepts only the extension's canonical tag.
It verifies source, checksums, notes, provenance, and attestations from the immutable
GitHub release before submitting the exact XPI. Credentials never enter untrusted
pull-request code.

ATN can publish an accepted version automatically. Upload acceptance, review state,
and public availability are separate observed stages. Do not assume manual
Developer Hub work is required: provide source or testing notes when ATN requests
them or when maintaining listing metadata. Keep the matching reviewer ZIP and
instructions available with the GitHub release.

Verify the exact public version and download, then compare its bytes or unsigned
payload with the qualified XPI. Public release notes are checked and reported
separately; missing notes do not make an existing public download unpublished.
If bytes are identical, the qualification evidence applies to those same bytes;
if ATN adds signature metadata, verify that only allowed signature entries differ
and smoke-test that exact public artifact. Keep API and payload evidence.

Run `mise exec -- npm run release:status -- thunderbird-extension-vX.Y.Z` for an
observed release summary. An inaccessible API or expired artifact is unknown,
not evidence of failure. The status helper does not publish, retry uploads,
approve environments, or create tags.

Use [release operations](release-operations.md) to diagnose failures and recover an
existing publication. Qualification evidence must use synthetic mail and exclude
provider keys, endpoint details, populated environment files, and local state.

# ThunderClaw release policy

## Independent components

ThunderClaw has two independently released components:

| Component | Tag | GitHub assets | Marketplace |
| --- | --- | --- | --- |
| OpenClaw plugin | `openclaw-plugin-vX.Y.Z` | plugin TGZ, checksums, provenance | ClawHub |
| Thunderbird extension | `thunderbird-extension-vX.Y.Z` | XPI, reviewer source ZIP, checksums, provenance | Thunderbird Add-ons (ATN) |

Each component owns its manifest version and component changelog. A release
changes only that component's version; the two versions need not match. The
root package is development orchestration metadata and is not a release
version authority. The historical combined `v0.1.0` and `v0.1.1` releases
remain immutable.

Installable artifacts are built once from the tagged commit, hashed, qualified
as those exact bytes, and promoted without rebuilding. Extension reviewer
source is generated from an explicit allowlist and must reproduce the candidate
XPI. It excludes dependencies, generated output, local state, credentials, and
qualification evidence.

## Migration sequence

Land the release-system migration as two logical commits:

1. **Release refactor at existing `0.1.1`.** Introduce independent metadata,
   tags, changelogs, workflows, strict legacy dispatch, and pinned counterpart
   qualification without changing either published component version.
2. **Plugin compatibility release `0.1.2`.** Change only the plugin manifest,
   lockfile mirror, and `packages/openclaw-plugin/CHANGELOG.md` for the qualified
   OpenClaw compatibility expansion, then tag `openclaw-plugin-v0.1.2`.

Do not combine these commits: reviewers and publication provenance must be able
to distinguish release-mechanism changes from the first independently shipped
product change. The extension remains `0.1.1` until it has its own change worth
publishing.

## Blocking pre-tag administration gate

Repository code cannot enforce GitHub or marketplace administration. Before
creating the first independent tag, an administrator must verify all of these
external controls; missing or ambiguous configuration blocks tagging:

- protect `openclaw-plugin-v*` and `thunderbird-extension-v*` tags against
  deletion, update, and unauthorized creation, while preserving immutable
  historical `v0.1.0` and `v0.1.1` tags;
- restrict the protected `release`, `release-qualification`, `clawhub`, and
  `thunderbird-addons` environments to the appropriate component tag patterns,
  require human approval, and keep write permissions only in promotion jobs;
- restrict the separate `clawhub-legacy` and `thunderbird-addons-legacy`
  environments to `main`, require human approval, and use them only for the
  immutable-ledger legacy audit/retry workflow;
- configure `release-qualification` with protected `DEEPSEEK_API_KEY`,
  `OPENCLAW_GATEWAY_TOKEN`, and `THUNDERCLAW_PLUGIN_TOKEN` secrets; and
- update the ClawHub OIDC trusted publisher for manual retries from
  `@thunderclaw/openclaw-plugin` from the combined tag scheme to repository
  `kwatson/thunderclaw`, the exact publishing workflow and `clawhub`
  environment, and an `openclaw-plugin-v*` tag-ref binding. Automatic tag-push
  publication still requires `CLAWHUB_TOKEN`; and
- confirm ATN credentials cannot run from plugin tags or untrusted pull
  requests and remain scoped to `thunderbird-addons`.

Test the OIDC claim/ref binding with a dry run from the intended workflow before
tagging. Do not broaden branch/ref trust to unblock publication. Record this
settings review in the release issue because it is not represented by a
repository diff.

## Candidate construction and exact-byte qualification

From a clean checkout, build only the component being released. The protected
component workflow records SHA-256 checksums and provenance, uploads the
immutable candidate, and makes every qualification job download that
candidate. Harnesses receive explicit paths through
`THUNDERCLAW_OPENCLAW_PLUGIN_TGZ` and `THUNDERCLAW_E2E_XPI`; they never pack,
build, or guess a candidate filename internally.

Every component candidate is tested with the last published counterpart:

- a plugin candidate is qualified with the extension tag pinned in the
  `thunderbird-extension` baseline entry;
- an extension candidate is qualified with the plugin tag pinned in the
  `openclaw-plugin` baseline entry.

The exact names, sizes, and SHA-256 digests are committed in
[`counterpart-baselines.json`](../e2e/qualification/counterpart-baselines.json).
The workflow downloads the named GitHub release asset, runs
`verify-counterpart-baseline.mjs`, and only then passes its explicit path to the
harness. A source rebuild, a marketplace-transformed file, or an unpinned
“latest” download is not a valid counterpart. After either component is
published and exact publication is verified, update only that component's
baseline entry for the next release.

Blocking checks include tests and typecheck, artifact inspection and secret
scanning, hashes/provenance, pinned OpenClaw integration, real Thunderbird
qualification, native filesystem/security checks, and relevant pairing and
real-agent trials. Extension releases additionally reproduce the XPI from
reviewer source. Failed gates cannot be waived by rebuilding or replacing bytes
under the same version.

## Tags, changelogs, and legacy dispatch

Prepare a tag only from a reviewed commit contained in `main`. The component
manifest version must equal the canonical tag version, and its component
changelog must contain exactly one non-empty matching section. Release notes
come only from that section:

```text
packages/openclaw-plugin/CHANGELOG.md
packages/thunderbird-extension/CHANGELOG.md
```

The root `CHANGELOG.md` is frozen history for combined `v0.1.0` and `v0.1.1`;
do not add new component release notes to it. Tags are annotated (or signed
when configured), never moved or reused, and use exactly
`openclaw-plugin-vX.Y.Z` or `thunderbird-extension-vX.Y.Z`.

The strict dispatcher accepts only those component tags plus historical
`v0.1.0` and `v0.1.1`. New tags route only their named build, qualification,
GitHub release, and marketplace channel. Historical tags use the permanently
frozen v1 combined-release parser behind the immutable baseline-ledger verifier
in `publish-legacy-release.yml`, with a manually selected
`openclaw-plugin`, `thunderbird-extension`, or `both` legacy job. Every other
tag/ref and channel/tag mismatch is rejected. The Thunderbird channel may retry
the exact historical XPI. Existing ClawHub versions are immutable and cannot
have a blank historical changelog repaired by republishing the same version,
so the plugin channel audits public artifact, source, and scan metadata without
claiming a retry or changelog repair.

## Publication and exact post-publication verification

Marketplace jobs download the component GitHub release, verify checksum,
provenance, component identity, tag, version, and source commit, then submit the
same bytes. They do not build or pack. A manual retry selects one channel and
exact release tag; it must not relabel an old artifact with the dispatch commit
or publish the counterpart.

ClawHub publishes the qualified TGZ through its protected environment. The
automatic tag path requires `CLAWHUB_TOKEN`; tokenless OIDC is allowed only for
a manual dispatch from the exact release tag and bound workflow/environment.
Wait for definitive catalog visibility, then query the public package
record/API and verify exact name, version, source tag/commit, scan state, and
artifact digest against the GitHub release.

ATN's API uploads and validates the exact XPI but cannot attach reviewer source
or private reviewer notes. After the protected job succeeds, a maintainer must
open that exact version in ATN Developer Hub, attach the matching reviewer
source ZIP from the same GitHub release, and enter reviewer testing notes.
Record this manual handoff; automation must not claim public completion before
it occurs. Then dispatch `publish-thunderbird-addons.yml` in metadata-only mode,
confirm both the reviewer source attachment and private reviewer testing notes,
and require ATN's public version API to match the canonical release notes and
the downloaded public-XPI digest/size. Verify that the public XPI is either
byte-identical to the qualified upload or differs only by complete allowlisted
Mozilla signature metadata, then perform a bounded
Generate/Preview/Apply/Undo smoke test. Preserve the API and smoke results as
release evidence.

Publication evidence is synthetic and never exposes credentials, real mail,
provider keys, endpoint details, or local state. No native helper or operating
system package belongs to the release graph.

## Compatibility surveillance

Scheduled checks may discover newer Thunderbird or OpenClaw releases but never
expand support or publish automatically. A human-reviewed compatibility change
updates pins, runs the complete component/counterpart matrix, and only then
updates [`compatibility.md`](compatibility.md) and the relevant component
changelog.

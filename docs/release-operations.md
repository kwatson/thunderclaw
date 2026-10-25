# ThunderClaw release operations

This runbook covers the standalone Thunderbird extension. The
[release policy](release.md) is authoritative. Use current workflows; historical
backend deployment and publication commands do not apply to this extension.

Use the verified `kwatson/thunderclaw` checkout. Respect the current user's scope
and authorization; this document grants no publication or settings permission.

## Establish the stage

Inspect the canonical extension tag, source commit, original run and attempt,
qualified candidate checksums, qualification jobs, GitHub release, ATN submission,
and any actual reviewer requests. A failed overall run does not mean every gate failed,
and a successful upload does not establish public marketplace completion.

Read-only starting points:

```text
gh workflow list --repo kwatson/thunderclaw --all
gh run list --repo kwatson/thunderclaw --workflow release.yml
gh run view <run-id> --repo kwatson/thunderclaw
gh release view thunderbird-extension-vX.Y.Z --repo kwatson/thunderclaw
```

Do not print provider keys, populated settings, real mail, or unfiltered provider
responses. Read only the evidence needed for the current stage. An unavailable
API response or expired artifact is unknown evidence, not proof of public absence.

| Evidence | Action |
| --- | --- |
| Candidate not yet built | Fix ordinary CI and prepare the intended product change; do not create a release to test workflow code. |
| Candidate exists and a qualification job failed | Inspect that gate's evidence. Preserve candidate bytes; do not waive the failure by rebuilding or replacing them. |
| Thunderbird could not start its virtual display | Diagnose infrastructure separately from product assertions; a fresh isolated trial must preserve the same XPI digest. |
| Qualified GitHub release exists; no confirmed ATN submission | Verify its notes, provenance, checksums, and attestations before an authorized exact-tag submission. |
| ATN accepted the upload | Check whether the version becomes public; act on actual reviewer requests. Do not upload again merely because review is slow. |
| Public ATN version exists | Verify download identity/payload; report release-note metadata separately. Reuse exact-byte qualification when identical, otherwise smoke-test the verified signed artifact. |
| Version, bytes, source, or metadata disagree | Stop promotion and resolve the mismatch. Never relabel a different archive as an existing release. |
| Publication was intentionally cancelled | Resume only with operator direction; elapsed time is not authorization. |

Reruns of old tagged workflows use their old implementation. A repair on main
cannot silently update that workflow. If a previously qualified GitHub release
requires an authorized submission retry, use the reviewed ATN workflow on main
with its existing canonical tag, preserving source and bytes from that release.
The `thunderbird-addons` environment permits that reviewed-main dispatch and
canonical extension tags. Required approval still applies; inspect pending
submissions first.
Never move a published tag or manufacture a version to clear a historical failure.

## Prepare and inspect releases

Use `mise exec -- npm run release:prepare -- X.Y.Z` to prepare the extension
version and changelog together. This is a local preparation step, not permission
to commit, tag, publish, or replace any public release. It requires GitHub CLI
access and ATN API availability to check the proposed version identity. Complete the generated
release notes, run checks, and merge the reviewed change before tagging.

Use `mise exec -- npm run release:status -- thunderbird-extension-vX.Y.Z` to
inspect observed build/qualification, GitHub publication, ATN acceptance, and
public-download verification. Inspect unknown stages rather than guessing. This
command is read-only with respect to GitHub and ATN.

## Verify ATN completion

ATN may publish automatically after accepting the XPI. Public availability is
determined by the exact public version/download, not manual confirmations or
the first upload response's `active` flag. A fresh API request can be needed when
cached metadata still shows the previous version. Do not repeatedly upload.

Verify advertised size/digest and compare the downloaded bytes/payload against
the qualified XPI. Report release-note presence/matching independently. Missing
notes do not block checking a public artifact. If source or private notes are
requested, provide the exact reviewer ZIP and testing instructions in Developer
Hub; this is a conditional response to a real request.

Keep synthetic evidence outside public source. Durable evidence belongs in CI
artifacts and provenance; temporary investigations can use ignored local output.

## Validate internal repairs

Run these through the managed runtime:

```text
mise exec -- npm run check
```

Workflow regression tests inspect pinned actions, shell syntax, tag/ref guards,
path classification, exact-byte verification, and protection dependencies. Use
actionlint when available. No product version bump is needed for this cleanup.
Do not claim local regressions prove live event propagation, environment rules,
marketplace signing, or hosted/local model compatibility. Verify external state
separately and report which paths actually ran.

# ThunderClaw release operations

This runbook covers the standalone Thunderbird extension. The
[release policy](release.md) is authoritative. OpenClaw compatibility admission,
ClawHub publishing/recovery, paired release qualification, and counterpart closeout
are retired; historical source and incident records remain available for audits.
Do not follow old autopilot commands to publish the standalone extension.

Use the verified `kwatson/thunderclaw` checkout. Respect the current user's scope
and authorization; this document grants no publication or settings permission.

## Establish the stage

Inspect the canonical extension tag, source commit, original run and attempt,
qualified candidate checksums, qualification jobs, GitHub release, ATN submission,
and Developer Hub handoff. A failed overall run does not mean every gate failed,
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
| ATN accepted the upload | Complete Developer Hub source/notes handoff and inspect that exact version; do not upload again merely because review is slow. |
| Public ATN version exists | Verify canonical notes, signed-payload correspondence, and exact-public-XPI smoke evidence. |
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

## Verify ATN completion

The ATN workflow verifies release assets, notes, tag/commit, and attestations before
submission. After its signing API accepts the XPI:

1. Attach the exact reviewer source ZIP to the same version in Developer Hub.
2. Enter canonical release notes and private reviewer testing notes.
3. Run metadata-only verification, confirming both handoff fields.
4. Require signed-XPI payload verification and the exact-public-artifact smoke test.

A workflow summary must distinguish accepted upload, manual handoff, review, and
verified public completion. Retain evidence without credentials or real mail.

## Retiring the old automation

The standalone source removes nine OpenClaw-related workflows and their dedicated
controller/recovery/rehearsal code. The live cutover also disables those workflow
IDs and removes only the obsolete **Release automation validation** required check
from main's ruleset. Keep **Tests, types, and packages**, **Signoffs**, pull-request
admission, and historical immutable tag protections.

Before changing settings, inspect active runs and existing rules. Disable the
OpenClaw rollout flag as well as its workflows when authorized, so older code
cannot continue routine admissions. Preserve published releases, tags, attestations,
state branches, and local Gateway data. Obsolete credentials/environments can be
retired separately after checking their remaining consumers; never revoke shared
credentials blindly. Repository workflow removal takes effect after merge; live
workflow disabling stops new admissions earlier.

## Validate internal repairs

Run these through the managed runtime:

```text
mise exec -- npm test
mise exec -- npm run typecheck
mise exec -- npm run build:extension
mise exec -- npm run pack:source
```

Workflow regression tests inspect pinned actions, shell syntax, tag/ref guards,
path classification, exact-byte verification, and protection dependencies. Use
actionlint when available. No product version bump is needed for this cleanup.
Do not claim local regressions prove live event propagation, environment rules,
marketplace signing, or hosted/local model compatibility. Verify external state
separately and report which paths actually ran.

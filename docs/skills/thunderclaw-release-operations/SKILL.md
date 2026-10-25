---
name: thunderclaw-release-operations
description: Diagnose, validate, publish, or recover standalone ThunderClaw Thunderbird extension releases and verify exact-byte completion. Use for release operations and release-automation validation.
---

# ThunderClaw release operations

Use the current ThunderClaw checkout and verify its remote is
`kwatson/thunderclaw`. Read `AGENTS.md`, [release policy](../../release.md), and
[release operations](../../release-operations.md) before choosing a release or
settings mutation. These documents govern the standalone extension; old OpenClaw
compatibility publishing, recovery, and counterpart-closeout automation is retired.

Apply the user's current scope and authorization, including approvals already
given. This skill grants no permission to publish, approve, change settings, move
tags, or send notifications. Complete authorized reviewable work before asking
for any missing authorization.

Establish the exact extension tag/source/run/attempt, qualified XPI and reviewer
source digests, qualification gates, GitHub release, ATN acceptance, Developer Hub
handoff, and public verification before choosing recovery. Preserve qualified
bytes and immutable public identity. A slow review, repaired workflow, or
historical failed run does not justify another product version or another upload.

Internal workflow, tool, documentation, and test-harness changes need ordinary CI
and relevant regressions, not a product tag. Preserve tests/types, exact-candidate
Thunderbird qualification, reviewer-source reproduction, checksums/provenance,
protected promotion, signing-payload verification, and the mandatory ATN handoff.

For authorized GitHub cleanup, inspect live rules/workflows before editing them,
retain the standalone CI and sign-off requirements, and remove only obsolete
OpenClaw admission/publication requirements. Do not delete public releases,
immutable tags, audit state, secrets, or local Gateway state as a side effect.

Finish by verifying the requested repository/settings changes and reporting
which checks and external paths actually ran. Keep private mail, provider keys,
backend responses, and populated environment values out of logs and documents.

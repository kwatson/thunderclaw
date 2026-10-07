---
name: thunderclaw-release-operations
description: Diagnose, qualify, publish, or recover ThunderClaw OpenClaw compatibility releases and verify their completion. Use for ThunderClaw release operations or release-automation validation, not general OpenClaw administration or unrelated plugin development.
---

# ThunderClaw release operations

Use the current ThunderClaw checkout. Verify its remote is
`kwatson/thunderclaw`; do not assume the shell starts in this repository.
This skill is maintained in that repo under
`docs/skills/thunderclaw-release-operations/`. A local discovery link may point
there; resolve its physical location if locating the repo from the skill.

Read the checkout's `AGENTS.md`, [release policy](../../release.md), and
[release operations runbook](../../release-operations.md) before choosing a
release mutation. For a new compatibility candidate, also read the
[autopilot design](../../openclaw-autopilot.md) or
[manual upgrade runbook](../../openclaw-upgrade-runbook.md), as appropriate.
The [0.1.16 incident](../../incidents/2026-10-06-openclaw-plugin-0.1.16.md)
provides historical evidence when investigating a recurring failure.

Establish the exact release stage from active reservation, source/run/attempt,
qualified bytes, publication acceptance, public verification, and baseline CI.
Follow the runbook's decision tree; run existing verifiers instead of inventing
equivalent checks. A historical failed workflow can contain successful gates;
a successful manual publisher does not validate automatic OIDC publication.

Apply the user's current scope and authorization, including approvals already
given. This skill grants no permission to publish, approve, move tags, broaden
environments, or send notifications. If authorization is missing, complete
read-only investigation and prepare the concrete action before asking.

Internal automation repairs need CI, regression coverage, or sandbox evidence,
not another product release. For publication recovery, preserve the existing
qualified archive and immutable source identity. Inspect accepted pending
ClawHub attempts before retrying an upload, respect intentional cancellation,
and distinguish terminal rejection from slow scans or ambiguous network errors.

Finish by verifying public bytes/source/notes/scans, merged counterpart baseline
and its CI, durable completion, and the requested automation settings. State
which path was actually exercised and link the evidence. Keep historical facts
and unimplemented roadmap work distinct from current behavior.

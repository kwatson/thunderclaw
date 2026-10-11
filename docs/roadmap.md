# ThunderClaw roadmap

Last reconciled: 2026-10-11

This file contains unfinished work only. Current behavior belongs in the
product and architecture documents; completed test results belong in release
provenance and CI artifacts.

## Now: compatibility release autopilot

1. Extend live sandbox evidence for merge races, lost dispatch responses,
   denied/cancelled finalizers, and repeated closeout. Executable synthetic
   regressions cover lost qualification callbacks, stale candidates, authorized
   tag interruptions, shared closeout admission, and long-scan read-only recovery;
   these do not prove live negative-case behavior. The credential-free validation
   workflow exercises runner setup and synthetic HTTP publication. Seven local
   negative regressions now cover protected admission denial, cancellation,
   lost dispatch, changed main, merge races, finalizer interruption, and repeated
   closeout. Read-only live environment-denial and cancellation probes passed
   on the maintenance branch; see the release operations audit for exact runs.
2. Validate the next fresh upstream candidate through hourly admission and
   publication. Authenticated pre-tag qualification reuse is implemented and
   regression-tested for the automatic lane only; retain exact archive, source
   tree, counterpart, request/attempt, gate, and trusted machinery binding.
   Manual plugin and extension lanes must continue running their own gates.
3. Decide longer-term immutable qualification evidence retention. Candidate
   archives expire after 14 days and result evidence after 90 days; status must
   report unknown when its required retained evidence is inaccessible rather
   than declaring completion from durable phase alone.
4. Before upgrading managed npm beyond 11, review the plugin packer's remaining
   array-output assumption. Provider staging/preflight accept strict npm 11/12
   metadata; keep build-tool selection explicit and verify all consumers together.
5. Add a deduplicated completion notification if wanted. Current workflow
   summaries expose stages; there is no separate completion notification service.
6. Re-enable hosted macOS real-Thunderbird automation after Thunderbird 154.
7. Add ATN reviewer-source automation if Thunderbird exposes a supported API.
   Until then, source and notes remain a recorded Developer Hub handoff; add
   exact post-publication ATN API verification and signed-XPI smoke evidence.

## Later

- Expand repeatable native Thunderbird lifecycle coverage on Windows and
  macOS, including same-profile upgrade/restart, optional host permission,
  credential rotation and revocation, Disconnect/Forget, compose, and message
  behavior. Qualification uses the cryptographically pinned last-published XPI
  rather than an ignored local build.
- Expand the remote HTTPS matrix to cover compose/message and credential
  lifecycle behavior, certificate failures, and ambiguous network outcomes.
- Expand guided pairing CLI qualification across direct shell, Docker
  TTY/non-TTY, and supported SSH approve/deny/revoke/`--code-stdin` journeys.
- Qualify newer OpenClaw releases without weakening the three-control embedded
  execution boundary. “Newer” remains unsupported until the matrix passes.
- Add a default-process-isolation Thunderbird browser-chrome or WebDriver BiDi
  lane when the required browsing-context support is available.
- Consider a graphical OpenClaw pairing-administration page only if a released,
  supported external-tab admin-action bridge can invoke scoped Gateway methods
  without exposing a broad credential. The CLI remains the complete operator
  path; no core patch or unsafe browser workaround is acceptable.
- Define and enforce production retention policy for content-free OpenClaw run
  telemetry and sensitive qualification artifacts.

## Not planned

- Native helper, Native Messaging, companion executable, MSIX, or Store package
- Patching or forking OpenClaw core
- Model-produced HTML or general Markdown-to-HTML conversion
- Model-controlled sending, recipients, headers, or attachments
- Nested lists, tables, images, arbitrary styles, custom list starts, or
  unrestricted compose DOM
- Automatic pairing approval, Claim, Apply, Undo, or Send

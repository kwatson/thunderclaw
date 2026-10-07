# ThunderClaw roadmap

Last reconciled: 2026-10-06

This file contains unfinished work only. Current behavior belongs in the
product and architecture documents; completed test results belong in release
provenance and CI artifacts.

## Now: compatibility release autopilot

1. Exercise the corrected automatic ClawHub OIDC publisher on the next genuine
   qualified plugin compatibility release. The 0.1.16 manual recovery does not
   prove tokenless publishing end to end; do not create a release for this test.
2. Extend sandbox evidence for GitHub App-triggered event propagation,
   environment rejection, merge races, lost dispatch responses, cancellation,
   and repeated closeout. Executable synthetic regressions now cover lost
   qualification callbacks, stale candidates, authorized tag interruptions,
   shared closeout admission, and long-scan read-only recovery; those do not
   prove live GitHub event delivery or marketplace OIDC admission. The credential-free validation workflow exercises
   real runner setup and synthetic HTTP publication, not marketplace admission.
3. Consider consolidating the remaining tagged integration and real-agent pair
   trials with authenticated pre-tag qualification. The automatic lane already
   reuses one plugin archive and the published extension; preserve coverage and
   exact artifact/source/counterpart binding before removing any gate.
4. Add a deduplicated completion notification if wanted. Current workflow
   summaries expose stages; there is no separate completion notification service.
5. Re-enable hosted macOS real-Thunderbird automation after Thunderbird 154.
6. Add ATN reviewer-source automation if Thunderbird exposes a supported API.
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

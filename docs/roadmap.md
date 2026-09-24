# ThunderClaw roadmap

Last reconciled: 2026-09-24

This file contains unfinished work only. Current behavior belongs in the
product and architecture documents; completed test results belong in release
provenance and CI artifacts.

## Now: compatibility release autopilot

1. Land the versioned OpenClaw metadata generator, field-level classifier,
   durable release state, and adversarial tests.
2. Rehearse the controller, automatic tag lane, publication, and idempotent
   closeout in dry-run and nonpublishing modes before enabling each mutation.
3. Configure protected App-only component tags, automatic environments,
   stage-specific credentials, and exact ClawHub OIDC or broker claims.
4. Re-enable hosted macOS real-Thunderbird automation after Thunderbird 154.
5. Add ATN reviewer-source automation if Thunderbird exposes a supported API.
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

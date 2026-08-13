# ThunderClaw roadmap

Last reconciled: 2026-08-12

This file contains unfinished work only. Current behavior belongs in the
product and architecture documents; completed test results belong in release
provenance and CI artifacts.

## Now: publish the first public release

1. Push the `v0.1.0` tag and let the protected release workflow build and
   qualify the exact XPI, plugin package, and Mozilla reviewer source archive.
2. Review the completed qualification jobs and their hashes and provenance.
   While the workflow is awaiting approval, optionally install its exact XPI
   on an actively used Windows or macOS Thunderbird profile and repeat a short
   Generate, Preview, Apply, and Undo smoke test.
3. Capture sanitized screenshots from the exact candidate XPI and prepare the
   matching Thunderbird Add-ons, ClawHub, README, and website presentation.
   Use synthetic mail and connection details only.
4. Approve creation of the GitHub release.
5. Submit the exact GitHub release artifacts to Thunderbird Add-ons and
   ClawHub for their initial manual publications.

## Next: publication automation

1. Complete public-repository protected-branch setup, dependency and security
   automation, and documentation checks. Tag-triggered build-once GitHub
   release promotion and its protected approval environment are implemented.
2. Promote the tracked real-agent qualification tooling into protected
   pre-release CI, and re-enable hosted macOS real-Thunderbird automation after
   Thunderbird 154.
3. Bootstrap Thunderbird Add-ons and ClawHub publication, then move
   updates to protected automated publishing and post-publication smoke tests.
4. Publish user-facing installation, privacy, support, release notes, and
   recovery material for the exact accepted artifacts.

## Later

- Expand repeatable native Thunderbird lifecycle coverage on Windows and
  macOS, including same-profile upgrade/restart, optional host permission,
  credential rotation and revocation, Disconnect/Forget, compose, and message
  behavior. The accepted `v0.1.0` XPI becomes the immutable upgrade baseline
  for the next release.
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

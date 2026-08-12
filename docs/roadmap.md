# ThunderClaw roadmap

Last reconciled: 2026-08-12

This file contains unfinished work only. Current behavior belongs in the
product and architecture documents; completed test results belong in release
provenance and CI artifacts.

## Now: accept the first public release candidate

Remaining production gates:

1. Complete Windows Thunderbird qualification for profile ACL/filesystem,
   optional host permission, same-profile upgrade/restart, credential rotation,
   operator revocation, Disconnect, Forget, compose, and message behavior.
2. Complete the same compose/message and credential-lifecycle matrix through
   the supported remote HTTPS endpoint, including certificate failures and
   ambiguous network outcomes.
3. Complete direct-shell, Docker TTY/non-TTY, and supported SSH qualification
   of the guided pairing CLI and approve/deny/revoke/`--code-stdin` journeys.
4. Produce the exact release-candidate XPI, plugin package, and Mozilla reviewer
   source archive, plus provenance, hashes, secret scans, and the final
   acceptance record described in
   [`release.md`](release.md).

## Next: publication automation

1. Configure the public repository with protected branches, secretless CI,
   dependency and security automation, documentation checks, and build-once
   artifact promotion.
2. Promote the tracked real Thunderbird and real-agent qualification tooling
   into CI, using hosted Linux first and controlled self-hosted Windows where
   required.
3. Bootstrap Thunderbird Add-ons and ClawHub publication, then move
   updates to protected automated publishing and post-publication smoke tests.
4. Publish user-facing installation, privacy, support, release notes, and
   recovery material for the exact accepted artifacts.

## Later

- Qualify newer OpenClaw releases without weakening the three-control embedded
  execution boundary. “Newer” remains unsupported until the matrix passes.
- Add a default-process-isolation Thunderbird browser-chrome or WebDriver BiDi
  lane when the required browsing-context support is available.
- Decide whether macOS is a supported release platform and, if so, add its
  filesystem, lifecycle, and Thunderbird qualification.
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

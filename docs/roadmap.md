# ThunderClaw roadmap

Last reconciled: 2026-08-12

This file contains unfinished work only. Current behavior belongs in the
product and architecture documents; completed test results belong in release
provenance and CI artifacts.

## Now: publish the first public release

1. Publish the final release commit to `origin/main`, create the immutable
   `v0.1.0` tag from that commit, and push only the tag to start the protected
   release workflow.
2. Let the workflow build and qualify the exact XPI, plugin package, and
   Mozilla reviewer source archive. Review all completed jobs, hashes,
   provenance, release notes, and known limitations.
   While the workflow is awaiting approval, optionally install its exact XPI
   on an actively used Windows or macOS Thunderbird profile and repeat a short
   Generate, Preview, Apply, and Undo smoke test.
3. Reconcile the approved synthetic screenshots and listing copy against the
   exact candidate XPI. Enter the full privacy policy and its summary in the
   Thunderbird Add-ons fields, and provide reviewer testing instructions that
   explain the separately installed OpenClaw prerequisite and the narrowly
   constrained loopback HTTP option.
4. Confirm control of the `thunderclaw` ClawHub publisher namespace, which must
   match the `@thunderclaw/openclaw-plugin` package scope. Dry-run the exact
   candidate `.tgz` with its release repository, tag, and commit attribution.
5. Approve creation of the GitHub release.
6. Submit the exact GitHub release XPI and source archive to Thunderbird
   Add-ons, and publish the exact plugin `.tgz` to ClawHub.
7. Download and smoke-test the ATN-signed XPI and install the public ClawHub
   package by its catalog identifier. Confirm their versions and public scan or
   review status before announcing the release.

## Next: publication automation

1. Complete public-repository protected-branch setup, dependency and security
   automation, and documentation checks. Tag-triggered build-once GitHub
   release promotion and its protected approval environment are implemented.
2. Re-enable hosted macOS real-Thunderbird automation after Thunderbird 154.
3. Bootstrap Thunderbird Add-ons and ClawHub publication, then move
   updates to protected automated publishing and post-publication smoke tests.
4. Update installation and support material with the final ATN and ClawHub
   listing URLs and any conditions identified by their first reviews.

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

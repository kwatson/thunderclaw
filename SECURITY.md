# Security policy

## Supported versions

Security fixes are provided for the latest published ThunderClaw release. Until
the first public release, reports are evaluated against the default branch.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability or include
credentials, private email, logs, database files, or populated configuration in
a report.

Use the repository's private vulnerability reporting feature from its
**Security** tab. If that feature is unavailable, email `kris@wtsn.io` with the
subject `ThunderClaw security report`. Include the affected version, impact,
reproduction steps, and the smallest sanitized evidence needed to investigate.

You should receive an acknowledgment within five business days. The maintainer
will coordinate validation, remediation, disclosure timing, and credit with the
reporter. Please allow a reasonable remediation period before public disclosure.

## Scope

Reports about ThunderClaw's extension, OpenClaw plugin, pairing protocol,
credential boundaries, fixed HTTP routes, build artifacts, and release process
are in scope. Vulnerabilities in Thunderbird, OpenClaw core, a model provider,
or another dependency should also be reported to that upstream project; please
tell us privately when the issue materially affects ThunderClaw.

The security design and residual risks are documented in
[`docs/security-and-privacy.md`](docs/security-and-privacy.md).


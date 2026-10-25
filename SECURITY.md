# Security policy

## Supported versions

Security fixes target the latest published ThunderClaw extension. Reports about
the standalone development candidate are also evaluated against the default branch.

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

Reports about ThunderClaw's extension, inference transport, prompt handling,
credential storage, editor boundaries, build artifacts, and release process are
in scope. Vulnerabilities in Thunderbird, a model provider/server, or another
dependency should also be reported to that upstream project; please tell us
privately when the issue materially affects ThunderClaw.

The security design and residual risks are documented in
[`docs/security-and-privacy.md`](docs/security-and-privacy.md).


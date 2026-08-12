# Contributing to ThunderClaw

Thank you for helping improve ThunderClaw. Bug reports, documentation fixes,
tests, and focused code changes are welcome.

## Before contributing

- Search existing issues and pull requests before opening a new one.
- Use a private security report for vulnerabilities; see
  [`SECURITY.md`](SECURITY.md).
- Keep proposals within the product and trust boundaries in
  [`docs/architecture.md`](docs/architecture.md) and
  [`docs/product-contract.md`](docs/product-contract.md).
- Do not include real email, credentials, private endpoints, local state, or
  qualification evidence in issues, commits, fixtures, or build artifacts.

For substantial behavior, protocol, dependency, or user-interface changes,
open an issue before investing in an implementation so the approach can be
discussed.

## Development

ThunderClaw is a monorepo containing a Thunderbird extension and an OpenClaw
plugin. The repository uses Node.js through `mise`:

```text
mise exec -- npm ci
mise exec -- npm test
mise exec -- npm run typecheck
```

Run the extension build when changing extension code:

```text
mise exec -- npm run build:extension
```

Additional setup and qualification guidance is in
[`docs/development.md`](docs/development.md) and
[`docs/testing.md`](docs/testing.md).

## Pull requests

Keep changes narrowly scoped and include tests for behavior changes. Update the
evergreen documentation when a public contract, supported version, setup step,
or security property changes. Describe the user-visible effect, the checks you
ran, and any remaining limitation in the pull request.

Contributions must be your original work or material you have the right to
submit under the repository's Apache License 2.0. By submitting a contribution,
you agree that it may be distributed under that license. Do not add third-party
code or assets without recording their source, license, and required notices.

Participation is governed by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).


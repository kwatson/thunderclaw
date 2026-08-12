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

### Developer Certificate of Origin

Contributions submitted through pull requests must comply with the
[Developer Certificate of Origin 1.1](https://developercertificate.org/). Add a
`Signed-off-by` trailer to every commit to certify that you have the right to
submit the contribution under the repository's Apache License 2.0:

```text
Signed-off-by: Your Name <your.email@example.com>
```

Git can add the trailer using the name and email from your Git configuration:

```text
git commit --signoff
```

Use `git commit --amend --signoff` for the most recent unsigned commit. For
multiple commits, use an interactive rebase and amend each unsigned commit,
then update the pull-request branch with `git push --force-with-lease`. The DCO
check requires the signoff email to match the commit author's email.

This pull-request check is not cryptographic commit signing and does not apply
to direct maintainer pushes. Do not add third-party code or assets without
recording their source, license, and required notices.

Participation is governed by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

# Upgrading to the standalone extension

ThunderClaw now connects directly from the extension to your chosen compatible
inference endpoint. Choose the provider, model, key, and writing preferences in
settings. There is no companion service, agent workspace, or server pairing in
the current setup.

## Existing installations

Install the newer XPI over the existing add-on; the stable extension ID remains
`thunderclaw@addons.thunderbird.net`. Check the installed version in settings.
The standalone extension is available from Thunderbird Add-ons. Use the public
listing or an exact GitHub release XPI when distributing a release.

Old device credentials cannot become provider API keys. The extension does not
read another application's configuration or import personality, memory, model
fallbacks, or provider secrets. Configure and test a connection explicitly.
Use **Writing style** for preferences such as concise wording or spelling.

Retired pairing data is removed locally during migration. That does not revoke
the former device remotely. Use the previous backend's administration to revoke
its device credential separately, and handle any old service or account cleanup
as a deliberate operation. Removing a saved provider key in the new settings
likewise does not revoke it with its provider.

## What carries forward

The review workflow remains Generate → Preview → Apply → Undo, with Send separate.
Supported plain text, flat lists, paragraphs, and bold/italic/underline use typed
operations and local safe DOM construction. Models never return HTML for insertion.
Original supported rich blocks accompany the selection so models can preserve
emphasis. This does not make arbitrary newsletter HTML eligible for compose edits.
Received translations keep the existing message structure, exact segment mapping,
and reversible original; source-language Auto-detect remains available by default.

Provider and model compatibility still needs qualification. Presets and synthetic
connection tests do not prove every action, language, formatting shape, or security
property. Follow [installation](installation.md), [compatibility](compatibility.md),
and [testing](testing.md). Remaining work is tracked in the [roadmap](roadmap.md).

## Repository maintenance

The active CI/release path publishes only the extension. Retired backend source
and tooling are available in Git history. Historical public releases, tags, and
attestations retain their identity. Ignored local state remains private and is
not removed by source cleanup.

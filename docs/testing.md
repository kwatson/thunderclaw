# ThunderClaw testing and qualification

## Test layers

ThunderClaw uses four complementary layers:

1. Fast deterministic tests for contracts, parsing, lifecycle, races,
   credentials, DOM boundaries, and error normalization.
2. Built-artifact checks and real Thunderbird tests with a deterministic
   loopback backend.
3. Pinned OpenClaw and real configured-agent qualification using synthetic
   accounts/content and exact artifacts.
4. Cross-platform release acceptance for Windows profile/filesystem behavior,
   remote HTTPS, upgrade, and publication artifacts.

Passing a lower layer does not substitute for a higher layer.

## Standard checks

For ordinary changes:

```text
mise exec -- npm test
mise exec -- npm run typecheck
```

For extension changes:

```text
mise exec -- npm run build:extension
```

Before a release candidate:

```text
mise exec -- npm test
mise exec -- npm run typecheck
mise exec -- npm run build:extension
mise exec -- npm run pack:plugin
mise exec -- npm run pack:source
mise exec -- npm run test:e2e:thunderbird
mise exec -- npm run test:e2e:thunderbird:upgrade
mise exec -- npm run qualify:pairing -- --no-install
mise exec -- npm run qualify:pairing:recovery
```

Run exact-artifact real-agent qualification only in the protected environment:

```text
mise exec -- npm run qualify:real-agent
```

Release qualification also builds and scans the allowlisted Mozilla reviewer
source archive, then verifies that its documented clean-install command
reproduces the extension. Qualification and publication must reuse the exact
plugin and XPI bytes produced by the release build.

## Real Thunderbird matrix

`test:e2e:thunderbird` builds the current XPI and installs that exact artifact
temporarily in official pinned Thunderbird 128 ESR and 153 builds. Each trial
uses a fresh synthetic profile and a network-isolated container with an
in-process deterministic backend.

The core compose scenario verifies:

- the real options and permission flow;
- Generate/Preview nonmutation;
- exact selected-target Apply;
- soft-wrap and paragraph-boundary canonicalization;
- supported typed Body Text/list behavior on eligible Thunderbird versions;
- stale-result rejection; and
- exact ThunderClaw Undo.

Per-version JSON, JUnit, logs, screenshots on failure, request ledgers, and
runtime/XPI metadata are written below `build/e2e/thunderbird/`. A version
directory is cleaned before publishing new results so a successful run cannot
retain an old failure.

The current Marionette driver uses `extensions.webextensions.remote=false` in
disposable profiles because remote options/popup browsing contexts are not
addressable through its window/frame API. This keeps the normal extension,
permission, background, compose, and popup code paths but does not replace a
default-process-isolation browser-chrome or WebDriver BiDi lane.

The separate `test:e2e:thunderbird:rich-compose` harness retains low-level
editor feasibility and regression fixtures. It is supporting qualification
tooling, not a separate product or distribution artifact.

## Upgrade matrix

`test:e2e:thunderbird:upgrade` uses a permanent profile to verify migration
from the previous accepted extension behavior into the release candidate. It
must cover removal of retired authentication state, endpoint and permission
retention, pairing, graceful restart, connection diagnostics, rotation,
Disconnect with remote revocation, re-pairing, and Forget.

The release matrix repeats the relevant flow on Windows because POSIX container
behavior cannot prove Windows profile ACL, reparse-point, locking, or permission
semantics.

## Pairing qualification

`qualify:pairing` is the repeatable pinned-Gateway lifecycle gate. Normal mode
inspects health/logs, packs the candidate, creates recoverable prior-plugin and
configuration snapshots, installs through supported OpenClaw commands, restarts
only the Gateway, and exercises:

- public request issuance;
- scoped operator list and approval;
- one-time claim and replay rejection;
- paired product authentication;
- atomic rotation and old-credential rejection;
- self/operator revocation;
- restart persistence; and
- raw secret scans across logs and SQLite/WAL/SHM when present.

Useful bounded modes are:

```text
mise exec -- npm run qualify:pairing -- --dry-run
mise exec -- npm run qualify:pairing -- --no-install
mise exec -- npm run qualify:pairing -- --self-test-rollback
```

On failure, recovery uses supported uninstall/install commands, restores the
private configuration snapshot, restarts only the Gateway, and waits for
health before cleaning temporary recovery state. Recovery is functional, not
a promise of byte-identical OpenClaw install metadata.

`qualify:pairing:recovery` verifies a supported backup outside the live state
tree, safe archive entries, isolated extraction, private mode, SQLite integrity,
current schema, sidecar exclusion, and opening the restored copy through the
production registry. Backups contain broad OpenClaw state and remain sensitive.

## Agent and OpenClaw qualification

Synthetic compatibility probes verify credentials, exact structured output,
zero tool activity, cancellation, and observed fallbacks. Real-agent
qualification then exercises the exact XPI and installed plugin against the
configured verified agent.

The protected real-agent matrix covers list operations, Preview/Apply/Undo/Redo,
stale body/selection/header/attachment cases, newer-edit Undo rejection, Draft
save/reopen, authoritative SMTP/MIME, new/reply/forward/reopened-draft origins,
provider request digests, disabled tools, configuration restoration, pairing
credential cleanup, and content-based secret scans.

Each OpenClaw upgrade additionally repeats session isolation, repair, fallback,
cancellation, hook auditing, persistence scans, plugin lifecycle, CLI, and
pairing recovery as specified in [`compatibility.md`](compatibility.md).

## Evidence policy

Human-readable documentation states current requirements and commands. Test
results belong in CI summaries, signed release provenance, or retained
qualification artifacts—not accumulating per-version Markdown narratives.

Retained evidence must include exact source/artifact digests, runtime versions,
and enough bounded metadata to reproduce the gate. It must exclude raw provider
secrets, paired credentials, claim secrets, broad Gateway tokens, raw prompts
unless deliberately sanitized, and unredacted configuration. Evidence and
backups containing messages or broad OpenClaw state are sensitive artifacts.

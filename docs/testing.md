# ThunderClaw testing and qualification

## Test layers

ThunderClaw uses four complementary layers:

1. Fast deterministic tests for contracts, parsing, lifecycle, races,
   credentials, DOM boundaries, and error normalization.
2. Built-artifact checks and real Thunderbird tests with a deterministic
   loopback backend.
3. Pinned OpenClaw and real configured-agent qualification using synthetic
   accounts/content and exact artifacts.
4. Cross-platform release acceptance for Windows, macOS, and Linux
   profile/filesystem behavior, remote HTTPS, upgrade, and publication
   artifacts.

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

## GitHub Actions

The `CI` workflow runs its ordinary Ubuntu checks on pull requests, pushes to
`main`, and manual dispatches. Those checks cover the deterministic test suite,
typechecking, and release-package builds.

The costlier pinned Thunderbird 153 Docker lane, pinned secretless OpenClaw
integration, and hosted Windows/macOS qualification run only when a maintainer
manually dispatches the workflow with **Run expensive pre-release
qualification** enabled. Immediately before accepting a release candidate, go
to **Actions**, select **CI**, choose **Run workflow**, select the exact
candidate branch, enable that option, and run it. A pull request, push, tag, or
GitHub release does not trigger these jobs. Failed Thunderbird jobs retain
their synthetic evidence for seven days.

The manually triggered OpenClaw integration job creates a fresh temporary state
directory, onboards without a model provider, installs the exact packed
ThunderClaw candidate, and qualifies public pairing, operator approval,
one-time claim, authenticated status, rotation, revocation, restart
persistence, raw-credential absence, and OpenClaw backup/restore compatibility.
It removes only its exact temporary container and state when complete. Run the
same lane locally with:

```text
mise exec -- npm run test:integration:openclaw
```

The first native desktop lanes use fresh GitHub-hosted Windows and macOS
runners. They are intentionally secretless trials: the native filesystem gate
uses the production pairing registry and checks restart persistence, raw-secret
absence, platform permissions, link/reparse-point rejection, and hard-link
rejection. Run it on either native platform with:

```text
mise exec -- npm run qualify:native-filesystem
```

A green hosted trial is evidence for that bounded gate, not proof of the full
Thunderbird/OpenClaw release matrix. Both hosted native-filesystem/security
lanes and the Windows Thunderbird 153 compose trial are established. Move a
lane to a dedicated ephemeral self-hosted worker only if a documented
hosted-runner limitation prevents a
required native behavior from being exercised. Exact-artifact real-agent
qualification runs only in a protected environment with a configured verified
agent; it must never run for fork pull requests or expose credentials or
retained evidence to untrusted jobs. The Thunderbird upgrade lane also remains
outside ordinary CI until its frozen baseline XPI is stored as an immutable,
reviewable CI input instead of ignored local build output.

The release-only Apple Silicon lane currently runs the deterministic and native
macOS filesystem/security gates, but not the real-Thunderbird compose trial.
Thunderbird 153 listens on Marionette but does not create the initial automation
session within the client's 360-second timeout on GitHub's `macos-15` runner. The
workaround for the related missing GPU helper tracked by
[Mozilla bug 2053898](https://bugzilla.mozilla.org/show_bug.cgi?id=2053898) does
not unblock that session. Linux and Windows continue to qualify the real
Thunderbird 153 compose flow. Current-version ThunderClaw operation has also
been manually smoke-tested on a MacBook Air. That is accepted platform smoke
evidence, while the hosted macOS compose lane remains a repeatability
improvement to revisit after Thunderbird 154 is released with its packaging
fix.

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

Routine hosted CI builds the current XPI and installs that exact artifact in
the official pinned Thunderbird 153 build. The same harness retains an opt-in
Thunderbird 128 ESR lane for manual compatibility checks. Each trial uses a
fresh synthetic profile and a network-isolated container with an in-process
deterministic backend.

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

The release matrix repeats the relevant flow on Windows and macOS because a
Linux container cannot prove Windows ACL/reparse-point behavior or macOS
profile permission, link, locking, certificate, and upgrade behavior.

## Native filesystem qualification

`qualify:native-filesystem` is a bounded, content-free gate for GitHub-hosted
Windows and macOS runners. It opens the production `PairingRegistry`, completes
a synthetic pairing, authenticates before and after close/reopen, scans the
SQLite files for raw synthetic secrets, and rejects a linked plugin directory
and multiply-linked database. On macOS it also verifies and repairs `0700`
directory and `0600` database modes. On Windows it reads native ACLs and fails
unless ownership and effective allowed access are limited to the current
identity, Creator Owner, LocalSystem, and Administrators.

The harness writes no retained state and removes its exact temporary directory.
Its JSON stdout contains platform metadata, file names, check names, and the
result only. It does not establish Thunderbird UI behavior, TLS trust behavior,
upgrade behavior, or the security of an arbitrary user-supplied OpenClaw state
root; those remain separate release gates.

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

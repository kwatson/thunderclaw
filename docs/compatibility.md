# ThunderClaw compatibility policy

## Supported compatibility matrix

| Component | Supported baseline | Policy |
| --- | --- | --- |
| OpenClaw | `>=2026.7.2-beta.7 <2026.9.1-0` | Bounded compatible API range; current qualification uses stable `2026.8.2` |
| Model providers | Any provider configured through supported OpenClaw agent APIs | Capability-gated at runtime; current paid release qualification uses DeepSeek |
| Thunderbird | 128 and newer | Plain selected-text, summary, and translation baseline |
| Thunderbird rich compose | Qualified 153 and newer shapes | Runtime-gated; unsupported shapes fail closed |
| Node.js development runtime | 24 through `mise` | Repository build and test runtime |

A newer Thunderbird major release or OpenClaw release line does not imply
support. OpenClaw prereleases, release candidates, stable releases, and
corrections within the declared 2026.8.2 range remain admitted, with exact
versions covered by ongoing compatibility surveillance.

## Desktop platform status

ThunderClaw is intended to support current Windows, macOS, and Linux desktop
installations at its first public release. GitHub-hosted Windows and Apple
Silicon macOS runners qualify the native filesystem/security boundary before
release; Windows and Linux additionally run the automated real-Thunderbird 153
compose flow. Current builds have been manually verified on Windows and on a
MacBook Air, confirming current-version macOS operation while hosted macOS
Thunderbird automation is deferred.

The hosted macOS compose lane is a repeatability improvement, not a blocker for
the current platform smoke claim. Thunderbird 153 cannot create its initial
Marionette session on GitHub's `macos-15` runner even after applying the related
GPU-helper workaround. Revisit that lane with Thunderbird 154. Remote HTTPS,
certificate, upgrade/restart, permissions, credential lifecycle, and exact
release-candidate lifecycle matrices remain useful post-release hardening rather
than blockers for the first public release. The protected release workflow's
exact-artifact checks remain blocking.

## Why OpenClaw 2026.7.2-beta.7 is the floor

ThunderClaw requires the public `runEmbeddedAgent` contract to expose these
controls together:

1. a caller-owned `SessionManager.inMemory()`;
2. `disableTools: true`; and
3. `disableTrajectory: true`.

OpenClaw `2026.7.1-2` exposes `disableTools`, but its public embedded-run
parameter contract does not expose the caller-owned session manager or
`disableTrajectory`. It therefore cannot satisfy ThunderClaw's restricted
execution and non-persistent session boundary.

The absence affects the core transform and compatibility-probe boundary, not
an optional feature. Without a supported caller-owned manager and trajectory
control, ThunderClaw cannot claim compose-scoped in-memory refinement, repair,
and fallback history or its no-normal-transcript/trajectory guarantee.

Package development, minimum Gateway, and build SDK metadata remain pinned to
the original `2026.7.2-beta.7` API floor so the plugin runtime code is unchanged.
The Docker integration image is pinned to the currently qualified stable
`2026.8.2` runtime. The peer dependency and plugin API use a bounded
range that preserves the original floor, admits prereleases, stable releases,
and correction releases through the 2026.8.2 line, and excludes the 2026.9.1
line. Expanding that range requires contract inspection and qualification.

## OpenClaw upgrade qualification

For each proposed OpenClaw version:

1. Inspect the published plugin SDK and public exports for all required agent,
   session, CLI, Gateway, state-resolution, and plugin-registration surfaces.
2. Install the exact packed ThunderClaw artifact through the supported plugin
   lifecycle and restart only the Gateway.
3. Verify plugin discovery, activation, CLI registration, full runtime status,
   fixed routes, and pairing administration.
4. Run tests, typecheck, plugin build, pairing lifecycle/recovery qualification,
   synthetic agent probes, and exact-artifact real-agent qualification.
5. Verify isolated same-compose refinement, repair, explicit fallback,
   cancellation, concurrency, TTL cleanup, and configuration invalidation.
6. Search retained state and logs for synthetic prompt, email, result, request,
   and secret canaries.
7. Repeat the ambient plugin-hook audit. Plugin inventory metadata alone is not
   accepted as proof of which dynamic handlers execute.
8. Record the supported version only after all blocking checks pass.

Failure at any step leaves the existing version pin unchanged.

## Agent compatibility

ThunderClaw does not maintain a provider allowlist. Provider and model routing
remain OpenClaw's responsibility: ThunderClaw sends every restricted model run
through the selected agent and accepts any configured backend that passes the
same capability checks. DeepSeek is the project's current paid real-agent
qualification baseline for cost and logistics; that describes test coverage,
not an intentional product restriction. Other OpenClaw providers, including
OpenAI-backed agents, are expected to work when their configured runtime path
passes the probe.

Catalog presence is not evidence that an agent can safely serve ThunderClaw.
Discovery reports configuration and an explicit compatibility state. Runtime
checks remain `not_run` until the user starts a synthetic verification probe.
Ordinary status, connection testing, discovery, startup, and feature use never
start a model-calling probe implicitly.

The probe checks:

- provider credentials and connectivity;
- exact nonce-bound structured output;
- absence of model-callable tool activity;
- cancellation after execution begins; and
- a configured fallback chain only when the chain is actually exercised.

Verification uses synthetic content, a caller-owned in-memory manager, and the
same tools-disabled and trajectory-disabled boundary as transformations.
Fallbacks remain `not_applicable` or `not_run` unless observed; configuration
alone never produces a passed result.

Compatibility evidence is bound to a fingerprint of relevant agent, provider,
model, fallback, prompt-policy, OpenClaw, plugin, and contract inputs. Relevant
configuration changes immediately make prior evidence unverified. A matching
restored configuration may recover matching durable evidence. Mid-probe change,
late completion, cancellation, restart interruption, corrupt storage, or a
failed commit cannot publish a verified result.

Compatibility evidence is stored separately from pairing/device authority.
The current public OpenClaw surface does not expose a safe credential-generation
identity, so credential-only provider rotation cannot by itself invalidate an
otherwise identical fingerprint. Provider connectivity is re-established by
the next explicit probe; this limitation must be reconsidered when the public
runtime exposes a suitable generation signal.

Unverified agents are not offered for normal feature execution. Partially
verified agents must be labeled honestly and must never imply checks that did
not run.

## Thunderbird compatibility

The manifest baseline remains Thunderbird 128. Structured compose features are
additive runtime capabilities rather than a silent increase of the extension's
global minimum.

Routine hosted release qualification uses the official pinned current
Thunderbird 153 build. Thunderbird 128 remains contract-tested and available
as an opt-in runtime compatibility lane. A new Thunderbird line must pass capture, Preview,
Apply, rollback, Undo/Redo, Draft reopen, SMTP/MIME, message display, permission,
and upgrade checks before it becomes a supported baseline.

The deterministic E2E harness currently disables remote WebExtension document
isolation in disposable profiles because Marionette cannot address the remote
options/popup browsing contexts. A default-process-isolation browser-chrome or
WebDriver BiDi lane remains required for stronger release assurance.

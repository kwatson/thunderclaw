# Changelog

All notable changes to ThunderClaw are documented in this file.

## [0.1.0] - 2026-08-12

### Added

- A Thunderbird MailExtension for previewing and explicitly applying compose
  improvements, proofreading, shortening, tone changes, translations,
  summaries, and custom writing instructions, with Undo kept separate from
  normal Send.
- Received-message summary cards and reversible visible-text translation that
  leave the original message source untouched.
- Narrow rich-compose support for qualified Thunderbird versions, limited to
  paragraphs, flat lists, and bold, italic, and underlined spans.
- A separately installed OpenClaw plugin with fixed HTTP(S) routes, strict JSON
  contracts, isolated in-memory model sessions, disabled model-callable tools,
  bounded repair and fallback behavior, and explicit cancellation.
- User-approved pairing with a scoped ThunderClaw credential, including
  operator CLI administration, rotation, revocation, and recovery paths.
- A state-driven Thunderbird connection pane with plain-language status,
  prominent pairing codes, contextual actions, progressive agent details, and
  clearer recovery controls.
- Explicit consent before pairing, point-of-use email transmission notices,
  and a complete Thunderbird Add-ons privacy policy describing the exact data
  sent through the user's OpenClaw Gateway, agent, and model provider.
- Independent validation and stale-result protection on both sides of the
  extension/plugin boundary, including request identity, generation, target
  and context hashes, output limits, and exact rich-segment identifiers.

### Known limitations

- Rich compose transformations are intentionally narrow. Unsupported document
  shapes are rejected, and model-produced HTML is never inserted.
- ThunderClaw requires a separately configured compatible OpenClaw installation
  and does not configure providers, models, agents, or provider credentials.
- GitHub release assets are not automatic publication to ClawHub or Thunderbird
  Add-ons; installation remains a separate, deliberate action.

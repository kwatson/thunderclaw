# ThunderClaw product contract

This document describes current behavior. It is a product contract, not a
record of how the behavior was developed.

## Compose actions

ThunderClaw can improve, proofread, shorten, retone, translate, summarize, or
follow a custom instruction for an eligible selection.

Generate does not mutate the draft. Preview shows only a validated result.
Apply is allowed only while the compose generation, connection binding,
selected agent, target identity, target hash, context hash, headers, recipients,
and attachments still match the authoritative state captured for the result.
Undo is rejected after a newer user edit or another state change makes exact
restoration unsafe.

## Plain selected text

Thunderbird 128 and newer support bounded text-range replacement. Replacement
text is canonicalized independently by the plugin and extension:

- an isolated model newline, including surrounding horizontal whitespace, is
  display wrapping and becomes one space;
- two or more newlines become exactly one blank-line paragraph boundary; and
- Markdown list-line syntax is rejected on the plain-text path rather than
  displayed or applied as literal list markers.

Thunderbird owns visual word wrapping. The Preview and applied text use the
same canonical form.

## Existing flat lists

Qualified Thunderbird 153 and newer selections can replace the items of a
complete direct-body flat `UL` or `OL`. Supported selection shapes are the
whole wrapper and the exact first-item text edge through final-item text edge.

The model returns only a bounded array of plain item strings. It may rewrite,
add, remove, or reorder items. Thunderbird retains the existing list kind and
constructs the result locally.

The following fail closed before Apply, and where determinable before model
execution:

- nested lists;
- custom list starts or cross-kind replacement;
- formatted or malformed items outside the explicitly supported rich path;
- comments or non-whitespace interstitial nodes;
- unsupported/custom attributes;
- partial-list selections; and
- ambiguous or unsupported Thunderbird serialization profiles.

Thunderbird 128 retains ordinary selected-text features but does not advertise
this structured list capability.

## Typed rich blocks

Qualified Thunderbird 153 and newer selections may return a typed block tree
containing only:

- paragraphs;
- unordered or ordered flat lists;
- list items;
- non-empty text spans; and
- canonical bold, italic, and underline marks.

The model returns neither HTML nor Markdown. The plugin, direct client, and
compose boundary validate the tree independently. Preview builds local DOM
with `createElement` and `createTextNode`; Apply serializes only the same local
allowlist for the qualified Thunderbird editor command.

Unknown fields, model HTML, URLs, attributes, links, styles, headings, tables,
images, code, nested lists, custom list starts, arbitrary line breaks, empty
spans, noncanonical mark ordering, and unsupported structures fail closed.

Rich output is available only when capture proves an exact eligible target:

- one or more complete supported paragraph blocks; or
- an exact complete Body Text paragraph represented by direct-body text/inline
  nodes bounded by qualified `BR` elements.

Body Text promotion admits only supported text and `B`/`I`/`U` inline grammar.
Boundary breaks must be attribute-free or have the exact qualified empty
browser-owned `_moz_dirty` profile. Partial runs, quoted content, signatures,
comments, mixed structures, unsupported attributes, and unbounded whole-body
text remain on their existing fail-closed or plain-text paths.

## Structural instruction intent

An affirmative bullet-list instruction requires unordered-list blocks. An
affirmative numbered-list instruction requires ordered-list blocks. Structurally
valid paragraph output does not satisfy those instructions. Negated,
descriptive, or mixed paragraph/list wording remains unconstrained.

The plugin and extension enforce the same bounded intent policy. A repair uses
the same restricted in-memory session. Compose transformations allow at most
two bounded repair calls after the primary response; malformed or empty output
may be repairable, while unsafe, stale, mismatched, or oversized output is not.

## Apply, rollback, and Undo

Rich Apply uses one qualified Thunderbird editor command. The compose script
verifies the complete supported postcondition, outside-node confinement, and
selection state. A detected postcondition failure must perform exactly one
native rollback Undo and verify exact restoration. If rollback cannot be
verified, rich Apply is disabled and success is never reported.

ThunderClaw Undo restores the accepted pre-Apply state. Native Thunderbird
Undo/Redo remains coherent for qualified operations. Forward and backward
selection direction is part of exact restoration.

## Message display

Summaries appear in a separate dismissible plain-text card. Translation changes
only eligible visible text nodes and can toggle back to the original. Existing
message structure, links, images, tables, attributes, and styles remain owned
by Thunderbird.

Displayed-message work is bound to the exact message identity and message
hash. Cancellation uses the exact request, run, and message identities; aborting
the local fetch is not a substitute for server cancellation.

## Explicit exclusions

ThunderClaw does not support model-produced HTML, general Markdown-to-HTML
conversion, nested lists, arbitrary compose DOM, tables, images, links, colors,
fonts, custom list numbering, automatic sending, or model-controlled message
headers and attachments.

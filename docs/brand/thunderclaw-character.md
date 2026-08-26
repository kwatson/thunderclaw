# ThunderClaw character design

Status: approved character and toolbar-icon directions

Last updated: 2026-08-10

## The character

ThunderClaw is a small teal hermit crab who found an abandoned rural mailbox
and made it his shell. He carries messages through bad weather, but he never
opens, changes, or delivers one without being asked. When his work is ready, he
leans back, looks up, and offers the letter gently: “Here you go.”

That gesture is the character's emotional center. ThunderClaw is helpful rather
than commanding, capable rather than flashy, and eager without being
subservient. He brings a suggestion to the user; the user decides what happens
next.

This mirrors the product boundary:

1. ThunderClaw generates a preview.
2. The user reviews it.
3. The user explicitly applies it.
4. Thunderbird's ordinary Send action remains separate.

## Relationship to OpenClaw

The crustacean is a quiet acknowledgment that ThunderClaw is powered by an
OpenClaw agent. It is not an adaptation of OpenClaw's mascot or visual identity.
ThunderClaw is differentiated by:

- crab anatomy rather than lobster anatomy;
- a compact teal body rather than a red crustacean;
- a terrestrial mail-courier story rather than a space motif;
- a cream rural-mailbox shell with a mustard thunderbolt; and
- a restrained, screen-printed editorial style.

This distinction is a design rule, not a trademark-clearance opinion.

## Canonical pose

The canonical illustration is a right-facing side view. The mailbox sits low
and slightly forward over the crab's long body. ThunderClaw shifts his weight
back onto the walking legs, raises one modest claw, and lets a small letter rest
on the open pincer. Both eyestalks angle upward toward the recipient.

The pose must read as an offering, not an instruction:

- “Here you go,” not “Take this.”
- Patient, not passive.
- Attentive, not pleading.
- Helpful, not autonomous.

## Character invariants

Preserve these traits in every drawing:

- A long, low teal crab body with three visible rear walking legs in side view.
- Two short, fine eyestalks with small eyes.
- No mouth, smile, nose, eyebrows, glasses, or human facial construction.
- Modest claws; they should not feel like weapons.
- A traditional rural mailbox used as a hermit shell, never mounted on a post.
- A cream shell, deep navy opening and lower band, and one mustard lightning
  bolt.
- A letter that rests on the presenting claw instead of being thrust or pointed.
- Expression conveyed through posture, eyestalk direction, and claw position.

Do not add generic AI sparkles, circuits, robot features, a space setting,
lobster anatomy, a red body, or model/provider branding.

## Mailbox construction

The shell is a compact traditional rural mailbox with a semicircular roof,
straight lower sides, a dark open front, and a subtle rear-door seam. Its length
is approximately one and a half times the visible crab body. It should appear
large enough to shelter the crab but light enough to carry.

The mailbox is both home and product metaphor: ThunderClaw works inside the
user's mail context. It must not become a hardhat, medieval helmet, freestanding
mailbox, delivery truck, or oversized appliance.

## Color palette

| Role | Color | Hex |
| --- | --- | --- |
| Crab | Teal | `#14B8A6` |
| Outline, opening, lower band | Deep navy | `#183153` |
| Mailbox and letter | Paper cream | `#FFFBEB` |
| Lightning accent | Mustard | `#F59E0B` |

Warm off-white may be used as an illustration background. Transparent raster
assets are provided for layouts that supply their own surface.

## Style

The illustration language is a modern interpretation of mid-century editorial
screen printing: economical shapes, confident navy contours, a limited palette,
and a small amount of tactile imperfection at large sizes.

Toolbar icons must use clean flat shapes without simulated texture. At small
sizes, silhouette and contrast take priority over anatomical detail. The
eyestalks, mailbox arch, presenting claw, letter, and lightning bolt are the
minimum identifying features. The canonical illustration must not simply be
shrunk into a toolbar icon; that icon needs a separate size-specific design.

## Usage

### Character illustration

Use the full character for onboarding, documentation, marketplace artwork,
empty states, and friendly success moments. Leave clear space equal to at least
one eye diameter around the outer contour.

### Application icon

Use the front-facing doorway portrait for toolbar and application icons. The
mailbox opening reads as a helmet-like arch around the character: two large
eyes on short stalks and two modest foreground claws form a compact,
symmetrical portrait. The mustard lightning bolt remains centered high on the
cream mailbox arch. There is no mouth.

This icon is a size-specific reduction of the character identity, not a crop
of the canonical side-view illustration. Use the supplied PNG matching the
requested display size so Thunderbird does not have to rescale a larger asset.

Never rotate or mirror the canonical offering pose merely to fit a layout. A
left-facing version must be redrawn so that the letter remains an intentional
offering rather than a mechanical reflection.

## Asset inventory

- [`assets/raster/thunderclaw-character-master.png`](assets/raster/thunderclaw-character-master.png):
  canonical 2100×1300 crop of the approved hero artwork. This is a mechanical
  crop and upscale with no generative redesign.
- [`assets/raster/thunderclaw-character-square-2048.png`](assets/raster/thunderclaw-character-square-2048.png):
  2048×2048 presentation tile using the approved hero artwork.
- [`assets/raster/thunderclaw-character-transparent-2048.png`](assets/raster/thunderclaw-character-transparent-2048.png):
  high-resolution transparent derivative for flexible layouts.
- [`assets/raster/thunderclaw-character-transparent-1024.png`](assets/raster/thunderclaw-character-transparent-1024.png):
  standard transparent PNG.
- [`assets/raster/thunderclaw-character-transparent-512.png`](assets/raster/thunderclaw-character-transparent-512.png):
  compact transparent PNG.
- [`assets/raster/thunderclaw-character-transparent-1024.webp`](assets/raster/thunderclaw-character-transparent-1024.webp):
  lossless WebP with alpha for web surfaces.
- [`assets/raster/thunderclaw-character-transparent.png`](assets/raster/thunderclaw-character-transparent.png):
  original-size transparent extraction source.
- [`assets/raster/icons/thunderclaw-toolbar-icon-master.png`](assets/raster/icons/thunderclaw-toolbar-icon-master.png):
  1024×1024 transparent source for the approved front-facing doorway portrait.
  Shipping derivatives are under
  `packages/thunderbird-extension/src/icons/` at 16, 20, 24, 32, 48, 64, 96,
  and 128 pixels.
- [`assets/raster/icons/thunderclaw-openclaw-plugin-icon-256.png`](assets/raster/icons/thunderclaw-openclaw-plugin-icon-256.png):
  256×256 transparent OpenClaw plugin-catalog derivative of the approved
  toolbar icon master, sized to remain within OpenClaw's fetched-icon limit.

The transparent family was isolated from the approved character using a
flat-chroma background and local alpha removal. It is a derivative rather than
the canonical source; compare future revisions against the exact master crop.
The rejected hand-authored SVG experiments were removed because they did not
preserve the approved character's proportions or gesture.

Licensing and provenance requirements for these files are in
[`README.md`](README.md). Copyright permission does not grant permission to
present a modified distribution as an official ThunderClaw release; see the
repository's [`TRADEMARKS.md`](../../TRADEMARKS.md).

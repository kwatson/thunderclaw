# Brand assets and provenance

This directory contains the editable source record and approved presentation
assets for the ThunderClaw brand. Keeping these files with the product source
makes releases reproducible and keeps asset provenance reviewable.

## Layout

- [`thunderclaw-character.md`](thunderclaw-character.md) defines the character,
  palette, approved poses, and usage rules.
- `assets/raster/` contains the approved source-size raster artwork and
  documented presentation derivatives.
- `assets/raster/thunderclaw-github-social-preview.jpg` is the GitHub social
  preview derivative: a centered 2:1 crop of `site/og.png`, resized to
  1280 by 640 pixels and encoded as a quality-92 JPEG.
- `assets/raster/icons/` contains the source-size toolbar icon artwork.
- Shipping size-specific icons live with the Thunderbird extension package and
  are generated from the approved toolbar icon master.
- Website favicon and install-icon derivatives live under `site/assets/`.
  The 16, 32, and 48 pixel files reuse the matching approved extension icons;
  the 180, 192, and 512 pixel files are mechanical resize or cream-canvas
  derivatives of the approved toolbar icon master. The Pages build assembles
  the multi-size `favicon.ico` from those approved PNG derivatives.
- The OpenClaw plugin's `assets/icon.png` is an exact copy of
  `assets/raster/icons/thunderclaw-openclaw-plugin-icon-256.png`, a mechanical
  derivative of the approved toolbar icon master. OpenClaw discovers that
  size-appropriate derivative through its fixed package-local icon convention.

The character document records which files are masters and which are
mechanical derivatives. The PNG and WebP files contain no embedded author,
location, prompt, or environment metadata.

The current raster family was introduced by the project maintainer as approved
project artwork before the repository's public-history reset. The public files
do not retain a third-party stock source or an external licensor. These master
digests identify the exact approved inputs copied into the public repository:

| Asset | SHA-256 |
| --- | --- |
| `thunderclaw-character-master.png` | `f5500476077b2a096e4a16e9cd7d1287404da3c559b7bad3b1febde8ba243da8` |
| `thunderclaw-character-transparent.png` | `1f2594be3cc4c572aaed3fec8516f67f675bed725a9819bd9e64be6b8b4d6e80` |
| `icons/thunderclaw-toolbar-icon-master.png` | `5d992ba14106cf892f59e16ed153e15e0e4dde0ac00d9d31563c30bfd14b3496` |
| `thunderclaw-github-social-preview.jpg` | `4d058504dc0a9d49e09982cc4d274500feb4c2fd3fb3bc04a2c095ced1c224ab` |

The square, transparent-size, WebP, and shipping icon families are mechanical
format, canvas, transparency, or resize derivatives of those approved inputs,
as described in the character specification.

## Licensing and trademarks

Unless a file states otherwise, the documentation and project artwork in this
directory are Copyright 2026 Kris Watson and are licensed under the repository's
Apache License 2.0. No separately licensed third-party brand asset is included
here.

Copyright permission is separate from trademark permission. Use of the
ThunderClaw name, logo, and character is also subject to
[`TRADEMARKS.md`](../../TRADEMARKS.md).

Before accepting a new or replaced asset, record its creator or source,
copyright owner, license, any generation or transformation steps, and the
relationship between master and derived files in this document or the relevant
asset specification. Do not commit stock assets, fonts, model outputs, or other
third-party material without confirming redistribution rights.

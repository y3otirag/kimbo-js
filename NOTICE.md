# NOTICE

Kimbo JS is original work, MIT licensed.

## Conceptual inspiration (no code copied)

The following projects were studied for architecture and threat-model ideas.
No source code was copied into Kimbo JS. Their licenses apply to their own
code, not to this independent implementation.

- **FindSomething** — https://github.com/momosecurity/FindSomething
  Passive page/JS URL extraction, iframe awareness, and the operational lesson
  that re-fetching target resources can invalidate one-time tokens and log the
  user out. Kimbo JS does not re-fetch pages and reads bundles cache-only.
  License: GPL-3.0.

- **AtlasWiki/EndPointer** — https://github.com/AtlasWiki/EndPointer
  Scope filtering and DevTools/popup presentation ideas.
  License: AGPL-3.0.

- **LinkFinder** — https://github.com/GerbenJavado/LinkFinder
  The general idea of extracting route-like strings from JavaScript.
  License: MIT.

If you intend to incorporate code from any of the projects above, review their
license terms first. Kimbo JS does not do so.

## Test fixture dependencies

- React 18.3.1 production UMD builds, vendored under
  `test/fixtures/vendor/` for the local SPA fixture.
  Copyright (c) Facebook, Inc. and its affiliates.
  License: MIT. See the license headers in those files.

## Icons

The Kimbo JS mark in `src/assets/` and `tools/make_icons.py` is original work
created for this project.

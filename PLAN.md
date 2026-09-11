# A3 Poster Tiler — web tool plan

## Origin

This tool generalizes a two-session ImageMagick/GIMP command-line workflow (2026-09-10/11)
that took source artwork and produced print-ready, tiled A3 PDFs — scaled-to-fit posters in
the first pass, then unstretched-and-mirrored posters in the second. The goal is a
browser-based tool that does the same job without a terminal: upload an image, choose a few
options, get a print-ready multi-page PDF of A3 tiles back.

Everything below is either a decision already validated against real files, or a gotcha that
cost real debugging time. Both are worth preserving so the web version doesn't re-learn them.

## Core operation

Given one image and a chosen A3 tile orientation:

1. **Fit mode** — two modes were used across the two sessions, both should be options:
   - *Scale to fit* — resize (preserving aspect, no cropping) so the image fits inside an
     N×M grid of A3 tiles, padding any leftover space with a background colour.
   - *Native / unstretched* — no resizing at all; grow the canvas to the next whole multiple
     of the A3 tile size and centre the image in it. Used when the print must be pixel-exact
     (e.g. a fixed real-world size), accepting that the sheet count follows the source
     resolution rather than a target sheet count.
2. **Optional mirror** — horizontal flip (not vertical), for anything printed or applied
   face-down (iron-on transfer, reverse-glass, window vinyl applied from the inside).
3. **Grid**: given the fit canvas size and tile size, slice left-to-right, top-to-bottom into
   exact tiles — the fit modes above guarantee no remainder.
4. **Output**: a single multi-page PDF, one page per tile, in reading order (page 1 =
   top-left). Each page must be sized as a literal A3 page, not just an A3-shaped image.

## Decisions carried over

- **A3 at 72 dpi = 1191×842 px** (landscape) / 842×1191 px (portrait). The web tool should
  let 72 dpi be overridden — a poster meant for close-up viewing may want more.
- **Tile orientation should be selectable per image**, not fixed — the CLI sessions found
  wildly different aspect ratios among source files (1.23:1 up to 3.7:1), and the "fewest
  sheets" orientation differed file to file. Show the user a live sheet-count preview for
  both orientations so they can pick.
- **Never silently produce blank tiles.** One source image (3.7:1 panorama) forced into a
  square-ish grid produced tiles that were >60% white. The tool should warn — e.g. "this
  fit leaves an entire row/column blank" — rather than just rendering whatever grid was
  requested.
- **Background colour for padding** should be a user choice (default white), not hardcoded.
- **Print guidance is part of the deliverable**, not an afterthought: the output should
  remind the user to print at 100%/actual size (never "fit to page"), and show the tile grid
  layout (e.g. `r0c0 | r0c1` / `r1c0 | r1c1`) so assembly order is unambiguous.

## Gotchas hit in the CLI sessions — must not regress in the web version

- **PDF page size defaults to Letter unless forced.** ImageMagick's PDF writer (and by
  extension anything wrapping Ghostscript or a similar PDF backend) will silently default
  the page/MediaBox to US Letter (612×792pt) regardless of the source image's pixel
  dimensions, unless the page geometry is explicitly set. This produced *visually correct
  but silently mis-sized* PDFs that only a `pdfinfo`/MediaBox check caught — not a visual
  glance. **The web tool must verify the emitted page size programmatically** (whatever PDF
  library is used) rather than trust that "looks like a grid" implies "is A3."
- **`fx:page.x`/`page.y` expressions evaluated after a `+repage` read back as 0.** Applies
  narrowly to the ImageMagick CLI approach; if a rewrite in a browser-native library
  (pdf-lib, canvas, etc.) avoids ImageMagick's page/offset model entirely, this specific trap
  doesn't apply — but it's a reminder that *tile identity (row/col) must be computed from the
  pre-crop grid position, not derived after any coordinate-resetting operation.*
- **Some legacy file formats can't be read directly by the common web libraries.** The
  source files in this project started as multi-layer PSD/XCF. A browser tool should define
  its supported input formats explicitly (flattened raster formats: PNG/JPEG/TIFF/WebP are
  safe; PSD/XCF layer data is not something to parse in-browser — ask the user to export a
  flattened image first, the way this session ultimately did manually via GIMP after
  automated headless export proved unreliable).
- **CMYK sources**: original PSDs were 8-bit CMYK. Browser canvas/PDF pipelines are
  practically always sRGB. Converting CMYK→sRGB before layout (not after) avoids colour
  shifts compounding with the resize math. If the tool ever supports CMYK output (for a
  commercial print shop), it needs its own explicit path — don't assume sRGB out is always
  correct.

## Suggested architecture

Static, client-side web app — no server needed for the core operation, which keeps the
user's artwork private and avoids upload/hosting concerns:

- **Input**: `<input type="file">` accepting PNG/JPEG/WebP/TIFF (TIFF may need a decode
  library — check browser-native support first, likely need `utif.js` or similar; PSD/XCF
  out of scope per above).
- **Image decode + compositing**: `<canvas>` — draw the source image, resize (if fit mode is
  "scale to fit"), flip horizontally (`ctx.scale(-1,1)` before drawing) if mirroring, and pad
  onto a background-filled canvas of the padded grid size.
- **Tiling**: `drawImage` with source-rect cropping, once per tile, onto a small per-tile
  canvas.
- **PDF assembly**: [pdf-lib](https://pdf-lib.js.org/) (pure JS, runs in-browser, gives
  explicit control over each page's `MediaBox` in points) — embed each tile canvas as a PNG
  image in a page whose `MediaBox` is set explicitly in points from the DPI (this is the
  control that was missing at the CLI layer and must not be missing here either).
- **UI**: a single page — file picker, orientation toggle (with live sheet-count + blank-tile
  warning for both options), fit-mode toggle, mirror toggle, DPI field (default 72), colour
  picker for background, a canvas preview showing the tile grid overlaid on the composed
  image, and a "Download PDF" button.

## Open questions to resolve before implementation

- Should the tool support multiple images / multiple outputs in one session (batch), given
  the CLI sessions always processed 2–3 files at once?
- Is DPI-based (screen/print) sizing sufficient, or does the tool need a real-world
  millimetre target size (e.g. "print this dog at exactly 900mm wide") — that changes the
  primary input from DPI to physical size, with DPI derived.
- Any deployment target in mind (a static site the user hosts, or just a local HTML file run
  from disk)?

## Verification plan for the web tool itself

Mirror the CLI verification steps, since they're what actually caught the two real bugs
hit this session:
1. Programmatically assert every emitted PDF page's `MediaBox` matches the intended tile
   size in points — not just eyeballing the rendered preview.
2. Reassemble the tiles (draw all pages back onto one canvas at their grid position) and
   diff/compare against the composed pre-slice canvas — confirms no cropping, no stretch, no
   off-by-one tile boundary.
3. Confirm mirroring visually reads backwards in a test render before shipping the feature.

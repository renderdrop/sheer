# Typed-signature fonts: candidate check (F15 B7)

Date: 2026-10-04. Primary source: github.com/google/fonts, `ofl/<folder>/METADATA.pb` and `OFL.txt` (raw, branch main). All ten are by designer Robert Leuschke (Typeset-It / Google Fonts project repos under github.com/googlefonts/<name>). Base URL below: `https://raw.githubusercontent.com/google/fonts/main/ofl/`.

Verified from source: licence text (SIL OFL 1.1), absence of a Reserved Font Name line, copyright line, file names, number of styles, subsets. Not verifiable here (no font rendering): style notes and per-glyph coverage of ä ö ü ß Ä Ö Ü. Subsets "latin" + "latin-ext" in Google's pipeline include all of Latin-1 and these German letters, so coverage is expected, but must be checked by a glyph test (cmap) when the file is first imported (unverified at glyph level).

| Family | Licence | RFN | Copyright (OFL.txt) | URL (after base) | Styles | Subsets | Style note (visual: unverified) | Verdict |
|---|---|---|---|---|---|---|---|---|
| Mea Culpa | OFL-1.1 | none | 2003-2021 The Mea Culpa Project Authors | `meaculpa/MeaCulpa-Regular.ttf` | 1 | latin, latin-ext, vietnamese, menu | Thin flowing pen script, some stroke contrast, long entry/exit strokes; legible | Ship |
| Ms Madi | OFL-1.1 | none | 2018 The Ms Madi Project Authors | `msmadi/MsMadi-Regular.ttf` | 1 | latin, latin-ext, vietnamese, menu | Thin near-monoline, casual signature, loops on ascenders; legible | Ship |
| Hurricane | OFL-1.1 | none | 2016-2021 The Hurricane Project Authors | `hurricane/Hurricane-Regular.ttf` | 1 | latin, latin-ext, vietnamese, menu | Very thin, fast monoline, tall slanted loops; legibility medium at small sizes | Ship |
| Island Moments | OFL-1.1 | none | 2013-2021 The Island Moments Project Authors | `islandmoments/IslandMoments-Regular.ttf` | 1 | latin, latin-ext, vietnamese, menu | Thin relaxed monoline, round loops; legible | Ship |
| Qwitcher Grypen | OFL-1.1 | none | 2007-2021 The Qwitcher Grypen Project Authors | `qwitchergrypen/QwitcherGrypen-Regular.ttf` (also `-Bold.ttf`) | 2 (400, 700) | latin, latin-ext, vietnamese, menu | Thin pointed-pen script with long loops; Regular is thin, Bold is heavier (not wanted). Ship Regular only | Ship (Regular) |
| Birthstone | OFL-1.1 | none | 2019 The Birthstone Project Authors | `birthstone/Birthstone-Regular.ttf` | 1 | latin, latin-ext, vietnamese, menu | Calligraphic copperplate with visible thick/thin contrast, small x-height; not monoline | Flag: not monoline |
| Love Light | OFL-1.1 | none | 2003 The Love Light Project Authors | `lovelight/LoveLight-Regular.ttf` | 1 | latin, latin-ext, vietnamese, menu | Hairline-thin, formal flourished capitals, long loops; fairly monoline but ornate, caps less legible | Ship (optional) |
| Petemoss | OFL-1.1 | none | 2008-2021 The Petemoss Project Authors | `petemoss/Petemoss-Regular.ttf` | 1 | latin, latin-ext, vietnamese, menu | Thin casual hand-signed look, mostly monoline, readable | Ship |
| Whisper | OFL-1.1 | none | 1993-2022 The Whisper Project Authors | `whisper/Whisper-Regular.ttf` | 1 | latin, latin-ext, vietnamese, menu | Extremely thin monoline, tall loops; may render faint at small sizes | Ship |
| Waterfall | OFL-1.1 | none | 2011 The Waterfall Project Authors | `waterfall/Waterfall-Regular.ttf` | 1 | latin, latin-ext, vietnamese, menu | Ornate formal script, strong contrast and heavy swashes; not monoline | Flag: not monoline |

Notes:
- Folder for Qwitcher Grypen is `qwitchergrypen` (double t in the family name is wrong; `qwittchergrypen` returns 404).
- All files are static TTF, no variable fonts. Each OFL.txt in the folder must be bundled next to the font (project practice, see docs/LICENSES.md Dancing Script row).
- The METADATA fetch was summarised by the fetch tool, not read raw; the file names, subsets and designer are consistent across all ten. Exact `copyright:` lines in METADATA were reported for most but not all; OFL.txt lines above are the authoritative ones.
- Latin-1 coverage and German glyphs: expected from subsets, to be confirmed by a cmap test (U+00E4, F6, FC, DF, C4, D6, DC). Some Leuschke scripts have no true capital sharp s; ẞ (U+1E9E) is not required.
- "Dijana Kornelsen" legibility: judge in a render test; long-loop fonts (Hurricane, Whisper, Love Light) risk reading "Dijana" as loops only at small sizes (unverified).
- No alternatives needed: 8 qualify.

## Recommendation (ship 8)

Mea Culpa, Ms Madi, Hurricane, Island Moments, Qwitcher Grypen (Regular only), Petemoss, Whisper, Love Light. Drop Birthstone and Waterfall (contrast, not monoline). If one fails the cmap or legibility test (most likely Love Light or Whisper), 7 remain; a tenth/ninth can be Birthstone as a fallback, flagged non-monoline. Ship order for the picker: Ms Madi (default), Island Moments, Petemoss, Mea Culpa, Hurricane, Qwitcher Grypen, Whisper, Love Light.

Licence note for LICENSES.md: OFL-1.1, unmodified, no RFN, so no renaming constraint; bundle OFL.txt per font. Complexity: S (assets + picker list), M if per-font cmap test and glyph fallback added.

## Sources

- https://github.com/google/fonts/tree/main/ofl (folders meaculpa, msmadi, hurricane, islandmoments, qwitchergrypen, birthstone, lovelight, petemoss, whisper, waterfall; files METADATA.pb, OFL.txt)
- https://raw.githubusercontent.com/google/fonts/main/ofl/meaculpa/OFL.txt (same pattern for the other nine)

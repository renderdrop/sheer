# Design system v2: "sheer." (v1.2, ADR-100)

Sources: `docs/REDESIGN_BRIEF.md` (binding), `docs/BRAND.md` (only truth for tokens), `docs/brand/moodboard.png` (layout proportions). Motion lives in `docs/MOTION.md`. Light only, flat, no translucent surfaces, no `backdrop-filter`, no `prefers-color-scheme`.

**Behaviour rule.** Behaviour, keyboard and ARIA of existing components stay as specified in v1.1 (`git show v1.1.0:docs/DESIGN.md`, §3.0–3.60) unless this file says otherwise. This file changes looks, slots and the places listed explicitly.

## 1. Tokens

### 1.1 Primitives (BRAND §24, exact; `:root`, not Tailwind utilities)

| Token | Value | Token | Value |
|---|---|---|---|
| `--color-yellow` | #FFF84D | `--radius-sm` | 6px |
| `--color-yellow-bright` | #FFFF22 | `--radius-md` | 10px |
| `--color-ink` | #0F0F0F | `--radius-lg` | 14px |
| `--color-text-secondary` | #6F6F6B | `--radius-xl` | 18px |
| `--color-canvas` | #FAFAF8 | `--space-1/2/3/4` | 4/8/12/16px |
| `--color-sand` | #F6F5F1 | `--space-6/8/12/16` | 24/32/48/64px |
| `--color-mist` | #DDE2EA | | |
| `--color-border` | #E5E5E1 | | |
| `--color-white` | #FFFFFF | | |

Additions (BRAND §9, §23 and this spec): `--space-5` 20, `--space-10` 40, `--space-20` 80, `--space-24` 96; `--radius-dialog` 16 (BRAND §9 modals); `--radius-pill` 999 (toggles, filter chips, tag chips §3.7, the round "+" button only); `--color-stone` #8A8A86 (control boundaries, 3.47:1 on white, 3.18:1 on Sand); `--color-danger` #C8321F (5.34:1 on white, 4.89:1 on Sand). Grid base is 4 px.

### 1.2 Semantic tokens (brief R0.1)

| Token | Value |
|---|---|
| `--surface-canvas` | Canvas #FAFAF8 (app background, nav, page sidebar) |
| `--surface-panel` | White (menu, top, mode and tool rows, mini bar, menus, popovers, cards) |
| `--surface-page-area` | #EFEFEC (behind PDF pages only) |
| `--surface-page` | White (PDF page) |
| `--surface-subtle` | Sand (hover, secondary button, banner, dialog) |
| `--surface-pressed` | #E5E5E1 (pressed fill) |
| `--text-primary` | Ink |
| `--text-secondary` | #6F6F6B (never on #EFEFEC: 4.38:1) |
| `--border-subtle` | 1px solid #E5E5E1 |
| `--border-control` | 1px solid Stone |
| `--accent` / `--accent-bright` | #FFF84D / #FFFF22 |
| `--on-accent` | Ink |
| `--shadow-standard` | 0 2px 12px rgba(0,0,0,0.04) |
| `--shadow-floating` | 0 8px 30px rgba(0,0,0,0.08) |
| `--ring-focus` | 0 0 0 1px Ink, 0 0 0 3px Solar (the only third box-shadow; lint allowlists this name) |
| `--opacity-disabled` | 0.4 |
| `--scrim` | rgba(15,15,15,0.12) (modal backdrop, no blur) |
| `--motion-fast/base/slow` | 120 / 160 / 180ms; exits `--motion-*-exit` 80 / 120 / 140ms |
| `--ease-out` | cubic-bezier(0.2, 0, 0, 1) |
| `--chip-height` | 20px (tag chips, §3.7) |
| `--tag-dot` | 8px (colour dot in tag chips and tag menus, §3.7) |
| `--citation-default` | `--hl-lavender` #DCCFFF (first-run citation fill; its underline is `--stroke-lavender`, §3.7) |
| `--preview-min-height` | 64px (formatted reference preview, §3.7) |
| `--seal-width` / `--seal-height` | 192 / 64 pt (default certificate seal box on the page, §3.8) |
| `--seal-min-width` / `--seal-min-height` | 120 / 40 pt (smallest seal box, §3.8) |

Pages use `--shadow-floating` (brief: two shadows only; BRAND §18's page shadow is not added).

### 1.3 Re-pointing the existing role layer

Tailwind names stay where listed, so markup changes only where the row says "rename" or "removed".

| Existing token | New value |
|---|---|
| `--color-canvas` (role, document area) | removed as role; name now the Canvas primitive. Every `bg-canvas`/`surface-canvas` usage renames to `bg-page-area` (`--color-page-area` = `--surface-page-area`) |
| `--color-bg`, `--bg-*`, `bg-bg` | removed; body = `--surface-canvas` |
| new `--color-app`, `--color-panel`, `--color-subtle`, `--color-pressed` | `--surface-canvas`, `--surface-panel`, `--surface-subtle`, `--surface-pressed` |
| `--color-scrollbar` / `-hover` | rgba(15,15,15,0.20) / 0.36 |
| `--color-text` | `--text-primary` |
| `--color-text-muted` | `--text-secondary` |
| `--color-text-accent` | removed (no yellow text); links are Ink, underlined |
| `--color-text-disabled`, `--color-icon-disabled` | Stone |
| `--color-accent` | `--accent` |
| `--color-accent-hover` | `--accent-bright` |
| `--color-accent-pressed` | `--accent` (pressed = scale 0.98) |
| `--color-on-accent` | Ink |
| `--color-focus` | `--accent` (always drawn with the Ink hairline, §2) |
| `--color-control-border` | Stone |
| `--color-selected` | Sand (plus a non-colour cue, §2) |
| `--color-fill-disabled` | Sand |
| `--color-track` | #E5E5E1 |
| `--color-divider` | #E5E5E1 |
| `--color-tile` / `--color-tile-icon` | Sand / Ink |
| `--color-card` | White |
| `--color-tooltip-bg` / `-text` / `-key` | White / Ink / Sand |
| `--color-success-*`, `--color-warning-*` | removed; usages become Ink text with their Lucide icon (circle-check, triangle-alert) |
| `--color-error-icon`, `--color-error-text` | `--color-danger` |
| `--color-surface`, `-strong`, `-solid` | White |
| `--color-backdrop` | `--scrim` |
| `--color-on-close`, `--win-close-hover` | White / `--color-danger` |
| `--color-page`, `--color-doc-paper` | White |
| `--color-doc-ink` | Ink |
| `--color-doc-select` | Ink |
| `--color-doc-hover` | Stone |
| `--color-doc-text-select` | rgba(111,111,107,0.28) |
| `--color-doc-hit` | Mist, `mix-blend-mode: multiply`; active hit adds a 2px Ink outline |
| `--color-doc-field` / `-hover` | rgba(221,226,234,0.6) / Mist |
| `--color-doc-required` | Ink |
| `--color-doc-redact` / `-fill` | `--color-danger` / rgba(200,50,31,0.12) |
| `--color-doc-crop-shade` | rgba(15,15,15,0.4) |
| `--color-annot-*`, `--annot-*` | removed; §1.4 |
| `--shadow-1` / `-2` / `-3`, `--page-shadow` | standard / floating / floating / floating |
| `--glass-*`, `--surface*`, `--canvas-edge`, `--ground-shadow`, `glass-1/2`, `surface-dialog`, `logo-float`, `logo-ground`, solid-mode and dark blocks | removed (dialogs: §4) |
| `--radius-xs` | removed → `--radius-sm` |
| `--radius-sm` | 6 |
| `--radius-button` | alias of `--radius-md` (10) |
| `--radius-panel` | alias of `--radius-lg` (14) |
| `--radius-card` | alias of `--radius-md` (10) |
| `--radius-pill` | 999 (restricted use) |
| `--space-0-5/1/1-5/2/3/4/5/6/8` (4…64) | rename to BRAND names: 0-5→1, 1→2, 1-5→3, 2→4, 3→6, 4→8, 5→10, 6→12, 8→16. Codemod every `p-1`, `gap-2` etc. (old step n = new step 2n) |
| `--font-sans`, `--font-display` | "Inter", "Helvetica Neue", Helvetica, Arial, sans-serif |
| `--text-xs`, `--text-sm` | 12/16, 400 (caption) |
| `--text-md` | 14/20, 400 |
| `--text-lg` | 16/24, 500 |
| `--text-xl` | 20/28, 500 |
| `--text-2xl` | 32/36, 400, −0.025em |
| `--ease-spring`, `--ease-float` | removed → `--ease-out` |
| `--motion-base` / `--motion-slow` | 160 / 180 |
| `--scale-press`, `--scale-enter`, `--scale-lift` | 0.98 / 0.98 / 1.02 |
| `--scale-thumb`, `--pulse-scale`, `--float-*` | removed (1) |
| `--control-sm/md/lg` | 28 / 36 / 40; new `--control-xl` 44 (hero search) |
| `--icon-12` | removed → 16; add `--icon-18`; `--icon-stroke` 1.75px; `--icon-stroke-sm` removed |
| `--caption-height`, `--status-*`, `--tabs-row-height`, `--hub-*`, `--logo-*` | removed (slots in §3) |
| `--toolbar-row-height` | rename `--topbar-height` 56 |
| `--inspector-width` | removed (ADR-102); add `--menubar-height` 32, `--mode-row-height` 40, `--tool-row-height` 48, `--minibar-height` 40, `--caption-button-width` 46 |
| `--panel-min/default/max` | 200 / 200 / 320 (`--panel-collapse-below` 144 unchanged) |
| `--tab-min/max` | 128 / 200 |
| everything else (z-layers, dialog/sheet widths, toast sizes, handles, search/comment row heights, signature sizes) | unchanged |

### 1.4 Highlight and ink palette (document content)

Highlights: fill at 45 % opacity, `mix-blend-mode: multiply`. The four alternatives share CIE L\* 85.5 ± 0.5; Solar (L\* 95.5) is the mandated default.

| Name | Highlight | Stroke (pen, shapes, text colour; L\* 57.5 ± 0.5, ≥ 3.3:1 on white) |
|---|---|---|
| Solar (default highlight) | #FFF84D | #FFF84D (fills only; the picker labels it "Solar, fill") |
| Mint | #7DEBB5 | #1F9E6A |
| Sky | #A3DEFF | #3D8FD1 |
| Rose | #FFC7D7 | #E15C86 |
| Lavender | #DCCFFF | #9278E6 |
| Ink (default stroke) | — | #0F0F0F |

Tokens: `--hl-*`, `--stroke-*`. Annotations from older files keep their stored colour; the picker then shows it as an extra "Custom" swatch. Signature ink: Ink or `--ink-signature` #1F3A93 (the only blue).

**Palette audit and single source (F19.14, ADR-141).** All colour lists live in `src/features/inspector/palette.ts` as named sets (`PALETTE_SETS`, active set `ACTIVE_PALETTE_SET` = `iris`; each set holds `highlight`, `stroke`, `fill`, `signature`). The one picker is `components/ColourPopover` (palette grid, custom hex, recent). A "toggleable palette" (owner spec pending) is a second entry in `PALETTE_SETS`; no surface may hold colour literals (`paletteSource.test.ts` scans for them).

| Surface | Palette source | Picker | State |
|---|---|---|---|
| Mini bar (`minibar/model.ts`, `Controls.tsx`) | `PALETTES[kind]` | ColourPopover | unified |
| Tool row colour row (`modes/ColourRow.tsx`) | `paletteNameOf(kind)` | ColourPopover | unified |
| Inspector (`inspector/*`) | `PALETTES` | ColourPopover | unified |
| Signature sheet (`SignatureSheet.tsx`) | `SIGNATURE_PALETTE` (Ink, `--ink-signature`) via radio | two-swatch radio by design | unified (source) |
| Text boxes (`insert/TextEditor.tsx`, `note/FreeTextEditor.tsx`) | no palette of their own; render the object's colour | mini bar | unified |
| Tags (`tags/palette.tsx`, `api/cite.ts TAG_PALETTE`) | derived from `PALETTES.highlight`; `TAG_PALETTE` mirrors Rust and is asserted equal | tag menu (fixed five) | unified (was a copy) |
| Stamps (`stamps/actions.ts TONE_RGB`) | derived from highlight[0] / stroke[0] (was literals) | tone menu | unified (was a copy) |
| Comment export | uses `TagDot` (tags source) | none | unified |

### 1.5 Type (Inter variable, `font-feature-settings: "cv11","ss01"`; numerals that change use `tabular-nums`)

| Class | Size/line | Weight | Tracking |
|---|---|---|---|
| `.t-display` | 72/72 | 400 | −0.045em |
| `.t-h1` | 48/52 | 400 | −0.035em |
| `.t-h2` | 32/36 | 400 | −0.025em |
| `.t-h3` | 20/28 | 500 | −0.01em |
| `.t-title` | 16/24 | 500 | 0 |
| `.t-body` | 14/21 | 400 | 0 |
| `.t-label` | 13/18 | 500 | 0 |
| `.t-caption` | 12/16 | 400, secondary | 0 |
| `.t-claim` | 11/16 | 500, uppercase | +0.28em |

Weights 400/500/600 only; 600 is reserved for state cues (§2).

## 2. Contrast rules (Solar on white is 1.12:1)

Yellow never carries information alone. Each yellow state has an Ink partner:

1. **Focus ring:** `--ring-focus` = 1px Ink hairline at the edge (19:1) inside a 2px Solar band. On yellow controls the hairline separates the two yellows. Canvas items scaled by `--page-scale` use the same pair as two outlines.
2. **Selected thumbnail:** 2px Solar border plus the page number below turning into a Solar chip with Ink 600 numerals (17:1); `aria-current="page"`.
3. **Active tool (tool row, §3.2):** Solar fill, label Ink 600 (inactive 500); `aria-pressed`.
4. **Toggle:** track border Stone (off) / Ink (on); knob Text-secondary (off, 4.0:1 on the track) / Ink (on); the knob's position is the cue.
5. **Slider:** rail #E5E5E1 4px, filled part Solar, thumb 16px Solar with a 2px Ink border; the number field shows the value.
6. **Checkbox / radio:** Stone border; checked = Solar fill, Ink border, Ink check/dot.
7. **Swatches:** 1px Stone ring on every swatch; selected = 2px Ink ring offset 2 + Ink check.
8. **Tabs (document, sidebar, sheet):** active = Ink text/icon 500 + 2px Solar underline; inactive = Text-secondary 400.
9. **Text inputs:** subtle border on three sides, bottom edge Stone (3.47:1).
10. **Selected (non-tool) rows, menus, segmented control:** Sand + check icon or a Stone 1px border on the active segment.
11. **Search hits (`--color-doc-hit`, `--color-doc-hit-active`):** Solar at 70 % (active: 100 %), drawn with `mix-blend-mode: multiply`, so the glyphs stay Ink on yellow (>= 12:1); the active hit adds a 2px `--color-doc-select` (Ink) outline, so it never relies on the stronger fill.
12. **Text selection (`--color-doc-text-select`):** Solar at 35 % multiplied over the page; the glyphs stay Ink (>= 15:1). The selection is also shown by the browser's selection range and the selection popover, not by colour alone.

Text ≥ 4.5:1 everywhere, UI ≥ 3:1. The contrast script checks every pair in this section.

## 3. Layouts

Minimum window 960 × 640. Every surface below has its own grid track. Nothing floats over the PDF except popovers, menus, tooltips, toasts, the selection popover and the properties mini bar (§3.3), and those never cover the selection.

### 3.1 Home (BrandSurface)

Columns: **nav 200** | **main 1fr** (White). Main padding 32 (48 from 1440 wide), content max 1120, centred.

- **Window strip:** the top 56 of both columns is a drag region. macOS: traffic lights at x 20 inside the nav strip. Windows: caption buttons 46 × 56 each at the right end of main; content keeps 138 clear on the right of that strip.
- **Nav** (Canvas, no border): wordmark (secondary, height 24) in a 48 row below the strip, padding-x 20; then 16 gap; rows 36, radius md, gap 4, padding-x 12, icon 18 + `.t-label`: Home, Zuletzt, Markiert, Werkzeuge. Active row: Sand + Ink 600. Bottom: Settings row 36, 16 from the bottom.
- **Hero:** Sand, radius xl, padding 40, min height 280, SolarGlow `hero` at 80%/85%. `.t-display` "PDFs / made simple." (two lines), 24 gap, search input 44 high, max 480, `/` shown as kbd at the right. Round "+" (48, Solar, `--radius-pill`, plus icon 20) 24 from the top and right.
- **Zuletzt:** 40 below the hero. Heading `.t-title` + "Alle anzeigen" ghost at the right (only when > 12). Grid `repeat(auto-fill, minmax(208px, 1fr))`, gap 16. Card: White, `--border-subtle`, radius md, padding 12, height 76: thumbnail tile 40 × 52 (radius sm, border, small `card` glow clipped in its corner), 12 gap, name `.t-label` (one line, ellipsis), time `.t-caption`. Hover: Sand; star and ⋯ icon buttons (28) appear at the right; a starred card shows its filled Ink star always.
- **Werkzeuge** section (and the Werkzeuge view): 40 below, heading `.t-title`, three columns from 1200 wide (gap 16; F19.6: tools stay above the fold at 1280×800 with open files and a banner), rows 56: icon 20, `.t-label` + `.t-caption` description, chevron-right 16. Hover Sand, radius md. No cards, no dividers.
- **Zuletzt / Markiert views:** same cards, no hero, heading `.t-h2` in the hero's slot.
- **Empty state** (never opened anything): the main column below the strip is one Sand area, radius xl, SolarGlow `empty`. Centre: `.t-display` "Drop a PDF here." and 32 below a Ghost button "Oder öffnen" (40). The whole window is a drop target.

### 3.2 Editor (WorkSurface), ADR-102

**Grid.** Rows, Windows: **menu row 32** | **top bar 56** | **mode row 40** | **tool row 48** | **body 1fr**; macOS without the menu row (native bar, ADR-016). Body: **page sidebar 200 (200–320, splitter 8, collapsible, persists)** | **canvas minmax(360, 1fr)**. No right column, no rail. Tokens `--menubar-height`, `--mode-row-height`, `--tool-row-height`, `--minibar-height` (40), `--caption-button-width` (46). Body at 960 × 640: 464 (Windows) / 496 (macOS). Header rows White; borders under the top bar (as built) and the tool row only.

**Menu row (Windows only).** No border, empty space drags. From x 8: Datei · Bearbeiten · Ansicht · Werkzeuge · Hilfe, buttons 28 high, padding-x 8, radius sm, `.t-label` 400 Ink; hover Sand, open #E5E5E1, focus ring; §4 Menus 4 below, from `menu.json`. Right: caption buttons 46 × 32 (close hover `--color-danger`); hidden in full screen.
- Keyboard: Alt (alone) or F10 focuses Datei and shows mnemonics; Alt+D/B/A/W/H (en F/E/V/T/H) opens; Left/Right switch menus (wrapping); Down/Enter/Space open; Esc closes, then returns focus. ARIA `menubar`/`menuitem`, `aria-haspopup`, `aria-expanded`.
- Contents: Datei unchanged from `menu.json` (it already holds Save/Save As, Export copy, Export images, Compress, Protect, Document properties, Print, Close). Ansicht loses "Eigenschaften". Werkzeuge = the five modes as radio items, "1"–"5" as hint text only (never registered as accelerators), then Felder hervorheben, Signaturen verwalten; tool items go. macOS's native Werkzeuge matches.
- **Home has no menu row** (BRAND §26; its nav covers open, recent, tools). Home's Windows caption buttons also become 46 × 32 so they never jump between views (amends §3.1).

**Top bar** (White, 1px border bottom; empty space is the drag region). Grid `1fr auto 1fr`:
- Left: macOS inset 80 (8 in full screen) or 8 on Windows; Back chevron icon button 36; file name `.t-label` (max 240, double-click = Save As) or, with ≥ 2 documents, tabs (28 high, 96–200 wide, close icon on hover/active, §2.8). Unsaved state shows a 6px Ink dot before the name.
- Centre: zoom dropdown (88 × 36, value `tabular-nums`), 8 gap, page field "3 / 12" (field 48 + total).
- Right: Undo, Redo, Search (36, gap 4), tour pill, 12 gap, **Fertig** Primary 36 (Ink dot while unsaved), padding-right 16.
- **Export and More ⋯ leave** (BRAND §26): Datei and Ansicht hold every item.

**Mode row.** `role="tablist"` "Modus". Text tabs from x 16, 40 high, padding-x 12, gap 4, `.t-label`, §2.8 (inactive Text-secondary 400, hover Ink, active Ink 500 + 2px Solar underline), focus ring inset. **Lesen 1 · Kommentieren 2 · Ausfüllen & Signieren 3 · Seiten 4 · Bearbeiten 5** (kbd in tooltip).
- Keyboard: roving, Left/Right/Home/End move and activate; Tab goes to the tool row. Digits 1–5 work anywhere except with a modifier (Ctrl+1/2/0 stay zoom) or in inputs, contenteditable, live form fields, menus, dialogs.
- **Default:** Lesen on every open; hub cards land in their mode (Sign, Fill form → 3; Split → 4; Redact → 5). Kept per document tab for the session.
- **Switch:** the tool becomes Auswählen (a stroke in progress commits, ADR-056); the selection stays unless Seiten is entered or left; pending redaction marks and their band stay until Anwenden/Abbrechen. A v1.1 single-letter tool shortcut of another mode switches mode first. Underline moves in `--motion-fast` (none with reduced motion).

**Tool row** (1px border bottom). `role="toolbar"` named by the mode, padding-x 16, gap 4, **≤ 8 slots**. Item 36 high, radius md, padding-x 10, icon 18 + 6 + `.t-label` 500. Kinds: tool (active until Esc or Auswählen), toggle, action.
- States: hover Sand; pressed #E5E5E1, scale 0.98; active tool Solar + Ink 600 + `aria-pressed` (§2.3); toggle on Sand + Ink 600 + `aria-pressed`; disabled 0.4, tooltip says why.
- Keyboard: one Tab stop, Left/Right/Home/End, Enter/Space; Esc releases to Auswählen and focuses the canvas.
- **Variants = one slot**, split item: main part (last used variant's icon, family label) activates it; a 20-wide chevron part (own roving stop, or Alt+Down) opens a Menu of variants and, for colour tools, a swatch row.
- **Overflow** (never wraps or scrolls): 1. all labels; 2. inactive items icon-only 36 × 36 with tooltip; 3. items leave from the right into a "Mehr" ⋯ last slot (never the active tool). At 960 step 2 suffices.

**Tool assignment (binding: FEEDBACK F14, owner).** Every item shows icon + label; at most eight visible per mode, the rest under "Mehr" ⋯ as the last slot (overflow steps above). Keys 1–5 switch the mode; Esc returns to Auswahl in every mode (no Auswahl slot outside Lesen). Colour tools (marked °) carry the 20-wide chevron part with the swatch row of §1.4; [ ] = variants in the same slot.

| Mode | Slots, in this order |
|---|---|
| Lesen | Auswahl · Hand (pan by drag) · Textauswahl · Lupe (tool, and Z held anywhere on the canvas; spell 13 lens) · Drehen [rechts / links / zurücksetzen] · Suche (action: opens the Suche tab and focuses its field) |
| Kommentieren | Hervorheben° · Unterstreichen° · Durchstreichen° · Notiz° · Textkommentar° · Zeichnen° · Formen° [Rechteck / Ellipse / Linie / Pfeil] |
| Ausfüllen & Signieren | Text · Häkchen · Kreuz · Punkt · Datum · Signatur [saved items / Neue Signatur] · Initialen [saved items / Neue Initialen] — form fields are always live in every mode (banner, §3.2), they are not a slot |
| Seiten | Ordnen (default: select and drag cards) · Drehen [links / rechts] · Löschen · Einfügen [Leere Seite / Seiten aus Datei…] · Extrahieren… · Teilen… · Zusammenführen… · Komprimieren… |
| Bearbeiten | Text einfügen · Bild einfügen · Zuschneiden · Schwärzen · Schützen… (action) · Metadaten… (action: document properties) |

**Not in modes** (Datei menu and "Fertig"): Speichern, Speichern unter, Kopie exportieren, Als Bilder exportieren, Drucken, Formular reduzieren, Dokumenteigenschaften, PDF aus Bildern. Schützen and Komprimieren stay in Datei as well (ADR-102). No link authoring tool exists, so links get no slot.

**Mode Seiten.** The canvas shows the page grid (v1.1 §3.28 behaviour) on `--surface-page-area`, padding 24, gap 24, cards §2.2; the organize "Fertig" goes. Page actions are disabled until a card is selected; zoom is disabled, the page field follows the focused card.

**Page sidebar** (Canvas, no border). Icon tab row 48: four icon buttons 36 (Seiten, Gliederung, Kommentare, Suche), §2.8. Collapse chevron at the right of that row. Thumbnails: padding 24, width = column − 48, gap 16, White, border, radius sm; number `.t-caption` 8 below (§2.2). Outline, search and comment content keep their v1.1 row anatomy in the new tokens.

**Comments tab:** filter row 36 (type menu + "Nur offene" toggle). Row: White card, border, radius md, padding 12, gap 8 between cards: type icon 16 + excerpt (Ink, two lines, Solar 45 % behind for highlights) / comment `.t-body` / author · time `.t-caption` / actions Antworten, Erledigen, Löschen (ghost 28). Done rows: opacity 0.6, collapsed to the excerpt line, expandable.

**Canvas** (`--surface-page-area`): padding 24, page gap 24, pages White + `--shadow-floating`. No glow, no gradient. **Banner slot**: a 40-high row at the top of the canvas column (0 when empty; a second 40 row below it holds the docked mini bar, §3.3), so pages never sit under it:
- Form banner: Sand, padding-x 16, file-text icon 16, "Formular erkannt – 12 Felder · Zum ersten Feld" (link Ink underlined), close icon button 28.
- Redact band: `--color-danger`, white text 13/500 "Schwärzen ist endgültig", right: Button variant `ghostOnDanger` "Abbrechen" (white text, hover `--on-danger-hover` rgba(255,255,255,0.16)) and variant `onDanger` "Anwenden" (White fill, danger text; never the Solar primary on red). Marks preview as 2px danger outline + 12 % fill + hatch; applied = Ink fill.

**Selection popover:** over a text selection, 8 above (flips below), White, border, radius md, `--shadow-floating`, padding 4, height 36: Ghost buttons Markieren · Kommentieren · Kopieren (gap 4). Esc closes. Keyboard unchanged from v1.1 §3.59. It follows the mini bar's placement rules (§3.3).

### 3.3 Properties mini bar

Replaces the tool options panel. Visible only while canvas objects (annotations, marks, signatures, images, text boxes, redaction marks) are selected; not for text selections, form fields or page cards.

**Anatomy.** White, `--border-subtle`, radius md, `--shadow-floating`, padding 4, height 40, gap 4. Controls 32: swatches 24 in a 32 hit area (§2.7), icon buttons, dropdowns (`tabular-nums`). Group dividers 1 × 20 #E5E5E1. **Löschen** (trash-2, Ink) always last.

**Placement.** Anchor = selection box with handles, plus 8. Centred above → below → **docked** in the banner slot's second row (inset 16) when neither fits, so it never covers the selection or its handles. Clamped to the canvas with an 8 inset; follows scroll and zoom unanimated; hidden while dragging, resizing or drawing, back 120 ms after release. Enter opacity + 4 px rise, `--motion-fast`; reduced motion: opacity only.

| Selection | Controls |
|---|---|
| Highlight, underline, strike | highlight swatches (§1.4, + Custom) · kind segmented (3 icons) · Kommentar · Löschen |
| Notiz | highlight swatches · Kommentar öffnen · Löschen |
| Textkommentar, text box | stroke swatches · font size dropdown 8–72 pt (field 56) · Löschen |
| Ink, line, arrow | stroke swatches · stroke dropdown 0.5/1/2/4/8 pt (line preview) · opacity dropdown 25/50/75/100 % · Löschen |
| Rectangle, ellipse | as Ink + fill dropdown (Keine + highlight swatches) |
| Fill mark ✓ ✗ • | kind segmented · Löschen |
| Signature, initials, image, redaction mark | Löschen |
| Several | only controls common to all; mixed values show an empty ring or "–" |

Each change applies live as one undo step.

**Keyboard.** `role="toolbar"` "Eigenschaften: {type}"; the selection's `aria-describedby` mentions F6. F6 from a selection focuses the first control; Left/Right/Home/End roving; Enter/Space/Down open dropdowns; Esc or Shift+F6 returns to the selection (Esc again deselects).

**Defaults for the next annotation.** Last used wins per creation kind, kept in the `tools` store (UI storage): a mini bar change sets the default of that kind; the split menu's swatch row sets colour before drawing. First run: highlight Solar, strokes Ink 2 pt, text 12 pt.

### 3.4 Changes versus the wave 4 build

1. Right tool sidebar and rail removed (`src/features/tools/` replaced); `--tool-sidebar-width`, `--tool-rail-width`, `ui.inspector`, `toolSidebarCollapsed` deleted.
2. Windows menu row 32 restored with caption buttons 46 × 32; Home's caption buttons become 46 × 32; Home has no menu row.
3. Top bar: Export and More ⋯ removed, caption buttons leave it; Undo, Redo, Search, Fertig stay.
4. New mode row 40 (five text tabs, keys 1–5, Lesen default).
5. New tool row 48 (≤ 8 slots, split variants, three-step overflow).
6. Seiten mode shows the page grid in the canvas; the organize "Fertig" goes.
7. Disclosure panels replaced by the properties mini bar; defaults are last used.
8. Werkzeuge menu lists modes; Ansicht loses "Eigenschaften".
9. Page sidebar, comments tab, canvas and banners stay as built; the banner slot gains the mini bar dock row.

### 3.5 F15 shell polish (FEEDBACK F15 block B, ADR-104, ADR-108)

Binding for B1–B5 and B8–B12 (B6/B7 are signature work, not shell). It overrides §3.2–§3.4 where they differ. New tokens go into `tokens.css`; strings into `en.json`/`de.json` with the keys given (en / de).

**B1 Save status.** Fertig is removed from the top bar (its slot closes up; the tour pill gets padding-right 16). A status button sits 8 right of the file name (or of the tab strip with ≥ 2 documents; it shows the active tab). Ghost, height 28, padding-x 8, radius sm, gap 4, `.t-caption`; the 6px Ink dot before the name goes (per-tab dots on tabs stay).

| State | Shows | Click | Tooltip |
|---|---|---|---|
| Saved | `check` 16 Text-secondary + "Saved" / "Gespeichert" (`save.status.saved`) | none (`aria-disabled`) | — |
| Unsaved | 6px Ink dot + "Edited" / "Geändert" (`save.status.edited`), Ink | saves | "Save" / "Speichern" + kbd Ctrl/Cmd+S |
| Never saved (new from images, merge) | dot + "Not saved yet" / "Noch nicht gespeichert" (`save.status.new`) | Save As | + kbd Ctrl/Cmd+S |
| Saving | "Saving…" / "Wird gespeichert…" (`save.status.saving`), no spinner, shown only after 200 ms | none | — |
| Failed | `triangle-alert` 16 + "Not saved" / "Nicht gespeichert" (`save.status.failed`), `--color-danger` | retries | the error message |

- Ctrl/Cmd+S saves (Save As when never saved); Ctrl/Cmd+Shift+S Save As; both work in every mode and from text inputs (an edit in progress commits first). The success cue is MOTION spell 6 (now in this slot).
- Below 1100 window width the label hides; icon/dot stays, `aria-label` carries the text. `role="status"` region next to the button announces "Saved" politely.

**B2 Sidebar toggle.** Top-bar icon button 36, left group: Back · **sidebar toggle** · file name (gap 4). Icon `panel-left-close` (open) / `panel-left-open` (closed), Ink, `aria-pressed`, `aria-controls` = sidebar id. Tooltip "Hide sidebar" / "Seitenleiste ausblenden" (`sidebar.hide`) or "Show sidebar" / "Seitenleiste einblenden" (`sidebar.show`) + kbd Ctrl+Alt+1 (macOS ⌘⌥1). The collapse chevron in the sidebar's tab row is removed (one control per edge).
- **Grip:** on the splitter (8 wide, existing slot), centred vertically: 4 × 32 pill, `--radius-pill`, #E5E5E1; hover/drag Stone, cursor `col-resize`. Click (no drag, < 4 px movement) collapses. When collapsed the splitter stays as an 8-wide track at the canvas's left edge showing the grip; click or drag > 48 reopens. Keyboard: splitter is `role="separator"` `aria-orientation="vertical"` with `aria-valuenow`; Left/Right ± 16, Enter toggles collapse. View → Sidebar stays (same action). Motion: spell 14.

**B3 One bar (decision: segmented control).** Mode row and tool row become one Sand bar (`--surface-subtle`), heights unchanged (40 + 48 = 88), no line between the tiers, 1px #E5E5E1 border below the bar only; the top bar keeps its border. Why not the yellow underline: Solar on Sand is 1.02:1 (fails §2's 3:1), and a Solar line directly above the Solar active tool reads as two "active" signals in one bar; BRAND §4 keeps Solar for active tools. The segmented control uses §2.10 (Stone border on Sand 3.18:1 + weight + White fill), so yellow stays the tool's cue alone.
- **Mode tier (40):** segmented control from x 16, height 32 centred (4 above/below), track transparent with a 1px #E5E5E1 outline (decorative), radius md, padding 2. Segments 28 high, radius sm, padding-x 12, gap 2, `.t-label`: inactive Text-secondary 400 (4.63:1 on Sand); hover `--segment-hover` rgba(255,255,255,0.6) + Ink; active White + 1px Stone border (3.18:1 vs Sand, 3.47:1 vs White) + Ink 500. Width hugs labels and never wraps (five de labels ≈ 560 at 960). Roles and keys as §3.2 (tablist, roving, 1–5); focus ring on the segment. New tokens: `--segment-height` 28, `--segment-hover`.
- **Tool tier (48):** as §3.2 except colours on Sand: hover White, pressed #E5E5E1 + 0.98, active tool Solar + Ink 600 + `aria-pressed` + a 1px Ink inset hairline `--tool-active-edge` (Solar vs Sand is 1.02:1, so the hairline carries the boundary, 18:1); toggle on White + Stone border + Ink 600. Separators: none between items; a 1 × 20 #E5E5E1 divider 8 before "Mehr". "Mehr" stays the last slot; overflow steps unchanged.
- Deliverable: before/after screenshots at 1280 × 800 and 960 × 640 in `review/f15/b3-*.png`.

**B4 Text comment.** In Textkommentar, one click on a page creates the box with its top-left at the click and puts the caret in it; no double-click. Edit box: padding 4 pt, min width 24 pt, height one line. It grows to the right with the text up to **max width = min(288 pt, page right edge − x − 12 pt)**; if that is < 96 pt the box is shifted left so it gets 96 pt. Beyond max width it wraps at word boundaries (long words break), height grows downward without limit (page bottom: the box keeps growing; it is never shifted after creation). Enter commits, Shift+Enter breaks the line (A7); click outside or Esc commits; an empty box is deleted on commit (no undo step). Double-click an existing box edits it; drag moves it in any tool (A4). Placeholder while empty: "Type…" / "Text eingeben…" (`textComment.placeholder`), Text-secondary.
Mini bar (replaces the Textkommentar row in §3.3): text colour (B5) · font size dropdown, steps 8, 9, 10, 11, 12, 14, 16, 18, 24, 32, 48, 72 pt, field 56 also accepts 6–144 typed · divider · align segmented: `align-left` / `align-center` / `align-right` (`align.left/center/right`: Left/Links, Centre/Zentriert, Right/Rechts) · divider · **Border** split toggle (`square`; menu: colour B5 + width 0.5/1/2 pt; `textComment.border` Border/Rahmen) · **Fill** split toggle (`paint-bucket`; menu: highlight palette + B5; opaque fill; `textComment.fill` Fill/Füllung) · Löschen. First-run defaults: Ink 12 pt, left, border off, fill off; then last used wins (§3.3).

**B5 Colour control.** In every mini bar and split menu swatch row: palette swatches (§1.4, strokes or highlights by context), then up to **3 recent custom** swatches, then a "More colours" swatch (24, Stone ring, `plus` 16; `color.more` More colours / Weitere Farben). It opens a popover (240 wide, §4): palette grid (6 per row) · "Recently used" / "Zuletzt verwendet" (`color.recent`) row of up to **8**, newest left, deduplicated, hidden when empty · hex row: preview swatch 24 + input (height 32, static "#" prefix, 6 chars, `font-variant-numeric: tabular-nums`, `aria-label` "Hex colour" / "Hex-Farbe" `color.hex`) + Primary "Apply" / "Übernehmen" (`color.apply`, 32).
- Input accepts 3 or 6 hex digits, with or without "#", case-insensitive (paste trims spaces); normalised to 6 uppercase. Live preview while valid. Invalid (other chars or 1, 2, 4, 5 digits on Enter/blur): §4 input error, caption "Use 3 or 6 hex digits, e.g. 1F9E6A" / "3 oder 6 Hex-Ziffern, z. B. 1F9E6A" (`color.hexInvalid`), Apply disabled, `aria-invalid`. Strokes with < 3:1 on white get a non-blocking caption "Low contrast on white" / "Wenig Kontrast auf Weiß" (`color.lowContrast`). Highlight customs render at 45 % multiply like the palette.
- Recent list: one list for the app (not per document), max 8, UI storage key `sheer.tools.recentColors`; a colour enters it on Apply. Keyboard: arrow keys move across swatches (grid), Enter picks, Tab reaches the input, Esc closes and returns focus.

**B8 Derived outline.** When the file has no bookmarks, the Outline tab shows a heuristic outline (Rust; font size/weight ranks, max 3 levels, ≤ 200 entries). Above the tree: a 32-high info row, Sand, radius sm, margin 8, padding-x 8: icon `wand` 16 Text-secondary + `.t-caption` "Derived from headings" / "Aus Überschriften abgeleitet" (`outline.derived`) with tooltip "Not stored in the file. Add bookmarks to replace it." / "Nicht in der Datei gespeichert. Lesezeichen ersetzen es." (`outline.derived.hint`). Rows are Text-secondary 400 (real outlines Ink). Nothing found: existing empty state "No outline" / "Keine Gliederung". The tree's `aria-describedby` points at the info row.

**B9 Comment margin.** Shown when the document has ≥ 1 annotation with comment text or replies (notes, markup with a comment, any annotation with replies; a text comment's own text is not a bubble). In every mode except Seiten. View → "Comments in margin" / "Kommentare am Rand" (`menu.view.commentMargin`, checkable, default on, persists).
- **Slot:** inside the canvas scroll content, a column right of the page stack: `--margin-gap` 16 between page edge and column, `--margin-width` 240. Pages + gap + column are centred as one unit. Fit width / fit page subtract 256 from the available width. Bubbles do not scale with zoom; their y follows the anchor's top at every zoom.
- **Narrow:** when canvas width − 48 − 256 < 360, the column collapses to `--margin-width-compact` 32: one 24 avatar marker per bubble at its anchor height; click/Enter opens that bubble as a popover (anchored left of the marker, 240 wide). The collapse never hides the page.
- **Collision:** bubbles keep document order (page, then anchor y). Each bubble's top = max(anchor y, previous bottom + 8). The focused/selected bubble is placed at its anchor first and the others re-stack above and below it. Bubbles may flow into page gaps; never across the column edge.
- **Leader:** none at rest. Hover or focus on a bubble (or its anchor): a 1px Stone line from the bubble's left edge to the anchor's right edge, plus the anchor's §2.1 outline pair; shown only when the bubble sits > 8 off its anchor.
- **Bubble:** Solar (`--note-bubble` = `--accent`), radius lg with the top-left corner radius sm (note-paper corner, points to the anchor), `--shadow-standard`, padding 12, gap 8. Header row 24: avatar 24 round, Ink fill, White initial 12/500 (no author: `user` icon 14), 8 gap, name `.t-label` Ink (ellipsis), date `.t-caption` **Ink** right ("Today 14:05"/"Heute 14:05", else locale short date; Text-secondary is 4.53:1 on Solar, too tight). Body `.t-body` Ink, 6 lines then "More" / "Mehr" (`comment.more`). Replies below, each: avatar 20 + name + date + text, divider rgba(15,15,15,0.12) above. Reply field: White, height 32 (grows to 4 lines), radius sm, placeholder "Reply…" / "Antworten…" (`comment.reply`); Enter sends, Shift+Enter breaks. Resolve: icon button 28 `check` top-right in the header, tooltip "Resolve" / "Erledigen" (`comment.resolve`); ⋯ 28 menu: Edit, Delete. Selected: + 1px Ink ring, `--shadow-floating`. Resolved: White, `--border-subtle`, opacity 0.6, collapsed to the header + first line, "Reopen" / "Wieder öffnen" (`comment.reopen`).
- **Keyboard:** the column is a `role="list"` after the page in Tab order; Up/Down move between bubbles, Enter expands/edits, Esc returns to the anchor. Each bubble `aria-label` "{type} by {author}, page {n}".
- **Left panel:** first line of each card = comment text (`.t-body`, 2 lines, ellipsis); if empty, the excerpt; if none, the type label. Type icon stays left.

**B10 Comments filter and sort.** The filter row (36) becomes: "Filter" Ghost (`list-filter` 16 + label, count chip `.t-caption` when active; `comments.filter` Filter/Filter) flex-1 · sort icon button 28 (`arrow-down-up`). Filter opens a popover (width = panel − 16, max 320): **Type** checkboxes with icons, **Author** checkboxes (document authors + "No author", hidden when only one), **Page** radios All / Current / From–to (two 48 fields), **Status** segmented All / Open / Resolved (`comments.status.all/open/resolved`: Alle/Offen/Erledigt). Footer: "Reset" / "Zurücksetzen" ghost. Sort menu (checked item): Page / Seite (default), Date, newest first / Datum, neueste zuerst, Author A–Z / Autor A–Z. When filtered, a caption under the row: "3 of 12 · Reset" / "3 von 12 · Zurücksetzen". No match: centred `.t-caption` "No comments match these filters." / "Keine Kommentare passen zu den Filtern." + Ghost Reset. Filters live per document for the session; sort persists in UI storage (`comments.sort`).

| Type (key `comments.type.*`) | en / de | Lucide 16, Text-secondary | Includes |
|---|---|---|---|
| highlight | Highlight / Markierung | `highlighter` | highlight, underline, strikeout |
| note | Note / Notiz | `sticky-note` | notes, text comments |
| drawing | Drawing / Zeichnung | `pen-line` | ink |
| shape | Shape / Form | `shapes` | rectangle, ellipse, line, arrow |
| signature | Signature / Signatur | `signature` | signatures, initials |
| quote | Quote / Zitat | `quote` | comments made from a text selection |

**B11 Shapes.** Pfeil (variant of Formen, `move-up-right`): a line with an open head at the end (PDF Line, `LE /OpenArrow`), head length 3 × stroke + 6 pt, 30° half-angle; Shift snaps to 15°. Mini bar = Ink/line row + "Ends" dropdown: End / Both (`shape.arrowEnds`).
- **Recognition** (Zeichnen only): after a stroke, holding the pointer still (≤ 4 px for **`--hold-shape` 500 ms**) while still pressed snaps it to circle, ellipse, axis-aligned rectangle (within 10°), line or arrow (line + hook ≤ 35 % of its length at the end). Not confident → nothing happens. Feedback: MOTION spell 20; the snapped shape uses the stroke's colour and width. Moving after the snap, before release, resizes it (end point / opposite corner). Release commits a real shape annotation; Ctrl/Cmd+Z once returns the freehand stroke. Esc during the hold cancels the snap.
- **Off switch:** Settings → new group "Drawing" / "Zeichnen" (`settings.drawing`) → toggle "Recognise shapes when you pause" / "Formen beim Innehalten erkennen" (`settings.shapeRecognition`), default on; mirrored as a checkable item at the bottom of the Zeichnen split menu. UI storage `tools.shapeRecognition`.

B12 canvas drift: removed after the legibility test (ADR-108 (3)).

### 3.6 R6 onboarding, tour, settings, tips

Binding for R6 (brief R6). A delta on the built `src/features/tour`, `settings`, `tips`: v1.1 behaviour (DESIGN v1.1 §3.14, §3.47) stays unless changed here. Coach mark and tip join §3's list of floating surfaces; they never cover their anchor, the canvas target, a selection or the mini bar (when the mini bar appears, they re-place to the anchor's other side, else dock bottom-right of the canvas, inset 16). WorkSurface: no glow, no scrim (§5's "coach marks' backdrop" does not exist; the tour is non-modal).

**Coach mark anatomy.** White (`--surface-panel`), `--border-control` (Stone), `--radius-lg`, `--shadow-floating`, width `--popover-max` 320 (max: canvas − 32), padding 16, no arrow. Top to bottom:
1. **Progress bar**, full card width inside the padding: track #E5E5E1 (`--color-track`), fill Solar, height **`--progress-height` 4** (new token), `--radius-pill`; fill = completed steps / total. Decorative (`aria-hidden`); the count carries the information (§2).
2. **Header row 24**, 12 below the bar: count "2 / 7" `.t-caption` Text-secondary, `tabular-nums` (`tour.count`, `aria-label` = `tour.stepOf`); right: Hide icon button 28 (`x`, `tour.hide`).
3. **Title** `.t-title` Ink, 8 below; done phase: `check` 16 Ink + `tour.done`.
4. **Body** `.t-body` Ink, 4 below, max 4 lines (texts are written to fit).
5. **Footer row 28**, 16 below: left Ghost "Skip tour" (`tour.skip`); right, gap 8: Secondary "Back" (`tour.back`), Primary "Next" (`tour.next`; last step "Finish", `tour.finish`). All size 28 (`--control-sm`), `.t-label`.

**States.** Waiting: Next advances without doing the step (the step counts as skipped, the bar fills anyway). Done: the bar fills to the step, title shows the check, the card auto-advances after `--hold-check` 600 as built; Next advances at once. Back: disabled (0.4, `aria-disabled`) on step 1; else shows the previous step in its last phase (done stays done; nothing in the document is undone). Finishing: card goes, pill says "Tour complete" (as built). Store gains `next()` and `back()`.

**Placement.** Gap 8 (`--space-2`) between card and anchor, no arrow. Top bar anchors: below, `align` as the anchor table. Tool tier and mode segments: below, centred. Sidebar toggle: below, start. Thumbnails: right, centred. Canvas targets: below, flip above, never over the target. Clamped inside the canvas scroller, inset 16 (as built, incl. `--canvas-extra-scroll`). An anchor moved into "Mehr" ⋯ anchors the ⋯ item; nothing on screen → the page field, then the canvas centre. **Anchor ring:** §2.1 pair (1px Ink + 2px Solar outline, offset 2) on the anchor; success = opacity 1→0.4→1, 2 × `--motion-fast`.

**Keyboard and ARIA.** `role="region"` labelled by the title; never takes focus when it appears; each new step is announced politely (`tour.announce`). Tab order: Hide, Skip, Back, Next. Enter on the pill shows the card and focuses Next. Esc inside hides the card and returns focus (as built). The anchor gets `aria-describedby` = body (as built).

**Motion.** Card enter: opacity + `--scale-enter`, `--motion-slow`; exit `--motion-slow-exit`; steps re-key (exit then enter). Bar fill: `scaleX` from the start edge, `--motion-base`. Reduced motion: card fades `--motion-fast`, bar jumps, no ring pulse (ring stays static).

**Steps** (7, unchanged order; anchors renamed because the status bar is gone, ADR-102/108). Anchors in the top bar switch from `side: top` to `bottom`; the auto mode switch in `useAnchor` goes: the step first anchors the mode segment until the user enters the mode.

| Step | Anchor change | New text (en / de) |
|---|---|---|
| open | `status-file-name` → `topbar-file-name` (file name or active tab, bottom/start) | unchanged |
| navigate | `status-page-button` → `topbar-page-field` (bottom/center) | "Scroll down, press Page Down or type 2 in the page field." / "Scrolle nach unten, drücke Bild ab oder tippe 2 ins Seitenfeld." |
| zoom | `toolbar-zoom-in` → `topbar-zoom` (zoom dropdown, same selector) | "Press {mod} and + or pick a level in the zoom menu." / "Drücke {mod} und + oder wähle eine Stufe im Zoom-Menü." |
| highlight | phase 0 `mode-comment` (segment, `data-tour-anchor="mode-comment"`), then `tool-highlight` | "Switch to Comment (2), choose Highlight, then drag across the sentence in the frame." / "Wechsle zu Kommentieren (2), wähle Hervorheben und ziehe über den Satz im Rahmen." |
| comment | `tool-note` (mode already Comment, else `mode-comment`) | "Choose Note, then click the dot. The note appears in the margin." / "Wähle Notiz und klicke auf den Punkt. Die Notiz erscheint am Rand." |
| sign | phase 0 `mode-fill`, then `tool-signature` | "Switch to Fill & Sign (3), choose Signature, then drag it into the frame." / "Wechsle zu Ausfüllen & Signieren (3), wähle Signatur und ziehe sie in den Rahmen." |
| reorder | `left-panel` (`[data-toolbar-item="left-panel"]`, **no longer exists**) → `sidebar-toggle` (`[data-sidebar-toggle]`); then Pages tab, thumbnail S; in Seiten mode the grid card (as built) | "Open the sidebar's Pages tab and drag page {from} above page {to}." / "Öffne in der Seitenleiste den Tab Seiten und ziehe Seite {from} über Seite {to}." |

Keys: `tour.step.navigate.text`, `.zoom.text`, `.highlight.text`, `.comment.text`, `.sign.text`, `.reorder.text` change in place. `LAST_RESORT` uses `topbar-page-field`, then `topbar-file-name` (both bottom). No step targets "Fertig" or the save status.

**Tab rule** (F11-7 kept). The tour always runs in its own welcome tab and never closes, replaces or saves another document. Restart: reuse an open welcome tab only if it has no edits; otherwise open a fresh welcome tab. **Change:** activating another tab no longer ends the tour; it **pauses** (card and ring hidden, pill shows "2 / 7" with `pause` 16); clicking the pill re-activates the welcome tab and resumes. Closing the welcome tab ends the tour (`tour.closed`, as built).

**Tour pill.** Right cluster of the top bar: Undo · Redo · Search, 12 gap, pill, padding-right 16 (Fertig's slot closed, §3.5 B1). Height 28, `--radius-pill` (added to its allowed uses), Sand fill, padding-x 10, gap 4, `compass` 16 Ink + "Tour 2 / 7" `.t-caption` Ink 500 `tabular-nums` (`tour.pill`). Below 1100 window width: "2 / 7" only, `aria-label` keeps the full text. States: hover #E5E5E1; pressed 0.98; card shown (`aria-expanded=true`) adds a 1px Stone border; paused `pause` icon, `tour.pillPaused` label; finishing `check` + "Tour complete". Exists only while a tour runs. Enter: opacity + 8 px rise `--motion-slow` (reduced: opacity, fast).

**Settings panel.** Popover (§4), 320 wide, padding 16, max height window − 32 (scrolls inside), anchored as built, Ctrl/Cmd+, opens. Title `.t-title` "Settings" (`settings.title`). Groups top to bottom, gap 16; each = label `.t-label` Ink 500, control 8 below, hint `.t-caption` 4 below:
1. **Language** (`settings.language`): Segmented System / English / Deutsch.
2. **Author name** (`settings.author`): Input 36, hint as built.
3. **Drawing** (`settings.drawing`): Toggle "Recognise shapes when you pause" (§3.5 B11).
4. **Updates** (`settings.updates`): opt-in Toggle + status as built; the **whole group is not rendered** while the updater is unconfigured (ADR-053).
5. **Tour & tips** (`settings.tour` "Tour & tips" / "Tour & Tipps"): Secondary "Restart tour" / "Start tour" (as built) + Ghost "Show tips again"; hint live.
6. **About** (`settings.about` "About" / "Über"), after a 1px #E5E5E1 divider (16 above/below): `.t-caption` "sheer. · Version 1.2.0" (`APP_NAME` + `about.version`), Ghost "About sheer." (`about.title`) opens the About dialog.

**Removed:** Signatures row (Werkzeuge → Signaturen verwalten holds it), Default PDF app row (moves to Hilfe on Windows, same key `settings.defaultApp.button`). No theme, no glass, no density option; a test asserts the six group labels and nothing else. Keyboard: Tab follows group order; Esc closes and returns focus to the anchor.

**Tips.** White, `--border-subtle`, `--radius-lg`, `--shadow-floating`, max width 280, padding 12, gap 8: `lightbulb` 16 Ink (the Sand tile goes) · text `.t-body` Ink · Hide icon button 28 (`tip.dismiss`). Slot: 8 below the tool item in the tool tier (⋯ when in Mehr), centred, clamped inside the canvas scroller inset 8. Rules: each tip shows **once ever** (written to `tipsSeen` before it shows, as built); **at most 3 per session** (new: a session counter in `runtime.ts`; "Show tips again" clears `tipsSeen` but not the cap); never while a tour runs or is paused; never while a coach mark, menu, dialog or popover is open; goes when its tool is released. No timeout. Motion: as the coach mark card; reduced: opacity fast.

| Tip id | Tool | Text change (en / de) |
|---|---|---|
| highlight | Hervorheben | "Drag across text. Underline and Strikethrough sit next to it." / "Über den Text ziehen. Unterstreichen und Durchstreichen liegen daneben." |
| note | Notiz | "Click where the note belongs. Reply to it in the margin." / "Dort klicken, wo die Notiz hingehört. Antworten am Rand." |
| text | Textkommentar | "Click and type. The box grows as you write; Shift+Enter adds a line." / "Klicken und tippen. Das Feld wächst mit; Umschalt+Enter fügt eine Zeile ein." |
| draw | Zeichnen | "Pause before you let go to turn a stroke into a shape." / "Vor dem Loslassen kurz innehalten macht aus dem Strich eine Form." |
| shapes | Formen | "Hold Shift to keep proportions. More shapes are in the arrow menu." / "Umschalt hält die Proportionen. Weitere Formen im Pfeilmenü." |
| crop | Zuschneiden | "Drag the edges of the frame to crop." / "Zum Zuschneiden die Kanten des Rahmens ziehen." |
| sign, pages, insertText, redact | as built | unchanged |

**New i18n keys** (en / de): `tour.count` "{step} / {total}" (both); `tour.back` Back / Zurück; `tour.finish` Finish / Abschließen; `tour.pillPaused` "Welcome tour paused. Return to the welcome document" / "Willkommenstour pausiert. Zurück zum Willkommensdokument"; `settings.tour` Tour & tips / Tour & Tipps; `settings.about` About / Über. Obsolete: `settings.help`, `settings.signatures`, `settings.signatures.hint`. Token addition: `--progress-height` 4.

### 3.7 v1.3 Citations (ADR-119)

Binding for v1.3.1–v1.3.4. The data model, storage and file formats are ADR-119's; this section defines looks, slots, keys and strings. The ADR-102 mode layout stays: **no new mode, no new left-panel tab, no new grid track**. New surfaces are popovers, a dialog tab and margin bubbles, all slots §3 already has. New tokens: §1.2 (`--chip-height`, `--tag-dot`, `--citation-default`, `--preview-min-height`). Light only, as the file header says.

**Alignment with ADR-119 (orchestrator):** tags are global (one list in settings, shared by all documents; assignments travel in the file). A selection across pages creates one citation per page with a shared group: each page gets its own highlight and bubble, the Comments tab lists them as adjacent cards, and the formatted citation and the citation list join a group's pages into one locator ("pp. 12–13" / "S. 12–13"). Save list… also offers RIS (.ris) and BibTeX (.bib), which hold the reference only (`reference.format.ris` / `.bib`: "RIS (reference managers)" / "RIS (Literaturverwaltung)", "BibTeX" / "BibTeX"). Component and file names in the ADR package cut follow this section (margin bubble, Reference tab, export popover), not the ADR's working names.

**C1 Citation look.** A citation is a text-markup annotation with two cues, so it never relies on colour (§2):
1. **Fill** from the highlight palette (§1.4, 45 % multiply); first run `--citation-default` (Lavender), then last used (§3.3 defaults, kind `citation`). Why Lavender: Solar is the plain highlight's default, so the two differ at first sight without a hue outside §1.4.
2. **Underline**: a 1 pt solid rule at each line's baseline in the fill's stroke partner (`--stroke-lavender` #9278E6, 3.3:1 on white; Mint/Sky/Rose likewise; Solar or a custom fill gets Ink). It is part of the appearance, so the cue survives print and other readers. A plain highlight has no rule; an underline annotation has no fill.
3. In the app: a White margin bubble with a `quote` icon (C3); type icon `quote` in the Comments tab.

**C2 Entry points** (all act on the current text selection, or create one by dragging):
- **Selection popover** (§3.2): Markieren · **Zitieren** · Kommentieren · Kopieren (Ghost, gap 4; height 36 unchanged). `aria-keyshortcuts` Primary+Shift+C.
- **Tool**: Kommentieren row slot 4, **Hervorheben° · Unterstreichen° · Durchstreichen° · Zitieren° · Notiz° · Textkommentar° · Zeichnen° · Formen°** (8 = the §3.2 maximum; at 960 overflow step 2 suffices). Icon `quote`, colour tool (split chevron + highlight swatch row), key **Q** (free; canvas scope like the other tool letters). Drag across text = MOTION spell 5 in the citation colour plus the rule; cursor = marker (spell 12). Tooltip tip id `cite`: "Drag across a passage. The citation and its page go to the margin." / "Über eine Passage ziehen. Zitat und Seite erscheinen am Rand."
- **Shortcut** Primary+Shift+C (free in the registry; never Primary+Shift+Q, which logs out on macOS).
- **Menu**: Bearbeiten → "Cite Selection" after "Add Comment" (disabled without a text selection). Datei → "Copy Citation List" and "Save Citation List…" after "Document Properties…".
- Result: the selection clears, the bubble enters (spell 22, new bubble), focus stays on the canvas, a polite announcement `citation.added`. No toast. One undo step (spell 7). Selection with no extractable text (scan, image): nothing is created, toast `citation.noText`.

**C3 Citation bubble** (margin column, B9 slot and collision rules; the margin now shows when ≥ 1 citation exists, View → Comments in margin covers both). White, `--border-subtle`, radius lg with top-left radius sm, `--shadow-standard`, padding 12, gap 8, width `--margin-width`.
- **Header 24:** `quote` 16 Ink · 8 · page label `.t-label` Ink "p. 12" / "S. 12" (`citation.page`; the PDF's page label when the file defines labels, e.g. "p. xii", else the page number) · right, icon buttons 28: Tags (`tag`), Copy citation (`copy`), ⋯ (Add comment, Edit reference…, Delete).
- **Quote** `.t-body` Ink in locale quotation marks (“…” / „…“), 4 lines then "More" (`comment.more`).
- **Short citation** `.t-caption` Text-secondary (4.98:1 on White) in the current style, e.g. APA "(Müller, 2021, p. 12)", DIN "(Müller 2021, S. 12)". "p."/"S." follow the UI language. Missing author or year renders the style's own fallback ("n.d." / "o. J.") plus a link-button "Add reference details" (`citation.addDetails`, Ink underlined) that opens C5 on the Reference tab.
- **Chips row** (C6), then the optional comment and replies exactly as B9 (divider rgba(15,15,15,0.12) above). Selected: 1px Ink ring + `--shadow-floating`. Leader as B9.
- **Narrow margin:** the 24 marker is White, 1px Stone ring, `quote` 14 Ink (instead of the avatar); click/Enter opens the bubble as the B9 popover.
- **Keyboard:** in the B9 `role="list"`; `aria-label` `citation.aria`. Tab inside: Tags, Copy, ⋯, "More", "Add reference details". Copy writes quote + short citation (`citation.copied` toast).

**C4 Mini bar row** (adds to §3.3). Citation: highlight swatches · Open citation (`quote`, focuses the bubble) · Copy citation (`copy`) · divider · Tags (`tag`) · Löschen. The Tags button (C6) also joins the highlight/underline/strike, Notiz, Textkommentar, Ink/line/arrow and rectangle/ellipse rows, before Löschen with a divider; never for fill marks, signatures, images, redaction marks.

**C5 Reference (document metadata).** Opens in the existing Document properties dialog (Datei → Document Properties…, Bearbeiten mode "Metadaten…", C3 "Add reference details", C7 "Edit reference…"), so no new surface. The dialog gains Tabs (§4, 36) under the header: **General** (today's content, unchanged) · **Reference**; width `--sheet-width` 560 (was `--dialog-width-md`); max height window − 64, the tab body scrolls, header, tabs and footer stay. The footer (Cancel · Apply) is shared; Apply writes both tabs as one undo step and sets the save status to Edited (B1). The last tab is not remembered; entry points that name Reference open it.
- **Order:** Type dropdown (book · article · chapter · report · web page · thesis; default from the heuristic, else article) · Title · Authors · Year (field 88, `tabular-nums`) · type fields (table) · Preview (as C7, style from storage).
- **Authors:** ordered list, rows 36, gap 8: `grip-vertical` 16 drag handle (Text-secondary, cursor grab) · Family name · Given name (two inputs, 1fr each, gap 8) · Remove `x` 28. An empty given name means an organisation. Below: Ghost "Add author" (`plus`), focuses the new row's family field. Reorder: drag the grip (rows jump, no animation, so no new spell) or Alt+Up/Down inside a row's input; announces `ref.authorMoved`.
- **Source captions:** right of each label, `.t-caption` Text-secondary: "from the file" (Info/XMP), "from page 1" (first-page heuristic), "edited" (user value). Edited fields with a file value show a 28 `rotate-ccw` icon button "Use the value from the file". No caption for empty fields.
- **States:** loading = skeleton inputs (spell 15). Nothing found or extraction failed = a 32 Sand info row (as B8, `info` 16) `ref.nothingFound`, all fields empty and editable. Validation on blur (§4 input error): year 4 digits, DOI starts "10.", URL http(s) only; invalid values block Apply with `aria-invalid`. Read-only or permission-restricted document: inputs render as read-only text with caption `tool.readOnly`; preview and export (C7) still work. Encrypted files: only after unlocking (as built); the same rules apply.

| Type | Fields after Year (labels `ref.*`) |
|---|---|
| Book | Edition · Publisher · Place · DOI · URL |
| Article | Journal · Volume · Issue · Pages · DOI · URL |
| Chapter | Book title · Pages · Edition · Publisher · Place · DOI |
| Report | Institution · Place · DOI · URL |
| Web page | Website · URL · Accessed (date input, default empty) |
| Thesis | Institution · Place · URL |

Accessed also appears for any type once URL is filled. Values of fields hidden by a type switch are kept until Apply and dropped then.

**C6 Tags.** Coloured categories for comments and citations. Colours: the five §1.4 highlight swatches only (no custom, no B5 "More colours"); tags may share a colour.
- **Chip:** White, `--border-subtle`, `--radius-pill`, height `--chip-height`, padding-x 8, gap 4: dot `--tag-dot` in the tag colour with a 1px Stone ring (§2.7; Solar on white is decorative, the name carries the meaning) + name 12/16 Ink, max 120, ellipsis. White fill keeps chips legible on Solar note bubbles. Bubbles and Comments-tab cards show up to 3 chips, then a "+2" chip (`tags.more`) with the rest in its tooltip.
- **Tag picker** (Tags buttons in C3, C4, card ⋯): Popover 240, padding 4: search input 32 "Find or create tag" (shown always) · checkbox menu items 32 (dot + name + check) · "Create “{name}”" item when the text matches no tag (next palette colour in order) · divider · "Manage tags…". Toggling applies at once, one undo step each. Keyboard: focus starts in the input, Down enters the list, Space toggles, Esc closes and returns focus.
- **Tag manager** (from "Manage tags…" in the picker and the C8 filter popover; replaces the opener in the same anchor): Popover 320, padding 16, title `.t-title` "Tags". Rows 36, gap 4: swatch button 24 (Menu with the five swatches, §2.7) · name input 32 (borderless until hover/focus, then §2.9) · usage count `.t-caption` `tabular-nums` · Delete `trash-2` 28. Footer Ghost "New tag" (`plus`, adds a row with the name focused). Name: 1–40 chars, unique ignoring case (`tags.duplicate`), empty on blur reverts; max 64 tags (`tags.limit`, New tag disabled). Delete removes the tag from every annotation using it, one undo step, toast `tags.deleted` + Undo. Empty: `.t-caption` `tags.empty` + New tag. Scope (app or document) per ADR-119; on a read-only document assignment is disabled (`tool.readOnly` tooltip).

**C7 Reference popover (export).** The B10 filter row becomes: Filter (flex-1) · **Reference** icon button 28 `book-marked` (tooltip `reference.button`) · sort 28. Popover width = panel − 16, max 320, padding 16, gap 12, top to bottom:
1. "Citation style" `.t-label` + dropdown 36 full width: APA 7 · MLA 9 · Chicago (author-date) · DIN ISO 690. UI storage **`sheer.citations.style`**; first run APA 7 in every UI language (owner 2026-10-05), then the last chosen style. Changing it updates every short citation in bubbles and cards.
2. Preview: label `.t-caption` "Preview", box Sand, radius sm, padding 12, min height `--preview-min-height`, `.t-body` Ink, 24 hanging indent, italics as the style requires, `aria-live="polite"`. Missing title/author/year: `.t-caption` `triangle-alert` 16 Ink + `reference.missing`.
3. Secondary 32 "Copy reference" (toast `reference.copied`).
4. Divider; "Citation list" `.t-label` + count `.t-caption` (`reference.count`); row: Secondary 32 "Copy list" · Secondary 32 "Save list…" (native save dialog, filters .txt / .html / .md per ADR-119, default name "{file name} – citations", last format in **`sheer.citations.format`**). List = reference, then every citation in page order (page label, quote, short citation). No citations: both disabled (tooltip and caption `reference.empty`).
5. Ghost "Edit reference…" opens C5 on Reference.
Datei → Copy/Save Citation List run the same commands without the popover. Errors (toasts, `triangle-alert` Ink + Ghost "Try again"): `reference.saveFailed`, `reference.copyFailed`. A file that forbids copying text: lists and Copy citation leave quotes out, toast `reference.quotesLeftOut`. Keyboard: Tab order = style, preview (not focusable), Copy reference, Copy list, Save list, Edit reference; Esc closes and returns focus to the button.

**C8 Comments tab.** Citations live here (no fifth tab: the four 36 tabs fill the 48 header at 200 width, and citations are annotations with the same filter, sort and jump needs). Card: type icon `quote`, quote (2 lines, citation fill 45 % behind), short citation `.t-caption`, chips; actions Copy citation, Löschen (Ghost 28); click = spell 8. Filter popover (B10): Type gains **Citation** (`quote`); the old "Quote" type (comments made from a selection) is renamed "Comment on text" / "Kommentar am Text" with icon `message-square-quote`, so "Zitat" means citations only. New group **Tags** after Author: checkboxes dot + name + count, plus "No tag"; shown when ≥ 1 tag exists; Ghost "Manage tags…" at its end. Empty-tab hint `comments.emptyHint` gains citations.

**Motion.** Reused only: spell 5 (Zitieren drag), 7 (undo), 8 (card jump), 15 (skeleton), 22 (bubble enter/re-stack), §3.6 popover/tab motion. Reduced motion: as those rows. Author reorder and chips: no animation.

| Key | en | de |
|---|---|---|
| `citation.cite` | Cite | Zitieren |
| `menu.edit.cite` | Cite Selection | Auswahl zitieren |
| `menu.file.copyCitationList` / `.saveCitationList` | Copy Citation List / Save Citation List… | Zitatliste kopieren / Zitatliste speichern… |
| `citation.added` | Citation added, page {page} | Zitat hinzugefügt, Seite {page} |
| `citation.noText` | No text could be read here, so no citation was added. | Hier ließ sich kein Text lesen, daher wurde kein Zitat angelegt. |
| `citation.page` | p. {label} | S. {label} |
| `citation.copy` / `.copied` | Copy citation / Citation copied | Zitat kopieren / Zitat kopiert |
| `citation.open` / `.editReference` | Open citation / Edit reference… | Zitat öffnen / Quellenangabe bearbeiten… |
| `citation.addDetails` | Add reference details | Angaben ergänzen |
| `citation.aria` | Citation, page {page} | Zitat, Seite {page} |
| `tip.cite` | (C2) | (C2) |
| `comments.group.citation` / `.quote` (changed) | Citation / Comment on text | Zitat / Kommentar am Text |
| `props.tab.general` / `.reference` | General / Reference | Allgemein / Quellenangabe |
| `ref.type` + `.book/.article/.chapter/.report/.web/.thesis` | Type: Book, Journal article, Book chapter, Report, Web page, Thesis | Art: Buch, Zeitschriftenartikel, Buchkapitel, Bericht, Webseite, Abschlussarbeit |
| `ref.title` / `.authors` / `.year` | Title / Authors / Year | Titel / Verfasser / Jahr |
| `ref.family` / `.given` | Family name / Given name | Nachname / Vorname |
| `ref.addAuthor` / `.removeAuthor` | Add author / Remove author | Person hinzufügen / Person entfernen |
| `ref.authorMoved` | Author {n} of {total} | Person {n} von {total} |
| `ref.journal` / `.bookTitle` / `.website` | Journal / Book title / Website | Zeitschrift / Buchtitel / Website |
| `ref.volume` / `.issue` / `.pages` / `.edition` | Volume / Issue / Pages / Edition | Band / Heft / Seiten / Auflage |
| `ref.publisher` / `.institution` / `.place` | Publisher / Institution / Place | Verlag / Institution / Ort |
| `ref.doi` / `.url` / `.accessed` | DOI / URL / Accessed | DOI / URL / Abgerufen am |
| `ref.source.file` / `.page1` / `.edited` | from the file / from page 1 / edited | aus der Datei / von Seite 1 / bearbeitet |
| `ref.restore` | Use the value from the file | Wert aus der Datei verwenden |
| `ref.nothingFound` | Nothing found in the file. Fill in what you know. | In der Datei nichts gefunden. Ergänze, was du weißt. |
| `ref.invalid.year` / `.doi` / `.url` | Use a 4-digit year. / A DOI starts with 10. / Use an address starting with http:// or https://. | Vierstellige Jahreszahl eingeben. / Eine DOI beginnt mit 10. / Adresse mit http:// oder https:// eingeben. |
| `reference.button` | Reference and citation list | Quellenangabe und Zitatliste |
| `reference.style` + `.apa/.mla/.chicago/.din` | Citation style: APA 7, MLA 9, Chicago (author-date), DIN ISO 690 | Zitierstil: APA 7, MLA 9, Chicago (Autor-Jahr), DIN ISO 690 |
| `reference.preview` / `.missing` | Preview / Some details are missing. | Vorschau / Einige Angaben fehlen. |
| `reference.copy` / `.copied` | Copy reference / Reference copied | Quellenangabe kopieren / Quellenangabe kopiert |
| `reference.list` / `.count.one` / `.count.other` | Citation list / {count} citation / {count} citations | Zitatliste / {count} Zitat / {count} Zitate |
| `reference.copyList` / `.saveList` | Copy list / Save list… | Liste kopieren / Liste speichern… |
| `reference.listCopied` / `.listSaved` | Citation list copied / Citation list saved | Zitatliste kopiert / Zitatliste gespeichert |
| `reference.empty` | No citations yet. Select text and choose Cite. | Noch keine Zitate. Text markieren und Zitieren wählen. |
| `reference.format.txt/.html/.md` | Plain text / Web page (HTML) / Markdown | Text / Webseite (HTML) / Markdown |
| `reference.saveFailed` | The citation list could not be saved. | Die Zitatliste konnte nicht gespeichert werden. |
| `reference.copyFailed` | Could not copy to the clipboard. | Kopieren in die Zwischenablage fehlgeschlagen. |
| `reference.quotesLeftOut` | This file does not allow copying text, so quotes were left out. | Diese Datei erlaubt kein Kopieren von Text, daher fehlen die Zitate. |
| `tags.title` / `.assign` / `.none` | Tags / Tags / No tag | Tags / Tags / Ohne Tag |
| `tags.find` / `.create` | Find or create tag / Create “{name}” | Tag suchen oder anlegen / „{name}“ anlegen |
| `tags.manage` / `.new` / `.name` / `.colour` / `.delete` | Manage tags… / New tag / Tag name / Colour / Delete tag | Tags verwalten… / Neuer Tag / Tag-Name / Farbe / Tag löschen |
| `tags.deleted` / `.empty` / `.more` | Tag “{name}” deleted / No tags yet. / +{n} | Tag „{name}“ gelöscht / Noch keine Tags. / +{n} |
| `tags.duplicate` / `.limit` | A tag with this name exists. / Up to 64 tags. | Diesen Tag gibt es schon. / Höchstens 64 Tags. |

**Acceptance (installed build, mouse only unless a key is named).**
1. Selecting text shows Markieren · Zitieren · Kommentieren · Kopieren; Zitieren creates a Lavender fill with a darker 1 pt underline and a White margin bubble with `quote`, the quote and "p. N".
2. Kommentieren mode shows eight tools with Zitieren fourth; at 960 × 640 all eight are visible icon-only, no "Mehr".
3. Dragging across text with Zitieren creates a citation; its chevron swatch row changes the colour of the next one and the underline follows the colour.
4. Primary+Shift+C and Bearbeiten → Cite Selection create a citation from a selection; both are disabled without one.
5. A document with page labels shows the label ("p. xii"), not the index.
6. Clicking the citation selects it and shows the C4 mini bar; Löschen removes it and Undo restores it.
7. Copy citation (bubble, mini bar, card) puts quote + short citation in the clipboard and shows a toast.
8. Datei → Document Properties… shows General and Reference tabs; Reference shows prefilled fields with "from the file" or "from page 1" captions.
9. Editing a field changes its caption to "edited" with a restore button; restoring brings back the file value.
10. Authors can be added, removed and reordered by dragging the grip; the preview follows.
11. Switching Type changes the visible fields per the C5 table; Apply marks the document Edited; saving and reopening keeps every value.
12. A file without metadata shows the "Nothing found" row and empty, editable fields.
13. An invalid year, DOI or URL shows the error caption and disables Apply.
14. The Reference button in the Comments filter row opens the popover; switching style updates the preview and every short citation at once.
15. The chosen style survives an app restart.
16. Copy reference, Copy list and Save list… (.txt, .html, .md) produce the reference and all citations in page order; the files open in a text editor and a browser.
17. With no citations, Copy list and Save list are disabled with the empty caption.
18. Saving to a write-protected folder shows the "could not be saved" toast with Try again.
19. A tag created from the picker appears as a chip on the bubble and the Comments card; the mini bar Tags button assigns the same tag.
20. Manage tags renames, recolours (five swatches only) and deletes a tag; chips update; Undo restores a deleted tag.
21. The filter popover offers Citation as a type and a Tags group; filtering by a tag shows only matching cards with "n of m · Reset".
22. A document whose permissions forbid changes disables Zitieren and tag assignment with the read-only tooltip, shows Reference fields read-only, and still exports.
23. With reduced motion on, creating a citation and opening popovers only fade.
24. No new surface covers the selection, the mini bar or a page at 960 × 640 and 1280 × 800.

### 3.8 v1.4 Certificate signature (ADR-121)

Binding for v1.4.1–v1.4.3. Crypto, storage and file structure are ADR-121's (PAdES B-B, self-generated or imported .p12/.pfx keys in the OS keychain, DocMDP, local validation without network or trust list); this section defines looks, slots, keys and strings. The ADR-102 layout stays: **no new mode, no new left-panel tab, no new grid track**. New surfaces reuse slots §3 already has: one tool slot, a tab in the existing Signatures dialog, a confirm dialog, the banner slot and a Signatures dialog. Light only. Wording rule: the UI never says "qualified", "legally binding", "verified identity" or names eIDAS levels as a property of these signatures; the confirm dialog says plainly that it is not a qualified signature (CLAUDE.md rule 5). No Adobe terms ("Digital ID", "Certify", blue ribbon).

New tokens (§1.2): `--seal-width` 192 pt and `--seal-height` 64 pt (default seal box; 72 pt with a reason), `--seal-min-width` 120 pt and `--seal-min-height` 40 pt. On-page colours are not new tokens: the seal uses `--color-ink`, `--color-stone`, `--text-secondary`; Rust holds them as named constants and a test compares them with `tokens.css`.

**S1 Entry point (v1.4.1).** Ausfüllen & Signieren gets its own slot, last: **Text · Häkchen · Kreuz · Punkt · Datum · Signatur · Initialen · Zertifikat** (8 = the §3.2 maximum; at 960 overflow step 2 suffices, no "Mehr"). Why not a Signatur variant: a certificate signature is irreversible and locks the file; hiding it in a split menu next to visual signatures invites confusing the two, and the visual signature keeps its simple meaning.
- Item: icon `stamp`, label `cert.tool`, tooltip `cert.tool.tooltip`. Split item (§3.2): main part activates with the last used certificate; the 20-wide chevron opens a Menu: certificates as radio items (name + `.t-caption` email), divider, "New certificate…", "Manage certificates…". **No tool letter** (an accidental key must never start an irreversible flow).
- No certificate yet: activating the tool opens the Signatures dialog on its Certificates tab (S2, empty state); after create/import the tool is active.
- Disabled (0.4, tooltip says why): document locked by a certifying signature (S5, `cert.locked.tool`), permissions forbid signing (`tool.readOnly`), keychain unavailable (`cert.keychainMissing`), XFA form.
- Werkzeuge → "Manage Signatures…" stays; it opens the same dialog on the last tab used this session.

**S2 Certificate manager** (tab in the existing Signatures dialog, `SignatureLibraryDialog`; one place for everything kept in the keychain). The header gains Tabs (§4, 36): **Signatures** (today's content) · **Certificates**. Dialog width `--sheet-width` 560, max height window − 64, tab body scrolls, header/tabs/footer stay.
- **List:** rows 56, radius md, padding-x 12, gap 4, hover Sand: `key-round` 20 Ink · 12 · name `.t-label` (ellipsis) over `.t-caption` "Self-generated · valid until 10/2029" or "Imported · issued by {issuer} · valid until …" (expired: `triangle-alert` 16 + `cert.expired`, Ink) · right: Details chevron 28 (expands in place) · Delete `trash-2` 28. Expanded details: two-column label/value grid (`.t-caption` / `.t-body`, `tabular-nums`): Name, Email, Organisation, Issuer, Serial number, Valid (from–to), SHA-256 fingerprint (pairs of hex grouped by 4, wraps, Copy icon button 28), Stored (`cert.stored`). Max 8 certificates (`cert.limit`; Create and Import disabled).
- **Footer of the tab:** Secondary "Create certificate…" · Secondary "Import .p12 or .pfx…" (left), Secondary "Close" (right). No Primary in list view (nothing to commit).
- **Create** (the tab body swaps to a form; Back Ghost `arrow-left` 28 returns): Name (required, 1–64), Email (optional, validated on blur), Organisation (optional, ≤ 64), caption `cert.createNote`. Footer: Secondary Cancel · Primary "Create". Creating: button label `cert.creating` after `--saving-delay`; done: back to the list, the new row selected and announced (`cert.created`).
- **Import:** Rust open dialog (.p12, .pfx; the frontend never sees the path or bytes); cancelled = nothing. Then the form shows the file's name (no path) and a password Input with a show/hide icon button 28 (`eye` / `eye-off`), focus in the field. Primary "Import". Errors under the field (§4 input error, `aria-invalid`): `cert.errPassword`, `cert.errFile`, `cert.duplicate`, `cert.errAlgorithm`. An expired certificate imports with the warning caption; it cannot sign (S3).
- **Delete:** inline confirm in the row (row turns Sand, text `cert.deleteConfirm`, Ghost Cancel · Secondary "Delete" in danger text). No undo (the keychain item is gone); focus moves to the next row or the empty state.
- **Empty:** centred `key-round` 24 Text-secondary, `cert.empty` `.t-title`, `cert.emptyHint` `.t-caption`, the two footer buttons. **Keychain unavailable:** a 32 Sand info row (as B8, `info` 16) `cert.keychainMissing`, Create/Import disabled; never kept in memory only (ADR-107).
- Keyboard: Tabs roving (Left/Right); list is `role="list"`, Tab reaches Details then Delete per row; Enter on Details toggles `aria-expanded`; Esc closes a form (back to list), then the dialog, focus returns to the opener.

**S3 Signing flow (v1.4.1).**
1. **Place.** With Zertifikat active: drag a box on a page, or click = `--seal-width` × `--seal-height` centred on the click (clamped inside the page, 12 pt inset). Cursor crosshair (spell 12). The placeholder draws the real seal preview (S4) with a 1px Ink dashed outline and handles; aspect free, minimum `--seal-min-*`. Keyboard: Enter on the canvas places it centred on the visible part of the current page; arrows move 1 pt, Shift+arrows 10 pt. Release (or Enter) opens the confirm dialog.
2. **Confirm** (Dialog §4, Sand, `--dialog-width-md`, title `.t-h3` `sign.cert.title`), top to bottom, gap 16: **Signer** dropdown 36 (certificates; caption issuer · valid until; expired/not yet valid: danger caption `cert.expired`, Primary disabled) · **Reason** Input (≤ 128, placeholder `sign.cert.reasonPlaceholder`) · **Location** Input (≤ 64) · seal preview on White, radius sm, live as fields change (`aria-hidden`; the fields carry the content) · notice block (White on the Sand dialog), radius md, padding 12, `lock` 16 Ink + `sign.cert.lockNotice` `.t-label` Ink 500, then `.t-caption` lines: `sign.cert.unsaved` (only with unsaved edits), `sign.cert.existing` (only when the file already has signatures), `sign.cert.notQualified` (always). Footer: Secondary Cancel · Primary `sign.cert.submit`.
3. **Save: always a new file.** Primary opens the Rust save dialog, default name `sign.cert.fileName` next to the original. Why not in place: signing is irreversible and the original stays the editable copy, so "how do I change it?" has an answer without any extra command. Choosing the open file's own path is allowed after the OS overwrite prompt; then this tab reloads as the signed file. Otherwise the signed file opens in a **new tab** that becomes active; the original tab keeps its state (its unsaved edits stay unsaved there).
4. **Progress and result.** Primary shows `sign.cert.signing` after `--saving-delay`, dialog inputs disabled; the OS may show its own keychain prompt. Success: dialog closes, toast `sign.cert.done`, polite announcement. Failure: the dialog stays, inline danger caption above the footer (`sign.cert.keychainDenied`, `sign.cert.failed`) and Primary becomes "Try again". Save dialog cancelled: back to the confirm dialog, nothing written.
- Cancel (or Esc) closes the dialog and keeps the placeholder selected: move/resize it, Enter reopens the dialog, Esc or Delete discards it. Switching mode or tool discards it. The placeholder never enters the document or the undo stack.

**S4 Seal look (v1.4.2).** The seal is the signature field's appearance stream, so every viewer shows the same picture; PDFium renders it in the app. Transparent background (sits on form lines like ink), 0.75 pt Stone frame, radius 4 pt, padding 8 pt. Left: Lucide `shield-check` 20 pt Ink (stroke 1.75, as vectors). 8 pt gap. Text column, Inter subset embedded: name 11/14 pt 500 Ink · `seal.signed` 8/10 pt Ink · date "2026-10-05 14:05 +02:00" 8/10 pt Text-secondary, tabular numerals (ISO form, readable in every locale) · optional `seal.reason` 8/10 pt Text-secondary. Language = UI language at signing. Smaller boxes scale the text down to 6 pt, then drop the reason line, then ellipsis the name; the date and "Digitally signed" are never dropped. No colour carries meaning (prints in greyscale). The on-page seal never shows validity: that is the app's job (S6), so a copied or altered seal cannot fake a status.

**S5 Read-only state (v1.4.2).** Applies to any file whose certifying signature allows no changes (ours always does), whoever signed it.
- **Banner slot** (§3.2, 40): the signature banner (S6) plus, right, Ghost 28 `cert.editableCopy`. Priority in the single slot: redact band > signature banner > form banner.
- **Save status** (§3.5 B1) new state: `lock` 16 Text-secondary + `save.status.signed`, `aria-disabled`, tooltip `cert.locked.tool`.
- **Disabled** (0.4, tooltip `cert.locked.tool`): every tool in Kommentieren, Ausfüllen & Signieren (incl. Zertifikat), Seiten and Bearbeiten; Zitieren and tag assignment; form fields (read-only, no focus ring change); thumbnail drag; Undo/Redo; Datei Save, Compress, Flatten form, Protect, Export copy; Document properties shows read-only fields (C5 rule). Mode tabs stay usable so people can look.
- **Still works:** Lesen tools, text selection, Copy, Search, Print, Export images, citation list export, Save As (byte-identical copy, signature stays valid).
- **Editable copy:** Rust save dialog, default `cert.editableName`; writes a copy without signature fields or seals (`cert.editableNote` as dialog message), opens it in a new tab. The signed file is never modified.
- Signed but not locked (others' approval signatures): v1.1 behaviour stays (edits allowed, saving asks to confirm `breaksSignature`); the banner shows only the status.

**S6 Validation (v1.4.3).** Runs in Rust after open for every file with ≥ 1 signed signature field; empty signature fields are ignored. Every signature is hostile input: strings are cleaned (control and bidi-override characters removed, 128 chars max, ellipsis) before display.
- **Banner** (Sand, §4 Banner): icon 16 + `.t-label` Ink + Ghost 28 "Details" (opens the Signatures dialog) + close 28 (hides for this tab's session). Text: subject (`sigs.banner.one` or `.many`) · worst state of all signatures · `sigs.identity.short`. Icons and state: intact `shield-check` Ink; later additions `shield-check` Ink + `.later`; changed `shield-alert` `--color-danger` + state word 600; can't be checked `shield-x` `--color-danger` + 600. The words carry the state; colour only repeats it (§2). Below 1100 window width the identity part moves into the banner's tooltip. While checking: `sigs.checking`, shown after `--saving-delay`.
- **Signatures dialog** (Dialog §4, `--sheet-width` 560, title `sigs.title`, max height window − 64, body scrolls; Datei → `menu.file.signatures` after Document Properties…, enabled only for signed files; banner Details; Enter or click on a seal widget opens it scrolled to that card). Cards in signing order, White, border, radius md, padding 16, gap 12:
  - Header: state icon 20 · `sigs.number` `.t-caption` over signer `.t-title` (ellipsis) · state `.t-label` 600 right.
  - Rows (label `.t-caption` / value `.t-body`): Signed at (`sigs.signedAt`, locale date + time + offset); Content (`sigs.state.*` sentence, plus `sigs.covers` when later versions exist); Identity (`sigs.identity`, always shown, also for imported certificates); Certificate: issuer, valid from–to (`sigs.certExpiredAtSigning` when the claimed time is outside), fingerprint + Copy 28; Reason, Location (only when present); Lock (`sigs.locks` when certifying).
  - Footer of a card: Ghost 28 `sigs.showOnPage` (spell 8 to the seal; invisible signature: `.t-caption` `sigs.invisible` instead).
  - Error card (malformed, unsupported algorithm, over limits, timeout): same header with `shield-x`, state `sigs.state.unknown`, one row with the reason (`sigs.error.*`), other rows only where readable. One broken signature never hides the others.
- **Seal on the page** (in-app only): hover/focus shows the §2.1 outline pair and tooltip "{name} · {state}"; changed or unknown adds a 2px `--color-danger` outline (overlay, like redaction marks). Seal widgets are buttons in the page Tab order, `aria-label` `sigs.aria`.
- Dialog footer: Secondary Close; when locked also Ghost `cert.editableCopy`. Keyboard: Tab through cards' controls in order; Esc closes and returns focus.

**Motion.** Reused only: §4 dialog and tab motion, spell 8 (Show on page), spell 12 (cursor), toast as built. No pulse on signing, no animated seal, no success check draw (save status is not involved). Reduced motion: fades `--motion-fast` as those rows. **Layout check:** dialogs are modal over the scrim (allowed); the banner sits in its slot so pages never move under it; at 960 × 640 the dialogs fit at 576 max height with scrolling bodies; the placeholder stays inside its page.

| Key | en | de |
|---|---|---|
| `cert.tool` / `.tool.tooltip` | Certificate / Sign with a certificate | Zertifikat / Mit Zertifikat signieren |
| `cert.menu.new` / `.manage` | New certificate… / Manage certificates… | Neues Zertifikat… / Zertifikate verwalten… |
| `lib.tab.signatures` / `.certificates` | Signatures / Certificates | Signaturen / Zertifikate |
| `cert.create` / `.import` | Create certificate… / Import .p12 or .pfx… | Zertifikat erstellen… / .p12 oder .pfx importieren… |
| `cert.name` / `.email` / `.org` | Name / Email (optional) / Organisation (optional) | Name / E-Mail (optional) / Organisation (optional) |
| `cert.createNote` | Valid for 3 years. The private key stays in this device's keychain. | 3 Jahre gültig. Der private Schlüssel bleibt im Schlüsselspeicher dieses Geräts. |
| `cert.creating` / `.created` | Creating… / Certificate “{name}” created | Wird erstellt… / Zertifikat „{name}“ erstellt |
| `cert.password` / `.show` / `.hide` | Password of the file / Show password / Hide password | Passwort der Datei / Passwort zeigen / Passwort verbergen |
| `cert.errPassword` / `.errFile` | Wrong password. / This file holds no usable certificate with a private key. | Falsches Passwort. / Diese Datei enthält kein nutzbares Zertifikat mit privatem Schlüssel. |
| `cert.duplicate` / `.errAlgorithm` | This certificate is already in the list. / This key type isn't supported. | Dieses Zertifikat ist schon in der Liste. / Dieser Schlüsseltyp wird nicht unterstützt. |
| `cert.selfSigned` / `.imported` / `.validUntil` | Self-generated / Imported · issued by {issuer} / valid until {date} | Selbst erstellt / Importiert · ausgestellt von {issuer} / gültig bis {date} |
| `cert.expired` / `.notYetValid` | Expired on {date} / Valid from {date} | Abgelaufen am {date} / Gültig ab {date} |
| `cert.field.issuer` / `.serial` / `.validity` / `.fingerprint` | Issuer / Serial number / Valid / SHA-256 fingerprint | Aussteller / Seriennummer / Gültig / SHA-256-Fingerabdruck |
| `cert.stored` / `.copyFingerprint` | Stored in the system keychain on this device / Copy fingerprint | Im Schlüsselspeicher dieses Geräts / Fingerabdruck kopieren |
| `cert.delete` / `.deleteConfirm` | Delete certificate / Delete “{name}” from this device? Files already signed stay signed, but you can't sign with it again. | Zertifikat löschen / „{name}“ von diesem Gerät löschen? Signierte Dateien bleiben signiert, aber du kannst damit nicht mehr signieren. |
| `cert.empty` / `.emptyHint` | No certificates yet. / Create one here or import a .p12 or .pfx file. | Noch keine Zertifikate. / Hier eines erstellen oder eine .p12- oder .pfx-Datei importieren. |
| `cert.limit` / `.keychainMissing` | Up to 8 certificates. / Certificates need the system keychain, which isn't available. | Höchstens 8 Zertifikate. / Zertifikate brauchen den Schlüsselspeicher des Systems; er ist nicht verfügbar. |
| `sign.cert.title` / `.signer` / `.reason` / `.location` | Sign with certificate / Signer / Reason (optional) / Location (optional) | Mit Zertifikat signieren / Unterzeichnet von / Grund (optional) / Ort (optional) |
| `sign.cert.reasonPlaceholder` | e.g. I approve this document | z. B. Ich gebe dieses Dokument frei |
| `sign.cert.lockNotice` | After signing, this document can no longer be edited. Make all changes first. | Nach dem Signieren lässt sich das Dokument nicht mehr bearbeiten. Nimm alle Änderungen vorher vor. |
| `sign.cert.unsaved` / `.existing` | Your unsaved changes are included. / The existing signatures stay valid. | Deine ungespeicherten Änderungen werden übernommen. / Die vorhandenen Signaturen bleiben gültig. |
| `sign.cert.notQualified` | This shows the file hasn't changed since signing. It is not a qualified electronic signature. | Sie zeigt, dass die Datei seit dem Signieren unverändert ist. Sie ist keine qualifizierte elektronische Signatur. |
| `sign.cert.submit` / `.signing` / `.fileName` | Sign and save as… / Signing… / {name} – signed | Signieren und speichern unter… / Wird signiert… / {name} – signiert |
| `sign.cert.done` / `.failed` / `.keychainDenied` | Signed copy saved as {file} / Couldn't sign. {reason} / The system didn't allow access to the key. | Signierte Kopie gespeichert als {file} / Signieren fehlgeschlagen. {reason} / Das System hat den Zugriff auf den Schlüssel verweigert. |
| `seal.signed` / `.reason` | Digitally signed / Reason: {reason} | Digital signiert / Grund: {reason} |
| `save.status.signed` / `cert.locked.tool` | Signed / Signed and locked. Make an editable copy to change it. | Signiert / Signiert und gesperrt. Für Änderungen eine bearbeitbare Kopie anlegen. |
| `cert.editableCopy` / `.editableName` / `.editableNote` | Make editable copy… / {name} – editable / The copy has no signatures. | Bearbeitbare Kopie… / {name} – bearbeitbar / Die Kopie enthält keine Signaturen. |
| `menu.file.signatures` / `sigs.title` / `.details` | Signatures… / Signatures / Details | Signaturen… / Signaturen / Details |
| `sigs.checking` / `.banner.one` / `.banner.many` | Checking signatures… / Signed by {name} / {count} signatures | Signaturen werden geprüft… / Signiert von {name} / {count} Signaturen |
| `sigs.state.intact` / `.later` | Unchanged since signing / Unchanged; additions were made after signing | Seit dem Signieren unverändert / Unverändert; danach wurde etwas ergänzt |
| `sigs.state.changed` / `.unknown` | Changed after signing / Can't be checked | Nach dem Signieren verändert / Nicht prüfbar |
| `sigs.identity.short` | identity not verified | Identität nicht geprüft |
| `sigs.identity` | Not checked against a trust list: the certificate is self-signed or from an unknown issuer. If it matters, compare the fingerprint with the signer. | Nicht mit einer Vertrauensliste abgeglichen: Das Zertifikat ist selbst erstellt oder von einem unbekannten Aussteller. Vergleiche bei Bedarf den Fingerabdruck mit der unterzeichnenden Person. |
| `sigs.number` / `.signedAt` | Signature {n} of {total} / Signed at (time from the signer's computer) | Signatur {n} von {total} / Signiert am (Zeit vom Computer der unterzeichnenden Person) |
| `sigs.covers` / `.locks` | Covers version {n} of {total} of this file / Locks the document against changes | Umfasst Version {n} von {total} dieser Datei / Sperrt das Dokument gegen Änderungen |
| `sigs.locksForms` | Allows only filling in forms and further signatures (certification P=2, ADR-123) | Erlaubt nur noch Formulare ausfüllen und weitere Signaturen |
| `sigs.certExpiredAtSigning` | The certificate was not valid at the stated time. | Das Zertifikat war zur angegebenen Zeit nicht gültig. |
| `sigs.showOnPage` / `.invisible` | Show on page / No visible seal | Auf der Seite zeigen / Kein sichtbares Siegel |
| `sigs.error.damaged` / `.method` / `.limits` | The signature data is damaged. / Uses a method {app} can't check. / Too large or complex to check safely. | Die Signaturdaten sind beschädigt. / Nutzt ein Verfahren, das {app} nicht prüfen kann. / Zu groß oder zu komplex für eine sichere Prüfung. |
| `sigs.aria` | Signature by {name}, {state}. Show details | Signatur von {name}, {state}. Details anzeigen |

**Acceptance (installed build, mouse only unless a key is named).**
1. Ausfüllen & Signieren shows eight tools with Zertifikat last; at 960 × 640 all eight are visible icon-only, no "Mehr".
2. With no certificate, clicking Zertifikat opens the Signatures dialog on Certificates with the empty state and both buttons.
3. Create certificate with only a name adds a row "Self-generated · valid until …"; an invalid email shows the error caption.
4. Import a .p12/.pfx: a wrong password shows "Wrong password." under the field; the right one adds an "Imported · issued by …" row; importing it again shows the duplicate error.
5. Details expands a row with issuer, validity and fingerprint; Copy fingerprint fills the clipboard.
6. Delete asks inline; confirming removes the row; the dialog reopened after an app restart still lists the remaining certificates.
7. The Zertifikat chevron lists certificates, New certificate… and Manage certificates….
8. Dragging on a page shows the seal preview; releasing opens the confirm dialog with signer, reason, location, the lock notice and the not-qualified line.
9. Cancel keeps the placeholder; it can be moved and resized; Esc removes it and nothing is added to Undo.
10. An expired certificate as signer shows the expired caption and disables the Primary.
11. Sign and save as… opens a save dialog with "{name} – signed"; after saving the signed file opens in a new tab, the original tab is unchanged.
12. The seal shows name, "Digitally signed", date and the reason; the same seal appears in another PDF viewer and on a greyscale print.
13. The signed tab shows the banner "Signed by … · Unchanged since signing · identity not verified" and the save status "Signed".
14. In the signed tab every editing tool, form field, thumbnail drag, Undo and Datei → Save are disabled with the locked tooltip; search, copy, print and Save As work.
15. Make editable copy… saves a copy without signatures that opens editable in a new tab.
16. Datei → Signatures… and the banner's Details open the dialog with signer, signed at, content, identity sentence, certificate, reason, location and lock rows.
17. A file signed twice shows "2 signatures" and two cards in order; Show on page scrolls to each seal.
18. Changing a byte in a signed file (test fixture) shows "Changed after signing" in the banner, card and a red seal outline.
19. A file with a damaged signature and a valid one shows one "Can't be checked" card with its reason and one intact card; the app stays responsive.
20. A file with additions after signing shows "Unchanged; additions were made after signing" and "Covers version 1 of 2".
21. Clicking a seal opens the dialog at its card; Tab reaches seals, Enter opens them.
22. With the keychain unavailable, Zertifikat is disabled with its tooltip and the Certificates tab shows the info row.
23. With reduced motion on, dialogs, tabs and Show on page only fade or jump.
24. No new surface covers a page, the selection or the mini bar at 960 × 640 and 1280 × 800; the banner never overlaps page 1.

#### §3.8 addendum v1.4.1 (ADR-123)

Polish only; S1–S6 stay valid where not overridden here. No new tokens.

**L1 Lock choice (S3 confirm dialog).** Shown only when the signature certifies (the document has no signed signature yet); for an approval signature the row is absent (not disabled). Control: **radio group**, not Segmented: the second label is long and the options need a sentence each, which a 32-high segment cannot hold. Slot: in the dialog's 16-gap column after Location, before the seal preview. Anatomy: group label `.t-label` `sign.cert.lock`, then two rows (min 36, gap 4, §4 radio 16 + 8 + `.t-body` label over `.t-caption` helper, helper wraps under the label, not under the radio). Default "No changes" on every open (never remembered). The notice block follows the choice: P=1 keeps `sign.cert.lockNotice`; P=2 shows `sign.cert.lockNoticeForms`. Keyboard: `role="radiogroup"` with `aria-labelledby` the group label; one Tab stop, Up/Down (and Left/Right) move and select, Space selects; each radio `aria-describedby` its helper. Disabled with the other inputs while signing.

**L2 Certificate menu (S1 chevron).** Items are `menuitemradio`, `aria-checked` on the active identity; checked = §2 rule 10 (check icon 16 left, others reserve the 16 slot). Each item: name `.t-label` over email `.t-caption` Text-secondary (row 48; no email = single line 32, no empty caption). Icons: identities none (the check column is their marker); "New certificate…" `plus`; "Manage certificates…" `settings-2`. `stamp` stays on the tool item only.

**L3 Grid for the extra buttons.** All sit on the parent's content edge, never indented past it.
- **Export certificate** (`cert.export`): in the expanded row details (S2), last line of the label/value grid, spanning both columns, left-aligned with the label column; Secondary 28, icon `download`, 8 below the fingerprint row.
- **Trust / Remove trust** (`sigcheck.trust` / `.untrust`) and **View signed version** (`sigcheck.viewSigned`): in the Signatures dialog card footer (S6), one row, left-aligned to the card's 16 padding, gap 8, in this order: Show on page · View signed version · Trust. All Ghost 28; icons `scan-eye`, `history`, `badge-check` (untrust: `badge-x`). View signed version only when later versions exist. At narrow widths the row wraps onto a second line (gap 8), never overflows.

**L4 Create-identity form.** Heading `.t-title` `cert.createTitle` on the Back button's row (Back 28 · 8 · heading), the form 16 below. Fingerprints everywhere (details, cards, trust list) render as uppercase hex pairs, blocks of 4 pairs separated by a space, pairs joined by ":" inside a block (`AB:CD:EF:01 23:45:67:89 …`), monospace stack, `tabular-nums`, wrap only between blocks. Copy copies the plain colon form without spaces.

**L5 File name.** Settled: `sign.cert.fileName` = "{name} – signed" / "{name} – signiert" (en dash U+2013, spaces both sides, extension appended by Rust). Unchanged from S3; any other variant in code is a bug.

**L6 Seal placeholder handles.** 8 handles (4 corners, 4 edge midpoints), visual 8 × 8, White fill, 1px Ink border, radius 2; hit area 24 × 24 centred (pointer only, doesn't widen the box). Minimum `--seal-min-width` × `--seal-min-height`; drags clamp there and at the page's 12 pt inset. Cursors: matching resize cursors. Keyboard (placeholder focused): arrows move 1 pt, Shift+arrows 10 pt (S3); **Alt+arrows** resize from the bottom-right corner by 1 pt, **Alt+Shift+arrows** by 10 pt (Right/Down grow, Left/Up shrink). Placeholder is `role="group"` with `aria-label` `cert.placeholder.aria`, size announced politely after a keyboard resize (`cert.placeholder.size`). No motion; reduced motion unaffected.

**L7 Version wording.** Card Content row: `sigs.covers` "Covers version {n} of {total} of this file" only when later versions exist; the last version says `sigcheck.wholeFile` "Covers the whole file". `sigs.coversVersion` is dropped.

| Key | en | de |
|---|---|---|
| `sign.cert.lock` | Allowed after signing | Nach dem Signieren erlaubt |
| `sign.cert.lockNone` / `.lockNoneHelp` | No changes / Nobody can change the file, add form entries or sign it again. | Keine Änderungen / Niemand kann die Datei ändern, Formulare ausfüllen oder erneut signieren. |
| `sign.cert.lockForms` / `.lockFormsHelp` | Fill in forms and allow further signatures / Others can fill in form fields and add their signatures; everything else stays locked. | Formulare ausfüllen und weitere Signaturen zulassen / Andere können Formularfelder ausfüllen und signieren; alles andere bleibt gesperrt. |
| `sign.cert.lockNoticeForms` | After signing, only form entries and further signatures can be added. Make all other changes first. | Nach dem Signieren lassen sich nur noch Formulare ausfüllen und weitere Signaturen hinzufügen. Nimm alle anderen Änderungen vorher vor. |
| `cert.createTitle` | New certificate | Neues Zertifikat |
| `cert.placeholder.aria` / `.size` | Seal position. Arrows move, Alt+arrows resize. / {w} × {h} pt | Siegelposition. Pfeiltasten verschieben, Alt+Pfeiltasten ändern die Größe. / {w} × {h} pt |
| `sigs.covers` / `sigcheck.wholeFile` | Covers version {n} of {total} of this file / Covers the whole file | Umfasst Version {n} von {total} dieser Datei / Umfasst die ganze Datei |

**Acceptance (addendum).**
25. Signing an unsigned file shows "Allowed after signing" with "No changes" selected; signing an already signed file shows no lock choice.
26. Choosing "Fill in forms…" changes the notice; the signed file allows form filling and a second signature, while editing tools stay disabled.
27. Reopening the dialog always starts at "No changes"; Up/Down switch the options with one Tab stop.
28. The Zertifikat chevron shows a check on the active identity, its email under the name, and `plus` / `settings-2` icons on the two commands.
29. Export certificate, Show on page, View signed version and Trust align with their container's content edge at 960 × 640 and 1280 × 800; nothing indents or overflows.
30. The Create form shows the heading "New certificate"; every fingerprint reads in blocks of four hex pairs.
31. The save dialog proposes "{name} – signed" (de: "{name} – signiert").
32. The placeholder has 8 handles, each grabbable within 24 px; it never shrinks below 120 × 40 pt; Alt(+Shift)+arrows resize it and announce the size.
33. A file with later additions shows "Covers version 1 of 2 of this file" on the first card and "Covers the whole file" on the last.

### 3.9 F17 UI quality (v1.4.2, ADR-124)

Overrides §3.2, §3.3, §3.6 and §3.8 L1 where stated. One new token: `--motion-morph` 150ms.

**Q1 Lock row (F17.0a, overrides L1 "never remembered" and "row absent").** The row is always present in the S3 confirm dialog, same slot.
- *Certifying signature:* L1 radio group; preselected = last choice (settings store `signing.lastLock`, per device; first run "No changes"). Confirming writes the choice; cancelling does not.
- *Approval signature:* read-only block, no radios, not a Tab stop: group label `sign.cert.lock`, then `lock` 16 Text-secondary + 8 + `.t-body` stating the document's existing lock (`sigs.locks`, `sigs.locksForms`, or `sign.cert.lockNoneSet`), then `.t-caption` `sign.cert.lockExisting`. Read in order by screen readers (plain text, not `aria-disabled` controls).

**Q2 Active tool (F17.2).** One rule for all five modes: an item of kind *tool* with `aria-pressed="true"` gets Solar fill + Ink 600 label + `--tool-active-edge`; *toggles* get the §3.5 toggle style; *actions* never stay filled. In Lesen, Auswahl, Hand, Textauswahl and Lupe are kind *tool*, so entering Lesen shows Auswahl filled. Drehen and Suche are actions. Holding Z (temporary lens) does not move the fill.

**Q3 Stroke width (F17.3).** Segmented control (§4) in the mini bar: track 32 high, padding 2, segments 28 high, **fixed width 36 each**, values **0.5 · 1 · 2 · 4 · 8** (number only, locale decimal: de "0,5"), `tabular-nums`, `white-space: nowrap`. Unit as one `.t-caption` "pt" 4 after the track. Width 5 × 36 + 4 = 184 + unit, constant across locales. Each segment `aria-label` `mini.strokePt` ("{n} pt"); radiogroup keyboard (one Tab stop, Left/Right). A custom width from an older file shows no segment selected; the tooltip names the value.

**Q4 Custom colour popover (F17.4).** Popover, width **min 240**, max 280, padding 16, gap 12, two rows:
1. Palette: §1.4 swatches + up to 6 recent custom colours, 24 in 32 hit areas, wraps by row of 6 (192 ≤ 208 inner).
2. Hex field, full width, 32 high: inner left 8 a 16 preview swatch (live, 1px Stone ring), "#" Text-secondary, input (6 chars, `tabular-nums`, uppercase on blur); inner right 4 an icon button 24 `check` (`color.apply`), field padding-right 32 so text never runs under it. No separate button.
- States: valid = check enabled; empty/invalid = check 0.4 `aria-disabled`; after Enter or blur with invalid text: `--color-danger` border + `.t-caption` danger `color.hexInvalid` 4 below (the popover grows; nothing overlaps), `aria-invalid`, `aria-describedby`.
- Accepts 3 or 6 hex digits, leading "#" and spaces stripped on paste.
- Keyboard: opens with focus on the current swatch; Tab order palette → field → check. Enter in the field confirms if valid (applies, closes, focus to the anchor); Esc closes without applying.

**Q5 Straighten shapes (F17.5).** Switch (§4 toggle, `--radius-pill`) in the Zeichnen mini bar, own group after stroke width (divider before it; Löschen stays last when a stroke is selected), label `.t-label` `draw.straighten`, tooltip `draw.straightenHelp`. Default **on**, stored in the `tools` store. On release with a hit the raw path interpolates to the fitted shape in `--motion-morph` with `--ease-out`; polite announcement `draw.straightened`. Undo after a morph restores the raw stroke (the morph is its own step). Reduced motion: the fitted shape replaces the stroke without interpolation; the announcement stays.

**Q6 Tool row (F17.6, extends §3.2 overflow).** Tool labels never use `text-overflow: ellipsis` and never clip; "…" appears only in menu item labels that open a dialog. Measure, do not guess: required width = sum of each item's intrinsic width (icon 18 + 6 + label `scrollWidth` at `nowrap`, + padding 20, + chevron part where present) + gaps + padding 32; available = the toolbar's `clientWidth`. If required > available, step 2 applies (inactive items icon-only 36 with tooltip; the active tool keeps its label). No shortened-label list (no abbreviations to translate). Re-measure on resize (ResizeObserver), font load, language change and mode change; return to step 1 only when 8 px wider than required (hysteresis, no flicker).

**Q7 Surface rule (F17.7, overrides §3.6 Settings "scrolls inside" and §3.8 "scrolling bodies").**
- Popovers and dialogs size to content (width within their range, height = content).
- A popover that fits no placement (Q8) within the viewport − 8 inset renders as a modal dialog with the same content, the anchor's label as title, max width 480.
- A dialog fits within viewport − 32 at 960 × 640 by design; only lists (`role` list, listbox, menu, tree, grid, or `data-scroll="list"`) scroll internally, with max height. Forms, headers and button rows never scroll; footers stay visible.
- **Crop popover:** width 320, padding 16, gap 16. Row 1: group label `crop.margins` ("Margins ({unit})"), then four fields in one row, order Left · Top · Right · Bottom, each 64 wide (label `.t-caption` above, number input 32, `tabular-nums`, right-aligned), gap 8 (4 × 64 + 3 × 8 = 280 ≤ 288). Row 2: Segmented full width (288), three segments 94: `crop.pages.current` · `crop.pages.all` · `crop.pages.range`; "Range" reveals a full-width range field 32 below (popover grows). Row 3: footer right-aligned, Secondary Cancel + Primary `crop.apply`, gap 8.

**Q8 Positioning engine (F17.8).** One module places tooltips, tips, coach marks, popovers, menus and the mini bar.
- Gaps from the anchor: tooltip 8, popover/menu 8, mini bar 8 (§3.3), coach mark 12; viewport inset 8.
- Placement order: tooltip top → bottom → right → left; popover/menu bottom-start → bottom-end → top-start → top-end → right → left; coach mark: its preferred side → opposite → remaining; mini bar per §3.3.
- *Menus and popovers inside a modal:* a menu or popover whose anchor is inside an open modal (`aria-modal`) renders at `--z-modal-popover` (350, between modal 300 and tooltip 400), as do its submenus and nested popovers; the app root is inert, the body-level portal stays reachable. Outside modals the layer stays `--z-popover`.
- Per candidate: **flip** to the opposite side if it overflows, then **shift** along the edge to stay inside the inset, then test collisions; first candidate with no collision wins.
- **Protected rects:** the anchor, focused element, all visible inputs, textareas, selects, contenteditables, buttons and toolbar items, the active tool, the current selection with handles. Notices (tips, coach marks, toasts) may not intersect any. Popovers and menus may not intersect the anchor, the active tool, pressed toggles (`aria-pressed=true`) or the focused input. Exception (ADR-124 addendum 1): a dropdown of the in-window menu bar (`role=menu` opened from `role=menubar`) follows OS menu conventions and may cover the tool row and the active tool below it, never its own anchor. Tooltips may not cover their anchor or a focused input.
- No placement: popover → dialog (Q7); tooltip → not shown; notice → waits in the queue (re-tested on layout change).
- **Notice queue:** at most one notice visible. Priority: 1 error toast, 2 coach mark (active tour), 3 info/success toast, 4 tip. Only an error preempts a visible notice (which returns to the queue head). FIFO within a priority. Tips wait until no input has focus for 2 s; a queued item whose context is gone is dropped.

**Q9 DOM gate (F17.10).** Run per registered surface at 960 × 640, en and de, light; tolerance 1 px. Violations are blockers.
1. *Overflow:* the surface rect leaves the viewport, or a descendant rect leaves the surface rect, or a non-list element has `scrollWidth > clientWidth`.
2. *Cut-off button:* a button, `[role=button]`, input or link is not fully inside the viewport and every clipping ancestor, or its visible label text has `scrollWidth > clientWidth` (includes ellipsis); visually hidden text (sr-only: clip/clip-path, 1 px boxes) and decorative hit-area pseudo-elements are not labels. A control scrolled out of view inside a fully visible list is not cut off.
3. *Internal scroll violation:* an element with computed `overflow-y` auto/scroll and `scrollHeight > clientHeight` that is not a list (Q7 roles).
4. *Overlap:* two interactive non-nested elements intersect; or two floating surfaces intersect; or a floating surface intersects a protected rect (Q8) outside itself. Intersections use the visible part of each element (clipped by its scrolling ancestors). In-field adornments (`data-adornment`, e.g. the password eye or the hex confirm check) inside their field wrapper are not overlaps. Modal dialogs over their scrim are exempt; menu-bar dropdowns per Q8.

**Strings.**

| Key | en | de |
|---|---|---|
| `sign.cert.lockExisting` | Set by the first signature; it cannot be changed. | Von der ersten Signatur festgelegt; nicht änderbar. |
| `sign.cert.lockNoneSet` | No lock: the file can still be changed | Keine Sperre: die Datei lässt sich noch ändern |
| `mini.strokePt` | {n} pt | {n} pt |
| `color.custom` / `color.hex` | Custom colour / Hex colour | Eigene Farbe / Hex-Farbe |
| `color.apply` | Apply colour | Farbe übernehmen |
| `color.hexInvalid` | Enter 3 or 6 hex digits, e.g. 3A7BFF. | 3 oder 6 Hex-Ziffern eingeben, z. B. 3A7BFF. |
| `draw.straighten` | Straighten shapes automatically | Formen automatisch begradigen |
| `draw.straightenHelp` | Turns rough circles, ellipses, rectangles, lines and arrows into clean shapes when you let go. Undo restores your stroke. | Macht beim Loslassen aus groben Kreisen, Ellipsen, Rechtecken, Linien und Pfeilen saubere Formen. Rückgängig stellt den Strich wieder her. |
| `draw.straightened` | Straightened to {shape} | Zu {shape} begradigt |
| `crop.margins` | Margins ({unit}) | Ränder ({unit}) |
| `crop.pages.current` / `.all` / `.range` | This page / All pages / Range | Diese Seite / Alle Seiten / Bereich |
| `crop.apply` | Crop | Zuschneiden |

**Acceptance (F17, installed release build, 960 × 640 and 1280 × 800).**
F-AC 1. A second certifying signature preselects the lock chosen last time; cancelling does not change it.
F-AC 2. An approval signature on a P=2 file shows the read-only lock text and no radios; Tab skips it.
F-AC 3. In all five modes the active tool is Solar-filled with the hairline; entering Lesen shows Auswahl filled.
F-AC 4. Stroke width shows five 36-wide segments on one line in en and de; "0,5" in de.
F-AC 5. The custom colour popover is ≥ 240 wide; the check sits inside the field; Enter applies a valid hex, Esc closes, invalid hex shows the danger caption without overlap.
F-AC 6. The straighten switch is on by default; a drawn rough circle morphs in 150 ms; Undo restores the stroke; with reduced motion it swaps instantly.
F-AC 7. No tool label ends in "…" or is clipped at 960 in de; when labels do not fit, inactive items are icon-only with tooltips and the active tool keeps its label.
F-AC 8. The crop popover shows four fields in one row and the page segmented control without scrolling; buttons fully visible.
F-AC 9. No tip, coach mark or toast covers an input, button or the active tool; only one notice is visible at a time.
F-AC 10. A popover that cannot fit opens as a dialog; Settings at 960 × 640 does not scroll its form.
F-AC 11. The DOM gate passes for every registered surface; any violation fails the run.

### 3.10 v1.5 Edit existing text (ADR-125)

Spec only; text model, font handling and the content-stream rewrite are ADR-125's. The ADR-102 layout stays: **no new mode, panel tab or grid track**. New surfaces reuse existing slots: one tool slot, the mini bar (§3.3), a popover, tooltips and the notice queue (§3.9 Q8). Light only, flat (header of this file): the brief's "Iris" maps to the single accent Solar, always paired with Ink (§2); there is no glass, so no glass fallback is needed, and no dark theme. Only semantic tokens are used, so a later theme needs no changes here. The edit box takes no new token. Two new tokens: `--edit-hover-outline` (1px Stone, offset 2 pt) and `--fallback-underline` (1px dotted Text-secondary, 2 pt below the baseline).

**E1 Entry.** In Bearbeiten, a new first slot **Text bearbeiten** (`text-cursor-input`, `editText.tool`, tooltip `editText.tooltip`) gives **Text bearbeiten · Text einfügen · Bild einfügen · Zuschneiden · Schwärzen · Schützen… · Metadaten…** (7 ≤ 8; Q6 measures). It is a tool (Q2 fill) with no tool letter, released by Esc as in §3.2. Its first use shows the tip `editText.tip` (§3.6 rules).
- **Hover** over editable text: the line's box (union of its glyph boxes, Rust) gets `--edit-hover-outline`, radius 2. Cursor `text`. Only one line is outlined at a time. Nothing else on the page changes.
- **Click** on a line: it becomes editable in place with the caret at the nearest glyph boundary to the click. **Double-click** selects a word (Unicode word boundaries), **triple-click** the line. Dragging selects within the line.
- **Commit:** Enter, a click outside the box, a mode or tool switch, Ctrl/Cmd+S (commit, then save, B1). **Cancel:** Esc (first press; a second Esc releases the tool). Clicking another line commits the current one and opens that one.
- **Tab / Shift+Tab** commit and open the next or previous editable line in reading order (Rust order: page, then paragraph, then line), continuing onto the next page. Refused lines are skipped. The target scrolls into view (spell 8, unanimated with reduced motion).
- **What you see while typing** is the final result: Rust re-renders the line in its real font (debounced 60 ms), and an app-drawn caret and selection sit over the preview. The original glyphs are hidden under the box, never shown twice.

**E2 Line and paragraph.** Rust groups text into **lines** (same baseline ± 0.2 em, same direction, gaps < 1 em) and **paragraphs**: consecutive lines with the same font size ± 0.5 pt, the same left edge ± 2 pt (or the same right edge or centre for right-aligned or centred text) and line pitch ≤ 1.6 × size. A blank gap, an indent change or a size change starts a new paragraph.
- **Visible boundary:** while a line is being edited, its paragraph shows a 2 pt Stone rule 4 pt left of the paragraph's lines, spanning their full height (`aria-hidden`). A single-line paragraph shows no rule. This is the only paragraph cue. Hover stays per line.
- **Growth (line mode, default):** the box keeps the detected alignment anchor (left, right or centre) and its height. Width follows the text instantly. Free width ends at the **limit** = min(the paragraph's widest line right edge, the next text or image object on that baseline − 4 pt, the page crop box − 12 pt).
- **Reflow (optional, per edit):** the mini bar toggle **Umbrechen** (`editText.reflow`), shown only for paragraphs of 2 or more lines. When on, words past the limit move to the next line of the same paragraph, and following lines re-wrap. The paragraph may add one line below only if the gap to the next object (or the crop box − 12 pt) is ≥ the line pitch. It never moves other paragraphs and **never crosses a page**. The default is **on** for every paragraph of 2 or more lines (ADR-132); switching it off holds for that edit only and is not stored. Without it the line stops at the paragraph edge; overflow past that edge shows the hatch, marker and caption, never past the page edge.
- **Overflow** (past the limit, line mode or reflow without room): the glyphs past the limit stay visible. A 2px `--color-danger` vertical marker sits at the limit, and the overflowing part sits on the redaction hatch at 12 % (`--color-doc-redact-fill`). The mini bar shows `editText.overflow` ("{n} pt too wide") in danger text with a `triangle-alert` 16 icon. Commit is still allowed (the text is written as typed and may touch its neighbours). The overflow state is announced once, politely.

**E3 Mini bar while editing** (§3.3 placement: above → below → docked, never over the box or its paragraph rule). Height 40, padding 4, gap 4. In order: **Font** Ghost 32 (`type` 16 + fixed label `editText.font`, no font name in the button, so it never ellipsises (Q9)). A fallback adds `triangle-alert` 16 before the label. · Size read-out `.t-caption` "11 pt" `tabular-nums` (read-only in v1.5) · divider · **Umbrechen** toggle (§2.4, only when multi-line) · divider · overflow caption (only when overflowing) · Cancel icon button 32 `x` (`editText.cancel`) · Commit icon button 32 `check` (`editText.commit`). Löschen is absent: to delete text, delete the characters; an empty line commits as removed.
- **Font popover** (Q8 popover, 280 wide, sizes to content): rows (label `.t-caption` / value `.t-body`): Font (`editText.font.original`: PostScript name, cleaned per S6 string rules) · Status (`.embedded` / `.subset` / `.notEmbedded`) · Substitute (`editText.font.fallback`: bundled family name, only if used) · Characters in substitute (`editText.font.count`, `tabular-nums`). Esc closes and returns focus to the button.

**E3a Live preview and reflow (ADR-129, v1.5.2).** While typing, the line is re-rendered from the draft without an undo step (`text_edit_preview`, debounced 60 ms, only the latest answer is shown); the edit box keeps the alignment anchor of E2, so right-aligned and centred lines grow from their right edge or centre. Reflow is `scope: paragraph` applied to the paragraph of the edited line; Umbrechen toggles it, and the change is announced politely (`editText.announce.reflowOn` / `reflowOff`).

**E4 Fallback font.** Two cases, both decided by Rust when the edit opens and on each preview:
1. **Font not embedded:** the whole line is drawn in the metric-closest bundled substitute (ADR-125 decides the fonts).
2. **Glyph missing from the embedded subset:** the changed words (word boundaries around every edited character) use the substitute; untouched words of the line keep the original font and bytes (ADR-125 addendum 1).
- **Marking:** characters set in the substitute get `--fallback-underline` (dotted, a shape cue, not colour) while editing and while hovering that line later in this session. In-app only, never written to the PDF.
- **Notice:** one info notice (§3.9 queue, priority 3), White tip anatomy (§3.6) with `info` 16. Its text is `editText.notice.notEmbedded` or `editText.notice.missingGlyphs` ({chars} lists up to 5 distinct characters, then "…" plus the count). It is anchored to the mini bar's Font button. The protected rects add the edit box, the paragraph rule and the whole mini bar, so it can never cover the box or an input. If it doesn't fit, it waits in the queue (Q8). The `triangle-alert` on the Font button and the popover keep the information either way. Shown once per line edit and case. It goes on commit or cancel, or with its Hide button (`tip.dismiss`). Never a modal.

**E5 Refusals.** Non-editable text gives no edit box. Hover shows a 1px dashed Stone outline around the run and cursor `not-allowed`. A tooltip (Q8, 8 above, never over a focused input) explains why after the normal tooltip delay. A click shows the same tooltip at once and announces it politely. Nothing is queued as a notice.

| Case (Rust detects) | Hover outline | Tooltip key |
|---|---|---|
| Invisible OCR layer over a scan (render mode 3) | yes | `editText.refuse.ocr` |
| Type3 fonts | yes | `editText.refuse.type3` |
| Text drawn as outlines (paths, no text objects) | none (no text to find); click on the shape | `editText.refuse.outlined` (only when a page-level heuristic finds glyph-like paths, otherwise nothing) |
| Text inside an image | none; click on an image | `editText.refuse.image` |
| Rotated by other than 0/90/180/270°, skewed, vertical writing mode | yes | `editText.refuse.rotated` |
| Font with no Unicode map (no ToUnicode, unknown encoding) | yes | `editText.refuse.encoding` |
| Form field values, annotations, text comments | none (other tools own them) | none |

**Document-level:** a certifying lock (S5) disables the tool with `cert.locked.tool`. A file whose permissions forbid editing uses `tool.readOnly`. A file with others' approval signatures can be edited, and the first commit shows the existing `breaksSignature` confirm, once per tab session. A page without any editable text shows `editText.noText` as a tooltip on the first click.

**E6 States.**

| State | Look |
|---|---|
| Default (tool active, no pointer) | page as is |
| Hover | `--edit-hover-outline` on the line |
| Focus (keyboard, not editing) | §2.1 pair (1px Ink + 2px Solar, offset 2) on the line |
| Active (editing) | §2.1 pair, paragraph rule, caret Ink 1px, selection `--color-doc-text-select`, mini bar |
| Disabled | tool 0.4 with tooltip (E5). On the page: dashed Stone outline |
| Busy (commit writing, > `--saving-delay`) | box keeps the pair, caret hidden, input blocked, mini bar caption `editText.busy`, `aria-busy` |
| Error (commit failed) | 2px `--color-danger` outline replaces the pair, the text stays editable, mini bar caption `editText.error` with a Retry icon button 32 (`rotate-ccw`), announced assertively |

**E7 Keyboard.** With the tool active and the canvas focused, Tab and Shift+Tab move the focus outline line by line (reading order), and Enter or F2 opens the line with the caret at its end. In the box: Left/Right/Home/End, Shift to select, Ctrl/Cmd+Left/Right by word, Ctrl/Cmd+A selects the line. Up/Down go to the start or end of the line, or move between lines when reflow is on. Shift+Enter is ignored (no new paragraphs in v1.5). Ctrl/Cmd+Z/Y inside the box undo typing in the box only; with no typing left to undo they do nothing (they never reach document undo while editing). F6 moves to the mini bar (§3.3), and Esc in the mini bar returns to the box. Digits 1–5 don't switch mode inside the box (contenteditable rule, §3.2).

**E8 Accessibility.** The box is `role="textbox"`, with `aria-multiline` true only with reflow and `aria-label` `editText.aria.line` (page, line). Its `aria-describedby` covers the keys hint and, when present, the substitute and overflow state. A polite live region announces start (`editText.announce.start`), commit, cancel, substitute (`.announce.fallback`), overflow and refusals. Errors are assertive. Text is exposed as real characters (the preview raster is `aria-hidden`). The dotted underline has a text equivalent in the Font popover and in the announcement. Hit areas are at least 24 px high regardless of zoom: small lines get an invisible padded hit box, so the outline itself stays the line's size.

**E9 Undo.** One document undo step per committed line, labelled `editText.undo` ("Edit text"). A reflowed paragraph is one step. Tab to the next line commits one step per line. Cancel and unchanged commits create no step. Undo restores the original objects byte-for-byte (Rust keeps them) and selects nothing. Spell 7 applies.

**E10 Motion.** Hover outline fades in `--motion-fast` (out `--motion-fast-exit`). The edit box, its growth and reflow change instantly (text must never lag the caret). The mini bar works per §3.3, the notice per §3.6, the scroll per spell 8. Reduced motion: the outline appears without the fade, the scroll jumps, and the mini bar and notice only fade.

**E11 Layout check (960 × 640, Q9).** Registered surfaces: the mini bar in edit state with all controls and the overflow caption (de widest: about 420 ≤ 752 canvas), the Font popover, the fallback notice and each refusal tooltip. The gate runs in en and de. The notice must not intersect the edit box, the paragraph rule or the mini bar. The mini bar docks when a line sits at the top and bottom of a short viewport. Nothing scrolls except the canvas.

| Key | en | de |
|---|---|---|
| `editText.tool` / `.tooltip` | Edit text / Edit existing text in place | Text bearbeiten / Vorhandenen Text direkt bearbeiten |
| `editText.tip` | Click a line to edit it. Tab goes to the next line, Esc cancels. | Zeile anklicken und bearbeiten. Tab springt zur nächsten Zeile, Esc bricht ab. |
| `editText.font` / `.font.original` | Font / Font | Schrift / Schrift |
| `editText.font.embedded` / `.subset` / `.notEmbedded` | Embedded / Embedded (subset) / Not embedded | Eingebettet / Eingebettet (Teilmenge) / Nicht eingebettet |
| `editText.font.fallback` / `.count` | Substitute / Characters in substitute | Ersatzschrift / Zeichen in Ersatzschrift |
| `editText.notice.notEmbedded` | This font isn't in the file. The line uses {font} instead, so it may look slightly different. | Diese Schrift ist nicht in der Datei. Die Zeile nutzt stattdessen {font} und kann leicht abweichen. |
| `editText.notice.missingGlyphs` | {chars} aren't in the file's font. They use {font} and are underlined with dots. | {chars} fehlen in der Schrift der Datei. Sie nutzen {font} und sind gepunktet unterstrichen. |
| `editText.reflow` | Wrap in paragraph | Umbrechen |
| `editText.overflow` | {n} pt too wide | {n} pt zu breit |
| `editText.cancel` / `.commit` | Cancel (Esc) / Apply (Enter) | Abbrechen (Esc) / Übernehmen (Enter) |
| `editText.busy` / `.error` | Applying… / Couldn't change the line. | Wird übernommen… / Zeile konnte nicht geändert werden. |
| `editText.undo` | Edit text | Text bearbeiten |
| `editText.aria.line` | Line {line} on page {page} | Zeile {line} auf Seite {page} |
| `editText.announce.start` | Editing. Enter applies, Escape cancels. | Bearbeiten. Enter übernimmt, Escape bricht ab. |
| `editText.announce.committed` / `.cancelled` | Line changed / Change discarded | Zeile geändert / Änderung verworfen |
| `editText.announce.fallback` | {n} characters use a substitute font | {n} Zeichen in Ersatzschrift |
| `editText.refuse.ocr` | This text was recognised from a scan and can't be edited. | Dieser Text wurde aus einem Scan erkannt und lässt sich nicht bearbeiten. |
| `editText.refuse.type3` | This text uses a drawn font and can't be edited. | Dieser Text nutzt eine gezeichnete Schrift und lässt sich nicht bearbeiten. |
| `editText.refuse.outlined` | This text was converted to shapes and can't be edited. | Dieser Text wurde in Formen umgewandelt und lässt sich nicht bearbeiten. |
| `editText.refuse.image` | This is part of an image, not text. | Das ist Teil eines Bildes, kein Text. |
| `editText.refuse.rotated` | Slanted or vertical text can't be edited yet. | Schräger oder senkrechter Text lässt sich noch nicht bearbeiten. |
| `editText.refuse.encoding` | The file doesn't say which characters this text is. | Die Datei gibt nicht an, welche Zeichen dieser Text sind. |
| `editText.noText` | No editable text on this page. | Kein bearbeitbarer Text auf dieser Seite. |

**Acceptance (installed release build, 960 × 640 and 1280 × 800).**
E-AC 1. Bearbeiten shows Text bearbeiten first. Hovering a line outlines only that line.
E-AC 2. A click puts the caret where clicked, a double-click selects a word, Enter applies, Esc restores the original, and Tab opens the next line.
E-AC 3. Typing past the limit shows the danger marker and "{n} pt too wide". With Umbrechen on, words move to the next line, and no text ever moves to another page.
E-AC 4. A non-embedded font and a missing glyph each show one notice that never covers the box or the mini bar. Substitute characters are dotted-underlined, and the Font popover names both fonts.
E-AC 5. OCR, Type3, image, rotated and unmapped text show their refusal tooltips. A locked file disables the tool.
E-AC 6. Each applied line is one Undo step. Undo restores the original exactly.
E-AC 7. A screen reader announces editing, applied, cancelled and substitute states.
E-AC 8. With reduced motion, nothing animates except fades. The DOM gate passes in en and de.

### 3.11 v1.6 Smart links

Spec only; detection rules, scoring and IPC are the v1.6 ADR's. **Binding (owner):** every smart link is a guess, drawn as an app overlay, **never written into the PDF**, switchable off, marked "Detected" / "Erkannt". **No new mode, panel tab or grid track**. New surfaces: a page overlay layer (inside the page rect), one tool slot, one top-bar slot, a link preview (tooltip class; joins §3's floating list), a range chooser (popover class, L14), one tip. Light only, tokens only, no glass. New tokens: `--smartlink-rest` (1px dashed Text-secondary, dash 3/2, 2 pt below the baseline), `--smartlink-visited` (same, Stone), `--smartlink-hover-fill` (`--surface-pressed`, `mix-blend-mode: multiply`), `--link-preview-max` 320.

**L1 Kinds** (Rust detects; the frontend gets boxes and targets by document ID, never text or paths beyond the preview string).

| Kind | Source run (the link) | Target |
|---|---|---|
| Footnote | superscript or smaller raised number/symbol in body text (¹, ³, *, †) | the note starting with the same marker at the bottom of that page (or the next page for a continued note), or the entry in an endnote section ("Notes", "Anmerkungen", "Endnoten") |
| Note back | the marker in front of a note | the one marker that points to it (only if exactly one does) |
| Contents | a contents line: title + dot leaders or gap + page number | the page; the hit area is the whole line |
| Reference | "siehe S. 12", "see p. 12", "pp. 12–14" · "Abb./Abbildung/Fig./Figure 3" · "Tab./Tabelle/Table 2" · "Kapitel/Chapter/Abschnitt/Section 4(.2)" · "§ 5" | the page (first page of a range), or the caption or heading line that starts with the same label |
| Literature | "(Müller 2019)", "(Müller, 2019, S. 4)", "Müller et al. (2019)", "[12]", "[3, 7]" | the bibliography entry. Each comma-separated part of a bracket is its own run: "[3, 7]" = two links; "[3–5]", "[3-5]" (en dash or hyphen) = one range run whose target is the chooser (L14); "[3, 5–7]" = a plain link "3" + a range run "5–7" |

**Page numbers.** A printed number resolves first to a matching page label (if the file defines labels), else through a printed-to-physical offset learned from page-number runs in headers/footers and confirmed by ≥ 3 contents lines whose title is found on the target page. No confirmed mapping, no link. The preview names both when they differ.

**L2 Confidence.** One fixed threshold, not user-adjustable, no "maybe" state. A link exists only if exactly one target scores above the threshold and the runner-up is clearly below. Ambiguous cases draw nothing (no greyed link): two "Müller 2019" without a/b suffix, "Abb. 3" with two captions, "§ 5 BGB" (a different law), a caption's own label, page numbers beyond the document. False negatives are acceptable; false positives are bugs.

**L3 What wins.** Anything already interactive wins: a candidate whose box intersects a real link rect (`get_page_links`), a form widget or an annotation is dropped. Real links keep the PDF's own appearance; the app adds for them only cursor `pointer`, a hover outline 1px Ink radius 2 and the §2.1 focus pair. They never get the underline, the fill or "Detected".

**L4 Look and states** (on the overlay layer: page bitmap < text layer < smart-link layer < real links < annotations < widgets).

| State | Look |
|---|---|
| Default | `--smartlink-rest` under the source run only (contents: under the page number only). No fill, no colour |
| Hover | underline solid Ink 1px; `--smartlink-hover-fill` on the run box (contents: the whole line), radius 2; cursor `pointer`; preview after 400 ms (L5) |
| Focus (keyboard) | §2.1 pair, offset 2, on the run box; preview at once |
| Active (pressed) | fill at full strength, no scale |
| Visited (this session, this tab) | `--smartlink-visited` instead of rest |
| Off / hidden | nothing drawn, no hit boxes, no detection running |

Glyphs stay Ink (fill multiplies). Hit boxes are at least 24 × 24 CSS px at every zoom (invisible padding, as E8); the drawn cue stays glyph-sized. A pointer press that moves ≥ 4 px becomes a text selection, so links never block selecting.

**L5 Link preview** (the "Detected" hint lives here, on every link, every time). White, `--border-subtle`, radius md, `--shadow-floating`, padding 12, width 200–`--link-preview-max`, gap 4, `role="tooltip"`, not focusable, not interactive:
1. Header 20: `wand` 16 Text-secondary + `.t-caption` `smartlinks.detected` · kind (`smartlinks.kind.*`) · target page `citation.page` (with physical page in parentheses when it differs, `smartlinks.physical`).
2. Body `.t-body` Ink: the note, entry, caption or heading text, cut by Rust to 280 characters at a word boundary + "…" (no CSS clamp, no scroll). Page targets without a heading: no body.
3. Footer `.t-caption` Text-secondary: `smartlinks.previewHint` with kbd.

Range run (L14): header `smartlinks.detected` · `smartlinks.kind.literature` · `smartlinks.range.count` ("Erkannt · Quelle · 3 Einträge"), no target page, no body; footer `smartlinks.range.hint` instead of `previewHint`. Not shown while its chooser is open.

Placement Q8 tooltip order, gap 8; protected rects add the source run, the selection and the mini bar. No fit: not shown (the link still works). Timing spell 16. `wand` is the app's one "derived" sign (as B8's outline row).

**One-time tip** (§3.6 rules: once ever, cap 3/session, queue priority 4): tip id `smartlinks`, anchored to the Lesen tool slot (L8), shown after the first hover or focus on a detected link: `tip.smartlinks`.

**L6 Following a link.** Click (or Enter/Space) pushes the current view (L7), then scrolls with spell 8. The target band (target lines' boxes + 2 pt) gets `--smartlink-hover-fill`, pulses 1 → 0.4 → 1 once (2 × `--motion-fast`) and fades out after 1200 ms. Page targets: no band, page top 24 below the canvas top. Focus goes to the target if it is a link (note back), else to the canvas. Zoom never changes. Polite `smartlinks.announce.jump`.

**L7 Back and forward.** History per document tab, session only, dropped on close.
- **Entry:** page ID + offset in page points + zoom + fit mode, so re-layout and sidebar changes still restore the exact view. Pushed by smart links, real internal links, outline rows and page-field Enter; not by scrolling, search or comment rows. A push within one viewport of the top entry replaces it.
- **Depth:** 50 back; forward cleared by every new push. Entries of deleted pages drop; reorders keep them (page IDs).
- **Restore:** zoom and fit mode first, then scroll, both instant (a return must land exactly). The origin run gets a 2px Ink outline for 1 s; focus returns to it if the jump was made by keyboard.
- **Keys** (document scope; inputs, crop handles, organize grid and contenteditables keep their own Alt+arrows): Back Alt+Left (macOS Cmd+[), forward Alt+Right (Cmd+]); mouse buttons 4/5. Alt+Left never opens the menu row (Alt was combined).
- **Control:** top bar centre group, after the page field, gap 8: Ghost 28, radius sm, `arrow-left` 16 (never `chevron-left`, which is Home). From 1100 window width it carries a label `.t-caption` `tabular-nums` "p. 4" (`nav.back.label`, the page you return to), fixed width 96; a label that does not fit, and every width below 1100, shows the icon only (no ellipsis, Q6). Tooltip `nav.back` + kbd; empty history: disabled 0.4, tooltip `nav.back.empty`. The slot is always present, so the centre group never shifts. Polite announcement `nav.announce.back`.

**L8 On/off.**
- **Settings:** new group "Smart links" (`settings.smartLinks`) between Drawing and Updates (the §3.6 group test now asserts seven labels): Toggle `settings.smartLinks.toggle`, default **on**, hint `settings.smartLinks.hint`. UI storage `sheer.smartLinks.enabled`. Changing it applies to every open tab and clears their per-tab overrides. The popover still fits 960 × 640 without scrolling (F-AC 10).
- **Quick toggle (per document tab, session):** Lesen gains slot 7 **Smarte Links** (`wand`, kind *toggle*, §3.5 toggle style, `aria-pressed`, tooltip `smartlinks.toggleHelp`): Auswahl · Hand · Textauswahl · Lupe · Drehen · Suche · Smarte Links (7 ≤ 8, Q6 measures). Mirrored by Ansicht → "Smart links" (`menu.view.smartLinks`, checkable). Turning it off removes the layer at once and announces `smartlinks.announce.off`; history stays.

**L9 Modes and tools.** Smart and real links are live only while the active tool is Auswahl, Hand (a click without drag follows) or Textauswahl, in any mode except Seiten. Hidden (not drawn, no hit boxes) while another tool is active, during Text bearbeiten, a redaction band, the tour's canvas steps or a selection drag. After a committed text edit, a page change or an undo, that page's links are recomputed for the new revision; stale links are never shown.

**L10 Performance.** Rust detects lazily for pages entering the render window (visible ± 1), at background priority after rendering, cached per page and revision. Target indexes (notes, captions, headings, bibliography, page mapping) build once per revision in the background; a link whose index is not ready is not drawn (no spinner, no wrong pop-in). Budget ≤ 30 ms per page; scrolling never waits. Off = no work.

**L11 Keyboard and screen readers.**
- Links are **not** separate Tab stops. Each visible page's links (real and smart, reading order) form one `role="list"` per page with one Tab stop, after the page and before the margin column (B9). Inside: Down/Right next, Up/Left previous, Home/End, Enter/Space follow, Esc back to the canvas. Past the last link, the next page's first link takes focus and scrolls into view.
- Each smart link: `role="link"`, name `smartlinks.aria.*` (kind, marker text, "detected", target page), `aria-describedby` = the preview text; visited adds nothing (visual only). Real links: `link.aria.page` / `link.aria.url`. The list is named `smartlinks.aria.list`.
- A range run is `role="button"`, `aria-haspopup="listbox"`, `aria-expanded`, name `smartlinks.aria.range`; Enter/Space opens its chooser (L14) instead of following.
- Contrast: rest underline Text-secondary 5.0:1, visited Stone 3.47:1, hover Ink; the state cue is line style plus fill, never colour alone (§2).

**L12 Motion.** Underline rest → hover: `--motion-fast` (out `--motion-fast-exit`). Preview: spell 16. Jump: spell 8. Back/forward: instant. Toggle off: layer fades `--motion-fast-exit`. Reduced motion: no fades on the underline, preview fades only, jumps are instant with the 2px Ink outline for 1 s instead of the band pulse.

**L13 Layout check (Q9, both sizes, en and de).** Registered: the link preview (longest de body, and the range variant), the Back control (labelled, disabled, icon-only), the 7-slot Lesen row, the tip, Settings with the new group, the range chooser (L14: 2 rows, and 20 rows scrolled to the end; anchored near the page's bottom edge so it flips to top-start).

| Key | en | de |
|---|---|---|
| `smartlinks.detected` | Detected | Erkannt |
| `smartlinks.kind.footnote` / `.noteBack` / `.contents` / `.reference` / `.literature` | Footnote / Back to text / Contents / Reference / Source | Fußnote / Zurück zum Text / Inhalt / Verweis / Quelle |
| `smartlinks.physical` | (page {n} of the file) | (Seite {n} der Datei) |
| `smartlinks.previewHint` | Click to jump · {back} returns | Klicken zum Springen · {back} kehrt zurück |
| `smartlinks.toggle` / `.toggleHelp` | Smart links / Footnotes, contents, references and sources as links. Guessed, never saved in the file. | Smarte Links / Fußnoten, Inhalt, Verweise und Quellen als Links. Geschätzt, nie in der Datei gespeichert. |
| `menu.view.smartLinks` | Smart links | Smarte Verknüpfungen |
| `settings.smartLinks` / `.toggle` | Smart links / Detect footnotes, contents, references and sources | Smarte Verknüpfungen / Fußnoten, Inhalt, Verweise und Quellen erkennen |
| `settings.smartLinks.hint` | Shown only in sheer., never written into your PDF. | Nur in sheer. angezeigt, nie in deine PDF geschrieben. |
| `tip.smartlinks` | Links marked Detected are guessed by sheer. and not in the file. Alt+Left goes back. | Mit Erkannt markierte Links rät sheer.; sie stehen nicht in der Datei. Alt+← führt zurück. |
| `smartlinks.aria.footnote` | Footnote {marker}, detected, page {page} | Fußnote {marker}, erkannt, Seite {page} |
| `smartlinks.aria.noteBack` | Back to footnote {marker} in the text, detected, page {page} | Zurück zu Fußnote {marker} im Text, erkannt, Seite {page} |
| `smartlinks.aria.contents` | {title}, detected, page {page} | {title}, erkannt, Seite {page} |
| `smartlinks.aria.reference` | {text}, detected, page {page} | {text}, erkannt, Seite {page} |
| `smartlinks.aria.literature` | Source {text}, detected, page {page} | Quelle {text}, erkannt, Seite {page} |
| `smartlinks.aria.list` | Links on page {page} | Links auf Seite {page} |
| `link.aria.page` / `.url` | Link to page {page} / Link to {host} | Link zu Seite {page} / Link zu {host} |
| `smartlinks.announce.jump` | Page {page}. {back} goes back. | Seite {page}. {back} führt zurück. |
| `smartlinks.announce.off` / `.on` | Smart links off / Smart links on | Smarte Links aus / Smarte Links an |
| `nav.back` / `.forward` | Back to previous view / Forward | Zurück zur vorigen Ansicht / Vorwärts |
| `nav.back.label` | p. {label} | S. {label} |
| `nav.back.empty` | Nothing to go back to yet | Noch nichts zum Zurückkehren |
| `nav.announce.back` | Back to page {page} | Zurück zu Seite {page} |

`{back}` renders the platform key (Alt+← / ⌘[).

**L14 Range chooser** (ADR-133 §2; Q8 popover, joins §3's floating list; light only, no glass).
- **Resolution.** Rust expands a range part ("3–5", "3-5") and resolves every number on its own by L2. ≥ 2 resolved: one range run (L1) whose chooser lists only the resolved numbers, ascending. Exactly 1: a plain literature link to it, no chooser. 0: no link. Reversed, zero-based or wider than 50 numbers: no link (hostile input bound). `{n}` = resolved count.
- **Run.** L4 states apply to the printed range part. While open: Active fill held, `aria-expanded="true"`; the hover preview (L5) closes and does not reopen.
- **Surface.** `--surface-panel`, `--border-subtle`, radius md, `--shadow-floating`, width `--link-preview-max` (320), padding 8. Header 28 (padding-inline 8): `wand` 16 Text-secondary + `.t-caption` `smartlinks.detected` · `smartlinks.range.count`; never scrolls. Below it the list, `role="listbox"`, rows 32, at most 12 visible (max height 384), beyond that the list scrolls (Q7 list; Q9 rule 3 exempt).
- **Row** (`role="option"`, radius sm, padding-inline 8, gap 8): number `.t-label` Ink `tabular-nums`, right-aligned, column 32 · entry preview `.t-body` Ink, flex 1, one line · target page `.t-caption` Text-secondary `tabular-nums` `citation.page`, right-aligned, intrinsic width. States: hover `--surface-subtle`; current (keyboard) `--surface-subtle` + §2.1 pair inset 2; pressed `--surface-pressed`; no disabled rows (unresolved numbers are absent).
- **Truncate rule.** Rust sends each entry cut to 120 characters at a word boundary. The frontend fits it to one line by measurement: drop trailing words until text + "…" fits (`scrollWidth ≤ clientWidth`); a single over-long word is cut at the last fitting grapheme + "…". Never CSS `text-overflow` (Q6, Q9 rule 2). Re-measured on font load and language change.
- **Placement.** Q8 popover order bottom-start → bottom-end → top-start → top-end → right → left, gap 8, inset 8; protected rects: the range run, the selection, the mini bar, the active tool, pressed toggles. No fit: Q7 dialog titled `smartlinks.range.title`. Closes on Esc, outside click, scroll, zoom, tool or mode change, toggle off, revision change; repositions on window resize.
- **Pointer.** Click on the run opens it with the first row current; click on a row closes it and follows (L6).
- **Keyboard.** Open (Enter/Space on the run) focuses the listbox, `aria-activedescendant` on the first row. Down/Up (no wrap), Home/End, PageDown/PageUp by 12, typed digits jump to that number. Enter: close, then the L6 jump (L7 pushes the view; origin = the range run, so Back restores focus to it). Esc or Tab/Shift+Tab: close, focus returns to the run (still inside the page's link list).
- **Screen readers.** Run per L11. Listbox named `smartlinks.aria.rangeList`; each option named `smartlinks.aria.rangeEntry`, `aria-describedby` = the 120-character entry text.
- **Motion.** Open: opacity 0 → 1 + 4 px translate from the anchor side, `--motion-fast` spring; close `--motion-fast-exit`. Row fill `--motion-fast`. Reduced motion: fades only.

| Key | en | de |
|---|---|---|
| `smartlinks.range.count` | {n} entries | {n} Einträge |
| `smartlinks.range.hint` | Click to choose · {back} returns | Klicken zum Auswählen · {back} kehrt zurück |
| `smartlinks.range.title` / `smartlinks.aria.rangeList` | Sources {range} | Quellen {range} |
| `smartlinks.aria.range` | Sources {range}, detected, {n} entries | Quellen {range}, erkannt, {n} Einträge |
| `smartlinks.aria.rangeEntry` | Source {number}, page {page} | Quelle {number}, Seite {page} |

**Acceptance (installed release build, mouse unless a key is named).**
L-AC 1. A footnote marker shows a dashed underline; hovering shows the preview with "Detected", the note text and the page; clicking scrolls to the note with the band pulse.
L-AC 2. Alt+Left (macOS Cmd+[) and the Back control return to the exact previous scroll position and zoom, also after zooming at the target; Alt+Right goes forward again.
L-AC 3. Back holds 50 entries; a new jump clears forward; closing the tab drops the history.
L-AC 4. A contents line with dot leaders jumps to the right page in a file whose printed numbers differ from physical pages; the preview names both.
L-AC 5. "see p. 12", "Abb. 3", "Tabelle 2", "Kapitel 4" and "§ 5" link to their page, caption or heading; an ambiguous "Abb. 3" (two captions) is not linked.
L-AC 6. "[12]", "(Müller 2019)" and "Müller et al. (2019)" link to the bibliography entry; two "Müller 2019" entries leave the reference unlinked.
L-AC 7. A detected candidate under a real link, form field or annotation is not drawn; the real link works as before.
L-AC 8. Saving and reopening the file (and opening it in another reader) shows no smart link, annotation or change; the save status stays "Saved" after following links.
L-AC 9. The Lesen toggle turns links off for this tab only; Settings turns them off for all tabs and survives a restart; when off, nothing is drawn.
L-AC 10. With Hervorheben or Text bearbeiten active, no link is drawn or clickable; dragging from a marker selects text.
L-AC 11. Tab reaches one link list per page; arrows move, Enter follows; a screen reader reads "Footnote 3, detected, page 12".
L-AC 12. Scrolling a 500-page file stays smooth; links appear only on rendered pages and never in a wrong place.
L-AC 13. With reduced motion, jumps are instant with the 1 s Ink outline and only fades remain.
L-AC 14. The DOM gate passes for every L13 surface in en and de at both sizes; nothing overlaps.
L-AC 15. "[3–5]", "[3-5]" and the "5–7" part of "[3, 5–7]" each show one underline; hover reads "Detected · Source · 3 entries"; click opens the chooser beside the run with one row per resolved number (unresolved absent; one resolved = plain link; none = no link); arrows + Enter jump and Back returns to the run; Esc closes and refocuses the run; 20 entries scroll after 12 rows.

### 3.12 v1.7 Scan & OCR (ADR-134, ADR-135)

Spec only; pipeline, layer and IPC are ADR-134's and ARCHITECTURE §15's. **No new mode, panel tab, grid track or tool slot** (Seiten has 8). New surfaces: OCR banner (banner slot, §3.2), OCR dialog, one Werkzeuge item, OCR toasts (§3.9 queue). Light only, tokens only, no glass ("Iris" = Solar, §3.10), no new tokens. Scripts address surfaces by `data-surface`.

**O1 Entry.** One command, **Text erkennen…** (`ocr.command`), in Werkzeuge after "Signaturen verwalten" (separator before; macOS native menu matches). It opens the dialog (O2). Two ways lead to it, nothing else:
- **Offer banner** (`data-surface="ocr-banner"`, variant `offer`): `ocr_classify_pages` runs in the background after the first render and each revision. Shown when the backend is not `none`, ≥ 1 page is `scan`, the document is not locked (O4) and not dismissed in this tab. §4 Banner: Sand, `scan-text` 16, `.t-label` `ocr.banner.page` (current page is a scan) else `ocr.banner.pages`; right: Ghost 28 `ocr.banner.action`, close 28 (`ocr.banner.dismiss`, tab session).
- **Seiten mode:** with cards selected, the command preselects scope "Selected pages".
- **Slot priority** (single 40 row): redact band > signature banner > OCR progress > form banner > OCR offer.

**O2 Dialog** (`data-surface="ocr-dialog"`). §4 Dialog, width `--dialog-width-md` (480), title `.t-h3` `ocr.title`, rows gap 16, sizes to content (Q7, never scrolls).
1. **Scope:** radiogroup `ocr.scope`: `ocr.scope.scan` (default when n ≥ 1) · `ocr.scope.current` · `ocr.scope.selected` (only with selected cards; then default) · `ocr.scope.all`. Counts `tabular-nums`. Caption `ocr.scope.hint` below. Within any scope only `scan` pages run (plus `sheerLayer` with Redo); `text`, `hasTextLayer`, `empty` are never touched (ADR-134 §5).
2. **Redo:** checkbox `ocr.redo` with count, shown only when the scope holds `sheerLayer` pages; default off.
3. **Language:** label `ocr.lang`, value `.t-body` = UI language (de → German/de-DE, en → English/en-US; ADR-135 §2), read-only, from `ocr_capabilities`:
   - available: value only;
   - fallback (other language available): `info` 16 + `.t-caption` `ocr.lang.fallback` (ADR-134 §3 ii);
   - none available (Windows): `triangle-alert` 16 + `.t-caption` `ocr.lang.none`, then Secondary 32 `ocr.lang.settings` opening `ms-settings:regionlanguage`. The command stays enabled here so the button has a home (reading of ADR-134 §3 iii).
4. **Footer:** Secondary `ocr.cancel`, Primary `ocr.start` ("Recognize {n} pages"). Disabled (0.4, tooltip) when n = 0 (`ocr.nothing`, also as caption above the footer) or no language.

**O3 Progress and result.** Start calls `ocr_start`; the dialog closes, focus returns to the invoker (banner action, else the canvas).
- **Progress banner** (variant `progress`, replaces the offer): Sand, `scan-text` 16, `.t-label` `ocr.progress` (page = done + 1, `tabular-nums`), right Ghost 28 `ocr.stop`. Between label and Stop a full-width determinate 4 px track on `--surface-pressed` with an Ink fill (width = done/total from `ocrProgress`), `done/total` tabular next to it (ADR-137). Stop calls `ocr_cancel`; the label becomes `ocr.stopping`, Stop disabled.
- **During a run** reading, search, annotating and zoom stay live; Save, Fertig, closing the tab and page structure changes are disabled (`ocr.busy`). Recognized pages are searchable at once (ADR-134 §8).
- **`ocrFinished`:** banner leaves. Toast (priority 3): `ocr.done`; with `failed` > 0 `ocr.donePartial`; after Stop `ocr.stopped`. All applied pages are one undo step (`ocr.undo`). `applied` = 0 and `failed` > 0, or a refused `ocr_start`: error toast `triangle-alert` `ocr.failed` + Ghost `ocr.retry` (reopens the dialog). `page_too_large` counts as failed.

**O4 States.**

| Case | Command | Banner |
|---|---|---|
| backend `none` | disabled 0.4, reason `ocr.unavailable` | none |
| signed/certified (ADR-121 lock) | disabled, `cert.locked.tool` | none |
| no `modify` permission | disabled, `tool.readOnly` | none |
| no scan pages | enabled; scan scope shows 0, Start disabled (`ocr.nothing`) | none |
| no language | enabled; O2 row 3 none state | offer shown |
| job running in this tab | disabled, `ocr.busy` | progress |

**O5 Keyboard.** Dialog: focus on the checked radio, arrows within the group; Tab order scope → Redo → settings → Cancel → Start; Enter starts when enabled; Esc cancels. Banner controls are Tab stops before the first page; Esc never stops a run.

**O6 Accessibility.** The offer banner is `role="status"` (announced once per open); the progress banner is not a live region and its per-page label is `aria-live="off"`. Bar `role="progressbar"` (`aria-valuenow` done, `aria-valuemax` total, `aria-valuetext` `ocr.progress`). Polite `ocr.announce.start` and result; failure assertive; no per-page announcements. Language captions are the row's `aria-describedby`. Bar Ink on `--surface-pressed` ≥ 3:1; state is never colour alone.

**O7 Motion.** Banner: opacity in `--motion-base` (out `--motion-base-exit`), slot height instant. Bar width `--motion-base` `--ease-out` per push. Dialog and toasts as §4. Reduced motion: fades only, bar jumps.

| Key | en | de |
|---|---|---|
| `ocr.command` / `ocr.title` | Recognize text… / Recognize text | Text erkennen… / Text erkennen |
| `ocr.banner.page` | This page is an image. Recognize text? | Diese Seite ist ein Bild. Text erkennen? |
| `ocr.banner.pages` | {n} pages are images. Recognize text? | {n} Seiten sind Bilder. Text erkennen? |
| `ocr.banner.action` / `.dismiss` | Recognize text… / Hide | Text erkennen… / Ausblenden |
| `ocr.scope` | Pages | Seiten |
| `ocr.scope.scan` / `.current` / `.selected` / `.all` | Scanned pages ({n}) / This page / Selected pages ({n}) / All pages | Gescannte Seiten ({n}) / Diese Seite / Ausgewählte Seiten ({n}) / Alle Seiten |
| `ocr.scope.hint` | Pages that already have text are skipped. | Seiten mit Text werden übersprungen. |
| `ocr.redo` | Recognize again pages done by {app} ({n}) | Von {app} erkannte Seiten neu erkennen ({n}) |
| `ocr.lang` | Language | Sprache |
| `ocr.lang.fallback` | {wanted} recognition isn't installed on this computer; {used} is used — some words may be wrong. | Die Erkennung für {wanted} ist auf diesem Computer nicht installiert; {used} wird verwendet – einige Wörter können falsch sein. |
| `ocr.lang.none` | No recognition language is installed on this computer. | Auf diesem Computer ist keine Erkennungssprache installiert. |
| `ocr.lang.settings` | Open language settings | Spracheinstellungen öffnen |
| `ocr.start` | Recognize {n} pages | {n} Seiten erkennen |
| `ocr.nothing` | No scanned pages to recognize here. | Hier gibt es keine gescannten Seiten. |
| `ocr.progress` | Recognizing page {page} of {total} | Erkenne Seite {page} von {total} |
| `ocr.stop` / `ocr.stopping` | Stop / Stopping… | Stoppen / Wird gestoppt… |
| `ocr.cancel` / `ocr.retry` | Cancel / Try again | Abbrechen / Erneut versuchen |
| `ocr.busy` | Wait until text recognition finishes. | Warte, bis die Texterkennung fertig ist. |
| `ocr.done` | Text recognized on {applied} pages | Text auf {applied} Seiten erkannt |
| `ocr.donePartial` | Text recognized on {applied} pages; {failed} failed | Text auf {applied} Seiten erkannt; {failed} fehlgeschlagen |
| `ocr.stopped` | Stopped. Text recognized on {applied} of {total} pages | Gestoppt. Text auf {applied} von {total} Seiten erkannt |
| `ocr.failed` | Text couldn't be recognized. | Text konnte nicht erkannt werden. |
| `ocr.unavailable` | Text recognition isn't available on this computer. | Texterkennung ist auf diesem Computer nicht verfügbar. |
| `ocr.undo` | Recognize text | Text erkennen |
| `ocr.announce.start` | Recognizing text on {total} pages | Erkenne Text auf {total} Seiten |

`{wanted}`/`{used}` are language names in the UI language; `{app}` = `APP_NAME`.

**O8 Surface gate (Q9, 960 × 640 and 1280 × 800, en and de).** Registered: `ocr-banner` (offer page/pages; progress at 0 %, mid, stopping), `ocr-dialog` (default; selected scope; Redo row; fallback; none state with settings button; n = 0), Werkzeuge menu with the item enabled and disabled, toasts `ocr.done`, `ocr.donePartial`, `ocr.stopped`, `ocr.failed`. The banner never covers a page; the toast never covers the banner's Stop.

**Acceptance (acceptance build, CDP; fixtures = generated image-only PDFs under `review/` and owner-pdf-F2).**
O-AC 1. A 3-page image-only PDF shows the offer "3 pages are images"; a mixed file on its scan page reads "This page is an image".
O-AC 2. A text-only PDF shows no banner; the dialog shows 0, Start disabled with `ocr.nothing`.
O-AC 3. Werkzeuge → Text erkennen… and the banner action open the same dialog; scope defaults to Scanned pages.
O-AC 4. In Seiten with 2 cards selected, the scope defaults to "Selected pages (2)".
O-AC 5. UI de: language row reads German; UI en without en-US: fallback caption names English and German.
O-AC 6. With no language available (mocked capabilities), the settings button shows and Start is disabled.
O-AC 7. Start closes the dialog; the banner reads "Recognizing page 1 of 3", bar and `aria-valuenow` advance per `ocrProgress`.
O-AC 8. After finish: toast "Text recognized on 3 pages"; search finds a known word on page 2 before saving; one Undo removes all three layers.
O-AC 9. Stop during page 2: toast `ocr.stopped` with applied < total; recognized pages stay searchable.
O-AC 10. During a run Save, Fertig and Löschen are disabled with `ocr.busy`; zoom and search work.
O-AC 11. Redo row appears only after a first run; unchecked, a second run skips those pages.
O-AC 12. A certified file and a no-modify file: command disabled with the matching tooltip, no banner.
O-AC 13. Backend `none` (mocked): command disabled with `ocr.unavailable`; no banner.
O-AC 14. Save and reopen: pages look pixel-identical, search still hits, the offer banner is gone.
O-AC 15. Keyboard only: banner action → arrows → Enter starts; Esc in the dialog cancels; focus returns to the invoker.
O-AC 16. Reduced motion: only fades; the O8 gate passes for every registered surface; nothing overlaps.

### 3.13 v1.8 Context help (ADR-138)

A delta on §3.6 Tips (v1.1 §3.47 rules stay) and §3.9 Q8. Four situations get a **clip tip** (text + 3 s APNG); every other tip stays text-only and unchanged (`note`, `text`, `draw`, `shapes`, `cite`, `insertText`, `crop`, `redact`, `editText`, `smartlinks`). Light only, tokens only, no new grid track, mode or panel; the tip is a floating notice (Q8 queue, priority 4). Surface `data-surface="tip"`, `data-tip-id`.

**C1 Situations.**

| Id | Trigger | Anchor (Q8, side bottom) | Goes when |
|---|---|---|---|
| `highlightClip` | Highlight (or Underline/Strikethrough) becomes the active tool (as built) | pressed tool item, else ⋯ (as built) | tool released |
| `formClip` (new) | A document with ≥ 1 fillable AcroForm field (not read-only; XFA-only excluded) becomes the **active tab** (open or tab switch), after its first page renders, mode ≠ Seiten | the form banner's "first field" link (`[data-banner="form"] button`), align start; banner absent (dismissed or lost the slot) → Fill & Sign segment `[data-tour-anchor="mode-fill"]`, centred | tab change, Seiten entered, first field value committed, dismiss |
| `signClip` | Signature tool armed for placing (as built; while the signature sheet is open the tip waits, dialog rule) | `signature` tool item | tool released |
| `pagesClip` | Entering Seiten (its idle tool `pages` turns active, as built) | `organize` item (as built) | mode left |

*Form on open, not on first field focus:* tips wait while an input has focus (Q8, 2 s), so a focus trigger would arrive after the user found the fields. The clip tips have their own ids (`highlightClip`, `formClip`, `signClip`, `pagesClip`, ADR-139): users who saw the v1.7 text tips (`highlight`, `sign`, `pages`) or the v1.8 `form` tip see each clip once; the old ids stay in `tipsSeen` and are ignored.

**C2 Placement.** Candidates in order: (1) anchor side per Q8 (flip, shift, collision test; gap 8; clamped inside the canvas scroller, inset 8); (2) dock bottom-end of the canvas, inset 16 (§3.6); (3) the **text-only card** (§3.6, 280) at (1) then (2); (4) wait in the queue. Protected rects (Q8): all inputs including form fields on the page, the anchor, the selection with handles, the mini bar, toolbar items. Re-placed on resize, mini bar appearance and banner change.

**C3 Anatomy.** Card White, `--border-subtle`, `--radius-lg`, `--shadow-floating`, width **`--tip-card-clip-width` 344** (max: canvas − 16), padding 12, column:
1. **Clip** `--tip-clip-width` 320 × `--tip-clip-height` 200 (16:10), `--radius-md`, 1px `--border-subtle`, Sand background; `<img>` `object-fit: cover`, `alt` = `tip.{id}.clip`. Fixed box: never resizes.
2. **Header row 28**, 8 below: `lightbulb` 16 Ink, gap 8, title `.t-label` Ink 500 (one line; flexes); right, gap 4: icon button 28 `rotate-ccw` (`tip.replay`), icon button 28 `x` (`tip.dismiss`).
3. **Body** `.t-body` Ink, 4 below, ≤ 2 short sentences, max 3 lines at 320 in de (texts written to fit). Height ≤ 324.

No "Don't show tips" link: four clip tips, each once, plus Hide is enough; the switch lives in Settings (C5). No arrow, no timeout.

**Clip asset.** `src/assets/tips/{id}.png` (an APNG; the `.png` extension keeps the bundler and the asset protocol on `image/png`) + `{id}-poster.png` (the last frame), 640 × 400 px (2×), ≤ 12 fps, 3.0 s, **`num_plays` 1** (stays on the last frame; ≤ 5 s so no pause control is needed, WCAG 2.2.2), ≤ 600 KB; poster ≤ 120 KB.

**States.**
- *Loading:* the card enters after `img.decode()` resolves or 400 ms pass; then the fixed box shows Sand and the image fades in `--motion-fast` (no layout shift).
- *Playing:* starts when the enter motion ends; Replay (always enabled) restarts it (re-keyed `src`). *Ended:* last frame stays.
- *Error* (missing or undecodable before showing): text-only card (§3.6), same body, no title. After showing: swap to the poster.
- *Reduced motion:* poster, no autoplay, no Replay; card fades `--motion-fast`.

**Keyboard and screen reader.** Never takes focus on show. `role="region"` `aria-labelledby` the title; the anchor's `aria-describedby` = body; title + body announced once politely (`tip.announce`, as built). Tab order: Replay, Hide; Esc dismisses, focus to the canvas (as built). The img carries `alt`, not a Tab stop.

**Motion.** As §3.6 (opacity + `--scale-enter`, `--motion-slow`; exit `--motion-slow-exit`).

**C4 Frequency.**
- Once ever per situation: the id is written to `tipsSeen` before showing (as built); "Show tips again" clears it.
- At most once per situation per session (runtime session set, as built), even after "Show tips again".
- Clip tips count toward the 3-per-session cap; a tip blocked by the cap is **not** marked seen and shows in a later session.
- Never during a running or paused tour or with a coach mark, menu, dialog or popover open; one notice at a time (Q8); an overlay opening later dismisses it (all as built). A queued tip whose context is gone (C1) is dropped unseen.
- `tipsEnabled` false (C5) blocks everything before any write.

**C5 Setting `tipsEnabled`** (settings store, boolean, default true; unknown/missing → true). Group "Tour & tips" (§3.6 group 5), one wrapping row (gap 12 / 4, items centred; ADR-124 fit at 960×640, about 72 px less than three stacked rows): (1) Secondary "Restart tour"/"Start tour" (as built); (2) **Toggle** (§4, 36 × 20) + 8 + label `.t-body` `settings.tips.enabled`, row 36, label is the toggle's accessible name (`role="switch"`, `aria-checked`); (3) Ghost "Show tips again"; hint `.t-caption` below (live).
- *Off:* no tip of any kind shows or queues; a visible tip leaves at once; `tipsSeen` is not written. Tour, coach marks, banners, toasts and the edit-text fallback notice are unaffected. "Show tips again" disabled (0.4, `aria-disabled`, tooltip and hint `settings.tips.offHint`).
- *On again:* remaining unseen tips resume. Still six groups (§3.6 test unchanged).

**C6 Storyboards.** Script `scripts/ui/accept/v18-clips.mjs`, acceptance build 1280 × 800, light, en, `tipsEnabled` off, no tour, sidebar closed, zoom 100 %. CDP `Page.captureScreenshot` with `clip` = region (CSS px, from the named element's rect) and `scale` giving 640 × 400; 12 fps into `scripts/ui/apng.mjs`. The webview has no OS pointer: the recorder composites a self-drawn pointer (`mouse-pointer-2` 20, Ink, White outline) at the CDP input position, a 24 Stone ring for 150 ms per press, and a §4 kbd chip bottom-right for 0.5 s per key. Self-made documents only (rule 16). Times in s.

1. **highlight**: welcome document p. 1, Comment, Highlight on; region 320 × 200 (scale 2) on the tour's highlight sentence. 0–0.4 pointer at sentence start (start frame: plain text); 0.4–1.8 drag to its end; 1.8–2.2 release, highlight appears; 2.2–3.0 pointer moves 40 off and rests. End: highlighted sentence.
2. **form**: new generated fixture `tests/fixtures/form-clip.pdf` (text fields "Name", "City", one checkbox), Lesen; region 320 × 200 (scale 2) over both fields. 0–0.5 click "Name"; 0.5–1.4 type "Alex Example"; 1.4–1.7 Tab; 1.7–2.5 type "Berlin"; 2.5–3.0 hold. End: both filled.
3. **sign**: welcome document, signature-frame page, Fill & Sign, typed signature "A. Example" saved beforehand, tool armed; region 480 × 300 (scale 4/3) around the frame. 0–0.3 ghost left of the frame; 0.3–1.2 move in; 1.2 click places; 1.3–2.3 drag bottom-right handle 32 out; 2.3–2.6 click empty area; 2.6–3.0 hold. End: signature, no handles.
4. **pages**: welcome document, Seiten, ≥ 4 cards; region 480 × 300 (scale 4/3) over cards 1–3. 0–0.4 pointer on card 3; 0.4–1.8 drag before card 1 (indicator); 1.8–2.2 drop, reflow; 2.2–3.0 hold; Undo after recording. End: order 3, 1, 2.

**C7 Strings** (`{mod}` as built).

| Key | en | de |
|---|---|---|
| `tip.highlightClip.title` | Highlight text | Text hervorheben |
| `tip.highlightClip` | unchanged (§3.6) | unchanged |
| `tip.highlightClip.clip` | Animation: the pointer drags across a sentence and it turns highlighted. | Animation: Der Zeiger zieht über einen Satz, der Satz wird hervorgehoben. |
| `tip.formClip.title` | This document is a form | Dieses Dokument ist ein Formular |
| `tip.formClip` | Click a field and type. Tab moves to the next field. | Feld anklicken und tippen. Tab springt zum nächsten Feld. |
| `tip.formClip.clip` | Animation: a name is typed into a field, then Tab moves to the next field. | Animation: Ein Name wird in ein Feld getippt, Tab springt ins nächste Feld. |
| `tip.signClip.title` | Place your signature | Signatur platzieren |
| `tip.signClip` | Click where it belongs and drag a corner to resize. Saved signatures stay encrypted on this device. | Klicken, wo sie hinsoll; an einer Ecke ziehen ändert die Größe. Signaturen bleiben verschlüsselt auf diesem Gerät. |
| `tip.signClip.clip` | Animation: a signature is placed in a frame and made larger. | Animation: Eine Signatur wird in einen Rahmen gesetzt und vergrößert. |
| `tip.pagesClip.title` | Reorder pages | Seiten ordnen |
| `tip.pagesClip` | Drag a page to move it. Shift or {mod} selects several pages. | Seite ziehen, um sie zu verschieben. Umschalt oder {mod} wählt mehrere Seiten. |
| `tip.pagesClip.clip` | Animation: the third page is dragged in front of the first. | Animation: Die dritte Seite wird vor die erste gezogen. |
| `tip.replay` | Play again | Erneut abspielen |
| `settings.tips.enabled` | Show tips | Tipps anzeigen |
| `settings.tips.offHint` | Tips are off. The tour still works. | Tipps sind aus. Die Tour funktioniert weiterhin. |

Tokens added: `--tip-card-clip-width` 344, `--tip-clip-width` 320, `--tip-clip-height` 200.

**C8 Surface gate (Q9, 960 × 640 and 1280 × 800, en and de, light).** Registered: `tip` for each of the four ids (playing, ended), loading box, error → text-only, reduced motion; text-only fallback via C2 (3); Settings panel with `tipsEnabled` on and off. At 960 × 640 each clip tip must place with its clip in the C6 setup (form via the dock, C2 (2)).

**Acceptance (acceptance build, CDP; self-made documents only).**
CT-AC 1. Fresh profile: Highlight shows the clip tip below the tool; it plays once, stops on the last frame; Replay replays.
CT-AC 2. Opening or switching to `form-clip.pdf` shows the form tip (banner link or docked), never over a field; committing a field value removes it; a document without fields never triggers it.
CT-AC 3. The sign tip shows only after the signature sheet closes; entering Seiten shows the pages tip, leaving removes it.
CT-AC 4. Once each: retrigger or restart shows nothing; after "Show tips again" it shows in the next session, never twice in one.
CT-AC 5. After three tips in a session a fourth situation shows nothing and is still unseen next session.
CT-AC 6. No tip during a running or paused tour or with a menu, dialog or popover open; one notice at a time.
CT-AC 7. `tipsEnabled` off: no tip of any kind, `tipsSeen` unchanged, "Show tips again" disabled with the hint, tour works. On again: unseen tips resume.
CT-AC 8. Missing clip (test build): text-only card; card rect constant from first paint.
CT-AC 9. Reduced motion: poster, no Replay, fade only.
CT-AC 10. Screen reader: region named by the title, body announced once, anchor described, `alt` read; focus never moves on show; Tab: Replay, Hide; Esc dismisses.
CT-AC 11. Each clip 640 × 400, ≤ 3.0 s, ≤ 12 fps, `num_plays` 1, ≤ 600 KB, from the bundle.
CT-AC 12. The C8 gate passes; no tip intersects an input, its anchor, the selection or the mini bar.

### 3.14 v1.9 Stamps (ADR-139 §3.1)

Spec only; the annotation writer is ADR-139's. A stamp is a real `/Stamp` annotation with our own appearance stream. **No new mode, panel tab, grid track or tool slot** (Kommentieren has 8, §3.7). Light only, tokens only, no glass ("Iris" = Solar, §3.10). Surfaces: a split variant, the stamp picker (popover), the mini bar, one Bearbeiten menu item. New tokens (PDF points at default size, scaled with the stamp): `--stamp-height` 40pt, `--stamp-height-dated` 56pt, `--stamp-min-width` 96pt, `--stamp-pad-x` 12pt, `--stamp-border` 1.5pt (the appearance stream's; the preview matches the saved stamp), `--stamp-radius` 4pt. The text is not letter-spaced.

**ST1 Entry.** Slot 5 becomes a split item **Notiz° [Notiz / Stempel]**. Exception to the §3.2 family label: the main part shows the last used variant's icon **and label** (`sticky-note` "Notiz" or `sticker` "Stempel"), so a stamp user sees "Stempel". Chevron menu: Notiz, Stempel, divider, the note swatch row (labelled `stamp.noteColour`; stamps never use it). `stamp` stays the certificate icon (§3.8 L2). Second entry: Bearbeiten menu → `stamp.menu` ("Stamp…"), switches to Kommentieren, arms the tool, opens the picker. No tool letter.

**ST2 Picker** (`data-surface="stamp-picker"`, §4 Popover 320, padding 16, gap 12, Q8 bottom-start under the slot; Q7 dialog fallback). Opens every time the Stempel variant is armed; preselects the current stamp. Rows:
1. **Colour:** Segmented full width (288), two segments 142: 16 swatch + `stamp.colour.solar` / `stamp.colour.ink`. Default last used (first run Solar).
2. **Predefined:** label `stamp.predefined`; 2 × 2 grid of tiles 140 × 48, gap 8, `role="radiogroup"`. Tile: White, `--border-subtle`, radius md; centred a live mini stamp (ST4 look, 13/600 type) in the chosen colour. Selected: 1px Ink border + `aria-checked`. Order: Draft, Approved, Confidential, Received (two lines: label + today's date).
3. **Own text:** label `stamp.own`; Input 32, max 32 characters, placeholder `stamp.ownPlaceholder`; 8 below Checkbox `stamp.addDate` (own text only; default off, last used). Enter chooses it.
4. **Recent** (only when ≥ 1): label `stamp.recent`; listbox, up to 3 rows 32 (`.t-body`, dated rows show a `calendar` 16 suffix), most recent first, deduplicated (exact text + date flag). Stored in the `tools` store (UI storage, this device), written on placing.

Height ≤ 424, so it fits below the tool row at 960 × 640 on Windows. Choosing a tile, a recent row or Enter in the field closes the picker and arms placement; a click on a page while the picker is open closes it and places the selected stamp.

**ST3 Placing.** Armed: cursor crosshair; a ghost (ST4 look, 50 % opacity, no shadow) follows the pointer centred on it.
- **Click:** places at default size (height `--stamp-height` or `--stamp-height-dated`; width = text + 2 × `--stamp-pad-x`, min `--stamp-min-width`), centred on the click, clamped inside the crop box.
- **Drag:** draws a box; the stamp fills it with its aspect kept (the box's smaller fit wins), min height 20pt.
- After placing the tool returns to Auswahl, the new stamp is selected (handles + mini bar). Placing again = the main part once more (picker opens on the last choice).
- **Keyboard:** after choosing in the picker, focus goes to the canvas; the ghost appears in the centre of the visible page; arrows move it 8 px (Shift 1 px); Enter places; Esc cancels.

**ST4 Look in the PDF** (appearance stream, no rotation, `/Rotate` of the page respected so it reads upright).
- Rounded rectangle, border `--stamp-border` Ink, radius `--stamp-radius`. **Solar:** fill #FFF84D (`--hl-solar`, 100 %), text Ink. **Ink:** no fill, text Ink. Solar text is never used (§2: 1.12:1).
- Text: bold sans (weight 700; the font is the ADR's, embedded subset when outside WinAnsi), centred, no letter-spacing. Predefined labels **uppercase** in the UI language at placing time ("ENTWURF", "APPROVED"); own text as typed. Size: one line 18pt at default; dated: label 16pt + date 11pt regular, 4pt gap.
- Date: the day of placing, `Intl.DateTimeFormat(uiLocale, { dateStyle: "medium" })`: de "07.10.2026", en "Oct 7, 2026". Fixed text, never updated.
- `/Name`: `/Draft`, `/Approved`, `/Confidential`, `/SheerReceived`, `/SheerCustom`; `/Contents` = the visible text in one line ("Received 07.10.2026") so other viewers and screen readers read it.

**ST5 Selected stamp.** §3.3 placement and handles: four corner handles (aspect locked), body drag moves (clamped to the page). Arrows move 1pt, Shift 10pt. Mini bar row **Stamp:** colour swatches Solar · Ink (24 in 32) · divider · Ghost 32 `stamp.change` (opens the picker anchored to the mini bar; a choice replaces the text, keeping centre and height) · Löschen. Delete/Backspace deletes. Comments tab: type icon `sticker`, excerpt = `/Contents`.

**ST6 States.** Tool and picker controls follow §4. Disabled: certified lock `cert.locked.tool`; no annotate permission `tool.readOnly` (as other Kommentieren tools); approval-signed files as other annotations. Hover on a placed stamp: cursor move; focus: §2.1 ring around the box.

**ST7 Accessibility.** Picker: Tab order colour → tiles (arrows within, Space/Enter chooses) → field → checkbox → recent (arrows, Enter). Esc closes, focus to the slot. Placed stamp: `aria-label` `stamp.aria` ("Stamp: {text}, page {page}"). Polite announcements: `stamp.announce.armed`, `stamp.announce.placed`, `stamp.announce.deleted`. Colour is never the only cue (text carries meaning).

**ST8 Undo.** One step each for place, move, resize, colour, text change, delete (labels `stamp.undo.*`; spell 7).

**ST9 Motion.** Picker per §4 popover; ghost follows unanimated; placing = the annotation's existing appear fade `--motion-fast`; reduced motion: no fade.

| Key | en | de |
|---|---|---|
| `stamp.tool` / `.tooltip` | Stamp / Put a stamp on the page | Stempel / Stempel auf die Seite setzen |
| `stamp.menu` | Stamp… | Stempel… |
| `stamp.noteColour` | Note colour | Notizfarbe |
| `stamp.colour.solar` / `.ink` | Yellow / Black | Gelb / Schwarz |
| `stamp.predefined` / `.own` / `.recent` | Stamps / Own text / Recent | Stempel / Eigener Text / Zuletzt |
| `stamp.draft` / `.approved` | Draft / Approved | Entwurf / Genehmigt |
| `stamp.confidential` / `.received` | Confidential / Received | Vertraulich / Erhalten |
| `stamp.ownPlaceholder` | e.g. Paid | z. B. Bezahlt |
| `stamp.addDate` | Add today's date | Heutiges Datum hinzufügen |
| `stamp.change` | Change… | Ändern… |
| `stamp.aria` | Stamp: {text}, page {page} | Stempel: {text}, Seite {page} |
| `stamp.announce.armed` | Stamp {text} ready. Click a page, or use arrow keys and Enter. | Stempel {text} bereit. Seite anklicken oder Pfeiltasten und Enter. |
| `stamp.announce.placed` / `.deleted` | Stamp placed on page {page} / Stamp deleted | Stempel auf Seite {page} gesetzt / Stempel gelöscht |
| `stamp.undo.add` / `.edit` / `.delete` | Add stamp / Change stamp / Delete stamp | Stempel setzen / Stempel ändern / Stempel löschen |

**Acceptance (acceptance build, CDP; self-made documents).**
ST-AC 1. Kommentieren still shows 8 slots; choosing Stempel in the Notiz split labels the slot "Stempel" and opens the picker without overlap at 960 × 640 (en, de).
ST-AC 2. de UI: tiles read ENTWURF, GENEHMIGT, VERTRAULICH, ERHALTEN + "07.10.2026"-style date; en shows "Oct 7, 2026".
ST-AC 3. A click places a stamp of default size centred on the point; a drag sizes it with the aspect kept.
ST-AC 4. Own text "Bezahlt" with date places a two-line stamp and appears first in Recent; a fourth text drops the oldest.
ST-AC 5. Mini bar: colour switch, Change…, Löschen work; corner drag resizes proportionally; each is one Undo step.
ST-AC 6. Saved file opened in a second PDF viewer shows the same stamp (appearance stream) and its `/Contents`.
ST-AC 7. Keyboard only: picker → Enter → arrows → Enter places; screen reader hears armed and placed.
ST-AC 8. Certified file: Stempel disabled with `cert.locked.tool`.
ST-AC 9. Surface gate passes for `stamp-picker` (with and without Recent) and the stamp mini bar.

### 3.15 v1.9 Headers and footers (ADR-139 §3.2)

Spec only; content-stream writing is ADR-139's (incremental, undoable). **No new mode, panel tab or grid track.** Surfaces: Bearbeiten slot 8, one Werkzeuge item, one dialog. Light only, tokens only, no new tokens.

**HF1 Entry.** Bearbeiten gains slot 8 **Kopf- und Fußzeile…** (`panel-bottom`, kind *action*): Text bearbeiten · Text einfügen · Bild einfügen · Zuschneiden · Schwärzen · Schützen… · Metadaten… · Kopf- und Fußzeile… (8; Q6 step 2 at 960). Werkzeuge → `hf.command` after "Text erkennen…". In Seiten with cards selected, the range preselects first–last selected page.

**HF2 Dialog** (`data-surface="hf-dialog"`, §4 Dialog, width `--sheet-width-wide` 696, title `hf.title`, sizes to content, never scrolls; about 530 high). Body: two columns, controls 408 | gap 24 | preview 216.

*Controls* (rows gap 16):
1. **Slots:** caption row `hf.left` · `hf.centre` · `hf.right` over three columns 130, gap 8. Group label `hf.header`, three dropdown triggers 32 (padding-x 8); group label `hf.footer`, three more. Each slot is one of **Keine · Text · Seitenzahl · Datum · Dateiname** (simple chooser; no tokens, no mixing in one slot). Each trigger `aria-label` "{row}, {column}". The last focused trigger is the **current slot** (1px Ink border, `aria-current`).
2. **Current slot options** (fixed 52 high, label `hf.slotOptions` "{row}, {column}"): Text → Input 32 (max 80 chars); Seitenzahl → dropdown `hf.page.n` / `.pageN` / `.pageNofTotal` (default) / `.nSlashTotal`; Datum → `.t-caption` sample in the ST4 date format (date of applying, fixed); Dateiname → caption: file name without extension (resolved by Rust); Keine → caption `hf.none.hint`.
3. **Size and margin:** Segmented `hf.size` 8 · 9 · 10 · 11 · 12 (36 each, Q3 style, "pt"), default 10; Segmented `hf.margin` 18 · 24 · 36 ("pt", distance from the crop-box edge to the text box), default 24.
4. **Pages:** Segmented `hf.range.all` · `hf.range.some`; "Pages" shows From and To Inputs 64 (`tabular-nums`) inline. Invalid range: danger border + caption `hf.range.invalid`, Apply disabled. No odd/even. `{n}`/`{total}` are physical page numbers and count.

*Preview* (right): box 216 × 306, Sand, radius md; the page White, contained, 1px `--border-subtle`, rendered by Rust with the draft (`hf_preview`, debounced 120 ms, latest answer only; the previous image stays meanwhile). Shows the first page of the range; caption `hf.previewPage`. `aria-hidden`; the controls carry the meaning.

*Footer:* left Ghost `hf.remove` (only when Sheer headers exist); right Secondary `hf.cancel`, Primary `hf.apply`.

**HF3 Defaults.** First open: footer left Datum, footer right Seitenzahl "Page {n} of {total}", rest Keine; 10 pt; 24 pt; all pages; current slot footer right. Text: Helvetica regular (embedded bundled font when outside WinAnsi, ADR), Ink, never Solar. Placement follows the page's `/Rotate` so text reads upright.

**HF4 Editing and removing.** Only headers added by Sheer are recognised: each is written as marked content `/Artifact <</Type /Pagination /Subtype /Header|/Footer /SheerHF true>>`, and the settings are stored under the private catalog key `/SheerHF` (ADR decides the encoding). Opening the dialog on such a file loads those settings and shows caption `hf.existing` under the title; Apply replaces them on all pages; Remove deletes them. Other headers in the file are never touched or detected.

**HF5 Apply and undo.** Apply closes the dialog, writes all pages as **one undo step** (`hf.undo` / `hf.undoRemove`), toast `hf.done` (priority 3). Busy > `--saving-delay`: Apply shows the §4 busy state, the dialog stays. Failure: error toast `hf.failed`, nothing written.

**HF6 Refusal.** Command and slot disabled (0.4, tooltip): any signature field signed → `hf.signed`; certified lock → `cert.locked.tool`; no modify permission → `tool.readOnly`; OCR running → `ocr.busy`.

**HF7 Keyboard and screen reader.** Focus starts on the footer-right trigger. Tab: triggers in reading order (header L/C/R, footer L/C/R) → options → size → margin → range → Remove → Cancel → Apply. Dropdowns per §4 (Enter/Space/Down open). Enter in an input applies when valid; Esc cancels; focus returns to the invoker. Polite `hf.done`; failure assertive.

**HF8 Motion.** Dialog per §4; preview image swaps without animation; reduced motion unchanged.

| Key | en | de |
|---|---|---|
| `hf.command` / `hf.title` | Headers and footers… / Headers and footers | Kopf- und Fußzeile… / Kopf- und Fußzeile |
| `hf.header` / `hf.footer` | Header / Footer | Kopfzeile / Fußzeile |
| `hf.left` / `.centre` / `.right` | Left / Centre / Right | Links / Mitte / Rechts |
| `hf.kind.none` / `.text` / `.page` / `.date` / `.file` | None / Text / Page number / Date / File name | Keine / Text / Seitenzahl / Datum / Dateiname |
| `hf.slotOptions` | {row}, {column} | {row}, {column} |
| `hf.page.n` / `.pageN` | 3 / Page 3 | 3 / Seite 3 |
| `hf.page.pageNofTotal` / `.nSlashTotal` | Page {n} of {total} / {n} / {total} | Seite {n} von {total} / {n} / {total} |
| `hf.none.hint` | This position stays empty. | Diese Stelle bleibt leer. |
| `hf.size` / `hf.margin` | Font size / Margin | Schriftgröße / Rand |
| `hf.range.all` / `.some` | All pages / Pages | Alle Seiten / Seiten |
| `hf.range.from` / `.to` | From / To | Von / Bis |
| `hf.range.invalid` | Enter pages from 1 to {total}. | Seiten von 1 bis {total} eingeben. |
| `hf.previewPage` | Preview: page {n} | Vorschau: Seite {n} |
| `hf.existing` | Headers and footers from {app} are on this file. Applying replaces them. | Diese Datei hat Kopf- und Fußzeilen von {app}. Übernehmen ersetzt sie. |
| `hf.remove` / `hf.cancel` / `hf.apply` | Remove / Cancel / Apply | Entfernen / Abbrechen / Übernehmen |
| `hf.done` | Headers and footers added to {n} pages | Kopf- und Fußzeilen auf {n} Seiten eingefügt |
| `hf.removed` | Headers and footers removed | Kopf- und Fußzeilen entfernt |
| `hf.failed` | Headers and footers couldn't be added. | Kopf- und Fußzeilen konnten nicht eingefügt werden. |
| `hf.signed` | This file is signed. Headers and footers would break the signature. | Diese Datei ist signiert. Kopf- und Fußzeilen würden die Signatur ungültig machen. |
| `hf.undo` / `.undoRemove` | Headers and footers / Remove headers and footers | Kopf- und Fußzeile / Kopf- und Fußzeile entfernen |

**Acceptance (acceptance build, CDP; self-made documents).**
HF-AC 1. Bearbeiten shows 8 slots with Kopf- und Fußzeile… last; Werkzeuge holds the item.
HF-AC 2. First open: footer left Date, footer right "Page 1 of N" in the preview; the dialog fits 960 × 640 without scrolling (en, de).
HF-AC 3. Changing a slot, size or margin updates the preview within 300 ms.
HF-AC 4. Range 2–3 on a 5-page file writes only pages 2–3; numbers read "Page 2 of 5".
HF-AC 5. Apply is one Undo step; Undo restores every page exactly.
HF-AC 6. Reopening loads the saved settings with `hf.existing`; Apply replaces without duplicates; Remove deletes them as one step.
HF-AC 7. Saved file: text is in the page content (search and a second viewer show it), tagged as pagination artifact.
HF-AC 8. Signed file: command disabled with `hf.signed`; certified: `cert.locked.tool`.
HF-AC 9. Invalid range: danger caption, Apply disabled. Keyboard only completes the dialog.
HF-AC 10. Surface gate passes for `hf-dialog` (default, text slot, existing, invalid range).

### 3.16 v1.9 Comment export (ADR-139 §3 (3))

**E1 Entry points.**
- **Comments tab, B10 filter row:** Filter (flex-1) · Reference 28 · sort 28 · **Export** icon button 28 `file-down`, tooltip `commentExport.button`. A direct button, not a ⋯ menu: the menu would hold one item. Width at the 200 minimum: 72 + 3 × 28 + 3 × 4 + 16 = 184.
- **Datei → "Export Comments…"** (`menu.file.exportComments`) after "Save Citation List…", `requiresDocument`.
- No exportable item in the document: both disabled, tooltip `commentExport.none`.

**E2 Dialog** (`data-surface="comment-export"`). §4 Dialog, width `--sheet-width` 560, title `.t-h3` `commentExport.title`, padding 24, rows gap 16, sizes to content (Q7, never scrolls). Two-column form: label `.t-label` column 120, control column flex-1, gap 16. Rows top to bottom:
1. **Include**, checkbox grid with 2 columns of 3 rows (32 each, B10 icon 16 + label): Comment on text (`message-square-quote`) · Note (`sticky-note`) · Highlight (`highlighter`, also underline and strikethrough) · Citation (`quote`) · Drawing (`pen-line`) · Shape (`shapes`). Signatures and form content are never exported.
2. **Author**: dropdown 36 with a checkbox menu (B10 authors + "No author"). Label "All authors" or "{n} authors". Hidden with one author.
3. **Tags**: the same dropdown pattern (dot + name), "All tags". Hidden without tags.
4. **Pages**: Segmented 32 All / Current / From–to. From–to shows two 48 fields in the same row.
5. **Status**: Segmented 32 All / Open / Resolved.
6. **Format**: Segmented 32 `commentExport.format.pdf` / `.md`. The last choice is stored in **`sheer.commentExport.format`** (first run PDF).
7. **Count**: `.t-caption` Text-secondary `commentExport.count` (`tabular-nums`, `aria-live="polite"`) updates live.
8. **Footer**: Secondary Cancel · Primary `commentExport.export`.

**Prefill:** opened from the Comments tab, the dialog takes the panel's current filter; from Datei, it takes the same filter. Changes in the dialog never change the panel. Drawings and shapes are on by default, one line each (decision: reviews depend on marks, and a line costs little). The de height is about 552, within 608.

**Sort:** page order only, with no control. Items go by page, then top-to-bottom and left-to-right by anchor. Replies go oldest first. A citation group across pages is one item on its first page with the joined locator ("S. 12–13").

**E3 Save and progress.** Export opens the native save dialog with the default name "{file name} – comments" / "– Kommentare", the format's filter only (.pdf or .md), and the last folder the OS remembers. If the save dialog is cancelled, the export dialog stays as it was.
- Rust collects the annotations and writes the file atomically (the frontend sends the filter, format, language and the formatted citation lines from `format/` only, never bytes or paths). Text is hostile: control characters become spaces, and caps follow `limits` (the quote cap is that of `QUOTE_SHOWN_MAX`).
- **Progress:** if the job runs more than `--saving-delay`, the footer row is replaced by the O3 pattern: `.t-label` `commentExport.progress` (`tabular-nums`) · a 4 px determinate track on `--surface-pressed` with an Ink fill · Ghost 32 `commentExport.stop`. Form controls are disabled while it runs. Stop or Esc cancels, and nothing is written. The bar has `role="progressbar"`, with no per-item announcements.
- **Success:** the dialog closes, focus returns to the invoker, and toast `commentExport.saved`. **Failure:** the dialog stays, a danger caption `commentExport.failed` appears above the footer, and Primary reads "Try again".
- A file that forbids copying text: quotes are left out, items keep their type, author and comment, and the success toast is `reference.quotesLeftOut`. A certified or read-only document still exports (it is a read action, §3.8).

**E4 Empty states.** If the filter matches nothing, the count line reads `commentExport.nothing` and Export is disabled with a `focusableWhenDisabled` tooltip of the same text. If no type is checked, the same message appears.

**E5 PDF summary.** Rust builds it with A4 pages (595 × 842 pt) and margins 56 pt (text width 483). The font is Inter (bundled, embedded subset). Glyphs Inter lacks use the §3.10 bundled substitute and never fail. Colours are Ink, Text-secondary and a Stone rule. `/Title` is "{title}: Comments", `/Lang` is the UI language, and all text is real, selectable text.
- **First page head:** `commentExport.pdf.title` 20/28 SemiBold, then the document name (the Reference title, else the file name) 12/16, then 9/12 Text-secondary `commentExport.pdf.meta` ("Exported 7 Oct 2026 · 23 items · Filter: Notes, Highlights"; the filter part only when filtered). Then a 0.5 pt Stone rule with 16 below.
- **Page heading:** `commentExport.pdf.page` ("Seite 12" / "Page 12"), 13/16 SemiBold, 24 above and 8 below. If the page label differs from the number: "Seite xii (14)". A heading is never the last line on a sheet.
- **Item** (gap 12, the first 3 lines kept together):
  1. Meta line 9/12: a Lucide icon 10 pt as vector (ISC), then the type label Medium Ink (subtype: Highlight / Underline / Strikethrough / Note / Text comment / Citation / Drawing / Rectangle…), then " · author · date" in Text-secondary (locale short date and time). Markup also gets an 8 pt swatch of its colour (decorative).
  2. **Quote block** (markup, citations, comment on text): a 2 pt Stone rule on the left, inset 10, 10/14 Ink in locale quotation marks, the full text.
  3. Citation: the line in the current style (§3.17 for the Deutsche Zitierweise) 9/12 Text-secondary.
  4. Comment text 10/14 Ink, paragraphs kept.
  5. Replies indented 16, each a meta line (author · date) and text 10/14.
  Drawings and shapes are line 1 plus 4 and 5 when present.
- **Running foot** on every sheet, 8/12 Text-secondary, centred 24 above the bottom edge: "{document name} · Comments · {n} / {total}".

**E6 Markdown.** UTF-8, LF line endings. Text is escaped (`\` before `` \ ` * _ [ ] < > # | ``; a leading "-", "+" or "1." is escaped too). Labels follow the UI language. The exact template:

```
# {commentExport.pdf.title}: {document name}

{commentExport.pdf.meta}

## {commentExport.pdf.page}

### {type label} · {author} · {date}

> {quoted text, every line prefixed "> "}

{citation line}

{comment text}

- **{reply author}** · {date}: {reply text}
```

Leave out empty parts and the blank line that goes with them. A drawing or shape is just its `###` line. "No author" becomes `commentExport.noAuthor`.

**E7 Keyboard and accessibility.** Focus trap. Initial focus goes to the first Include checkbox. The order is the visual order. Enter on a focused button activates it. Esc closes, or cancels a running export. Each checkbox grid is a `group` with the row label. The count is polite.

**Motion.** Dialog open and close as §4. The progress fill animates its width in `--motion-fast`. With reduced motion there is no width transition.

**Acceptance.**
CE-AC 1. The Comments filter row shows Export after sort, and Datei shows Export Comments…. Both are disabled in a document without annotations.
CE-AC 2. The dialog opens with the panel's current filter. Changing it leaves the panel unchanged.
CE-AC 3. The count updates live. No match disables Export with the empty text.
CE-AC 4. Export opens the native save dialog filtered to .pdf or .md with the default name. Cancelling returns to the dialog.
CE-AC 5. The PDF has the title head, "Seite n" headings in page order, quote blocks with the marked text, citation lines, comments and indented replies, A4, with selectable text.
CE-AC 6. The Markdown matches E6 and renders correctly in a Markdown viewer. Text such as `*`, `#` and `<script>` in comments shows literally.
CE-AC 7. Drawings and shapes appear as one line each and can be excluded.
CE-AC 8. A document with ≥ 500 items shows progress. Stop writes nothing.
CE-AC 9. A write-protected folder shows the failure caption and Try again.
CE-AC 10. A copy-protected file exports without quotes and shows the toast.
CE-AC 11. The format choice survives a restart.
CE-AC 12. The Q9 gate passes at 960 × 640 in en and de, including the progress state.

### 3.17 v1.9 Deutsche Zitierweise (ADR-139 §3 (4))

**Z1 Today and the addition.** Sheer has one reference per document. The four styles (`format/`) render the reference, the short citation and the citation list as `StyledBlock`s, and Rust writes those as .txt, .html and .md. The smallest addition is a fifth style id **`germanNotes`** (`file_label` "Deutsche Zitierweise"). For its footnotes, a block gains an optional kind (`heading`, or `note` with number n) and a run an optional note reference n. Rust renders these per format (Z4). No new surface.

**Z2 Picker.** In C7, the dropdown gains a fifth item after DIN ISO 690: `reference.germanNotes`. When it is selected, a `.t-caption` Text-secondary `reference.germanNotes.hint` appears below the dropdown (the popover grows, Q7). The preview shows the bibliography entry. Storage key `sheer.citations.style`, value `germanNotes`.

**Z3 What it produces.** "First" is per output: the first entry in page order of a list or comment export.
- **Full note** (first): the bibliography entry plus the locator, ending with a full stop.
- **Short note** (afterwards): "Family, Kurztitel, S. x." for one author, "Müller/Schmidt" for two, "Müller u. a." / "Müller et al." for three or more. With no author, Kurztitel alone. **Kurztitel** is the title up to its first ":", ".", "?", "!" or " – ", cut to 4 words.
- **"ebd." is not offered** (decision). Users paste single citations between their own sources, and there "ebd." turns wrong silently. It goes on the later faculty-variant list.
- **Bubble, card, mini bar:** the short note without the final stop. **Copy citation** (single): quote + line break + the full note, because the paste target may be its first mention.
- **Bibliography:** one entry, the reference without a locator. Author: "Family, Given" joined with "/", and more than 3 authors becomes the first author + "u. a.".
- Terms follow the UI language like the other styles: S./p., Aufl./ed., H./no., hier/here, o. J./n.d., o. O./n.p. (book, chapter, report, thesis only), Zugriff am/accessed, In:/In:.

**Examples** (record: Müller, Hans; Schmidt, Eva for the article; locator 12, then 14).

| Type | de: full note / short note | en: full note / short note |
|---|---|---|
| Book | Müller, Hans: Digitale Lesekultur. Eine Einführung. 2. Aufl. Berlin: Beispielverlag, 2021, S. 12. / Müller, Digitale Lesekultur, S. 14. | Müller, Hans: Digitale Lesekultur. Eine Einführung. 2nd ed. Berlin: Beispielverlag, 2021, p. 12. / Müller, Digitale Lesekultur, p. 14. |
| Article | Müller, Hans/Schmidt, Eva: Lesen am Bildschirm. In: Zeitschrift für Medien 12 (2021), H. 3, S. 45–67, hier S. 12. / Müller/Schmidt, Lesen am Bildschirm, S. 14. | … In: Zeitschrift für Medien 12 (2021), no. 3, pp. 45–67, here p. 12. / Müller/Schmidt, Lesen am Bildschirm, p. 14. |
| Web page | Müller, Hans: Leitfaden PDF. In: Beispiel-Portal, 2023, S. 12. URL: https://example.org/pdf (Zugriff am 05.10.2026). / Müller, Leitfaden PDF, S. 14. | … In: Beispiel-Portal, 2023, p. 12. URL: https://example.org/pdf (accessed 5 October 2026). / Müller, Leitfaden PDF, p. 14. |

Chapter: "…: Kapitel. In: Buchtitel. Aufl. Ort: Verlag, Jahr, S. a–b, hier S. x." Report and thesis: "…: Titel. Ort: Institution, Jahr, S. x."

**Z4 Citation list** (Copy list, Save list…, Datei commands). Order: entries in page order, each the quote followed by its note mark; then the heading `reference.notes` with the notes; then the heading `reference.bibliography` with the entry. If an entry has no quote (copy-protected file), the mark stands alone.

| Format | Mark | Notes | Headings |
|---|---|---|---|
| .txt | superscript digits „…“¹ | "¹ Müller, Hans: …" one per line | plain line |
| .html | `<sup><a href="#fn1" id="fnref1">1</a></sup>` | `<ol class="notes">` with `<li id="fn1">` + back link ↩ | `<h2>` |
| .md | `[^1]` | `[^1]: …` | `## ` |

The clipboard gets the .txt form. Italics as the other styles (title of a book or journal). Comment export (§3.16) puts the full note on the first citation and the short note after it, with no marks.

**Accessibility.** In HTML, marks get `aria-label` `reference.noteAria`. Headings are real headings.

**Acceptance.**
DZ-AC 1. The style dropdown lists five styles, the fifth being Deutsche Zitierweise, with the hint caption. The choice persists.
DZ-AC 2. The preview shows the bibliography entry for a book, an article and a web page as in Z3, in de and en UI.
DZ-AC 3. Bubbles and cards show "Müller, Kurztitel, S. 12" with no parentheses.
DZ-AC 4. Copy citation gives the quote plus the full note.
DZ-AC 5. With three citations, the list has marks 1–3, note 1 full, notes 2–3 short, then the bibliography. .txt, .html and .md render as Z4, and the HTML links work both ways.
DZ-AC 6. A citation group gives one note with "S. 12–13".
DZ-AC 7. Missing author, year or place give the Kurztitel, "o. J." and "o. O.". Nothing crashes on an empty record.
DZ-AC 8. RIS/BibTeX are unchanged. The other four styles' outputs are byte-identical to v1.8.
DZ-AC 9. The comment export with this style shows the full note first, then short notes.

### i18n (en / de)

| Key | en | de |
|---|---|---|
| `commentExport.button` / `menu.file.exportComments` | Export comments… / Export Comments… | Kommentare exportieren… / Kommentare exportieren… |
| `commentExport.title` | Export comments | Kommentare exportieren |
| `commentExport.include` / `.author` / `.tags` / `.pages` / `.status` / `.formatLabel` | Include / Author / Tags / Pages / Status / Format | Aufnehmen / Person / Tags / Seiten / Status / Format |
| `commentExport.allAuthors` / `.authors` / `.allTags` | All authors / {n} authors / All tags | Alle Personen / {n} Personen / Alle Tags |
| `commentExport.format.pdf` / `.md` | PDF summary / Markdown | PDF-Zusammenfassung / Markdown |
| `commentExport.count` | {count} items on {pages} pages | {count} Einträge auf {pages} Seiten |
| `commentExport.nothing` | Nothing to export with these settings. | Mit diesen Einstellungen gibt es nichts zu exportieren. |
| `commentExport.none` | No comments to export | Keine Kommentare zum Exportieren |
| `commentExport.export` / `.stop` | Export… / Stop | Exportieren… / Stoppen |
| `commentExport.progress` | Exporting {done} of {total} | Exportiere {done} von {total} |
| `commentExport.saved` / `.failed` | Comments exported / The comments could not be exported. | Kommentare exportiert / Die Kommentare konnten nicht exportiert werden. |
| `commentExport.fileName` | {name} – comments | {name} – Kommentare |
| `commentExport.pdf.title` / `.page` / `.pageLabel` | Comments / Page {n} / Page {label} ({n}) | Kommentare / Seite {n} / Seite {label} ({n}) |
| `commentExport.pdf.meta` / `.filtered` | Exported {date} · {count} items / · Filter: {types} | Exportiert am {date} · {count} Einträge / · Filter: {types} |
| `commentExport.pdf.foot` | {name} · Comments · {n} / {total} | {name} · Kommentare · {n} / {total} |
| `commentExport.type.underline` / `.strike` / `.textComment` | Underline / Strikethrough / Text comment | Unterstreichung / Durchstreichung / Textkommentar |
| `commentExport.noAuthor` | No author | Ohne Person |
| `reference.germanNotes` | Deutsche Zitierweise (footnotes) | Deutsche Zitierweise (Fußnoten) |
| `reference.germanNotes.hint` | Full reference in the first footnote, short after that. | Erste Fußnote mit Vollbeleg, danach Kurzbeleg. |
| `reference.notes` / `.bibliography` | Notes / Bibliography | Fußnoten / Literaturverzeichnis |
| `reference.noteAria` | Footnote {n} | Fußnote {n} |

## 4. Components (R4)

States apply to all: hover ≤ background/border/icon colour change; pressed scale 0.98 at most; focus = `--ring-focus` (keyboard only); disabled = `--opacity-disabled`, no pointer events, tooltip still explains why.

| Component | Default | Hover | Pressed / selected | Notes |
|---|---|---|---|---|
| Primary | Solar, Ink `.t-label`, radius md, height 36 (40 large), padding-x 16 | `--accent-bright` | scale 0.98 | one per view; no shadow |
| Secondary | Sand, Ink | #E5E5E1 | scale 0.98 | |
| Ghost | transparent, Ink | Sand | #E5E5E1 | |
| Icon button | 36 or 40, radius md, icon 18/20 Ink | Sand | #E5E5E1; toggled = Sand + Ink icon + `aria-pressed` | secondary icons Text-secondary |
| Input | White, height 36, radius md, padding-x 12, §2.9, placeholder Text-secondary | border-bottom Ink | focus ring; error: danger border + danger caption below | |
| Dropdown trigger | as input + chevron-down 16 | Sand | open: chevron rotates | |
| Menu | White, border, radius md, floating, padding 4; items 32, radius sm, padding-x 8 | Sand | checked = Ink check 16; shortcut `.t-caption` right | disabled items 0.4 |
| Popover | White, border, radius md, floating, padding 16, 200–320 | — | — | |
| Dialog | Sand, radius dialog 16, floating, padding 24, title `.t-h3`; footer right: Secondary + one Primary | — | — | scrim `--scrim` |
| Toast | bottom centre, 24 from the window edge, White, border, radius md, floating, 40 high, Ink `.t-label`, optional Ghost action | — | — | icons Ink only |
| Tooltip | White, border, radius sm, floating, padding 4 8, `.t-caption` Ink, max 240 | — | — | kbd inside |
| kbd | Sand, border, radius sm, height 20, min 20, padding-x 4, 12/500 Ink, tabular | — | — | |
| Tabs | 36 high, label Text-secondary 400 | Ink | active §2.8 | |
| Segmented | Sand track radius md, padding 2; segments 32, radius sm | Ink label | active White + Stone border + Ink 500 | |
| Toggle | 36 × 20, `--radius-pill`, §2.4 | track Sand→#E5E5E1 (off) | | |
| Checkbox | 16, radius sm, §2.6 | border Ink | | radio: round |
| Slider | §2.5, min 120 | thumb border Ink stays | dragging: no scale | |
| Skeleton | Sand in the target's shape, shimmer (MOTION) | — | — | |
| Banner | Sand, 40 min, icon 16 Ink, `.t-label`, close 28 | — | — | danger variant only for redact/errors |
| Dropzone | 1px dashed #E5E5E1, radius lg, Sand | drag-over: border Stone; Home adds SolarGlow `drop` | — | text is the cue |
| Swatch | 24 round, §2.7 | Stone→Ink ring | | |
| Thumbnail card | §3.2 | border Stone | selected §2.2 | |
| Doc card / tool row / nav row | §3.1 | Sand | | |

**Signature sheet:** White (sheet exception to Sand dialogs), radius dialog, width `--sheet-width-wide`; tabs Zeichnen / Tippen / Bild; pad: Sand, 1px Stone baseline at 75 % height, drawn as a separate element and never exported; ink choice Ink / #1F3A93 as two swatches. Tippen: three cards (`--sig-font-card-*`) in Ms Madi (default), Hurricane, Birthstone (OFL, bundled; owner pick, ADR-108); Homemade Apple is removed.

**Cursors:** per tool SVG at 2× DPR (MOTION spell 12); default arrow elsewhere.

**Icons:** Lucide only, stroke 1.75, 16/18/20 (24 only for the "+" and empty-state actions), Ink or Text-secondary, never yellow, never filled except the starred star.

## 5. Surfaces

- **`<BrandSurface>`**: Home, empty state, splash, Welcome page 1, onboarding coach marks' backdrop, installer art. May contain `<SolarGlow>` and `.t-display`/`.t-h1`.
- **`<WorkSurface>`**: the whole editor (top bar, sidebars, canvas, dialogs opened from it). Renders no glow; a `<SolarGlow>` inside it throws in dev and renders nothing in production. Lint: no `radial-gradient` outside `tokens.css`.
- **`<SolarGlow variant>`**: one absolutely positioned layer, `inset: -10%` (so the light can start outside the container), `pointer-events: none`, `will-change: transform`, parent clips with its radius. Variants (tokens `--glow-*`, BRAND §5 recipes, Solar at most 0.95 alpha, optional Mist counter-light at 20%/10%):
  - `hero`: Solar at 80 % 85 %, stops 0.95 / 0.55 at 22 % / 0 at 55 %, plus Mist 0.8 at 20 % 10 %.
  - `empty`: Solar-bright 0.9 at 70 % 75 % to transparent 48 %, plus Mist.
  - `card`: Solar 0.7 at 90 % 90 % to transparent 60 %.
  - `drop`: `empty` with opacity driven by cursor proximity (MOTION spell 4).
  - `splash`: `empty` centred behind the wordmark.
  At most one large glow per BrandSurface region, plus `card` glows. Text over a glow is always Ink (17:1 on Solar).

## 6. Strings and assets

`APP_NAME` renders "sheer."; bundle and file names stay `Sheer`. Claim "PDFs made simple." (de identical). Empty state: "Drop a PDF here." / "PDF hier ablegen."; "Or open" / "Oder öffnen".

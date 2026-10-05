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
| `--color-control-hover` | Sand |
| `--color-control-pressed` | #E5E5E1 |
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
| `--tab-min/max` | 96 / 200 |
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
- **Werkzeuge** section (and the Werkzeuge view): 40 below, heading `.t-title`, two columns from 1200 wide (gap 16), rows 56: icon 20, `.t-label` + `.t-caption` description, chevron-right 16. Hover Sand, radius md. No cards, no dividers.
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
- **Tag manager** (from "Manage tags…" in the picker and the C8 filter popover; replaces the opener in the same anchor): Popover 320, padding 16, title `.t-title` "Tags". Rows 36, gap 4: swatch button 24 (Menu with the five swatches, §2.7) · name input 32 (borderless until hover/focus, then §2.9) · usage count `.t-caption` `tabular-nums` · Delete `trash-2` 28. Footer Ghost "New tag" (`plus`, adds a row with the name focused). Name: 1–32 chars, unique ignoring case (`tags.duplicate`), empty on blur reverts; max 64 tags (`tags.limit`, New tag disabled). Delete removes the tag from every annotation using it, one undo step, toast `tags.deleted` + Undo. Empty: `.t-caption` `tags.empty` + New tag. Scope (app or document) per ADR-119; on a read-only document assignment is disabled (`tool.readOnly` tooltip).

**C7 Reference popover (export).** The B10 filter row becomes: Filter (flex-1) · **Reference** icon button 28 `book-marked` (tooltip `reference.button`) · sort 28. Popover width = panel − 16, max 320, padding 16, gap 12, top to bottom:
1. "Citation style" `.t-label` + dropdown 36 full width: APA 7 · MLA 9 · Chicago (author-date) · DIN ISO 690. UI storage **`sheer.citations.style`**; first run DIN ISO 690 when the UI is German, else APA 7. Changing it updates every short citation in bubbles and cards.
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

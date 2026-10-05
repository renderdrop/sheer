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
- **Reflow (optional, per edit):** the mini bar toggle **Umbrechen** (`editText.reflow`), shown only for paragraphs of 2 or more lines. When on, words past the limit move to the next line of the same paragraph, and following lines re-wrap. The paragraph may add one line below only if the gap to the next object (or the crop box − 12 pt) is ≥ the line pitch. It never moves other paragraphs and **never crosses a page**. The default is off. The last choice is kept in the `tools` store.
- **Overflow** (past the limit, line mode or reflow without room): the glyphs past the limit stay visible. A 2px `--color-danger` vertical marker sits at the limit, and the overflowing part sits on the redaction hatch at 12 % (`--color-doc-redact-fill`). The mini bar shows `editText.overflow` ("{n} pt too wide") in danger text with a `triangle-alert` 16 icon. Commit is still allowed (the text is written as typed and may touch its neighbours). The overflow state is announced once, politely.

**E3 Mini bar while editing** (§3.3 placement: above → below → docked, never over the box or its paragraph rule). Height 40, padding 4, gap 4. In order: **Font** Ghost 32 (`type` 16 + fixed label `editText.font`, no font name in the button, so it never ellipsises (Q9)). A fallback adds `triangle-alert` 16 before the label. · Size read-out `.t-caption` "11 pt" `tabular-nums` (read-only in v1.5) · divider · **Umbrechen** toggle (§2.4, only when multi-line) · divider · overflow caption (only when overflowing) · Cancel icon button 32 `x` (`editText.cancel`) · Commit icon button 32 `check` (`editText.commit`). Löschen is absent: to delete text, delete the characters; an empty line commits as removed.
- **Font popover** (Q8 popover, 280 wide, sizes to content): rows (label `.t-caption` / value `.t-body`): Font (`editText.font.original`: PostScript name, cleaned per S6 string rules) · Status (`.embedded` / `.subset` / `.notEmbedded`) · Substitute (`editText.font.fallback`: bundled family name, only if used) · Characters in substitute (`editText.font.count`, `tabular-nums`). Esc closes and returns focus to the button.

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

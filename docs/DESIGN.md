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

Additions (BRAND §9, §23 and this spec): `--space-5` 20, `--space-10` 40, `--space-20` 80, `--space-24` 96; `--radius-dialog` 16 (BRAND §9 modals); `--radius-pill` 999 (toggles, filter chips, the round "+" button only); `--color-stone` #8A8A86 (control boundaries, 3.47:1 on white, 3.18:1 on Sand); `--color-danger` #C8321F (5.34:1 on white, 4.89:1 on Sand). Grid base is 4 px.

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
- Redact band: `--color-danger`, white text 13/500 "Schwärzen ist endgültig", right: Ghost "Abbrechen" (white text, hover `--on-danger-hover` rgba(255,255,255,0.16)) and Primary "Anwenden". Marks preview as 2px danger outline + 12 % fill + hatch; applied = Ink fill.

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

**Signature sheet:** White (sheet exception to Sand dialogs), radius dialog, width `--sheet-width-wide`; tabs Zeichnen / Tippen / Bild; pad: Sand, 1px Stone baseline at 75 % height, drawn as a separate element and never exported; ink choice Ink / #1F3A93 as two swatches. Tippen: three cards (`--sig-font-card-*`) in Dancing Script, Great Vibes, Alex Brush (OFL, bundled); Homemade Apple is removed.

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

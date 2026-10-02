# Design system (Phase 3 spec)

Binding: ADR-011. Raw values only in `src/styles/tokens.css`; components use role tokens.

**Rules:** one UI hue (Iris). Glass only on the control layer; canvas opaque; no glass inside glass; tooltips solid.
Nothing overlaps except transient layers ≥ 100 (§1.7). State is never color alone.

## 1. Tokens

Theme follows the OS; `html[data-theme]` overrides. **Solid mode** applies when `backdrop-filter` is unsupported, under
`prefers-reduced-transparency: reduce`, `html[data-transparency="reduced"]` (macOS flag via Rust, or setting
"Glass: Solid"), or `forced-colors: active`.

### 1.1 Palette

| Token | Value |
|---|---|
| `--iris-50 100 200 300 400` | `#F4F5FF` `#E1E2FF` `#C9CAFF` `#8E8EF2` `#7B7CF0` |
| `--iris-500 600 700` | `#5B5BD6` `#4A4AC4` (new) `#3A3AAB` |
| `--ink`, `--ink-60 50 40 30` | `#1C1C2E` `#5F6072` `#7F8094` (new) `#A3A4B8` (new) `#B4B5C4` (dividers only) |
| `--success --warning --error` | `#2E9E6B` `#D98A1F` `#D64B4B` (icons/fills only) |

### 1.2 Color roles

| Role | Light | Dark |
|---|---|---|
| `--color-bg` | 135° `#F4F5FF→#FAFAFF` | 135° `#0F1020→#15162B` |
| `--color-canvas` | `#E8E9F6` | `#0B0C18` |
| `--color-text` | ink | `#FFFFFF` |
| `--color-text-muted` | ink-60 | ink-40 |
| `--color-text-accent` (links) | iris-700 | iris-200 |
| `--color-text-disabled` | ink-50 | ink-60 |
| `--color-accent / -hover / -pressed` | iris-500 / 600 / 700 | iris-300 / 200 / 400 |
| `--color-on-accent` | `#FFFFFF` | ink |
| `--color-focus` | iris-500 | iris-300 |
| `--color-control-border` | ink-50 | ink-50 |
| `--color-control-hover` | iris-100 | white 8 % |
| `--color-control-pressed` | iris-200 | white 14 % |
| `--color-selected` | iris-100 | `rgba(142,142,242,.20)` |
| `--color-fill-disabled` | ink 6 % | white 6 % |
| `--color-track` | iris-200 | white 20 % |
| `--color-divider` | ink-30 | white 12 % |
| `--color-tile / -tile-icon` | iris-100 / iris-700 | `rgba(142,142,242,.16)` / iris-200 |
| `--color-tooltip-bg` (text white, keys ink-40) | ink | `#2B2C42` |
| `--color-{success,warning,error}-icon` | `#2E9E6B` `#B5700F` `#D64B4B` | `#2E9E6B` `#D98A1F` `#D64B4B` |
| `--color-{success,warning,error}-text` (≥ 12 px) | `#1B7049` `#8A5A0E` `#B03535` | `#7FD8AA` `#F5C26B` `#FF9A9A` |
| `--win-close-hover` | `#C42B1C` | `#C42B1C` |

"White 8 %" = `rgba(255,255,255,.08)`; "ink 6 %" = `rgba(28,28,46,.06)`. Semantic icons only on G1/solid surfaces;
toasts use accent icons. **Document layer** (white pages, both themes): selection and current search hit 2 px iris-500,
handles 8 px; text selection `rgba(91,91,214,.30)`, hits `.28`.

### 1.3 Glass

| Token | Light | Dark |
|---|---|---|
| `--surface` (over `--color-bg` only) | `rgba(255,255,255,.72)` | `rgba(28,28,46,.62)` |
| `--surface-strong` (over page content) | `rgba(255,255,255,.90)` | `rgba(28,28,46,.90)` |
| `--surface-solid` | `#FFFFFF` | `#1C1C2E` |
| `--glass-filter` / `--glass-edge` | `blur(24px) saturate(140%)` / `inset 0 0 0 1px` white 60 % | same / white 12 % |
| `--shadow-1` / `-2` / `-3` | ink: `0 1px 2px` .06 + `0 8px 32px` .08 / `0 2px 6px` .08 + `0 12px 40px` .16 / `0 24px 64px` .24 | black: .24+.32 / .32+.48 / .56 |

Recipes: **G1** = `--surface` + filter + edge + `--shadow-1` (toolbar, panels, banner, empty card). **G2** =
`--surface-strong` + filter + edge + `--shadow-2` (popover, toast, drop overlay). Dialogs, submenus: solid + `--shadow-3`.

`--surface-strong` is .90, not ADR-011's ≈ .86: worst-case muted text drops to 4.47 at .86.
Solid mode: `--surface-solid`, no filter, edge → 1 px divider; geometry unchanged. `forced-colors`: system colors,
focus `Highlight`. Blur never animates.

### 1.4 Radii, spacing, sizes

- Radii: `--radius-xs 4` · `-sm 8` · `-button 12` · `-panel 16` (toolbar, panels, canvas, overlays) · `-card 20` (empty card, dialog) ·
  `-pill 999`. Concentric: inner = outer − padding.
- Spacing (8-pt; 4 and 12 only inside controls): `--space-0-5 4 · 1 8 · 1-5 12 · 2 16 · 3 24 · 4 32 · 5 40 · 6 48 · 8 64`.
- Sizes: controls `sm 24 · md 32 · lg 40`; `--target-min 24`, default 32; hairline 1; focus width 2, offset 2.

### 1.5 Type

`-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`; ≥ 20 px uses
"Segoe UI Variable Display". Weights 400/600; numbers `tabular-nums`.

| Token | px | Use |
|---|---|---|
| `--text-xs` | 11/16, 600 | badges, key chips (minimum) |
| `--text-sm` | 12/16 | status bar, tooltips, meta; labels 600 |
| `--text-md` | 14/20 | body, controls; button labels 600 |
| `--text-lg` | 16/24, 600 | panel titles |
| `--text-xl` | 20/28, 600, −0.01em | empty state, dialogs |
| `--text-2xl` | 28/36, 600, −0.01em | onboarding |

"Meta" below = `--text-sm` + muted.

### 1.6 Motion

- `--motion-fast 150ms` hover, press, tooltip, exits · `--motion-base 200ms` popover, toast, tab indicator ·
  `--motion-slow 250ms` panel, inspector, banner.
- `--ease-out cubic-bezier(.22,1,.36,1)` opacity/color/size · `--ease-in cubic-bezier(.4,0,1,1)` exits ·
  `--ease-spring cubic-bezier(.34,1.56,.64,1)` transforms only (Motion: `spring`, `visualDuration .2`, `bounce .15`).
- Tooltip delay 500 ms (keyboard 300, 0 if another closed < 300 ms ago).
- Reduced motion: no transforms; transitions opacity-only, 150 ms `--ease-out`; smooth scroll → instant.

### 1.7 Elevation (only these z-index values)

| Layer | z | Members |
|---|---|---|
| `--z-base` | 0 | grid slots |
| canvas-local | 1–4 | `isolation: isolate`: page, text layer, annotation overlay, scroll-edge scrim |
| `--z-popover` | 100 | popovers, menus |
| `--z-toast` | 200 | toast |
| `--z-modal` | 300 | dialog, backdrop `rgba(15,16,32,.32)` |
| `--z-tooltip` | 400 | tooltips |
| `--z-drag` | 500 | drag ghost, drop overlay |

### 1.8 Icons

Lucide, `absoluteStrokeWidth` 1.5 px (2 px at 12), `currentColor`, `aria-hidden`. Sizes: 12 badges/status · 16 default ·
20 toolbar tools · 24 empty-state tile.

## 2. Layout grid

| Row | Height |
|---|---|
| caption (Windows only) | 32 |
| toolbar-row (drag region) | 56 = toolbar 40 + 8 above/below |
| banner | 0, or ≥ 48 + 8 gap |
| main | 1fr |
| status | 32 |

Main columns: `8 | left 192–400 (default 248) | splitter 8 | canvas minmax(360px,1fr) | 8 | inspector 288 | 8`.

- Collapsed left: track and outer gutter go; the splitter becomes the leading gutter. Hidden inspector: track and gap go.
- Canvas: `--color-canvas`, radius 16, padding 24, page gap 16, `scroll-padding-top: 24px`.
- **Scroll-edge scrim:** top 24 px inside the canvas (8 solid canvas color, 16 fade), layer 4, `pointer-events: none`,
  shown when `scrollTop > 0`. The toolbar never covers pages.
- Window minimum 960 × 640.
- No document: main = `8 | empty state | 8` on `--color-bg`; toolbar keeps its slot, tools `aria-disabled`.
- ≥ 1280 px: inspector track reserved while a document is open; the panel fades in with a selection or non-Select tool,
  so the canvas never shifts. 960–1279: track only via toggle; left panel auto-collapses if the canvas would be < 360.

### 2.2 Window chrome

| | macOS | Windows |
|---|---|---|
| Config | `titleBarStyle: Overlay`, `hiddenTitle` | `decorations: false` |
| Controls | traffic lights x 16, centred y 28 (start `trafficLightPosition {x:16, y:22}`, verify); toolbar-row leading inset 80 (full screen 8) | caption buttons 46 × 32, Lucide `minus`, `square`/`copy`, `x` 16; close hover `--win-close-hover` + white glyph |
| Drag | empty toolbar-row | empty caption; double-click maximizes; Alt+Space; max button keeps Snap Layouts |
| Title | none (status bar shows name) | `logo.svg` 16 + 8 + name, meta; inactive → text-disabled |

### 2.3 Focus

Tab and F6/Shift+F6: toolbar → banner → left panel → splitter → canvas → inspector → status bar; F6 restores each region's
last focus. Closing a panel, popover or dialog refocuses its trigger. Esc order:
tooltip → popover → gesture → tool → selection. Every command is in the native menu; no Ctrl+Alt on Windows (AltGr).

## 3. Components

**Roving** = one tab stop remembering the last item; arrows move; Home/End jump.

### 3.0 Shared states

| State | Treatment |
|---|---|
| hover | `--color-control-hover`, 150 ms; only under `(hover: hover)` |
| pressed | `--color-control-pressed`, `scale(.97)` spring |
| focus-visible | 2 px `--color-focus` outline, offset 2, follows radius; scroll containers pad ≥ 4 px |
| disabled | text-disabled, no hover; `aria-disabled` (still focusable) inside toolbar, menu, tablist |
| selected / on | `--color-selected` + 1 px inset accent ring + text-accent |
| active tool | accent fill + on-accent icon |

### 3.1 Button

One primary per view. Optional icon 16, label 600, gap 8, min width 64. Sizes: sm 24 h, padding 8, radius 8,
`--text-sm` · md 32, 12, 12, `--text-md` · lg 40, 16, 12 (empty-state Open only).

| Variant | Rest | Hover | Pressed | Disabled |
|---|---|---|---|---|
| primary | accent, on-accent | accent-hover | accent-pressed | fill-disabled + text-disabled |
| secondary | solid + 1 px inset control-border | control-hover | control-pressed | divider border |
| ghost | transparent (link: text-accent) | control-hover | control-pressed | text-disabled |

Keys: Enter, Space.

### 3.2 IconButton

md 32 / sm 24 (status bar, rows, banners); icon 16, toolbar 20; radius 12 / 8. Variants: plain, toggle
(`aria-pressed`, selected state), tool (§3.3). Requires `aria-label` (= tooltip) and `aria-keyshortcuts` when bound.

### 3.3 Toolbar

Leading → trailing: sidebar toggle `panel-left` | **Select** | **Markup**: Highlight, Comment, Draw | **Fill & Sign**:
Form, Signature | **Pages** | More `ellipsis` | spacer | zoom out, readout (56 w, `--text-sm`, opens zoom menu),
zoom in | inspector toggle `panel-right`. Items gap 4; clusters split by 8 + 1 × 16 px divider + 8. G1, 40 h,
padding 4, radius 16.

| Tool | Select | Highlight | Comment | Draw | Form | Signature | Pages |
|---|---|---|---|---|---|---|---|
| Lucide | `mouse-pointer-2` | `highlighter` | `message-square` | `pen-line` | `text-cursor-input` | `signature` | `layout-grid` |
| Key | V | H | C | D | F | S | P |

Variants (underline, shapes, text box, initials…) live in Tool options, never in split buttons. More: Stamp (M4),
Redact (M5), Rotate view, Go to page…, then collapsed clusters; unshipped items hidden.

- States: plain, hover, pressed, active, **locked** = active + 12 px badge inside the bottom-right (inset 2): on-accent
  disc, `lock` 8 px in accent.
- Click = one-shot (back to Select after one commit); double-click or Shift+Enter locks; Esc or clicking the locked
  tool → Select. Locked tooltip adds "Locked · Esc to release".
- Overflow (ResizeObserver) moves into More: Pages, then Fill & Sign, then zoom −/+. Select, Markup, readout and
  toggles stay. A collapsed active tool makes More active.
- Keys: `role=toolbar` `aria-label="Tools"`, roving Left/Right (no wrap), Enter/Space; ArrowDown opens menus. Tool
  letters only while the canvas has focus.
- A11y: clusters `role=group` with labels; tools `aria-pressed`; lock in `aria-description`.

### 3.4 Tooltip

Solid tooltip-bg, radius 8, padding 4 8, 24 h, max 240 w; name `--text-sm`; platform key chips `--text-xs` ink-40 on
white 12 %, radius 4. 8 px below toolbar anchors, right of panel anchors; flips to stay 8 px inside the window; never
covers its anchor. Stays while hovering anchor or tooltip (100 ms grace); hides on blur, Esc, click. Opacity 150 in,
100 out. `role=tooltip` + `aria-hidden` (duplicates the label); Esc closes only a shown tooltip. Meets 1.4.13.

### 3.5 Popover

G2, radius 16, padding 8, 200–320 w, max height window − 16. Items
32 h, radius 8: icon 16, `--text-md`, shortcut as meta; checked = `check` + text-accent.
Bottom-start, 8 offset, flips, 8 px window margin. In: opacity + scale .96 → 1, 200 spring;
out: opacity 150 `--ease-in`.
Keys: trigger `aria-haspopup` `aria-expanded`; Enter/Space/ArrowDown focus the first item, ArrowUp the last. Menus:
Up/Down wrap, type-ahead, Enter activates and closes, Right/Left submenu, Tab closes. `role=dialog` popovers cycle Tab
inside. Esc or outside click closes and refocuses the trigger. One open at a time; submenus solid.

### 3.6 Tabs

Left-panel views: Thumbnails `gallery-vertical`, Outline `list-tree`, Comments `messages-square`, Search `search`.
Header 48 (padding 8) holds a 32 h segmented tablist of four equal icon tabs, then a 32 h title row (`--text-md` 600 +
sm actions). Selected state; its fill slides (`transform`, 200 spring). Keys: `role=tablist`, roving Left/Right (wrap),
automatic activation; Tab enters the panel; ⌘F / Ctrl+F opens Search. `aria-controls` → tabpanel. Default
Thumbnails; last tab persisted.

### 3.7 Slider

Always paired with a 56 × 24 numeric field (precision, WCAG 2.5.7). Track 4 h pill, min 120 w,
fill accent, rest `--color-track`; thumb 16 white disc, 1 px control-border, `--shadow-1`; hit area 24 h. Hover/drag:
thumb `scale(1.125)`; focus ring on thumb; disabled: text-disabled. Keys (native range): arrows step, Shift × 10,
PageUp/Down 10 %, Home/End; field Enter commits, Esc reverts. `<label>`, `aria-valuetext` with unit.

### 3.8 Splitter

The 8 px gutter right of the left panel, full main height; centred 4 × 32 pill: hidden at rest, control-border on hover,
accent on drag/focus; `col-resize`. Target 8 px under the spacing exception (neighbours pad 8). Range 192–400, step 8;
release < 144 collapses; double-click resets 248; width persisted. Toggle collapse animates 250 `--ease-out`; fit-width
re-fits once at the end. Keys: `role=separator`,
`aria-valuenow/min/max`, `aria-controls`, tab stop; Left/Right 8 (Shift 40), Home/End, Enter collapse/restore.

### 3.9 Panel

Left panel and inspector: G1, radius 16; header 48 (padding 8); body scrolls, padding 8, rows 32 h radius 8. Inspector
288: header = selection ("Highlight", "3 items") or "Tool options"; sections split by dividers; fades
in (opacity 250), never translates or takes focus. Thumbnails: radius 4, `--page-shadow`, page pill (`--text-xs`, tile
colors; current page: accent pill + 2 px accent ring). Reorder by pointer or Move up/down (menu, Alt+↑/↓). `<aside>`
landmarks, F6 stops; lists roving Up/Down, Enter.

### 3.10 Status bar

32 h on `--color-bg`, no surface, padding 0 16, meta, gap 16. Leading: file name (middle-truncated, ≤ 40 %),
"Edited", signed/encrypted icon 12 with tooltip. Trailing: activity ("Saving…" + spinner), page "3 / 120" and zoom
"125 %" as sm ghost buttons opening Go to page and the zoom menu. `<footer>`, F6 stop. A polite live region announces
"Page 3 of 120" 500 ms after scrolling settles.

### 3.11 Empty state

Centred column, max 560 w.

1. **Drop card:** G1, radius 20, padding 32; tile 48 (radius 12, tile colors, `file-up` 24); "Open a PDF"
   `--text-xl`; "Drop a file anywhere in this window or choose one." muted; primary lg "Open…" + meta "⌘O"/"Ctrl+O".
2. **Recents**, 32 below: header "Recent" (meta 600) + ghost sm "Clear"; ≤ 8 rows, 56 h, radius 12, padding 8:
   thumbnail 32 × 40 | name over meta "Folder · 2 h ago" | sm `x` (on hover/focus, `tabindex=-1`). Missing file:
   `file-x` in warning-icon, "File not found"; activation offers Locate… / Remove. Footer meta: "Recent files are
   stored only on this device." Omitted when empty.

Native drag-over: selected fill + 2 px inset accent ring, title "Drop to open"; with a document open, a G2 overlay inset
8 px in the canvas slot (`--z-drag`). Keys: initial focus Open; recents roving Up/Down, Enter opens, Delete removes,
Shift+F10 menu; removals and Clear give an Undo toast. Drop is pointer-only; Open is the keyboard path.

### 3.12 Toast and error banner

| | Toast | Banner |
|---|---|---|
| Use | confirmation, optional Undo | persistent: signed file, XFA, engine stopped, save failed |
| Slot | canvas bottom centre, 16 above edge, `--z-toast` | banner row; pushes content |
| Anatomy | G2, 40 h, radius 16, padding 4 4 4 12, 240–400 w; accent icon 16, `--text-md`, optional ghost action | G1, ≥ 48 h, radius 16, padding 8 8 8 16; icon 16 (`info` accent, `triangle-alert` warning, `circle-alert` error), text color message, ≤ 2 buttons, optional `x` |
| Lifetime | 4 s, 8 s with action; pauses on hover, focus, blur; one at a time | until resolved; one shown, error > warning > info |
| Motion | translateY 8 → 0 + opacity, 200 spring; out 150 | height + opacity 250; reduced: instant |
| Keys / A11y | never takes focus; action duplicates a command; `role=status` | F6 region; Esc does not dismiss; error `role=alert`, else `status` |

Errors never toast.

## 4. Contrast verification

Worst points: `--surface` over `--color-bg` (light `#FCFCFF`; dark bounded by `#1C1C2E`); `--surface-strong` over
black (light) or white (dark) content. Text needs 4.5, non-text 3.

| Pairing | Light | Dark |
|---|---|---|
| text on solid / glass / strong / canvas / bg | 16.73 / 16.34 / 13.35 / 13.88 / 15.42 | 16.73 / ≥ 16.73 / 12.39 / 19.44 / 17.77 |
| text on control-hover / pressed / selected | 13.17 / 10.66 / 13.17 | 13.30 / 10.82 / 12.03 |
| muted on solid / glass / strong / canvas / bg / selected | 6.17 / 6.03 / 4.92 / 5.12 / 5.69 / 4.86 | 6.82 / ≥ 6.82 / 5.05 / 7.93 / 7.24 / 4.90 |
| text-accent on solid / strong / selected / canvas | 8.85 / 7.06 / 6.96 / 7.34 | 10.66 / 7.89 / 7.66 / 12.39 |
| tile icon on tile | 6.96 | 8.29 |
| on-accent on accent / hover / pressed | 5.37 / 6.85 / 8.85 | 5.82 / 10.66 / 4.77 |
| control border on solid / glass / strong / hover | 3.88 / 3.79 / 3.09 / 3.05 | 4.32 / ≥ 4.32 / 3.20 / 3.43 |
| focus, active fill, ring on solid / glass / canvas / strong / selected | 5.37 / 5.24 / 4.45 / 4.28 / 4.22 | 5.82 / ≥ 5.82 / 6.76 / 4.31 / 4.18 |
| lock disc on accent / glyph on disc | 5.37 / 5.37 | 5.82 / 5.82 |
| success / warning / error text on solid / glass | 6.07 / 5.92 / 6.16 · 5.93 / 5.78 / 6.02 | 9.81 / 10.21 / 8.24 · ≥ solid |
| same on strong | 4.84 / 4.72 / 4.92 | 7.26 / 7.56 / 6.10 |
| success / warning / error icon on solid / glass | 3.38 / 3.97 / 4.23 · 3.30 / 3.88 / 4.13 | 4.96 / 6.06 / 3.96 · ≥ solid |
| accent toast icon on strong | 4.28 | 4.31 |
| tooltip text / keys | 16.73 / 6.82 | 13.62 / 5.55 |
| white glyph on close hover | 5.66 | 5.66 |
| disabled on solid (exempt) | 3.88 | 2.71 |

Document layer: iris-500 on white page 5.37. **Fails, never use:** white on iris-400 3.51, `#D98A1F` text 2.76, ink-60
on iris-200 3.93, iris-500 text on canvas 4.45, iris-300 text in light 2.88.

## 5. Brand

Logo `assets/brand/logo.svg` only. Wordmark "Sheer": system font 600, −0.02em, `--color-text`, icon gap 0.5 × cap
height. Monochrome tray variant: page path in `currentColor`, no tile. No other logo variants.

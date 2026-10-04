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
| `--color-bg` (= `--bg-fields` over `--bg-gradient`, §1.10) | fields over 135° iris-100 → iris-50 | fields over 135° `#1C1D40→#0F1020` |
| `--color-canvas` (F2 review: a tray, not a slab) | `#ECEDFC` | `#111226` |
| `--canvas-edge` (inset, canvas only) | `inset 0 1px 0 rgba(255,255,255,.70), inset 0 0 0 1px rgba(91,91,214,.08)` | `inset 0 0 0 1px rgba(255,255,255,.06)` |
| `--color-scrollbar / -hover` (thumb; track transparent, §1.11) | `rgba(58,58,171,.28)` / `.44` | `rgba(201,202,255,.24)` / `.40` |
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
on glass (G1, G2) they take the `-text` color of their role, since `-icon` (success 2.73) fails over the tinted glass (§4).
Icons in a tile always use `--color-tile-icon`; toasts use accent icons in a tile. **Document layer** (white pages, both themes): selection and current search hit 2 px iris-500,
handles 8 px; text selection `rgba(91,91,214,.30)`, hits `.28`.

### 1.3 Glass

| Token | Light | Dark |
|---|---|---|
| `--surface` (over `--color-bg` only; iris-50 tint) | `rgba(244,245,255,.66)` | `rgba(30,30,58,.60)` |
| `--surface-strong` (over page content; untinted, ADR-020) | `rgba(255,255,255,.90)` | `rgba(28,28,46,.90)` |
| `--surface-solid` (dialogs, submenus, fields, G2 in solid mode) | `#FFFFFF` | `#1C1C2E` |
| `--surface-fallback` (G1 in solid mode) | `#F8F8FF` | `#1E1E3A` |
| `--glass-filter` | `blur(24px) saturate(160%)` | same |
| `--glass-edge` (thin light inner edge, lit from above) | `inset 0 1px 0 rgba(255,255,255,.90), inset 0 0 0 1px rgba(255,255,255,.55)` | `inset 0 1px 0 rgba(255,255,255,.14), inset 0 0 0 1px rgba(255,255,255,.10)` |
| `--shadow-1` | `0 1px 2px rgba(58,58,171,.06), 0 8px 32px rgba(91,91,214,.12)` | black `0 1px 2px` .24 + `0 8px 32px` .32 |
| `--shadow-2` | `0 2px 6px rgba(58,58,171,.08), 0 12px 40px rgba(91,91,214,.16)` | black .32 + .48 |
| `--shadow-3` | `0 24px 64px rgba(58,58,171,.24)` | black .56 |

Light shadows are Iris (iris-500 at 12 % for the main shadow of G1, iris-700 for the contact shadow); dark keeps black,
where a coloured shadow does not read. Recipes: **G1** = `--surface` + filter + edge + `--shadow-1` (toolbar, panels,
banner, empty card). **G2** = `--surface-strong` + edge + `--shadow-2`, no filter (popover, toast, drop overlay;
they sit over the canvas, which is never blurred, MOTION §5).
Dialogs, submenus: solid + `--shadow-3`.

`--surface-strong` is .90, not ADR-011's ≈ .86: worst-case muted text drops to 4.47 at .86. It stays untinted: over
pages a tint does not show and costs the control border its 3:1 (2.93 at an `#F8F8FF` base, less at iris-50).
**Solid mode:** G1 → `--surface-fallback`, G2 → `--surface-solid`, no filter, edge → 1 px `--color-divider`,
`--bg-fields: none` (the gradient stays: it is paint, not transparency); shadows and geometry unchanged.
**Forced colors:** `--color-bg` → `Canvas` (gradient and fields none), surfaces `Canvas` + 1 px `CanvasText` border,
shadows none, focus `Highlight`. Blur never animates.

### 1.4 Radii, spacing, sizes

- Radii: `--radius-xs 4` · `-sm 8` · `-button 12` · `-panel 16` (toolbar, panels, canvas, overlays) · `-card 24` (empty card, dialog; was 20, ADR-020) ·
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

**`docs/MOTION.md` is the motion spec (ADR-022)** and supersedes every duration, easing and motion note in this file.

- One curve: `--ease-spring` = the bounce-.15 spring as `linear()` (MOTION §1), fallback `cubic-bezier(.25,.1,.25,1)`;
  Motion: `{ type: "spring", bounce: .15, visualDuration: <token in s> }`. `--ease-in` and `--ease-out` are removed.
- `--motion-fast 120ms` · `--motion-base 200ms` · `--motion-slow 320ms`; exits one step shorter than enters.
- Transform amounts: `--scale-press .97`, `--scale-enter .96`, `--scale-thumb 1.125`, `--offset-enter 8px`, new
  `--scale-lift 1.04`, `--pulse-scale 1.06`, `--pulse-opacity .6`; new sizes `--drag-card-width 160`, `--drag-card-height 208`.
- Tooltip delay 500 ms (keyboard 300, 0 if another closed < 300 ms ago).
- Reduced motion: opacity only (enter base, exit fast), layout in one step, zoom and scroll at once; transform tokens → 1 / 0.
- One ambient exception: the empty-state logo float (§1.10, `--ease-float`); off under reduced motion.

### 1.7 Elevation (only these z-index values)

| Layer | z | Members |
|---|---|---|
| `--z-base` | 0 | grid slots |
| canvas-local | 1–4 | `isolation: isolate`: page, text layer, annotation overlay, scroll-edge scrim |
| `--z-popover` | 100 | popovers, menus, tour coach mark (§3.14) |
| `--z-toast` | 200 | toast |
| `--z-modal` | 300 | dialog, backdrop `rgba(15,16,32,.32)` |
| `--z-tooltip` | 400 | tooltips |
| `--z-drag` | 500 | drag ghost, drop overlay |

### 1.8 Icons

Lucide, `absoluteStrokeWidth` 1.5 px (2 px at 12), `currentColor`, `aria-hidden`. Sizes: 12 badges/status · 16 default ·
20 toolbar tools · 24 empty-state tile.

### 1.9 Implementation (Tailwind 4)

`src/styles/tokens.css` holds every value of §1; `tokens.test.ts` checks it against these tables. Tailwind's default theme is dropped
(`--*: initial`), so only role tokens exist as utilities. Names follow the token names:

- Colors: `bg-accent`, `text-text-muted`, `border-divider`, `bg-surface-solid`, `bg-page` (the page gradient is `bg-bg`).
- Spacing: `p-1` is `--space-1` (8 px), not Tailwind's 4 px; `p-0-5`, `gap-1-5`. Sizes: `h-control-md`, `size-icon-16`, `min-w-target-min`.
- `rounded-panel`, `shadow-2`, `text-md` (size, line height and weight together), `font-display` for ≥ 20 px, `ease-spring`, `duration-fast`, `z-popover`.
- Recipes: `glass-1` (G1), `glass-2` (G2), `surface-dialog` (solid + `--shadow-3`), `shadow-page`. Solid mode needs no variant: the tokens change underneath.
- Beyond the tables, only values the specs imply: `--color-tooltip-text`/`-key` (§3.4), `--color-page` and `--color-doc-*` (§1.2 last paragraph),
  `--color-backdrop` (§1.7), `--page-shadow` (§3.9, = `--shadow-1`) and `--scale-press`/`--scale-enter`/`--offset-enter`
  (§3.0, 3.5, 3.12), which reduced motion resets to 1, 1 and 0 so a component needs no extra branch.
- Widths the specs name, as tokens: `--field-width` 56 (slider number field, zoom readout; `w-field`), `--slider-min` 120, `--popover-min` / `--popover-max` 200 / 320,
  `--tooltip-max` 240, `--splitter-width` 8 (`w-splitter`), and the left panel `--panel-min` / `-default` / `-max` 192 / 248 / 400 with `--panel-collapse-below` 144 (§2, §3.8;
  `components/tokens.ts` mirrors them as numbers for the splitter, and the test fails on drift). `--spacing-0` is `0px` (`min-w-0`, `inset-0`). `--scale-thumb` 1.125 (§3.7)
  joins `--scale-press` and `--scale-enter` and reduced motion resets it to 1. Components contain no raw sizes.
- Layout slots (§2, 2.2, 3.11), as tokens with Tailwind names: `--caption-height` 32 (`h-caption`), `--toolbar-row-height` 56 (`h-toolbar-row`), `--banner-min-height` 48 (`min-h-banner-min`), `--status-height` 32 (`h-status`), `--status-name-max` 40 % (`max-w-status-name`),
  `--caption-button-width` 46 (`w-caption-button`), `--chrome-inset-mac` 80 (`ps-chrome-inset`), `--inspector-width` 288 (`w-inspector`), `--canvas-min` 360 (`min-w-canvas-min`), `--empty-max-width` 560 (`max-w-empty-max`) and the
  scroll-edge scrim `--scrim-height` 24 + `--scrim-solid` 8 (`canvas-scrim` utility, `h-scrim`). `--color-on-close` is the white glyph on the Windows close hover (`text-on-close`; `HighlightText` in forced colors).
  `LAYOUT` in `components/tokens.ts` mirrors the four widths the collapse rules calculate with, and the test fails on drift.
- Theme: `prefers-color-scheme`, overridden by `html[data-theme]`. Solid mode: unsupported `backdrop-filter`, `prefers-reduced-transparency`,
  `html[data-transparency="reduced"]`, `forced-colors`. The dark values and the solid values each exist twice in the file (media query and attribute); the test keeps the copies identical.

### 1.10 Mood (ADR-020)

Target: soft light, translucent cards with large radii and a light inner edge, icons in small rounded tiles, pill
badges, generous white space. One hue: everything below is Iris, ink or white.

**Background layer.** `--color-bg` paints the window root (the shell element, `--z-base`, behind every slot; it is the
window, not a surface, so it overlaps nothing). Two tokens, layered fields over gradient:

| Token | Light | Dark |
|---|---|---|
| `--bg-gradient` | `linear-gradient(135deg, #E1E2FF, #F4F5FF)` (iris-100 → iris-50) | `linear-gradient(135deg, #1C1D40, #0F1020)` |
| `--bg-field-a` (Iris field, top left) | `radial-gradient(ellipse 720px 240px at 8% 0%, rgba(142,142,242,.32), transparent)` | same shape, `rgba(91,91,214,.28)` |
| `--bg-field-b` (light field, top right) | `radial-gradient(ellipse 560px 200px at 72% 0%, rgba(255,255,255,.85), transparent)` | same shape, `rgba(142,142,242,.10)` |
| `--bg-field-c` (Iris field, bottom left) | `radial-gradient(ellipse 480px 360px at 0% 100%, rgba(201,202,255,.40), transparent)` | same shape, `rgba(58,58,171,.30)` |
| `--bg-fields` | `field-a, field-b, field-c` | same |

**Why fields.** Blur over a smooth gradient shows nothing. Fields a and b give the toolbar row a strong change of
hue and lightness along its length (Iris-deep at the leading end, near-white at ~72 %), field a also sits behind the
top of the left panel, field c behind its foot. Through `--surface` at .66 that variation reads as frosted glass;
over the canvas there is nothing to see because the canvas is opaque and never blurred. Fields are static (no motion,
no parallax), sized in px and anchored in %, so they keep their shape from 960 × 640 up.

**Placement rule.** Field a ends 240 px below the window top. Text that sits directly on `--color-bg` (status bar,
recents header and rows, §3.10–3.11) must lie below that band; there the darkest light background is
`rgb(220,221,255)` (muted 4.67). Glass is computed over the darkest field point (`#C6C7FB` light, `#2E2E6A` dark).

**Tinted glass.** `--surface` is iris-50-based at .66 (light) and `#1E1E3A`-based at .60 (dark), §1.3; edge and Iris
shadows per §1.3. `--surface-strong` and dialogs stay neutral.

**Tiles and pills.** Tile = `--color-tile` fill, `--color-tile-icon` glyph, radius concentric with its container.
Used for: the toast icon (32, radius 12), the info banner icon (32, radius 8), the empty card's shortcut hint (pill).
Semantic banner icons (warning, error) stay bare (tile contrast fails in dark). Pill badge = `--radius-pill`,
`--text-xs`, 20 h, padding 0 8, tile colors: the page pill (§3.9) and the status bar "Edited" badge (§3.10).

**Changed components.** Shell root (background), toolbar, panels, banner, empty state (card + logo, §3.11), toast,
popover edge and shadow, dialog radius and shadow, status bar "Edited", thumbnails' page shadow (coloured via
`--page-shadow` = `--shadow-1`; dark per §1.11), canvas colour and edge, scrollbars (§1.11). Unchanged: document layer, tooltips, fields, segmented control.

**Float animation** (empty-state logo only; the one ambient motion in the app, an exception to §1.6 durations):

| Token | Value |
|---|---|
| `--float-distance` | 8px (reduced motion: 0) |
| `--float-duration` | 3000ms per direction (6 s cycle) |
| `--ease-float` | `cubic-bezier(.37,0,.63,1)` (sine in-out) |

Keyframes `float`: sheet `translateY(0)` → `translateY(calc(-1 * var(--float-distance)))`, `alternate infinite`; the
ground shadow runs the same timing, `scale(1)` → `scale(.88)` and opacity 1 → .7. Transform and opacity only
(compositor), `will-change: transform` on the sheet only. Paused (`animation-play-state`) while `document.hidden`;
unmounted with the empty state. Entry: opacity 0 → 1 + `scale(--scale-enter)` → 1, 250 spring; the float starts after.
**Reduced motion:** no float, no scale; the sheet rests at 0 with a static ground shadow; entry is opacity, 150
`--ease-out`. **Forced colors:** the logo stays (an image), the ground shadow is hidden.

### 1.11 Scrollbars (F2 review)

Never the native grey bar, never arrow buttons. Every scroll region (canvas, panel bodies, popover lists, empty state)
uses the `::-webkit-scrollbar` recipe in both webviews: 8 px, track and corner transparent, thumb `--color-scrollbar`,
radius pill, 2 px transparent border with `background-clip: padding-box`; hover thumb `--color-scrollbar-hover`;
`::-webkit-scrollbar-button { display: none; width: 0; height: 0 }`. **Not** `scrollbar-width`/`scrollbar-color`:
WebView2 (Chromium ≥ 121) ignores every `::-webkit-scrollbar` rule on an element that sets them, and its standard bar
draws arrow buttons on Windows (F2 review). They stay only under `@supports not selector(::-webkit-scrollbar)`. The bar sits inside
the slot's padding, never in a separate white band. **Forced colors:** rules removed (`scrollbar-color: auto`), native bars.
**Page shadow, dark:** `--page-shadow` is `0 0 0 1px rgba(255,255,255,.08), 0 8px 24px rgba(0,0,0,.56)` (black alone
vanishes on the canvas); light stays `--shadow-1`. The canvas carries `--canvas-edge`; it is paint, so solid mode keeps it.

New tokens join §1.9's test: `--canvas-edge`, `--color-scrollbar`, `--color-scrollbar-hover`, `--bg-gradient`, `--bg-field-a/b/c`, `--bg-fields`, `--surface-fallback`, `--float-*`,
`--ease-float`, `--logo-hero` 104, `--logo-slot` 128 (Politur M5: sized so an 800 px window fits; was 160 / 184), `--ground-shadow` (`radial-gradient(closest-side,
rgba(91,91,214,.24), transparent)` light, `rgba(0,0,0,.48)` dark).

## 2. Layout grid

| Row | Height |
|---|---|
| caption (Windows only) | 32 |
| toolbar-row (drag region) | 56 = toolbar 40 + 8 above/below |
| tabs (§3.18) | 0 with no document, else 32 + 8 gap |
| banner | 0, or ≥ 48 + 8 gap |
| main | 1fr |
| status | 32 |

Main columns: `8 | left 192–400 (default 248) | splitter 8 | canvas minmax(360px,1fr) | 8 | inspector 288 | 8`.

- Collapsed left: track and outer gutter go (they shrink to 0, animated, see 2.4 and 3.8); the splitter becomes the leading gutter. Hidden inspector: track and gap go.
- Canvas: `--color-canvas`, radius 16, padding 24, page gap 16, `scroll-padding-top: 24px`.
- **Scroll-edge scrim:** top 24 px inside the canvas (8 solid canvas color, 16 fade), layer 4, `pointer-events: none`,
  shown when `scrollTop > 0`. The toolbar never covers pages.
- Window minimum 960 × 640.
- No document: main = `8 | empty state | 8` on `--color-bg`; toolbar keeps its slot, tools `aria-disabled`.
- ≥ 1280 px (`auto`): no empty reservation (F2 review: a blank 288 column reads as broken). The canvas spans to the
  trailing gutter; a selection or non-Select tool opens the inspector track with the same grid-track transition as the
  left panel (MOTION §4.2: the panel slides in on the track, the canvas keeps its anchor); it closes
  when selection and tool return to none/Select. Reduced motion: track at once, opacity fade.
  960–1279: track only via toggle; left panel auto-collapses if the canvas would be < 360.

### 2.2 Window chrome

| | macOS | Windows |
|---|---|---|
| Config | `titleBarStyle: Overlay`, `hiddenTitle` | `decorations: false` |
| Controls | traffic lights x 16, centred y 28 (start `trafficLightPosition {x:16, y:22}`, verify); toolbar-row leading inset 80 (full screen 8) | caption buttons 46 × 32, Lucide `minus`, `square`/`copy`, `x` 16; close hover `--win-close-hover` + white glyph |
| Drag | empty toolbar-row | empty caption; double-click maximizes; Alt+Space; max button keeps Snap Layouts |
| Title | none (status bar shows name) | `logo.svg` 16 + 8 + name, meta; inactive → text-disabled |

### 2.3 Focus

Tab and F6/Shift+F6: toolbar → document tabs → banner → left panel → splitter → canvas → inspector → status bar; F6 restores each region's
last focus. Closing a panel, popover or dialog refocuses its trigger. Esc order:
tooltip → dialog → popover → gesture → tool → selection (the stacking order of 1.7, topmost first; `DISMISS_PRIORITY`). Every command is in the native menu on macOS; Windows has none (ADR-016), so there every command is on the toolbar, in More or on the keyboard; no Ctrl+Alt on Windows (AltGr).

### 2.4 Implementation (app shell)

`features/shell/Shell.tsx` composes the rows: caption (Windows), toolbar row, banner, main, status. The main row is a grid whose `grid-template-columns` comes from `shellTracks`
(`lib/layout.ts`, pure, tested) for the *structure* `shellStructure` derives from the window and the stores (see Render isolation below): left panel, splitter, canvas and inspector tracks
appear and disappear by the rules above, and each child is placed by `grid-column`. `computeShellLayout` is the two together, with the canvas width; the components do not call it (ADR-015), it keeps the
rules testable as one. The main row has an 8 px gap above the status bar so panels and canvas do not touch its text.

- **Inspector modes.** `ui.inspector` is `auto`, `open` or `closed`. `auto` lets a selection or a non-Select tool fade the panel in, but only from 1280 px (the track then opens animated, §2); `open` shows it and gives it a
  track at any width; `closed` hides the panel and, below 1280, the track. The toolbar toggle is pressed while the panel is visible and sets `open` or `closed`.
- **Left panel collapse** is derived, not stored twice: the user's choice (`ui.leftPanelCollapsed`, set by the splitter's Enter, a release below 144 or the toolbar toggle) or the layout's own (canvas under 360).
  The latter returns when the window grows. Collapsing or restoring animates over 250 ms `--ease-out`: the two tracks of the panel (outer gutter and panel) stay in the track list at size 0 when it is collapsed, so the list keeps its shape and `MainGrid` lets the browser
  transition `grid-template-columns` (the class is on the grid for 300 ms after the change only: a splitter drag must follow the pointer). The panel fades in step (`LeftPanelSlot`, `AnimatePresence`, `usePanelFade`) and is inert while it goes;
  once faded it leaves the page. Under reduced motion only opacity moves (150 ms): a restore gives the tracks at once and the panel fades in on them, a collapse takes them away in one step after the fade (`tokens.css`). The shell renders once for the change and never for a frame
  or the end of the animation (`Shell.renders.test.tsx`). The width is `ui.leftPanelWidth` while dragging and is saved to settings (`leftPanelWidth`, 192 to 400) 300 ms after it settles.
- **Commands and keys.** Every command is an action of `src/actions/registry.ts` (ADR-016): the toolbar items, the More menu, the key handler and the macOS menu bar derive from it, so a tooltip's key chip, `aria-keyshortcuts` and the real binding cannot differ. The platform's primary key is Cmd on macOS and Ctrl elsewhere. A bare letter (the tool keys) works only while the canvas has focus, and no key is ever taken from a text field.
- **Platform chrome.** The first paint takes the platform from the user agent, then `app_ready`'s answer replaces it (ADR-014). Windows: caption row, caption buttons are not tab stops. macOS: 80 px toolbar-row inset, 8 in full screen.
  The toolbar row (and the Windows caption) carry `data-tauri-drag-region="deep"`: any non-interactive part drags, buttons never do.
- **Canvas** is the `<main>` landmark around one focusable scroll region; the scrim is a sibling of that region (it must not scroll) and shows once `scrollTop > 0`. The region holds one content box as large as the layout (24 px padding around it, page gap 16 = `--space-2`, read from the token), and only the pages within a viewport height of the viewport are mounted in it (at most 24), each a white placeholder of its real size with `role="img"`, named "Page n of m". Nothing animates: a zoom or a jump scrolls at once, so reduced motion changes nothing here. Ctrl/Cmd+wheel and the pinch zoom around the pointer, the buttons and keys around the middle of the viewport; Single page and Two pages turn with Next/Previous page and with the wheel at the end of the page.
- **Empty state.** The drop zone is visual only (`ui.dropHover`, set from Rust: the `dropHover` message of the app channel, ARCHITECTURE §6); the webview never reads a dropped file or path. Recents show a placeholder until M1 has the list; the privacy footer belongs to the rows and
  is omitted while there are none (§3.11).
- **Banner.** `BannerRow` follows `ui.banner`. It opens and closes with height and opacity over 250 ms ease-out (§3.12, `useRevealMotion`); under reduced motion only the opacity changes, 150 ms. The row clips its
  content while it moves and not at rest, where the glass shadow reaches beyond it.
- **Render isolation.** The shell must not re-render for what changes often. `Shell` follows only the *structure* (`shellStructure` in `lib/layout.ts`: booleans that flip at the thresholds of the collapse rules, read through
  `useShellStructure`), the platform and the window chrome. Each part follows what it shows: `ToolbarSlot` the active tool and whether the zoom is at a limit (the readout and the zoom menu follow the zoom themselves,
  `ZoomReadout`, `useZoomMenu`), `ViewerCanvas` and `ViewerStatusBar` the open document's image, page and zoom, `MainGrid` and `LeftPanelSplitter` the panel width, `BannerRow` the error. The viewer's state is the
  `useViewer` store (`features/viewer/useViewer.ts`): its actions never change, they read the state when called. A page, a zoom step, a render, a drag over the window or a step of the splitter therefore renders those parts and
  not the shell, the toolbar or the left panel (`Shell.renders.test.tsx` counts renders). The window's maximized and full-screen state is read once when a resize has settled (150 ms), not per frame.

Differences from the spec, all temporary: the file name is cut at its head and keeps its last 8 characters (a CSS-only
middle truncation); the tabs are placeholders; More carries the commands that have no toolbar button (Open, Close document, Actual size, Fit width, Fit page, the three scroll modes as a checked choice of one — Continuous scrolling, Single page, Two pages —, Next and Previous page, Settings, About), which is the only way to them with a mouse on Windows (ADR-016), and Settings and About open the popover and the dialog of 3.13; tools only change the active tool until M2.

## 3. Components

**Roving** = one tab stop remembering the last item; arrows move; Home/End jump.

### 3.0 Shared states

| State | Treatment |
|---|---|
| hover | `--color-control-hover`, 150 ms; only under `(hover: hover)` |
| pressed | `--color-control-pressed`, `scale(.97)` spring |
| focus-visible | 2 px `--color-focus` outline, offset 2, follows radius; scroll containers pad ≥ 4 px |
| disabled | text-disabled, no hover; `aria-disabled` (still focusable) inside toolbar, menu, tablist |
| selected / on | `--color-selected` + 1 px inset accent ring + text-accent. Forced colors drop the ring (a box-shadow) and flatten the fill, so a 2 px `Highlight` border (`forced-colors:` variant) carries the state instead; it is a border, not an outline, because the focus ring is an outline |
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
zoom in | inspector toggle `panel-right`. Items gap 4; clusters split by `--toolbar-group-gap` (12) + 1 × 16 px divider + 12 (F9: Markup and Edit read as two groups). G1, 40 h,
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

Submenus (`MenuItemSpec.submenu`): an item shows a chevron (mirrored in right-to-left) and `aria-haspopup="menu"` / `aria-expanded`. The submenu is a `role=menu` named after its item, a solid
surface (`surface-dialog`, shadow 3; glass is never nested), same width as a popover, in the popover layer. It opens to the right of the item (left in right-to-left, and flipped when it does not fit), overlapping the
parent panel with no gap, its first item level with the parent item. It opens on Right, Enter, Space or a click and then focuses its first item; Left closes it and refocuses the item; Esc closes only the innermost
submenu (second Esc: the menu); Tab closes the whole menu; choosing an item closes every level and refocuses the trigger. Up/Down/Home/End/type-ahead move inside the open level, and moving to another item of the
parent closes the submenu. A disabled item stays focusable and opens nothing. **Hover intent:** the pointer must rest 200 ms on an item before its submenu opens (it takes no focus), and an open submenu stays 300 ms
after the pointer left its item, so a path across a neighbour does not close it; entering the submenu or returning to the item cancels the closing. Touch has no hover: the tap opens it. A submenu closing while it holds
focus returns focus to its item. Motion as the popover (opacity + scale, opacity only under reduced motion). A click inside a submenu is not an outside click. Submenus nest.

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

The numeric field is the shared **Field** primitive (`components/Field.tsx`, styles in `controlStyles.ts`): a plain `<input>`, 56 wide (`w-field`), `sm` 24 or `md` 32 high
(the Go to page form uses `md`), radius 8, 1 px `--color-control-border` on `--surface-solid`; disabled takes the divider border and `text-disabled`, `aria-invalid` the error-icon border, focus is the
global 2 px ring. It has no label of its own.

### 3.8 Splitter

The 8 px gutter right of the left panel, full main height; centred 4 × 32 pill: hidden at rest, control-border on hover,
accent on drag/focus; `col-resize`. Target 8 px under the spacing exception (neighbours pad 8). Range 192–400, step 8;
release < 144 collapses; double-click resets 248; width persisted. Toggle collapse slides per MOTION §4.2; fit width follows
as a transform and commits once at the end without a visible change. Keys: `role=separator`,
`aria-valuenow/min/max`, `aria-controls`, tab stop; Left/Right 8 (Shift 40), Home/End, Enter collapse/restore.

### 3.9 Panel

Left panel and inspector: G1, radius 16; header 48 (padding 8); body scrolls, padding 8, rows 32 h radius 8. Inspector
288: header = selection ("Highlight", "3 items") or "Tool options"; sections split by dividers; slides in
from the trailing edge (MOTION §4.2), never takes focus. Thumbnails: radius 4, `--page-shadow`, page pill (`--text-xs`, tile
colors; current page: accent pill + 2 px accent ring). Reorder by pointer or Move up/down (menu, Alt+↑/↓). `<aside>`
landmarks, F6 stops; lists roving Up/Down, Enter.

### 3.10 Status bar

32 h on `--color-bg`, no surface, padding 0 16, meta, gap 16. Leading: file name (middle-truncated, ≤ 40 %),
"Edited" as a pill badge (§1.10), signed/encrypted icon 12 with tooltip. Trailing: activity ("Saving…" + spinner), page "3 / 120" and zoom
"125 %" as sm ghost buttons opening Go to page and the zoom menu. `<footer>`, F6 stop. The page is the one most of the viewport is on while scrolling, and the page shown in the paged modes. A polite live region announces
"Page 3 of 120" 500 ms after scrolling settles.

### 3.11 Empty state

Centred column, max 560 w, padding 40 top and bottom; it scrolls when the window is short (at 640 × 960 logo and card
fit, recents scroll).

1. **Logo slot** (focal point, ADR-020): 128 h (`--logo-slot`), full column width, own grid row; nothing else sits in
   it. `assets/brand/logo.svg` at 104 (`--logo-hero`; one size at every window height, chosen so an 800 px window shows
   logo, card and recents; was 160 in 184), centred, top inset 8 at rest, so the float (§1.10) stays inside
   the slot; ground shadow 96 × 8 (`--ground-shadow`), centred, bottom inset 4. Decorative: `alt=""`, `aria-hidden`,
   `pointer-events: none`; never a tab stop. Always the full-colour logo (Iris tile + sheet), both themes.
2. **Drop card**, 24 below: G1, radius 24, padding 40, content centred; no icon tile (the logo above replaces it);
   "Open a PDF" `--text-xl`; 8 below, "Drop a file anywhere in this window or choose one." muted; 24 below, primary lg
   "Open…" and, 8 right, the shortcut as a pill badge ("⌘O"/"Ctrl+O", §1.10); 16 below, the ghost md
   "Create PDF from images…" (M6, §3.43).
3. **Recents**, 32 below: header "Recent" (meta 600) + ghost sm "Clear"; ≤ 8 rows (3 when the viewport is ≤ 860 high, `empty-recents`), 56 h, radius 12, padding 8:
   thumbnail 32 × 40 (states §3.48) | name over meta "Folder · 2 h ago" | sm `x` (on hover/focus, `tabindex=-1`). Missing file:
   `file-x` in warning-icon, "File not found"; activation offers Locate… / Remove. Footer meta: `recents.privacy` (§3.48).
   Omitted when empty.

Native drag-over: selected fill + 2 px inset accent ring, title "Drop to open"; with a document open, a G2 overlay inset
8 px in the canvas slot (`--z-drag`). Keys: initial focus Open; recents roving Up/Down, Enter opens, Delete removes,
Shift+F10 menu; removals and Clear give an Undo toast. Drop is pointer-only; Open is the keyboard path.

### 3.12 Toast and error banner

| | Toast | Banner |
|---|---|---|
| Use | confirmation, optional Undo | persistent: signed file, XFA, engine stopped, save failed |
| Slot | canvas bottom centre, 16 above edge, `--z-toast` | banner row; pushes content |
| Anatomy | G2, 40 h, radius 16, padding 4 12 4 4, 240–400 w; icon 16 in a 32 tile (radius 12), gap 8, `--text-md`, optional ghost action | G1, ≥ 48 h, radius 16, padding 8 8 8 8; `info` 16 in a 32 tile (radius 8), or bare `triangle-alert` / `circle-alert` 16 in `--color-{warning,error}-text` (on glass, §1.2) centred in 32; gap 8, text color message, ≤ 2 buttons, optional `x` |
| Lifetime | 4 s, 8 s with action; pauses on hover, focus, blur; one at a time | until resolved; one shown, error > warning > info |
| Motion | translateY 8 → 0 + opacity, 200 spring; out 150 | height + opacity 250; reduced: instant |
| Keys / A11y | never takes focus; action duplicates a command; `role=status` | F6 region; Esc does not dismiss; error `role=alert`, else `status` |

Errors never toast.

### 3.13 Settings popover and About dialog

**Settings** is a G2 popover (3.5), bottom-start under the toolbar's More button, where the command is listed. The `settings` action opens it from
anywhere (Ctrl or Cmd and comma, More, the macOS menu bar); a second press leaves it open. Three rows, each a label (meta, 600) over a
**segmented control** with the value chosen: **Theme** System · Light · Dark, **Glass** Auto · Solid (a meta hint says what Solid does), **Language**
System · English · Deutsch (the language names are not translated). The control is a `radiogroup`: a 40 high track (`--radius-button`, 1 px
`--color-divider` border, 4 padding) of equal segments (`--radius-sm`, concentric) in the selected state of 3.0; hover, pressed and focus as for every
control. Keys: the chosen segment is the only tab stop; Left, Right, Up and Down move to the next segment and choose it (wrapping), Home and End
jump; Tab cycles inside the popover; Esc closes and refocuses More. A choice is saved at once (`update_settings`) and applies at once (theme and glass
on `<html>`, language to the UI); a change the backend refuses shows its error under the rows (`role=alert`, `--color-error-text`).

**Author prompt (ADR-034).** The author name is empty by default (placeholder `settings.author.placeholder`, "No author"; no `/T` is written). Before the first
save of a document with annotations, while the name is empty and `authorPrompt` is pending, an inline group appears once in its own slot at the end of the
toolbar row (`glass-1`, Field sm pre-filled with the OS name as suggestion, primary `author.prompt.confirm`, ghost `author.prompt.skip`). Enter confirms, Esc
and Skip keep it empty; the save follows at once; `authorPrompt` becomes done.

**About** is a dialog (`role=dialog`, `aria-modal`): solid `--surface-solid` with `--shadow-3`, `--radius-card`, 320 wide, centred over the
`--color-backdrop` at `--z-modal`. Column, centred, 16 apart: the logo (64), the name (`--text-xl`) over "Version x.y.z" (meta, from `app_ready`; omitted
until known), "Open source under AGPL-3.0-or-later", the privacy line (meta: offline, no telemetry), then a secondary "Third-party licenses" button
(a placeholder until the notices ship, ADR-010 item 8: `aria-disabled`, still focusable, tooltip and `aria-description` "Coming soon") and the primary
"Close", which has the initial focus. Esc (after a tooltip), Close and a press on the backdrop close it; Tab and Shift+Tab cycle inside; the app behind
is `inert` and no command runs while it is open, whichever way it comes (key, native menu, toolbar; one guard in `runAction`), except About, which closes it; focus returns to where it was. In: opacity + scale .96 → 1 as a popover, out: opacity
150; reduced motion: opacity only. Solid mode and forced colors change nothing, the surface is already solid.

### 3.14 Welcome tour (F4, ADR-023)

On first launch a bundled sample, "Welcome to {app}.pdf", opens. Each page holds one task. A coach mark points at the tool,
and a success pulse (MOTION §4.7) ends each step. Code lives in `src/features/tour/` (`steps.json`, the `useTour` engine, `CoachMark`, `TourPill`).

**Steps.** `steps.json` is the single source. The engine imports it, and the generator reads it with `include_str!` (ids, pages,
target rects in pt, `shipped`). The PR that ships a step's tool flips `shipped`.

| # | id | Page | Anchor (phase a → b) | Complete when | Ships |
|---|---|---|---|---|---|
| 1 | open | 1 | status bar file name | the welcome document's `opened` event, after its first frame has faded in (§4.6) | M1 |
| 2 | navigate | 1 | status bar page button | current page (§3.10) ≥ 2 once scrolling settles (500 ms), by any input | M1 |
| 3 | zoom | Z | toolbar zoom in | a zoom-in commits at rest above the zoom at step start (button, keys, wheel, pinch, menu) | M1 |
| 4 | highlight | M | Highlight tool → sentence box | a highlight covers ≥ 50 % of the sentence quad | M2 |
| 5 | comment | M | Comment tool → comment spot | a comment anchored ≤ 24 pt from the spot centre | M2 |
| 6 | sign | S | Signature tool → signature box | a signature's centre lies in the box | M4 |
| 7 | reorder | S | thumbnails toggle → page S's thumbnail | page S precedes page M | M3 |

Unshipped steps do not exist at runtime, and their blocks are not generated, so no page asks for a missing tool. Numbers
count shipped steps only (M1: 1–3). A step completes on its first qualifying event. A state that is already true at the step's start completes it
at once. Phase a anchors the tool (in overflow: More, plus `tour.inMore`). While the tool is active, phase b anchors the canvas
target. Releasing the tool returns to phase a. A step marked `detect: "manual"` shows Next (none through M4).

**Success moment.** `pulse(anchor, t("tour.done"))`: the anchor ring grows and fades (slow), and the card's chip crossfades to
`check` (fast). Hold 1.2 s, then the card exits (fast) and the next card enters at its anchor (base). After the last step the pill
pulses, shows `check` + `tour.complete` for 1.2 s and exits. The last done message appends `tour.toClosing`. Reduced motion and forced colors follow §4.7.

#### Document

Generator: `src-tauri/tests/welcome_document.rs` with `PdfBuilder` (`tests/support/`) writes
`src-tauri/resources/welcome/welcome-{en,de}.pdf` (Tauri resources). The test fails if the committed files differ, and
`UPDATE_WELCOME=1` rewrites them. Strings come from the `welcomePdf.*` and `tour.step.*` keys of the locale files, and `{app}` from `APP_NAME`.
Fonts: `/F1` Helvetica and `/F2` Helvetica-Bold, Type1 Standard 14, WinAnsiEncoding, not embedded. `win_ansi` gains „ “ ” …
(0x84 0x93 0x94 0x85), and any other non-WinAnsi character fails the test. Colours: DeviceRGB from §1.1 only. One axial (Type 2) shading.
Rounded rects are four Béziers (k = .5523). The file has no images, annotations, links, actions or JavaScript. It has `/Info /Title`, catalog
`/Lang` en-US / de-DE, and one outline entry per page.

**Page** 600 × 800 pt (3:4, on the 8 grid), white in both themes. Coordinates here run top-left with y down; the generator
flips them (y_pdf = 800 − y). Margins 48, content 504 = 6 columns of 64 with 24 gutters, baselines on 8. All text is left-aligned
except the badge digit (Helvetica digits are 556/1000 em) and the zoom target text (centred by an average advance of 0.5 em). Strings keep their explicit `\n`;
over-long ones are wrapped greedily at spaces (≤ 64 chars at 12 pt, ≤ 56 at 16 pt). Chip text: `welcomePdf.chip.step` / `welcomePdf.chip.steps`.

| Element | Geometry | Paint | Type |
|---|---|---|---|
| Header band | x 48 y 48, 504 × 128, r 24 | axial iris-500 (48,48) → iris-700 (552,176), clipped | — |
| Step chip | x 72 y 72, 120 × 24, r 12 | iris-100 | F2 10 iris-700, x 84, baseline 88 |
| Page badge | circle (512, 84) r 20 | white | printed number, F2 20 iris-700, centred, baseline 91 |
| Title | x 72, baseline 152 | white (5.37 / 8.85 on the band ends) | F2 28 |
| Instruction | x 48, baseline 216 | ink | F1 16 |
| Task block | x 48, w 504, r 16, from y 248, 24 apart | iris-50, 1 pt iris-200 stroke | label F2 14 ink (top + 32), body F1 12/16 ink-60 |
| Target frame | r 8, 1 pt iris-300, dash [4 4] | — | — |
| Footer | rule y 752, 1 pt ink-30; text x 48, baseline 772 | ink-60 | F1 9, `welcomePdf.footer` |

**Page kinds:**

| Kind | Chip · title · instruction | Task target / content |
|---|---|---|
| W Welcome (steps 1–2) | Steps 1–2 · `p1.title` · `p1.text` | Block "1 Open a PDF" with a done disc (iris-500 r 12, white 2 pt check). Block "2 Go to page 2" with a chevron-down 24 iris-500, centre x 300 |
| N Navigate (no task) | Step 2 · `nav.title` · `nav.text` | Block with three lines `nav.ways` (page number in the status bar, keys, thumbnails; F1 12 ink-60), then a chevron-down and `nav.next` |
| Z Zoom (3) | Step 3 · Zoom in · `p2.text` | A 504 × 160 block with three lines of F1 5 pt ink (`p2.small`), centred (centre 300, 328) inside a dashed target frame of about 176 × 48, unreadable at 100 % |
| M Markup (4–5) | Steps 4–5 · `p3.title` · `p3.text` | Sentence frame y 248, 504 × 56; `p3.sentence` F1 16 ink, x 72, baseline 282. Comment spot: ring (480, 392) r 12, 2 pt iris-500, dot r 4. With S present: `order` note (F1 12 ink-60) in the last block |
| S Sign and sort (6–7) | Steps 6–7 (or the one shipped) · `sign.title` (else `tour.step.reorder.title`) · `sign.text` (else `tour.step.reorder.text`) | Signature frame x 48 y 248, 288 × 96; rule ink-30 y 320, x 72–312; `sign.label` F1 9 ink-60, baseline 336. Reorder block: `tour.step.reorder.text` |
| E Closing (always last) | `chip.done` · `end.title` · `end.text` | Block `end.nextTitle`: `end.next.open`, then one line per shipped cluster (`end.next.markup` M2, `.organize` M3, `.sign` M4). Block `end.restart`. Block `end.keysTitle`: rows 24 apart, key at x 72 (F2 12 ink), action at x 344 (F1 12 ink-60; 240 collides with the German keys), from `steps.json` `closingShortcuts` (open, zoom in/out, next/previous page, settings, plus the letters of shipped tools). Key labels are `welcomePdf.key.*`, and a vitest checks them against `formatBinding` for Windows and macOS |

**Editions** (page order; the printed number is in brackets where it differs from the position):

| Shipped | Pages |
|---|---|
| M1 | W · N · Z · E (4) |
| M2 | W · Z · M · E (4) |
| M3, M4 | W · Z · M [4] · S [3] · E (5) |

N exists only to keep an edition at 4 pages. Kinds with no shipped step are left out. Once reorder ships, M and S
swap places, and their badges and footers print the intended numbers. The task "drag page 3 above page 4" moves S above M, so the
steps still run in order (M, then S), and after the task the printed numbers ascend. E is never involved in the swap.

#### Lifecycle

- **Setting** `welcomeTour: "pending" | "shown"` (default pending; `update_settings` accepts it).
- **First launch:** after `app_ready` and the settings arrive, if the value is pending and no document came with the launch (argv, OS open,
  second instance), the UI writes `shown` *first*, then calls `open_welcome_document()`. That call picks the edition by the
  resolved UI language and opens the resource through the normal intake (hostile-input rules unchanged). It returns
  `DocumentInfo.kind = "welcome"` and the display name `doc.welcomeName`. The document is read-only: Save acts as Save As, and closing discards tour edits without a prompt.
- **Close mid-tour** (Close, or another document opened over it): the tour ends, card and pill exit (fast), and toast
  `tour.closed` shows. Nothing resumes.
- **Skip:** the card's Skip ends the tour, the document stays open, and toast `tour.skipped` shows.
- **Restart:** Settings (§3.13) gains a fourth row: label `settings.tour` (meta 600) over a secondary sm button
  (`settings.tour.start`, or `.restart` while running) and the meta hint. Pressing it closes the popover (focus → More) and closes the open document through
  the normal close flow (cancel = nothing happens). The welcome document then opens fresh at step 1.

**Progress pill** (status bar leading, after the file-name group, gap 16): a sm ghost button, 24 h, radius pill, padding 0 8,
tile colours, `compass` 12 + `tour.pill` in `--text-xs` tabular. Hover, pressed and focus follow §3.0. There is no disabled state: the pill exists only while a tour runs.
Click, Enter or Space toggles the card (`aria-expanded`, `aria-controls`). Name: `tour.pillLabel`. It enters with the document
(base, opacity + translateY 8), and its number crossfades (fast).

#### Coach mark

**Purpose:** one non-modal hint at a time, pointing where the step happens.

**Anatomy:** a G2 card (`--surface-strong`, edge, `--shadow-2`; solid mode `--surface-solid`), radius 16, width 304 (256 when the
canvas is narrower), padding 16, gap 8.
- Header (24): chip `tour.stepOf` (pill, tile colours), spacer, sm IconButton `x` "`tour.hide`".
- Title `--text-md` 600, then the instruction `--text-md`.
- Footer (24, only with actions): ghost sm Skip on the leading side; secondary sm "Show me" or primary sm Next on the trailing side.

The beak is a 16 × 8 triangle of the card's surface and edge, centred on the anchor and ≥ 16 from the corners. The **anchor ring** is the §4.7 ring layer held
at `--pulse-opacity`. On controls it sits at radius + 2, and it gives way to the focus outline while the anchor has focus. On canvas targets it is the target rect + 4, in canvas-local layer 3, `aria-hidden`.

**Slot and layer:** `--z-popover`. The card is clamped to the canvas slot inset 8, so it covers page content only, never the toolbar,
panels, inspector, status bar, its anchor or its target.
- Toolbar anchor: below the toolbar, 8 gap, beak up, centred on the anchor.
- Status anchor: card bottom on the canvas slot's bottom edge, beak down across the 8 gap. It aligns to the anchor's leading
  edge (file name) or trailing edge (page, zoom).
- Canvas target: below the target + 8, else above, else on the trailing side. It follows scroll, zoom and panel slides each frame (transform,
  in a layout effect, MOTION §3). When the target is out of view, the card docks at the canvas top centre without a beak, and "Show me" scrolls to the target (§4.8).
- Coexistence: the anchor's tooltip is suppressed. While a popover, menu or dialog is open the card fades out (fast) and the ring
  stays; it returns afterwards (base). If a toast would meet the card, the toast moves 8 above the card.

**States:**

| State | Treatment |
|---|---|
| entering | opacity + scale .96 from the beak side, base |
| waiting | default |
| done | chip → `check` tile, title `tour.done`, footer hidden, 1.2 s |
| hidden | after Esc, `x` or an open popover; the pill remains |
| docked | target off-screen |
| exiting | opacity, fast |

The card itself has no hover or focus ring; its controls follow §3.0. Buttons are never disabled: an action that does not apply is not offered.

**Keyboard:**
- The card never takes focus on appearing.
- While visible it is an F6 stop right after the toolbar (§2.3). Tab is not trapped; DOM order is hide, Skip, action.
- Esc with focus inside the card hides it and restores the region's last focus. Elsewhere, Esc keeps the §2.3 order (the card is not in
  `DISMISS_PRIORITY`), so releasing a tool never hides a hint.
- The pill's Enter shows the card and focuses its first control.

**Accessibility:**
- `role="region"`, `aria-labelledby` the title. Not a dialog, no `aria-live`.
- Step starts (`tour.announce`) and completions (pulse message) go to the status bar's polite live region.
- While active, the anchor gets `aria-describedby` → the instruction.
- Text on strong: 13.35 / 12.39 (§4). Forced colors: Canvas + 1 px CanvasText, bordered beak, ring and chip `Highlight`.
- Reduced motion: RM fade; the card follows scroll at once.

#### Strings

UI (`tour.*`, `settings.tour*`, `doc.*`); the PDF reuses `tour.step.*` for block labels and bodies.

| Key | en | de |
|---|---|---|
| `tour.region` | Welcome tour | Willkommenstour |
| `tour.pill` | Tour {step} / {total} | Tour {step} / {total} |
| `tour.pillLabel` | Welcome tour, step {step} of {total}. Show hint | Willkommenstour, Schritt {step} von {total}. Hinweis anzeigen |
| `tour.stepOf` | Step {step} of {total} | Schritt {step} von {total} |
| `tour.announce` | Step {step} of {total}: {title}. {text} | Schritt {step} von {total}: {title}. {text} |
| `tour.hide` / `.skip` / `.next` / `.showMe` | Hide hint / Skip tour / Next / Show me | Hinweis ausblenden / Tour überspringen / Weiter / Zeigen |
| `tour.done` | Done: {title} | Erledigt: {title} |
| `tour.complete` | Tour complete | Tour abgeschlossen |
| `tour.toClosing` | The last page has tips and shortcuts. | Die letzte Seite zeigt Tipps und Tastenkürzel. |
| `tour.inMore` | You find it under More. | Sie finden es unter Mehr. |
| `tour.skipped` | Tour skipped. Start it again in Settings. | Tour übersprungen. Neustart in den Einstellungen. |
| `tour.closed` | Tour ended. Start it again in Settings. | Tour beendet. Neustart in den Einstellungen. |
| `tour.step.open.title` / `.text` | Open a PDF / This file opened by itself. Next time: Open… or drop a file. | PDF öffnen / Diese Datei hat sich selbst geöffnet. Künftig: Öffnen… oder Datei ablegen. |
| `tour.step.navigate.*` | Go to page 2 / Scroll down or press Page Down. | Zu Seite 2 / Scrollen Sie nach unten oder drücken Sie Bild ab. |
| `tour.step.zoom.*` | Zoom in / Click + to zoom in. | Vergrößern / Klicken Sie auf +, um zu vergrößern. |
| `tour.step.highlight.*` | Highlight a sentence / Choose Highlight, then drag across the sentence in the frame. | Satz hervorheben / Wählen Sie Hervorheben und ziehen Sie über den Satz im Rahmen. |
| `tour.step.comment.*` | Add a comment / Choose Comment, then click the dot. | Kommentar hinzufügen / Wählen Sie Kommentar und klicken Sie auf den Punkt. |
| `tour.step.sign.*` | Sign / Choose Signature, then drag it into the frame. | Unterschreiben / Wählen Sie Unterschrift und ziehen Sie sie in den Rahmen. |
| `tour.step.reorder.*` | Put pages in order / Open Thumbnails and drag page 4 above page 5. | Seiten ordnen / Öffnen Sie Miniaturen und ziehen Sie Seite 4 über Seite 5. |
| `settings.tour` / `.start` / `.restart` | Welcome tour / Start tour / Restart tour | Willkommenstour / Tour starten / Tour neu starten |
| `settings.tour.hint` | Opens the welcome document. | Öffnet das Willkommensdokument. |
| `doc.welcomeName` | Welcome to {app}.pdf | Willkommen bei {app}.pdf |
| `welcomePdf.chip.step` / `.steps` / `.done` | Step {n} / Steps {a}–{b} / Done | Schritt {n} / Schritte {a}–{b} / Fertig |
| `welcomePdf.footer` | Page {n} of {total} · Welcome to {app} | Seite {n} von {total} · Willkommen bei {app} |
| `welcomePdf.p1.title` / `.text` | Welcome to {app} / Each page is one small task. | Willkommen bei {app} / Jede Seite ist eine kleine Aufgabe. |
| `welcomePdf.p2.text` | Make the small print below easy to read. | Machen Sie die kleine Schrift unten lesbar. |
| `welcomePdf.p2.small` | You found it. Pinch, Ctrl or Cmd + wheel, or the + button all zoom. | Gefunden. Zoomen geht mit zwei Fingern, Strg oder Cmd + Mausrad oder der Taste +. |
| `welcomePdf.p3.title` / `.text` | Mark it up / Highlight the sentence, then comment on the dot. | Markieren / Satz hervorheben, dann den Punkt kommentieren. |
| `welcomePdf.p3.sentence` | Good documents are short, clear and kind. | Gute Dokumente sind kurz, klar und freundlich. |
| `welcomePdf.nav.title` / `.text` | You turned the page / There are more ways to move around. | Seite gewechselt / Es gibt weitere Wege durch ein Dokument. |
| `welcomePdf.nav.ways` | Click the page number below to jump. · Ctrl or Cmd + Down goes to the next page. · Thumbnails show every page. | Klicken Sie unten auf die Seitenzahl, um zu springen. · Strg oder Cmd + Ab führt zur nächsten Seite. · Miniaturen zeigen jede Seite. |
| `welcomePdf.nav.next` | Next up: zoom. | Als Nächstes: Zoomen. |
| `welcomePdf.order` | Page numbers out of order? Step {n} fixes that. | Seitenzahlen durcheinander? Schritt {n} behebt das. |
| `welcomePdf.end.title` / `.text` | You're all set / Here is what to try next. | Alles erledigt / Das können Sie als Nächstes tun. |
| `welcomePdf.end.nextTitle` / `.keysTitle` | What next / Shortcuts | Wie weiter / Tastenkürzel |
| `welcomePdf.end.next.open` | Open your own PDF: Open… or drop a file on the window. | Eigene PDF öffnen: Öffnen… oder Datei auf das Fenster ziehen. |
| `welcomePdf.end.next.markup` / `.organize` / `.sign` | Highlight, comment and draw on any PDF. / Sort, rotate and delete pages. / Sign with a drawn, typed or image signature. | Markieren, kommentieren und zeichnen. / Seiten ordnen, drehen und löschen. / Unterschreiben: gezeichnet, getippt oder als Bild. |
| `welcomePdf.end.restart` | Restart this tour any time: Settings, then Welcome tour. | Tour jederzeit neu starten: Einstellungen, dann Willkommenstour. |
| `welcomePdf.key.open` / `.zoom` / `.page` / `.settings` | Ctrl+O / Cmd+O · Ctrl+Plus / Ctrl+Minus (Cmd on Mac) · Ctrl+Down / Ctrl+Up (Cmd on Mac) · Ctrl+Comma / Cmd+Comma | Strg+O / Cmd+O · Strg+Plus / Strg+Minus (Cmd am Mac) · Strg+Ab / Strg+Auf (Cmd am Mac) · Strg+Komma / Cmd+Komma |
| `welcomePdf.keyAction.open` / `.zoom` / `.page` / `.settings` | Open a file · Zoom in and out · Next and previous page · Settings | Datei öffnen · Vergrößern und verkleinern · Nächste und vorige Seite · Einstellungen |
| `welcomePdf.sign.title` / `.text` / `.label` | Sign and sort / Sign in the frame, then move this page up. / Signature | Unterschreiben und ordnen / Im Rahmen unterschreiben, dann Seite nach oben schieben. / Unterschrift |

### 3.15 Outline panel (M1)

**Purpose:** the file's bookmarks as a tree in the left panel's Outline tab (`list-tree`, §3.6); a row jumps to its place.
Code `src/features/outline/`; data `getOutline` (`src/api/outline.ts`): ≤ 10 000 nodes, depth ≤ 32, titles ≤ 512 chars, target page id + y or `null`.

**Data.** Fetched when the tab is first shown, kept until close or revert. Titles are untrusted: a text node only, never markup or a
link; an empty title shows `outline.untitled` (muted). One flat index per load (parent, depth, `posinset`/`setsize`) plus targets
sorted by (page index, y) for the current-section lookup (binary search).

**Anatomy.** Header per §3.6: title row "Outline" + sm IconButton `chevrons-down-up` (`outline.collapseAll`). Body: `role=tree`,
padding 8, rows per §3.9 (32 h, radius 8, padding 0 8 0 4):
- Indent `--outline-indent` 16 × (level − 1), capped at `--outline-indent-max` 64 (level 5); deeper levels share it, `aria-level` stays exact.
- Disclosure slot 24: `chevron-right` 16, rotates 90° when expanded (mirrored in RTL); leaves keep the empty slot so titles align.
  The chevron is not a separate tab stop; clicking it toggles without jumping.
- Title `--text-md`, one line, end ellipsis, gap 4. When truncated, the tooltip (§3.4, right of the panel) shows the full title,
  wrapped, at most 8 lines.
- Current marker: a 2 × 16 `--color-accent` pill, inset 2 on the leading edge, inside the row.

**States**

| State | Treatment |
|---|---|
| default | `--color-text` on G1 |
| hover / pressed | §3.0 fill; no scale (full-width row) |
| focus-visible | §3.0 ring, radius 8 |
| selected | §3.0 selected (last activated row, `aria-selected`); one at a time |
| current | marker + `aria-current="location"`: the last node in document order whose target is at or before the reading position (current page §3.10, viewport top y); inside a collapsed branch, its nearest visible ancestor. Recomputed 150 ms after scrolling settles; the tree never expands or scrolls by itself while reading |
| no target | title `--color-text-muted`, `aria-description` `outline.noTarget`; a parent still expands; a leaf has `aria-disabled` (focusable) |

**Initial expansion.** Top level shown; the ancestors of the current node expanded; a single top-level parent expanded too. The total
revealed is capped at 200 rows (the current branch wins, then document order). Expansion is per document, in memory, kept across
tab switches. On first show the current row is scrolled into view (nearest, at once).

**Keyboard** (WAI-ARIA tree, one tab stop, roving): Up/Down previous/next visible row, no wrap · Right: collapsed → expand,
expanded → first child · Left: expanded → collapse, else → parent · Home/End first/last visible row · `*` expands the siblings
(within the 200-row cap) · type-ahead: printable keys build a 500 ms buffer, focus moves to the next visible row whose title
starts with it (case-insensitive, locale compare, wraps) · Enter/Space: target → jump and select; no target → toggle. Focus stays
in the tree after a jump; F6 reaches the canvas.

**Virtualization.** Visible rows = a flat list from the index and the expanded set (memoized). Fixed 32 px rows: only the viewport ± 8
rows are mounted between two spacers; the focused row stays mounted off-screen. Treeitems carry `aria-level`, `aria-setsize`,
`aria-posinset`, and `aria-expanded` on parents. A 10 000-node outline keeps the MOTION §5 budget.

**Jump.** The target y lands at the canvas `scroll-padding-top` (24), per MOTION §4.8 (≤ 2 viewports spring slow, farther at once +
§4.3 fades; paged modes crossfade). The status bar announces the page as usual.

**Empty, loading, error** (centred column at body top, padding 24, gap 8):
- Empty: `list-tree` 16 in a 32 tile (radius 8), `outline.empty` (`--text-md` 600), `outline.emptyHint` meta.
- Loading: nothing for 300 ms, then a 16 spinner + `outline.loading` meta (`role=status`); no skeleton, no shimmer.
- Error: bare `circle-alert` in `--color-error-text`, `outline.error`, secondary sm `outline.retry`; `role=alert`.

**Motion.** Chevron rotate fast; revealed rows fade in (opacity, fast); collapse in one step. Layout never animates (MOTION §3).
**Reduced motion:** chevron and rows at once; jumps at once.

**Mood (§1.10).** Rows sit on the panel's G1 tint; no per-row glass. Accent only for the marker, the selected ring and focus; the
empty tile uses tile colours. Solid mode changes nothing beyond the panel surface.

**Forced colors.** Selected: 2 px `Highlight` border (§3.0); the marker is a 2 px `Highlight` inline-start border; chevrons
`CanvasText`; no-target leaves `GrayText`.

**Tokens (new, §1.9 test):** `--outline-indent` 16, `--outline-indent-max` 64.

| Key | en | de |
|---|---|---|
| `outline.label` | Outline | Gliederung |
| `outline.collapseAll` | Collapse all | Alle einklappen |
| `outline.untitled` | Untitled | Ohne Titel |
| `outline.noTarget` | No destination in this document | Kein Ziel in diesem Dokument |
| `outline.empty` / `.emptyHint` | This document has no outline / Bookmarks saved in the file appear here. | Dieses Dokument hat keine Gliederung / Lesezeichen aus der Datei erscheinen hier. |
| `outline.loading` | Loading outline… | Gliederung wird geladen… |
| `outline.error` / `.retry` | Couldn't read the outline. / Try again | Gliederung konnte nicht gelesen werden. / Erneut versuchen |

### 3.16 Search panel (M1)

**Purpose:** find text in the open document; the left panel's Search tab (`search`, §3.6). Code `src/features/search/`. Rust searches page by page,
streams hits (page, char range, quads, snippet) and cancels on every new query. Query ≤ 256 chars; hits capped at 10 000.

**Anatomy** (header per §3.6, title "Search"):
- Query field: full width, md 32, Field styles (§3.7); leading `search` 16 muted, trailing sm `x` (`search.clear`, shown when non-empty, `tabindex=-1`).
- Option row, 8 below: sm toggle IconButtons `case-sensitive` (`search.matchCase`) and `whole-word` (`search.wholeWord`), `aria-pressed`.
- Status row, 32 h: count meta (`tabular-nums`) | spacer | sm `chevron-up` / `chevron-down` (previous / next). While running: `search.progress` and a
  2 h pill bar (`--color-track`, fill accent) under the row.
- Hit list, `role=listbox`: page header rows 24 h (`search.page`, meta 600, not focusable, never sticky); hit rows 48 h, radius 8, padding 8:
  snippet `--text-sm`, ≤ 2 lines, ≤ 40 chars of context each side, match 600 + `--color-selected` fill radius 4. Snippets are text nodes only.
  Virtualized as §3.15 (fixed heights).

**Lifecycle.** Typing searches after 250 ms idle from 2 chars; Enter searches 1 char at once. Hits appear as pages finish; the first
hit becomes active without scrolling the canvas. Options rerun the query. Results live until the query is cleared or the document closes.

**Canvas.** Hits draw in the text layer (§3.17, below the glyph spans): every hit `--color-doc-hit` (.28), radius 2; the active hit adds a
2 px `--color-doc-select` outline. Hits stay while the panel is collapsed; clearing the query removes them.

**States** (centred column per §3.15): empty query: `search` tile, `search.empty` + `search.emptyHint` · no result: `search.none`
+ `search.noneHint` · no text layer anywhere: `search.noText` · failed: `circle-alert`, `search.error`, secondary sm `search.retry`, `role=alert`.

**Keyboard.** Primary+F opens the tab, focuses and selects the field. In the field: Enter next, Shift+Enter previous, Down enters the
list, Esc clears a non-empty field. Anywhere with hits: primary+G / primary+Shift+G (Windows also F3 / Shift+F3), wrapping. List: roving
Up/Down over hit rows, Enter or click makes the hit active and jumps (target quad at `scroll-padding-top`, MOTION §4.8); focus stays.

**A11y.** Status row is a polite live region: the final count once, then `search.position` per step. Rows `aria-selected` = active hit,
named by page + snippet. **Reduced motion:** jumps at once; the progress bar has no transition.
**Forced colors:** hits `Highlight` (§1.9), active hit 2 px `CanvasText` outline.

| Key | en | de |
|---|---|---|
| `search.label` / `.placeholder` | Search / Find in document | Suche / Im Dokument suchen |
| `search.clear` | Clear search | Suche löschen |
| `search.matchCase` / `.wholeWord` | Match case / Whole words | Groß-/Kleinschreibung / Ganze Wörter |
| `search.count` | {n} results on {p} pages (10 000+ when capped) | {n} Treffer auf {p} Seiten |
| `search.progress` | Searching… page {i} of {n} | Suche… Seite {i} von {n} |
| `search.page` | Page {n} | Seite {n} |
| `search.position` | Result {i} of {n}, page {p} | Treffer {i} von {n}, Seite {p} |
| `search.empty` / `.emptyHint` | Search this document / Results appear here, grouped by page. | Dieses Dokument durchsuchen / Treffer erscheinen hier, nach Seiten gruppiert. |
| `search.none` / `.noneHint` | No results for "{q}" / Check the spelling or turn off the options. | Keine Treffer für „{q}“ / Schreibweise prüfen oder Optionen ausschalten. |
| `search.noText` | This document has no searchable text. | Dieses Dokument enthält keinen durchsuchbaren Text. |
| `search.error` / `.retry` | Search failed. / Try again | Suche fehlgeschlagen. / Erneut versuchen |

### 3.17 Text layer (M1)

**Purpose:** select and copy page text. One layer per mounted page (canvas-local layer 2), above the bitmap, same box as the page.

**Anatomy.** Rust returns text runs (string, quad, char range) per page in content order; each run is a transparent span scaled to its
quad (`color: transparent`, never visible). Search hits (§3.16) sit beneath the spans. No per-glyph DOM.

**States.** Select tool only (other tools: `pointer-events: none`). Cursor `text` over runs, `default` between, `pointer` over links
(§3.21). Selection `--color-doc-text-select` (.30) via `::selection`, both themes (pages are white). Disabled: page not yet rendered;
no text: the layer is empty and the cursor stays `default`.

**Keyboard.** Canvas focused: primary+C copies the selection; primary+A selects all text on the current page (§3.10), never the
whole document; Esc clears it (last in the §2.3 Esc order). Shift+arrows are the browser's. Copy goes through Rust (`get_text`,
by char range) so ligatures and hyphens come out as plain text; the frontend writes the clipboard, text only.

**Rotation.** The layer takes the same transform as its page (file `/Rotate` + view rotation, §3.20) so runs stay on their glyphs.
Selection follows content order, not screen geometry: a drag on a rotated page selects the same text as on the upright page.
Hit-testing maps the pointer into page space once per move.

**A11y.** The run text is real DOM text in content order; each page is `role=group` named "Page n of m" (replacing `role=img` once
the layer exists). Pages without text keep `role=img` + `text.noText` description.
**Reduced motion / forced colors:** nothing moves; selection becomes `Highlight` (§1.9).

| Key | en | de |
|---|---|---|
| `text.copied` (polite live) | Copied | Kopiert |
| `text.noText` | No text on this page | Kein Text auf dieser Seite |

### 3.18 Document tabs (M1)

**Slot.** A new grid row `tabs` between toolbar-row and banner (§2): 0 with no document, else 32 + 8 gap below. Columns
`8 | strip 1fr | 8 | overflow 24 | 8`. It is on `--color-bg`, no surface, and its empty part is a drag region like the toolbar row. It
appears in one step with the first document (no height animation); nothing else shares it.

**Anatomy (tab).** 32 h, 120–240 w (`--tab-min` / `--tab-max`, equal shares), radius 12, padding 0 4 0 12, gap 8: `file-text` 16 muted |
name `--text-md`, middle-truncated, full name in the tooltip | trailing 24 slot: sm `x` (`tabs.close`, `tabindex=-1`), or an 8 px accent
dot when edited and not hovered/focused. Tabs gap 4.

| State | Treatment |
|---|---|
| default | text on bg |
| hover / pressed | §3.0 (no scale) |
| focus-visible | §3.0 ring, radius 12 |
| selected | G1 (`--surface` + edge, no shadow) + text; solid mode: `--surface-fallback` + divider edge |

**Overflow.** At `--tab-min` the strip scrolls horizontally (wheel, Shift+wheel, keyboard follow), no scrollbar; 16 px mask fades at
clipped edges. The overflow sm IconButton `chevron-down` (`tabs.all`) appears only then: a menu of all documents, checked = active.

**Behaviour.** Click selects; middle-click or `x` closes; closing the active tab selects its right neighbour, else left; the last close
returns to the empty state. Primary+W closes the active document. Ctrl+Tab / Ctrl+Shift+Tab cycle on both platforms (Cmd+Tab is the
macOS app switcher), plus Cmd+Shift+] / [ on macOS and Ctrl+PageDown / PageUp on Windows. **No drag reorder in M1** (decided:
no keyboard equivalent yet; recorded in DECISIONS). The welcome document (§3.14) is an ordinary tab named by its title; closing it
follows §3.14 Lifecycle. Each tab keeps its own page, zoom, rotation, panel tab and search.

**Keyboard / A11y.** `role=tablist` (`tabs.label`), roving Left/Right (wrap), automatic activation, Delete closes the focused tab;
`aria-controls` the canvas. Edited state in `aria-description`. F6 order: toolbar → tabs → banner → … (§2.3).
**Motion.** A new tab fades in (fast); a closing tab fades out (fast) and the others reflow at once. Selected fill does not slide.
Reduced motion: opacity only. **Forced colors:** selected = 2 px `Highlight` border.

**Tokens (new):** `--tabs-row-height` 32, `--tab-min` 120, `--tab-max` 240.

| Key | en | de |
|---|---|---|
| `tabs.label` | Open documents | Geöffnete Dokumente |
| `tabs.close` | Close {name} | {name} schließen |
| `tabs.all` | All open documents | Alle geöffneten Dokumente |
| `tabs.edited` | Edited | Bearbeitet |

### 3.19 Password prompt (M1)

**Purpose:** open an encrypted PDF that needs a user password. Owner-only protection opens without prompting.

**Anatomy.** Dialog as About (§3.13: solid, `--shadow-3`, `--radius-card`, backdrop, `--z-modal`), 400 w (`--dialog-width`), padding 24,
left-aligned: `lock` 16 in a 32 tile | title `password.title` `--text-xl`; 8 below `password.body` muted; 16 below the label
(meta 600) and a full-width md field (`type=password`, `autocomplete=off`, `spellcheck=false`) with a trailing sm toggle `eye` / `eye-off`
(`password.show`, `aria-pressed`); error line slot (16 h, reserved, so nothing jumps); 24 below, trailing: secondary `password.cancel`, primary `password.open`.

**States.** Empty field: Open `aria-disabled`. Checking: Open shows a 16 spinner, field read-only. Wrong: field `aria-invalid`,
`circle-alert` 12 + `password.wrong` in `--color-error-text` (`role=alert`), field text selected; no shake. Each retry after the third
waits 1 s (Rust-side). Corrupt or unsupported encryption: the dialog closes and the error banner (§3.12) explains.

**Security.** The password crosses IPC once per attempt, is never stored, logged, or put in settings or recents, and the field is cleared
when the dialog closes. Session-only: reopening asks again.

**Keyboard.** Initial focus: the field. Enter submits; Esc or Cancel closes, nothing opens, focus returns to the trigger. Tab cycles inside.
**Motion** as About; reduced motion opacity only.

| Key | en | de |
|---|---|---|
| `password.title` | Password required | Passwort erforderlich |
| `password.body` | "{name}" is protected. Enter its password to open it. | „{name}“ ist geschützt. Geben Sie das Passwort ein, um es zu öffnen. |
| `password.label` / `.show` | Password / Show password | Passwort / Passwort anzeigen |
| `password.wrong` | Wrong password. Try again. | Falsches Passwort. Bitte erneut versuchen. |
| `password.cancel` / `.open` | Cancel / Open | Abbrechen / Öffnen |

### 3.20 Go to page and view rotation (M1)

**Go to page.** The status bar page button (§3.10) opens a `role=dialog` popover (§3.5) above it (top-start, flips): label
`goto.label` meta 600; row: md Field (56) | `goto.of` meta | primary sm `goto.go`. The field opens holding the current page,
selected. Enter or Go jumps (MOTION §4.8) and closes; Esc closes. Input outside 1…n: `aria-invalid` + `goto.invalid` in
`--color-error-text` below, popover stays. Action `go-to-page`: primary+Shift+N, More "Go to page…", macOS menu.

**View rotation.** Rotates every page of the active document by 90° for viewing only; the file is untouched (page rotation that saves
is M3 Organize). Per tab, in memory. Commands: `rotate-view-right` `rotate-cw` primary+R, `rotate-view-left` `rotate-ccw` primary+L,
`rotate-view-reset`; they live in More → "Rotate view" submenu and the macOS View menu. While rotation ≠ 0, the status bar shows a
sm ghost button `rotate-cw` 12 + "90°" before the page button; it resets (`aria-label` `rotate.reset`).
The reading position (current page, its relative y) is kept; fit modes recompute. Motion: the canvas crossfades (base), pages never spin;
reduced motion: at once. A polite announcement `rotate.announce`.

| Key | en | de |
|---|---|---|
| `goto.label` / `.of` / `.go` | Go to page / of {n} / Go | Gehe zu Seite / von {n} / Los |
| `goto.invalid` | Enter a number from 1 to {n}. | Geben Sie eine Zahl von 1 bis {n} ein. |
| `rotate.menu` / `.right` / `.left` | Rotate view / Rotate right / Rotate left | Ansicht drehen / Nach rechts drehen / Nach links drehen |
| `rotate.reset` / `.announce` | Reset rotation / View rotated {deg}° | Drehung zurücksetzen / Ansicht um {deg}° gedreht |

### 3.21 Link confirmation and XFA banner (M1)

**Links.** Internal links (GoTo) jump without asking. A URI link opens a dialog first; nothing leaves the app without a click.
Rust validates: scheme `http`, `https` or `mailto` only, ≤ 2048 chars, IDN hosts shown as punycode, no credentials in the URL.

**Anatomy.** Dialog as §3.19, 400 w: `external-link` 16 tile | `link.title`; `link.body` muted; the target in a `--surface-solid` box
with 1 px divider border, radius 8, padding 8, `--text-md`, `overflow-wrap: anywhere`, ≤ 6 lines then scrolls; scheme + host
600, rest regular. Buttons: ghost `link.copy` (leading) · secondary `link.cancel` · primary `link.open`. Blocked scheme or invalid
URL: title `link.blockedTitle`, body `link.blocked`, target shown, only `link.close`.

**Keyboard.** Initial focus Cancel (safe default); Enter on Open opens via the OS (`open_url` in Rust) and closes; Esc cancels. Copy
gives a `text.copied` announcement, dialog stays. No "don't ask again".

**XFA banner.** When Rust reports XFA, a warning banner (§3.12): bare `triangle-alert` in `--color-warning-text`, `xfa.message`,
optional `x` (`xfa.dismiss`, hides it for this document's session). `role=status`, F6 region; per tab, so switching tabs swaps it.

| Key | en | de |
|---|---|---|
| `link.title` / `.body` | Open external link? / This link leads outside {app}: | Externen Link öffnen? / Dieser Link führt aus {app} heraus: |
| `link.open` / `.cancel` / `.copy` / `.close` | Open / Cancel / Copy link / Close | Öffnen / Abbrechen / Link kopieren / Schließen |
| `link.blockedTitle` / `.blocked` | Link not opened / {app} opens only web and email links. | Link nicht geöffnet / {app} öffnet nur Web- und E-Mail-Links. |
| `xfa.message` | This form uses XFA, which {app} can't show. You see its fallback pages, which may be incomplete. | Dieses Formular nutzt XFA, das {app} nicht anzeigen kann. Angezeigt werden Ersatzseiten, die unvollständig sein können. |
| `xfa.dismiss` | Dismiss | Ausblenden |

**Tokens (new):** `--dialog-width` 400 (§3.19, §3.21).

### 3.22 Annotation tools (M2)

**Purpose:** the Markup cluster of §3.3 grows to five tools; variants stay out of split buttons (§3.3).

| Tool | Lucide (follows variant) | Key | Variants (inspector, remembered) | Cursor |
|---|---|---|---|---|
| Highlight | `highlighter` · `underline` · `strikethrough` | H | Highlight, Underline, Strikethrough | `text` over runs, else `crosshair` (drag a rect) |
| Note | `message-square` | C | — | `crosshair` |
| Text comment | `type` | T | — | `crosshair` |
| Draw | `pen-line` | D | — | `crosshair` |
| Shapes | `square` · `circle` · `minus` · `move-up-right` | R | Rectangle, Ellipse, Line, Arrow | `crosshair` |

**Variant.** The last variant per family is stored in the `tools` store presets (persisted). Pressing the tool's key while it is active
cycles its variants; the toolbar icon, tooltip and `aria-label` name the current variant ("Underline (H)"). The inspector shows the
variant as a segmented control (§3.13) atop Tool options.

**Modes** per §3.3: click = one-shot, double-click or Shift+Enter locks, Esc or a click on the locked tool → Select. One-shot ends
after one commit; Draw groups strokes that start ≤ 1000 ms apart into one Ink annotation (one `coalesce_key`), then returns.

**States.** §3.0 plus active and locked (§3.3). No document or a read-only document: tools `aria-disabled`, tooltip says why.
Overflow: Markup never collapses (§3.3); the toolbar adds 80 px, so Pages collapses first.

**Keyboard.** Letters work only while the canvas has focus and never in a text field (§2.4); every tool is a registry action
(`tool-highlight` …), so the tooltip chip, `aria-keyshortcuts` and the macOS Tools menu agree. With a tool active, Enter on the
focused canvas places a default-size annotation at the viewport centre (keyboard path for Note, Text, Shapes; Highlight uses the
text selection, §3.17: H with selected text marks it at once).

**A11y.** Polite live `tool.announce` on change. **Motion:** §4.1 tool on; reduced motion unchanged (no transform).

| Key | en | de |
|---|---|---|
| `tool.highlight` / `.underline` / `.strike` | Highlight / Underline / Strikethrough | Hervorheben / Unterstreichen / Durchstreichen |
| `tool.note` / `.text` / `.draw` | Note / Text comment / Draw | Notiz / Textkommentar / Zeichnen |
| `tool.shapes` / `.rect` / `.ellipse` / `.line` / `.arrow` | Shapes / Rectangle / Ellipse / Line / Arrow | Formen / Rechteck / Ellipse / Linie / Pfeil |
| `tool.announce` | {tool} tool{locked, select, true { , locked} other {}} | Werkzeug {tool}{locked, select, true { , fixiert} other {}} |
| `tool.readOnly` | This document can't be edited. | Dieses Dokument kann nicht bearbeitet werden. |

### 3.23 Annotations on the canvas (M2)

**Slot.** The annotation overlay is canvas-local layer 3 (§1.7): one SVG per mounted page, same box and transform as the page (§3.17
Rotation). Clean annotations are in the bitmap; the overlay draws drafts, edited annotations and all selection chrome. Search hits
stay in layer 2; the **active** hit's outline is redrawn in layer 3 so a filled shape never hides it. Popovers sit at `--z-popover`.

**Anatomy.** Selection = bounding box 2 px `--color-doc-select`, 2 outside the shape; handles `--handle-size` 8, **round** (`--radius-pill`), page-surface fill, 2 px
`--color-doc-select` ring, hit area 24; hover/press fill `--color-doc-select`; while the item has keyboard focus the ring is `--color-focus`.
Never square. Boxes and ellipses: 8 handles; Line/Arrow: 2 endpoints; Ink: 4 corners; Highlight family and
Note: box only (no resize).

| State | Treatment |
|---|---|
| default | as in the file |
| hover (Select tool) | 1 px `--color-doc-hover` box; cursor `move` (handles: the resize cursor of their edge) |
| selected | box + handles |
| focus-visible | §3.0 ring around the box (offset 2), plus the selection |
| dragging | the overlay moves the draft; the bitmap copy is hidden (`pageRev`, ARCHITECTURE Annotate) |
| locked / read-only | box without handles, cursor `default` |

**Move/resize.** 4 px drag threshold; clamped to the page box; Shift keeps aspect (resize) or axis (move). One `apply_command` on
pointerup. Click selects, Shift- or primary-click toggles in the selection; a drag on empty page area in Select tool selects text, not annotations.

**Keyboard.** Each annotation is a tab stop after the canvas region, page then reading order (top-left first); F6 skips them.
Focus selects; Shift+Space adds the focused one. Arrows nudge 1 pt (Shift 10), Alt+arrows resize the trailing/bottom edge;
nudges coalesce for 500 ms into one undo step. Delete/Backspace deletes (announced, Undo toast §3.12); Enter edits (§3.25);
Esc clears the selection (§2.3 order).

**A11y.** `role=button`, `aria-roledescription` = type (`tool.*`), `aria-pressed` = selected, name `annot.name`.
**Motion:** none; the canvas never animates (§2.4). **Forced colors:** box and handle borders `Highlight`, handle fill `Canvas` (hover `Highlight`).

**Tokens (new):** `--handle-size` 8, `--color-doc-hover` `rgba(91,91,214,.50)` both themes.

| Key | en | de |
|---|---|---|
| `annot.name` | {type} by {author}, page {n}{text, select, none {} other {: {text}}} | {type} von {author}, Seite {n}{text, select, none {} other {: {text}}} |
| `annot.deleted` | {type} deleted | {type} gelöscht |

### 3.24 Properties inspector (M2)

**Slot:** the inspector (§2, §3.9), 288. Header: type ("Highlight"), `inspector.items`, or `inspector.toolOptions` with the tool name.
Sections 16 apart, divider between, each a label (meta 600) over its control. Tool options edit presets; a selection edits itself.

**Colour.** Annotation colours are document content (ADR-011 §9): the eight Okabe-Ito colours, the same in both themes (pages are white),
`--annot-yellow #F0E442` · `-orange #E69F00` · `-vermillion #D55E00` · `-purple #CC79A7` · `-blue #0072B2` · `-sky #56B4E9` ·
`-green #009E73` · `-black #000000`. One row: 8 swatches `--swatch-size` 24 circles, gap 8, 1 px inset `--color-control-border`.
Selected = `check` 12 (white on dark swatches, ink on light) + 2 px `--color-focus` ring offset 2: never colour alone. Second row
"Recent": the last 4 colours read from the file that are not in the palette (a file may hold any colour); hidden when none.
`radiogroup`, roving arrows (wrap), names in tooltip + `aria-label`. Defaults: Highlight yellow, Underline/Strike vermillion, Note
yellow, Text black, Draw and Shapes blue.

**Stroke** (Draw, Shapes): segmented 1 · 2 · 4 · 8 pt, each segment a line of that weight + `aria-label`. **Opacity:** Slider + field
(§3.7), 10–100 %, step 5. **Font size** (Text): md Field 56 + sm `chevron-down` menu of 8 10 12 14 18 24 36; range 6–144 pt;
Helvetica only in M2.

**Live edit.** Slider drags preview in the overlay and commit on release; other controls commit at once; one undo step each.

**Multi-selection.** Only sections every selected type has. Differing values: no swatch checked and meta `inspector.mixed`; the field
shows `inspector.mixed` as placeholder. A change applies to all as one command (one undo step).

**Empty state** (Select tool, nothing selected, inspector open): centred column per §3.15, `sliders-horizontal` tile,
`inspector.empty` + `inspector.emptyHint`.

**A11y / motion.** Never takes focus (§3.9); F6 region. Panel motion MOTION §4.2. **Forced colors:** swatches keep their colour
(`forced-color-adjust: none`) with a 1 px `CanvasText` ring; selected adds a 2 px `Highlight` ring.

| Key | en | de |
|---|---|---|
| `inspector.toolOptions` / `.items` | Tool options: {tool} / {n} items | Werkzeugoptionen: {tool} / {n} Elemente |
| `inspector.colour` / `.recent` / `.stroke` / `.opacity` / `.fontSize` | Colour / Recent / Line width / Opacity / Font size | Farbe / Zuletzt / Linienstärke / Deckkraft / Schriftgröße |
| `colour.*` | Yellow, Orange, Vermillion, Purple, Blue, Sky blue, Green, Black | Gelb, Orange, Zinnoberrot, Purpur, Blau, Himmelblau, Grün, Schwarz |
| `inspector.mixed` | Mixed | Gemischt |
| `inspector.empty` / `.emptyHint` | Nothing selected / Select an annotation or pick a tool to see its options. | Nichts ausgewählt / Wählen Sie eine Anmerkung oder ein Werkzeug, um Optionen zu sehen. |

### 3.25 Note popover and free-text editing (M2)

**Note anchor.** A 24 × 24 (`--note-icon`, in points, scales with zoom; hit area ≥ 24 px) icon in the note's colour on the page.
Click, Enter or a new note opens its popover.

**Popover.** G2 `role=dialog` (§3.5), `--note-width` 280, right-start of the anchor, 8 offset, flips; it closes when the anchor scrolls out.
Anatomy, gap 8: header row 32: author `--text-md` 600 · date meta (`Intl` medium date + short time) · spacer · sm `ellipsis` menu
(`note.delete`, `note.copy`) · sm `x`. Body: autosizing textarea, Field styles, 3–10 lines then scrolls. Replies (`/IRT`) below a
divider: author/date line + text, read-only for others, editable for the own. Footer: field `note.replyPlaceholder`; primary sm
`note.reply`, `aria-disabled` while empty.

**Author** comes from the new Settings row "Author name" (§3.13), default the OS account's display name (read in Rust). Text is plain;
file text renders as text nodes only.

**Editing.** A new note opens with focus in the body. The body commits on blur or close (one coalesced undo step); a new note closed
empty is removed without an undo entry. Primary+Enter posts a reply; Enter is a newline. Esc closes and refocuses the anchor. Tab cycles inside.

**Free text.** Text comment tool (en "Text comment", de "Textkommentar"; tooltip hint `toolbar.tool.text.hint`): a click places a 160 pt box (drag sets the width) and enters editing; on an existing one, double-click or Enter.
Editing is a textarea in layer 3 exactly over the box, font size × zoom, 1 px dashed `--color-doc-select`; width fixed, height grows.
Esc or a click outside commits; empty → removed. Primary+Z inside the field is the field's own undo.

**Motion.** Popover per §3.5; reduced motion opacity only. **Forced colors:** popover `Canvas` + `CanvasText` border.

**Tokens (new):** `--note-icon` 24, `--note-width` 280.

| Key | en | de |
|---|---|---|
| `note.label` | Note by {author} | Notiz von {author} |
| `note.delete` / `.copy` | Delete note / Copy text | Notiz löschen / Text kopieren |
| `note.replyPlaceholder` / `.reply` | Reply… / Reply | Antworten… / Antworten |
| `settings.author` | Author name | Name des Autors |

### 3.26 Comments panel (M2)

**Purpose:** every markup annotation (not links, popups, widgets) of the document, in the left panel's Comments tab (§3.6).

**Anatomy.** Title row "Comments" + sm IconButtons `list-filter` (filter popover, pressed while a filter is on) and `arrow-down-up`
(sort menu). Under it, when filtered, meta `comments.filtered`. Body: `role=tree` as §3.15 (virtualized, fixed heights).
- Group header rows 24 (`search.page`, meta 600, not focusable) when sorted by page.
- Root row 64, radius 8, padding 8: colour dot 8 + type icon 16 + author 600 + date meta; excerpt `--text-sm`, 2 lines, ellipsis.
- Replies: level 2, rows 48, indent 16; the root shows `comments.replies` and the §3.15 chevron.

**Filter** (role=dialog popover): checkbox groups Type and Author (from the document), ghost `comments.reset`. **Sort** (menu, checked):
Page (default), Newest, Oldest. Both per tab, in memory.

**Behaviour.** Live from ChangeSets. Enter or click jumps (MOTION §4.8), selects the annotation on the canvas and keeps focus in the
panel; the row of a canvas selection becomes `aria-selected` and scrolls into view (nearest). Delete deletes (§3.23).

**States.** Empty: `messages-square` tile, `comments.empty` + `.emptyHint`. Filtered empty: `comments.noMatch` + ghost `comments.reset`.
Loading/error as §3.15. Keyboard: §3.15 tree keys.

**A11y.** Rows named by `annot.name` + reply count. **Motion:** §3.15. **Forced colors:** dots keep their colour + `CanvasText` ring.

| Key | en | de |
|---|---|---|
| `comments.label` | Comments | Kommentare |
| `comments.filter` / `.sort` / `.reset` | Filter / Sort / Reset filter | Filtern / Sortieren / Filter zurücksetzen |
| `comments.type` / `.author` | Type / Author | Typ / Autor |
| `comments.byPage` / `.newest` / `.oldest` | Page / Newest first / Oldest first | Seite / Neueste zuerst / Älteste zuerst |
| `comments.filtered` | {shown} of {total} | {shown} von {total} |
| `comments.replies` | {n, plural, one {# reply} other {# replies}} | {n, plural, one {# Antwort} other {# Antworten}} |
| `comments.empty` / `.emptyHint` | No comments yet / Notes, highlights and drawings appear here. | Noch keine Kommentare / Notizen, Markierungen und Zeichnungen erscheinen hier. |
| `comments.noMatch` | No comments match the filter. | Keine Kommentare entsprechen dem Filter. |

### 3.27 Undo, Save and unsaved changes (M2)

**Undo/Redo.** Toolbar cluster before More: IconButtons `undo-2` / `redo-2`, `aria-disabled` when the history is empty; tooltips name
the step (`history.undo`). Overflow moves them into More first. Keys: primary+Z, primary+Shift+Z; Windows also Ctrl+Y. In a text
field the field's native undo wins. Polite live `history.undone` / `.redone`. Per document (Rust history, ADR-003).

**Unsaved indicator.** Tab dot (§3.18), status bar "Edited" badge (§3.10), `aria-description` `tabs.edited`; macOS also marks the
window edited (dot in the close button) while any tab is edited.

**Save.** Primary+S saves in place; primary+Shift+S opens Rust's Save As dialog (no path reaches the UI). Both in More and the macOS File
menu. A document that cannot be written in place (welcome, read-only) saves as Save As. While saving: status "Saving…" (§3.10); done:
success pulse "Edited" → "Saved" (MOTION §4.7); failure: error banner (§3.12) with `save.saveAs`. Errors never toast.

**Close with changes.** Closing an edited tab or quitting opens a dialog as §3.19 (400 w): `save` tile | `save.title`; `save.body`
muted; buttons ghost `save.discard` (leading) · secondary `save.cancel` · primary `save.save`. Initial focus Save; Enter saves, Esc
cancels. Quitting walks the edited documents one by one, activating each tab; the title adds `save.count`. Cancel stops the quit.
Motion as About.

| Key | en | de |
|---|---|---|
| `history.undo` / `.redo` | Undo {step} / Redo {step} | {step} rückgängig / {step} wiederholen |
| `history.undone` / `.redone` | Undone: {step} / Redone: {step} | Rückgängig: {step} / Wiederholt: {step} |
| `save.save` / `.saveAs` / `.saved` | Save / Save As… / Saved | Speichern / Speichern unter… / Gespeichert |
| `save.title` / `.count` | Save changes to "{name}"? / ({i} of {n}) | Änderungen an „{name}“ speichern? / ({i} von {n}) |
| `save.body` | Your changes are lost if you don't save them. | Ihre Änderungen gehen verloren, wenn Sie sie nicht speichern. |
| `save.discard` / `.cancel` | Don't Save / Cancel | Nicht speichern / Abbrechen |
| `save.failed` | Couldn't save "{name}". | „{name}“ konnte nicht gespeichert werden. |

### 3.28 Organize mode (M3)

**Purpose:** reorder, rotate, delete, insert and extract pages on a grid. Pages (`tool-pages`, P) is a mode, not one-shot: it
ends with Done, P, Esc (tool level, §2.3) or Enter on a page; the viewer returns at the focused page (§4.6 clone from the cell).

**Slot.** The grid replaces the canvas in its track (`<main>`, radius 16, `--color-canvas`). The left panel collapses (layout
collapse) and returns on exit. Inspector: closed in `auto`; `open` shows the selection read-only. Read-only file: Pages `aria-disabled`.

**Anatomy.** Top, inset 8: organize bar, G1 40 h per §3.3: `rotate-ccw` · `rotate-cw` · `trash-2` | `file-plus` Insert menu ·
`file-output` Extract… · `scissors` Split… | spacer | Slider + Field `organize.size` (`--grid-thumb` 96–256, step 32, persisted) |
primary sm `organize.done`. Below, the grid scrolls: padding 24, gap 24. Cell: square `--grid-thumb` box, thumbnail centred,
radius 4, `--page-shadow`; 8 below the §3.9 pill: label, plus number when different ("iii · 3"). Hover: §3.0 fill behind the
cell (radius 8, padding 4); selected §3.0; focus ring radius 8.

**Selection.** Click; primary+click toggles; Shift+click ranges; primary+A; a drag on empty space draws a marquee (1 px accent).
Commands act on the selection, else the focused page.

**Drag.** After 4 px the selection lifts into a drag card (MOTION §4.5 lift, follows the pointer, `--z-drag`, ≤ 3 stacked
thumbnails + count badge); sources fade to .4. An insertion marker, 2 px accent pill of cell height (`--insert-marker`), sits in
the nearest gap; edges auto-scroll. Drop: FLIP reflow (base); Esc: card returns. Reduced motion: no lift, no FLIP.

**Commands** (one undo step each). Rotate: primary+L / R (view rotation off here). Delete: no confirm, toast `organize.deleted`
+ Undo; never the last page. Insert (blank, sized like its neighbour; or from file, Rust's Open dialog) goes after the focused page,
else at the end; inserted pages become the selection and pulse (§4.7).

**Keyboard / A11y.** `role=listbox` `aria-multiselectable`, roving 2D arrows, Space toggles, Shift+arrows extend, Alt/Option+arrows
move the selection (ADR-016 amendment). Options `organize.page`; changes announced politely. Forced colors: `Highlight`.

| Key | en | de |
|---|---|---|
| `organize.done` / `.insert` | Done / Insert | Fertig / Einfügen |
| `organize.blank` / `.fromFile` | Blank page / Pages from file… | Leere Seite / Seiten aus Datei… |
| `organize.size` / `.page` | Thumbnail size / Page {label} ({n} of {total}) | Miniaturgröße / Seite {label} ({n} von {total}) |
| `organize.deleted` | {n, plural, one {Page deleted} other {# pages deleted}} | {n, plural, one {Seite gelöscht} other {# Seiten gelöscht}} |
| `organize.moved` | Moved to position {n} | An Position {n} verschoben |

### 3.29 Merge (M3)

**Suggestion.** Dropping two or more PDFs (window or empty state) opens nothing yet: an info banner (§3.12) `merge.suggest` with
primary sm `merge.merge` and secondary sm `merge.tabs`; its `x` drops the files. Non-modal: the open document stays usable; a new
drop replaces the banner. One PDF opens as today. Also More / macOS File: "Merge files…" (sheet with the active document first).

**Sheet.** Dialog as §3.19, 560 w (`--sheet-width`), padding 24: `files` tile | `merge.title` `--text-xl`; 16 below a list
(`role=listbox`, max 6 rows visible, then scrolls): rows 56 per §3.11 recents: `grip-vertical` 16 | thumbnail 32 × 40 | name over meta
`merge.meta` | sm `x` (`merge.remove`). Under it secondary sm `merge.add` (Rust Open dialog) and meta `merge.total`. Footer
trailing: secondary `merge.cancel`, primary `merge.merge`.

**Reorder.** Pointer drag on a row with the §3.28 drag card (one row) and a horizontal 2 px marker in the 8 px row gap; keys:
Alt/Option+Up/Down move the focused row (announced `organize.moved`). An encrypted file asks §3.19 when added; a broken one shows
`circle-alert` + `merge.unreadable` and blocks Merge until removed. Fewer than two files: Merge `aria-disabled`.

**Result.** Merge shows a 16 spinner, then the sheet closes and a new tab `merge.untitled` opens, unsaved (edited dot); Save goes
to Save As. Failure: error banner. Motion as About; reduced motion opacity only.

| Key | en | de |
|---|---|---|
| `merge.suggest` | Merge {n} files into one document? | {n} Dateien zu einem Dokument zusammenführen? |
| `merge.merge` / `.tabs` | Merge… / Open as tabs | Zusammenführen… / Als Tabs öffnen |
| `merge.title` / `.add` / `.remove` | Merge files / Add files… / Remove {name} | Dateien zusammenführen / Dateien hinzufügen… / {name} entfernen |
| `merge.meta` / `.total` | {pages} pages · {size} / {n} pages in total | {pages} Seiten · {size} / {n} Seiten insgesamt |
| `merge.unreadable` / `.cancel` / `.untitled` | Can't read this file / Cancel / Merged document | Datei nicht lesbar / Abbrechen / Zusammengeführtes Dokument |

### 3.30 Split and Extract (M3)

**Entry.** Organize bar Split… / Extract…, More "Split…" / "Extract pages…", macOS File menu. Extract in Organize with a
selection goes straight to Rust's Save As (default name `split.extractName`); everywhere else it opens this dialog on Extract.

**Dialog** as §3.19, 480 w (`--dialog-width-md`): `scissors` tile | `split.title`. A segmented control (§3.13, 32 h) `split.every` ·
`split.ranges` · `split.extract`, then the field slot:
- Every: md Field N (1 … n − 1, default 1), meta `split.pages`.
- Ranges / Extract: full-width md text field, placeholder `split.placeholder`; commas separate, `8-` runs to the end; ranges may
  not exceed n. Validation 150 ms after typing: `aria-invalid` + `split.invalid` in the reserved 16 px error slot.

**Preview** (`role=status`, polite): meta `split.preview` with the first three ranges, "…" after. **Naming** (Every, Ranges): text
field `split.naming`, default `{name}-{n}`, tokens `{name}` `{n}` `{pages}`; meta example `split.example`. Footer: secondary Cancel,
primary `split.split` (Rust's native folder dialog, then write) or `split.save` (Save As). The UI never sees a path; Rust never
overwrites (adds " (2)").

**Progress.** Primary shows a spinner; > 1 s, a progress bar (4 h pill, `--color-track`, accent fill, `role=progressbar`) with
Cancel. Done: dialog closes, toast `split.done` + `split.show` (OS file manager). Errors: banner. Reduced motion: bar steps.

| Key | en | de |
|---|---|---|
| `split.title` / `.every` / `.ranges` / `.extract` | Split or extract / Every N pages / By ranges / Extract | Teilen oder extrahieren / Alle N Seiten / Nach Bereichen / Extrahieren |
| `split.pages` / `.placeholder` | pages per file / e.g. 1-3, 5, 8- | Seiten pro Datei / z. B. 1-3, 5, 8- |
| `split.invalid` | Use pages 1 to {n}, e.g. 1-3, 5, 8-. | Seiten 1 bis {n} verwenden, z. B. 1-3, 5, 8-. |
| `split.preview` | {n, plural, one {Creates 1 file} other {Creates # files}}: {ranges} | {n, plural, one {Erzeugt 1 Datei} other {Erzeugt # Dateien}}: {ranges} |
| `split.naming` / `.example` | File names / e.g. {example} | Dateinamen / z. B. {example} |
| `split.split` / `.save` / `.extractName` | Split… / Save As… / {name} pages {range} | Teilen… / Speichern unter… / {name} Seiten {range} |
| `split.done` / `.show` | {n} files saved / Show in folder | {n} Dateien gespeichert / Im Ordner zeigen |

### 3.31 Compress (M3)

**Entry.** More "Compress…" and macOS File menu (`compress`, `file-archive`). Dialog as §3.19, 480 w: `file-archive` tile |
`compress.title`; meta `compress.now`.

**Presets** (`role=radiogroup`, roving Up/Down, selection follows focus): three rows 64, radius 12, padding 12, §3.0 selected:
name 600 over description meta, trailing estimate `--text-sm` tabular. Default Balanced, last choice persisted.

| Preset | Images | Description key |
|---|---|---|
| Small | 96 dpi, JPEG q 50 | `compress.smallHint` |
| Balanced | 150 dpi, q 70 | `compress.balancedHint` |
| High quality | 220 dpi, q 85 | `compress.highHint` |

All presets also recompress streams losslessly and drop unused objects. **Estimate:** Rust samples pages on open; until then a 12
spinner; then `compress.estimate`; under 5 % gain `compress.little`.

**After** (radio pair): `compress.openNew` (default) · `compress.saveAs`. Footer: Cancel, primary `compress.go`.

**Progress.** Body keeps its height; the presets yield to a progress bar (§3.30) + meta `compress.progress`; Cancel stays and
stops the job (nothing changes). Done: a new unsaved tab `compress.untitled`, or Rust's Save As; toast `compress.done`. Result
not smaller: nothing opens, meta `compress.noGain` in place, Close. Errors: banner. Motion as About; reduced motion opacity only.

| Key | en | de |
|---|---|---|
| `compress.title` / `.now` | Compress / Now {size} | Komprimieren / Aktuell {size} |
| `compress.small` / `.balanced` / `.high` | Small / Balanced / High quality | Klein / Ausgewogen / Hohe Qualität |
| `compress.smallHint` / `.balancedHint` / `.highHint` | For email; images look softer / Good for most uses / For print; smaller savings | Für E-Mail; Bilder weicher / Für die meisten Zwecke / Für den Druck; spart weniger |
| `compress.estimate` / `.little` | ≈ {size} (−{pct} %) / Little to gain | ≈ {size} (−{pct} %) / Kaum Ersparnis |
| `compress.openNew` / `.saveAs` / `.go` | Open as new document / Save as file… / Compress | Als neues Dokument öffnen / Als Datei speichern… / Komprimieren |
| `compress.progress` / `.done` | Page {i} of {n} / Compressed to {size} | Seite {i} von {n} / Auf {size} komprimiert |
| `compress.untitled` / `.noGain` | {name} (compressed) / This file can't be made smaller. | {name} (komprimiert) / Diese Datei lässt sich nicht verkleinern. |

**Tokens (new, §3.28–§3.31):** `--grid-thumb` 160 (96–256), `--insert-marker` 2, `--sheet-width` 560, `--dialog-width-md` 480.

### 3.32 Form filling (M4)

**Purpose:** fill AcroForm fields in place under Select and Form (F). Form also focuses the first empty field and shows the form's Tool
options (highlight toggle, Flatten). XFA stays §3.21. Field scripts and format actions never run (SECURITY); values are stored as typed.

**Slot.** One HTML control per widget in layer 3 (§3.23), exactly over its rect; font = the field's size × zoom (auto size fits the
height), Helvetica fallback. Rust regenerates appearances on commit. A document with fields shows the status bar pill `form.badge`
(§3.10) and, once per session, an info banner (§3.12) `form.banner` with secondary sm toggle `form.highlight` (`aria-pressed`) + `x`.

**Highlight.** `--color-doc-field` over fillable widgets (setting `formHighlight`, default on; banner, Tool options, More). Required:
plus 1 px `--color-doc-required` border (shape, not colour alone), `aria-required`, tooltip `form.required`. Read-only: no tint, a
text node with `aria-readonly`, cursor `default`.

| State | Treatment |
|---|---|
| hover | `--color-doc-field-hover` |
| focus | 2 px `--color-doc-select` ring, offset 2 (document layer, both themes) |
| read-only document | every field as read-only; Form `aria-disabled` |

**Controls.** Text: single-line `<input>`, multi-line `<textarea>` scrolling inside its rect; `/MaxLen` → `maxlength` (`form.maxLength`
announced once); comb fields one character per cell; password flag → `type=password`. Checkbox/radio: the file's on/off appearance;
Space toggles; a radio group is one `radiogroup`, arrows move and select. Combo: `chevron-down` trigger opening a §3.5 menu (current
checked); editable combos keep a text input. List: inline `listbox` (multi when flagged) if rows reach 24 px at zoom, else the menu.

**Order.** Tab/Shift+Tab follow the page's `/Tabs` (else rows, top-left first), pages in order, fields before annotations. Rust
supplies the order, so an unmounted page scrolls into view (nearest, at once). Past the last field, Tab leaves the canvas.

**Commit.** Text on blur or Enter (single line); toggles and choices at once; one undo step per field.

**Flatten.** Form Tool options and More `form.flatten` (macOS Edit menu). Dialog §3.19: `stamp` tile | `form.flattenTitle`;
`form.flattenBody` muted; secondary Cancel (initial focus), primary `form.flattenGo`. Undoable until saved.

**Motion:** none on the canvas. **Forced colors:** tint none, 1 px `CanvasText` border, required 2 px, focus `Highlight`.

| Key | en | de |
|---|---|---|
| `form.badge` / `.banner` | Form / This document has fields you can fill in. | Formular / Dieses Dokument enthält ausfüllbare Felder. |
| `form.highlight` / `.required` | Highlight fields / Required | Felder hervorheben / Pflichtfeld |
| `form.maxLength` | Maximum {n} characters | Höchstens {n} Zeichen |
| `form.flatten` / `.flattenGo` | Flatten form… / Flatten | Formular reduzieren… / Reduzieren |
| `form.flattenTitle` / `.flattenBody` | Flatten form? / Fields become fixed page content. You can undo until you save; after saving it is permanent. | Formular reduzieren? / Felder werden fester Seiteninhalt. Bis zum Speichern rückgängig zu machen, danach endgültig. |

### 3.33 Signature creation sheet (M4)

**Entry.** Sign popover (§3.34), library (§3.35). Dialog as §3.29 but 696 w (`--sheet-width-wide`: the pad plus padding), padding 24: `signature` tile | `sign.createTitle` or
`sign.createInitials`. 16 below, a segmented tablist (§3.6, 32 h): Draw `pen-line` · Type `type` · Image `image` (last persisted).
Every panel fills the same 200 h slot (`--sig-pad-height`), so switching never resizes.

**Draw.** Pad: white in both themes (document surface), 1 px `--color-divider`, radius 12, 600 w (`--sig-pad-width`; initials 200 × 200,
centred). Baseline 1 px `--ink-30` at 72 % height; meta `sign.here` centred until the first stroke. Ink (ADR-051, `features/signatures/ink`): centripetal Catmull-Rom centreline, width from velocity (fast thin, slow thick, 0.45–1.5 × the
3 px nominal, eased) plus pen `pressure` when reported (mouse: neutral); round caps; the outline is cubic Béziers. The pad is SVG (sharp at
any devicePixelRatio, no backing store) and the live stroke uses the same function as the saved art, redrawn once per animation frame.
Rust validates and stores the Bézier paths. Below: colour radiogroup of two §3.24 swatches (`--annot-black`
default, `--annot-blue`) | spacer | ghost sm `eraser` `sign.clear` (label "New": clears the pad; a real button, so Tab and Enter/Space work). Primary+Z removes the last stroke. Pad `role=img`
`sign.padLabel`; meta `sign.keyboardHint`.

**Type.** md Field, full width, prefilled with the author name (§3.13), ≤ 64 chars. Below: radiogroup of up to four 248 × 64 cards
(2 × 2, gap 16) rendering the text per font, §3.0 selected; same swatches. **Fonts: system only, none bundled** (OFL is outside rule 2).
Rust offers installed fonts from an allowlist (macOS Snell Roundhand, Bradley Hand, Apple Chancery, Noteworthy; Windows Segoe Script,
Ink Free, Segoe Print, Lucida Handwriting), skipping any whose OS/2 `fsType` is restricted; none → UI font italic. Text becomes
outlines; no font is embedded.

**Image.** secondary `sign.choose` → Rust Open dialog (PNG, JPEG). Rust decodes as hostile input (≤ 10 MB, ≤ 4096 px), trims
margins, scales to ≤ 1024 px; the UI gets a preview, never a path. Error in a reserved 16 px slot (`sign.badImage`). No background removal.

**Footer.** Leading checkbox `sign.save` (default on; `aria-disabled` + `lib.noKeychain` when §3.35 says so); trailing secondary
Cancel, primary `sign.create` (`aria-disabled` while empty). From the popover, Create arms placement (§3.34).

**Keyboard.** Initial focus: tablist; Tab cycles; Esc cancels. Motion as About; reduced motion opacity only. **Forced colors:** pad
`Canvas` + `CanvasText` border; ink keeps its colour.

| Key | en | de |
|---|---|---|
| `sign.createTitle` / `.createInitials` | Create signature / Create initials | Unterschrift erstellen / Initialen erstellen |
| `sign.draw` / `.type` / `.image` | Draw / Type / Image | Zeichnen / Tippen / Bild |
| `sign.here` / `.clear` / `.padLabel` | Sign here / New / Signature pad | Hier unterschreiben / Neu / Unterschriftenfeld |
| `sign.keyboardHint` | Can't draw? Use Type. | Zeichnen nicht möglich? Nutzen Sie Tippen. |
| `sign.choose` / `.badImage` | Choose image… / Use a PNG or JPEG under 10 MB. | Bild auswählen… / PNG oder JPEG unter 10 MB verwenden. |
| `sign.save` / `.create` | Save to library / Create | In Bibliothek speichern / Erstellen |

### 3.34 Placing signatures and Fill & Sign (M4)

**Popover.** Signature (S, §3.3) opens a `role=menu` popover (§3.5, 280 w):
1. Signatures, then Initials: rows 48, thumbnail 96 × 32 (`--sig-thumb`) on a white chip, radius 4, + name; session-only entries add
   meta `sign.session`. A kind without entries shows `sign.add` / `sign.addInitials` (opens §3.33).
2. Divider; rows 32: `calendar` `sign.date` · `type` `sign.text` · `check` `sign.check` · `x` `sign.cross` · `dot` `sign.dot`.
3. Divider; `sign.manage` (§3.35).

**Placing.** An item arms the tool (§3.3 one-shot/lock). Over a page a ghost at default size follows the pointer at .5 opacity in
layer 3, cursor `copy`; a click places it centred on the pointer, clamped to the page. Enter on the focused canvas places at the
viewport centre (§3.22); Esc disarms. Defaults: signature 36 pt high, initials 24 pt, text/date 12 pt Helvetica, marks 12 × 12 pt.

**Editing.** Placed items are selected (§3.23; round handles, Iris ring). Vector art is drawn as SVG `<path d>` (Béziers), the picture as the 1 024 px frame. Signatures, initials, marks: 4 corner handles, aspect always locked. Text, Date: 2 side
handles (width); editing as §3.25 free text. Move, nudge, delete, undo per §3.23. Stored as annotations; Flatten (§3.32) bakes them.

**Inspector.** Colour (§3.24): drawn/typed ink black or blue; image none; marks and text the full palette. Date: segmented
`sign.short` · `sign.medium` · `sign.long`, `Intl.DateTimeFormat` with the OS region (from Rust), not the UI language; today's
date at placement, then static text. Font size (Text, Date) per §3.24.

**States.** No document or read-only: S `aria-disabled` (§3.22). A signature field (`/FT /Sig`) shows `signature` 16 centred in its
tint; a click places the default signature fitted into its rect (visual only; no digital signature in M4).

**A11y.** Items named `sign.item`; placed items `aria-roledescription` = kind, announced `sign.placed`. **Motion:** popover §3.5;
canvas none.

| Key | en | de |
|---|---|---|
| `sign.add` / `.addInitials` / `.manage` | Add signature… / Add initials… / Manage signatures… | Unterschrift hinzufügen… / Initialen hinzufügen… / Unterschriften verwalten… |
| `sign.date` / `.text` / `.check` / `.cross` / `.dot` | Date / Text / Check mark / Cross / Dot | Datum / Text / Häkchen / Kreuz / Punkt |
| `sign.short` / `.medium` / `.long` | Short / Medium / Long | Kurz / Mittel / Lang |
| `sign.item` / `.placed` | {kind}: {name} / {kind} placed on page {n} | {kind}: {name} / {kind} auf Seite {n} platziert |
| `sign.session` | This session only | Nur diese Sitzung |

### 3.35 Signature library (M4)

**Entry.** Sign popover `sign.manage`, More "Signatures…". Dialog as §3.19, 480 w: `signature` tile | `lib.title`.

**List.** Groups `lib.signatures`, `lib.initials` (header rows 24, meta 600). Rows 56, radius 12, padding 8 (§3.11): thumbnail
120 × 40 (`--sig-thumb-lg`) white chip | name 600 over meta `lib.meta` | sm `pencil` `lib.rename` | sm `trash-2` `lib.delete`.
≤ 8 per kind (then Add `aria-disabled`, `lib.full`). Below: secondary sm `sign.add`, `sign.addInitials`. Scrolls after 6 rows.

**Rename.** The name becomes an sm Field in place, selected; Enter or blur commits (1–40 chars), Esc reverts. Defaults "Signature 1".

**Delete.** No confirm: the row turns into meta `lib.deleted` + ghost sm `lib.undo` for 8 s (`role=status`); toasts sit below the
modal layer, so Undo stays in the row. Closing commits.

**Empty.** Centred per §3.15: `signature` tile, `lib.empty` + `lib.emptyHint`, primary `sign.add`.

**Storage note.** Footer meta with `lock` 12: `lib.encrypted`. Entries are encrypted at rest in app data; the key lives in the OS
keychain (macOS Keychain, Windows Credential Manager). Never in settings, logs or recents; nothing leaves the device.

**Keychain unavailable.** A warning group in its own slot above the list (bare `triangle-alert` in `--color-warning-text`,
`lib.noKeychain`, `role=status`); `sign.save` off and `aria-disabled`; new entries are session-only (`sign.session`). Stored entries
that can't be decrypted are hidden; `lib.locked` + ghost `lib.reset` (deletes them after a §3.19 confirm).

**Keyboard.** Initial focus first row; roving Up/Down, Home/End; Enter places (closes, arms §3.34); F2 renames; Delete deletes; Tab
reaches row buttons and footer. Motion as About; reduced motion opacity only. **Forced colors:** chips `Canvas` + `CanvasText` border.

| Key | en | de |
|---|---|---|
| `lib.title` / `.signatures` / `.initials` | Signatures / Signatures / Initials | Unterschriften / Unterschriften / Initialen |
| `lib.meta` / `.rename` / `.delete` | {source} · added {date} / Rename / Delete | {source} · hinzugefügt {date} / Umbenennen / Löschen |
| `lib.deleted` / `.undo` / `.full` | {name} deleted / Undo / Library full (8) | {name} gelöscht / Rückgängig / Bibliothek voll (8) |
| `lib.empty` / `.emptyHint` | No saved signatures / Create one to sign documents faster. | Keine gespeicherten Unterschriften / Erstellen Sie eine, um schneller zu unterschreiben. |
| `lib.encrypted` | Stored encrypted on this device. | Verschlüsselt auf diesem Gerät gespeichert. |
| `lib.noKeychain` | The system keychain isn't available, so signatures can't be saved. They're forgotten when {app} closes. | Der Systemschlüsselbund ist nicht verfügbar; Unterschriften können nicht gespeichert werden und gehen beim Beenden von {app} verloren. |
| `lib.locked` / `.reset` | Some saved signatures can't be unlocked. / Remove them | Einige Unterschriften lassen sich nicht entsperren. / Entfernen |

**Tokens (new, §3.32–§3.35):** `--color-doc-field` `rgba(91,91,214,.10)`, `--color-doc-field-hover` `.18`, `--color-doc-required`
`#D64B4B` (both themes, ≥ 3:1 on white), `--sig-pad-height` 192, `--sig-pad-width` 512, `--sig-thumb` 96 × 32, `--sig-thumb-lg` 120 × 40.

### 3.36 Insert text and image (M5)

**Purpose:** add new page content: a text box or a PNG/JPEG image. Unlike the Text comment annotation (§3.22, T) it is not a comment and
never appears in Comments (§3.26); storage per ADR-047.

**Toolbar.** New cluster **Edit** after Fill & Sign (§3.3): `text-cursor` `insert.text` "Insert text" / "Text einfügen" (E; tooltip hint `insert.text.hint`) · `image-plus` `insert.image` (I) · `crop`
`crop.tool` (K, §3.37). Modes per §3.3 (one-shot / locked). Overflow order becomes Undo/Redo, Pages, **Edit**, Fill & Sign, zoom.
No document, read-only, or edit not permitted (§3.39): `aria-disabled`, tooltip `tool.readOnly`. More gains (after Stamp): Redact…
(§3.38), Protect… (§3.39), Document properties… (§3.40).

**Text.** Cursor `crosshair`; a click places a 160 pt box (a drag sets the width) and enters editing. Editing as §3.25 free text
(textarea in layer 3 over the box, font size × zoom, 1 px dashed `--color-doc-select`, width fixed, height grows; Esc or a click
outside commits; empty → removed). Selected: §3.23 box + 2 side handles (width); double-click or Enter edits. Fonts: the standard
Helvetica, Times, Courier, not embedded, WinAnsi only (as ADR-041); an unsupported character keeps the box in editing with
`insert.charset` in `--color-error-text` below it (`role=alert`).

**Image.** Arming opens Rust's Open dialog (PNG, JPEG) first; Cancel returns to Select. Rust decodes as hostile input (≤ 20 MB,
≤ 8192 px; else error banner `insert.badImage`); the UI gets a preview, never a path. A ghost at default size (half the page width,
natural aspect) follows the pointer at .5 opacity in layer 3, cursor `copy`; a click places it centred and clamped, a drag draws its
size. Selected: 4 corner handles, aspect locked; with `insert.lockAspect` off, 4 side handles join.

**Inspector** (Tool options or selection, §3.24). Text: Font segmented `insert.sans` · `insert.serif` · `insert.mono`; Font size
§3.24 (default 12); Colour §3.24 swatches (default black); Align segmented `align-left` · `align-center` · `align-right`. Image:
checkbox `insert.lockAspect` (on), Opacity §3.24. Multi-selection per §3.24.

**Keyboard / A11y.** Enter on the focused canvas places at the viewport centre (§3.22). Move, nudge, delete, undo per §3.23.
`aria-roledescription` `insert.textRole` / `.imageRole`; placing announces `insert.placed`. **Motion:** canvas none; inspector §3.24.
**Forced colors:** per §3.23.

| Key | en | de |
|---|---|---|
| `insert.text` / `.image` | Add text / Add image | Text hinzufügen / Bild hinzufügen |
| `insert.sans` / `.serif` / `.mono` / `.font` / `.align` | Sans / Serif / Mono / Font / Alignment | Serifenlos / Serif / Monospace / Schrift / Ausrichtung |
| `insert.lockAspect` | Keep proportions | Proportionen beibehalten |
| `insert.textRole` / `.imageRole` / `.placed` | Text box / Image / {kind} added on page {n} | Textfeld / Bild / {kind} auf Seite {n} hinzugefügt |
| `insert.charset` | This character can't be used here. Remove "{char}". | Dieses Zeichen ist hier nicht möglich. Entfernen Sie „{char}“. |
| `insert.badImage` | Couldn't add the image. Use a PNG or JPEG under 20 MB. | Bild konnte nicht hinzugefügt werden. PNG oder JPEG unter 20 MB verwenden. |

### 3.37 Crop mode (M5)

**Purpose:** set the visible area (CropBox) of pages. Crop hides content, it does not remove it (`crop.hides` points to Redact).

**Mode.** Crop (K) is a mode like Pages (§3.28): it ends with Apply, Cancel, K or Esc (tool level). While active the canvas shows
Single page (restored after; Next/Previous page turn), and the inspector track opens at any width as in `open` (the previous
`ui.inspector` returns on exit); the left panel's layout collapse (§2) keeps the canvas ≥ 360.

**Canvas** (layer 3, current page): crop rect 2 px `--color-doc-select`, 8 handles (§3.23, hit 24); outside it
`--color-doc-crop-shade`. Default rect = the current CropBox. Drag inside moves, handles resize, a drag on the shade draws a new
rect; Shift keeps aspect; minimum 72 × 72 pt, clamped to the MediaBox; cursors per §3.23.

**Inspector**, header `crop.title`, sections per §3.24:
1. `crop.margins`: 2 × 2 grid, gap 8; each a label (meta) over md Field 56 + unit meta: Top, Bottom, Left, Right. Unit mm or in from
   the OS measurement system (Rust), step 0.5 mm / 0.02 in, arrows step, Shift × 10. Field and rect are one value: Enter or blur
   moves the rect, dragging updates the fields. Too small: `aria-invalid` + `crop.tooSmall` in the reserved 16 px slot.
2. `crop.applyTo` (`radiogroup`): `crop.current` (default) · `crop.all` · `crop.range` + full-width md field (syntax and
   `split.invalid` per §3.30). Margins apply as distances on every page; differing sizes add meta `crop.sizes`.
3. `info` 12 + meta `crop.hides`.

Footer, fixed at the panel foot (padding 8, divider above): secondary sm `crop.reset` (back to the MediaBox) | spacer | secondary sm
`crop.cancel` · primary sm `crop.apply`. Apply is one undo step, ends the mode, and pulses the affected thumbnails (MOTION §4.7,
message `crop.done`).

**Keyboard.** The rect is a focusable `role=group` named `crop.rectLabel`; arrows move 1 pt (Shift 10), Alt+arrows resize the
trailing/bottom edge (§3.23); Enter applies; F6 reaches the inspector. **Motion:** shade opacity fast; inspector MOTION §4.2;
reduced motion opacity only. **Forced colors:** rect `Highlight`; shade keeps its fill (`forced-color-adjust: none`).

| Key | en | de |
|---|---|---|
| `crop.tool` / `.title` / `.rectLabel` | Crop / Crop pages / Crop area, page {n} | Zuschneiden / Seiten zuschneiden / Zuschnittbereich, Seite {n} |
| `crop.margins` / `.top` / `.bottom` / `.left` / `.right` | Margins / Top / Bottom / Left / Right | Ränder / Oben / Unten / Links / Rechts |
| `crop.applyTo` / `.current` / `.all` / `.range` | Apply to / This page / All pages / Pages | Anwenden auf / Diese Seite / Alle Seiten / Seiten |
| `crop.tooSmall` / `.sizes` | The area must be at least 1 inch on each side. / Pages differ in size; the same margins apply to each. | Der Bereich muss je Seite mindestens 2,54 cm groß sein. / Seiten sind unterschiedlich groß; für jede gelten dieselben Ränder. |
| `crop.hides` | Cropping hides content but keeps it in the file. Use Redact to remove it. | Zuschneiden blendet Inhalte aus, entfernt sie aber nicht. Zum Entfernen „Schwärzen“ verwenden. |
| `crop.reset` / `.cancel` / `.apply` / `.done` | Reset / Cancel / Apply / {n, plural, one {Page cropped} other {# pages cropped}} | Zurücksetzen / Abbrechen / Anwenden / {n, plural, one {Seite zugeschnitten} other {# Seiten zugeschnitten}} |

### 3.38 Redaction (M5)

**Purpose:** remove content permanently in two steps: **mark** (reviewable, undoable) and **apply**.

**Entry.** More and macOS Tools menu `redact.tool` (`square-slash`); in Search (§3.16) the status row gains a sm IconButton
`square-slash` `redact.searchAll` before the chevrons while hits exist. Redact is a mode (ends with Esc at tool level or Done).
Marks live per tab in memory, never in the file. While a tab holds marks and the mode is off, a warning banner (§3.12) says
`redact.pending` with secondary sm `redact.review`; saving is allowed and the banner stays.

**Marking.** Cursor `text` over runs (a text drag marks the runs' quads), else `crosshair` (drag a rect, ≥ 4 pt). A mark in layer 3:
2 px `--color-doc-redact` border over the `--color-doc-redact-fill` hatch (pattern, not colour alone). Select, move, resize, delete
per §3.23 (area marks 8 handles, text marks box only). `redact.searchAll` marks every hit (≤ 10 000) as one undo step and opens the mode.

**Inspector**, header `redact.title`: list (`role=listbox`, virtualized, roving) grouped by `search.page` headers 24; rows 48, radius
8, padding 8: `text` or `square` 16 + excerpt `--text-sm` (2 lines) or `redact.area` | sm `x` `redact.remove` (hover/focus,
`tabindex=-1`). Enter or click jumps (MOTION §4.8) and selects the mark; Delete removes it. Below: checkbox `redact.metadata` (on).
Footer fixed as §3.37: ghost sm `redact.clear` | spacer | primary sm `redact.apply` (`aria-disabled` at 0). Empty: `square-slash`
tile, `redact.empty` + `redact.emptyHint` (§3.15 column).

**Apply dialog** as §3.19, 480 w: bare `triangle-alert` 16 in `--color-warning-icon` centred in 32 | `redact.confirmTitle`; body
`--text-md`: `redact.confirmBody`, then meta `redact.pages`. Initial focus secondary `redact.cancel`; primary `redact.go`. Progress
as §3.31 (bar + `redact.progress`; Cancel changes nothing).

**Success.** The dialog closes, marks become solid black boxes, the affected thumbnails and the "Edited" badge pulse (MOTION §4.7,
message `redact.done`), toast `redact.done` with `redact.undo` (one step until saved). The pending banner goes. Saving after
redaction is a full rewrite without earlier revisions (ADR-047, SECURITY).

**A11y.** Marks `aria-roledescription` `redact.mark`; count changes polite. **Motion:** none on the canvas; dialog as About.
**Forced colors:** mark border `Highlight`, hatch kept (`forced-color-adjust: none`).

| Key | en | de |
|---|---|---|
| `redact.tool` / `.title` / `.mark` | Redact… / {n, plural, one {1 mark} other {# marks}} / Redaction mark | Schwärzen… / {n, plural, one {1 Markierung} other {# Markierungen}} / Schwärzungsmarkierung |
| `redact.searchAll` / `.area` / `.remove` | Mark all results for redaction / Area / Remove mark | Alle Treffer zum Schwärzen markieren / Bereich / Markierung entfernen |
| `redact.pending` / `.review` | {n} redaction marks are not applied yet. / Review | {n} Schwärzungen sind noch nicht angewendet. / Prüfen |
| `redact.metadata` / `.clear` / `.apply` | Also remove document metadata / Clear all / Apply… | Auch Dokument-Metadaten entfernen / Alle löschen / Anwenden… |
| `redact.empty` / `.emptyHint` | No marks / Drag over text or an area, or mark search results. | Keine Markierungen / Über Text oder einen Bereich ziehen oder Suchtreffer markieren. |
| `redact.confirmTitle` | Redact permanently? | Endgültig schwärzen? |
| `redact.confirmBody` | Marked content is removed, not covered. Affected pages become images: their text can no longer be selected or searched, and their annotations, links and form fields are flattened. Once saved, this can't be undone. | Markierte Inhalte werden entfernt, nicht verdeckt. Betroffene Seiten werden zu Bildern: Ihr Text ist nicht mehr auswählbar oder durchsuchbar, Anmerkungen, Links und Formularfelder werden reduziert. Nach dem Speichern ist das nicht umkehrbar. |
| `redact.pages` / `.progress` | Pages: {pages} / Redacting page {i} of {n} | Seiten: {pages} / Schwärze Seite {i} von {n} |
| `redact.cancel` / `.go` | Cancel / {n, plural, one {Redact 1 page} other {Redact # pages}} | Abbrechen / {n, plural, one {1 Seite schwärzen} other {# Seiten schwärzen}} |
| `redact.done` / `.undo` | Redacted. Save to make it permanent. / Undo | Geschwärzt. Zum Festschreiben speichern. / Rückgängig |

### 3.39 Protect (M5)

**Entry.** More and macOS File menu `protect.menu` (`lock`); the status bar's encrypted icon (§3.10) opens it too.

**Sheet** as §3.19, 480 w: `lock` tile | `protect.title`. Sections split by a divider, 16 apart:
1. **Status** (only when protected): `lock` 16 + `protect.isProtected` | secondary sm `protect.remove`. Without owner rights, Remove
   reveals an md password field `protect.permPassword` in place + primary sm `protect.remove`.
2. **Open password:** checkbox `protect.requireOpen`; on reveals label + md field `protect.password` and, 8 below, `protect.confirm`
   (both as §3.19: `type=password`, `autocomplete=off`, `spellcheck=false`, `eye` toggle). Under them a strength meter: 4 segments,
   each 4 h pill, gap 4, `--color-track`, filled segments accent, + meta label (`protect.weak` … `.strong`; the word carries the
   state). Computed locally from length and character classes (weak < 8; fair 8–11; good 12–15 or ≥ 8 with 3 classes; strong ≥ 16
   or ≥ 12 with 3 classes); a hint, never a block. Mismatch on blur: `aria-invalid` + `protect.mismatch` in the reserved 16 px slot.
3. **Permissions:** checkboxes `protect.print`, `protect.copy`, `protect.edit` (all on). Turning one off reveals
   `protect.permPassword` + confirm (required, must differ: `protect.same`). Meta `protect.permNote`.
4. Meta `lock` 12 `protect.aes`.

Footer: secondary `protect.cancel`, primary `protect.apply` (`aria-disabled` until valid). Existing passwords are never shown or
prefilled.

**Effect.** Apply is one undo step; the document is edited and encrypts on the next save (full rewrite, AES-256). Remove likewise.
**Security:** passwords cross IPC once on Apply, live in Rust only until that save or the tab closes (zeroised), never in settings,
logs, recents or the undo history; fields clear on close.

**Keyboard.** Initial focus first control; Enter applies when valid; Esc cancels; Tab cycles. Motion as About.

| Key | en | de |
|---|---|---|
| `protect.menu` / `.title` / `.apply` / `.cancel` | Protect… / Protect document / Protect / Cancel | Schützen… / Dokument schützen / Schützen / Abbrechen |
| `protect.isProtected` / `.remove` | This document is password-protected. / Remove protection | Dieses Dokument ist passwortgeschützt. / Schutz entfernen |
| `protect.requireOpen` / `.password` / `.confirm` | Require a password to open / Password / Confirm password | Passwort zum Öffnen verlangen / Passwort / Passwort bestätigen |
| `protect.weak` / `.fair` / `.good` / `.strong` | Weak / Fair / Good / Strong | Schwach / Mittel / Gut / Stark |
| `protect.mismatch` / `.same` | Passwords don't match. / Use a different password than the open password. | Passwörter stimmen nicht überein. / Ein anderes Passwort als das zum Öffnen verwenden. |
| `protect.print` / `.copy` / `.edit` | Allow printing / Allow copying text / Allow editing | Drucken erlauben / Kopieren von Text erlauben / Bearbeiten erlauben |
| `protect.permPassword` | Permissions password | Berechtigungspasswort |
| `protect.permNote` | Most apps respect these limits, but they are not a lock. | Die meisten Apps beachten diese Einschränkungen, sie sind aber keine Sperre. |
| `protect.aes` | Encrypted with AES-256 when you save. {app} never stores passwords. | Beim Speichern mit AES-256 verschlüsselt. {app} speichert keine Passwörter. |

### 3.40 Document properties (M5)

**Entry.** More and macOS File menu `props.menu` (`file-text`).

**Dialog** as §3.19, 480 w: `file-text` tile | `props.title`. Editable, each label (meta 600) over a full-width md field, 16 apart:
Title, Author, Subject, Keywords (comma-separated). ≤ 1000 chars; control characters stripped. Divider; a read-only `<dl>`, rows 24:
label meta (120 w) | value `--text-md`, text nodes only: Creator, Producer, Created, Modified (`Intl` medium date + short time, OS
region), Pages, PDF version, Size, Protection. Missing values `props.none`.

**Remove all.** Leading ghost `props.removeAll` empties the fields; read-only values read `props.willRemove` (meta italic); a
reserved slot shows `info` 12 + `props.removeNote`. Nothing changes before Apply; Cancel discards.

Footer: ghost `props.removeAll` | spacer | secondary `props.cancel`, primary `props.apply` (`aria-disabled` while unchanged). Apply
is one undo step (Info and XMP kept in sync, ADR-047); a removal adds toast `props.removed` + Undo.

**Keyboard / A11y.** Initial focus Title; Enter in a field applies; Esc cancels. Motion as About; reduced motion opacity only.

| Key | en | de |
|---|---|---|
| `props.menu` / `.title` | Document properties… / Document properties | Dokumenteigenschaften… / Dokumenteigenschaften |
| `props.docTitle` / `.author` / `.subject` / `.keywords` | Title / Author / Subject / Keywords | Titel / Autor / Thema / Stichwörter |
| `props.creator` / `.producer` / `.created` / `.modified` | Created with / PDF producer / Created / Modified | Erstellt mit / PDF-Erzeuger / Erstellt / Geändert |
| `props.pages` / `.version` / `.size` / `.protection` | Pages / PDF version / Size / Protection | Seiten / PDF-Version / Größe / Schutz |
| `props.none` / `.willRemove` | — / Will be removed | — / Wird entfernt |
| `props.removeAll` / `.removeNote` | Remove all metadata / Document metadata is removed when you apply. Text and images on pages stay. | Alle Metadaten entfernen / Dokument-Metadaten werden beim Anwenden entfernt. Text und Bilder auf den Seiten bleiben. |
| `props.cancel` / `.apply` / `.removed` | Cancel / Apply / Metadata removed | Abbrechen / Anwenden / Metadaten entfernt |

**Tokens (new, §3.36–§3.40):** `--color-doc-redact` `#B03535`, `--color-doc-redact-fill` 45° stripes `rgba(176,53,53,.24)` 2 px /
gap 4, `--color-doc-crop-shade` `rgba(15,16,32,.48)` (all both themes, document layer).

### 3.41 Output commands: placement and keys (M6)

No toolbar buttons (output is rare; the toolbar stays tools). Every command is an action (ADR-016) in More and the macOS File
menu, in one group after Save As, divider above and below:

| Action | Label key | Lucide | Shortcut | Disabled when |
|---|---|---|---|---|
| `images-to-pdf` | `img2pdf.menu` | `images` | — | never |
| `export-copy` | `copy.menu` | `file-output` | — | no document |
| `export-images` | `exportImg.menu` | `file-image` | Primary+Shift+E | no document; copying not permitted |
| `print` | `print.menu` | `printer` | Primary+P | no document; printing not permitted |

`images-to-pdf` also sits in More with no document. A disabled item stays focusable (§3.0), tooltip `output.notAllowed` for a
permission (§3.39). All four open a dialog (§3.19 recipe: solid, `--shadow-3`, `--radius-card`, backdrop, `--z-modal`, padding 24,
`icon` tile | title `--text-xl`); motion as About (MOTION §4.1: opacity + `--scale-enter`, `--motion-base` spring, exit
`--motion-fast`; reduced motion opacity only); Esc or Cancel closes and refocuses the trigger; Tab cycles inside. Paths never reach
the UI: Rust shows every native file and folder dialog and never overwrites (adds " (2)"). **Progress** everywhere is §3.30's bar:
primary shows a 16 spinner, after 1 s the body keeps its height and the option area yields to a 4 h bar (`role=progressbar`,
`aria-valuetext` = the meta line) + meta; Cancel stays. Errors: banner (§3.12), never toast. Pending redaction marks (§3.38) are
never output; while a tab holds them, Print, Export a copy and Export as images show `info` 12 + meta `output.pendingRedact` in a
reserved slot above the footer.

### 3.42 Export as images (M6)

**Purpose:** write pages as PNG or JPEG files into a folder.

**Dialog** 480 w (`--dialog-width-md`): `file-image` tile | `exportImg.title`. Rows 16 apart, each a label (meta 600) over its control:
1. **Format:** segmented control (§3.13, 32 h) `PNG` · `JPEG` (format names untranslated).
2. **Pages** (`radiogroup`): `exportImg.all` (default) · `exportImg.current` · `exportImg.range` + full-width md field (syntax,
   validation 150 ms and `split.invalid` in the reserved 16 px slot, per §3.30).
3. **Resolution:** segmented `72` · `150` (default) · `300` · `exportImg.custom`, each with meta "dpi" below the group; Custom
   enables an md Field 56 + meta "dpi" in the same row (36–600, arrows step 1, Shift × 10). The field slot is always reserved
   (disabled, not hidden), so nothing jumps.
4. **JPEG quality:** Slider + Field (§3.7), 10–100, default 85, `aria-valuetext` `exportImg.qualityValue`. With PNG it stays,
   `aria-disabled`, meta `exportImg.pngLossless` beside the label.
5. **Estimate** (`role=status`, polite): 12 spinner while Rust samples (≤ 3 pages, rendered at the chosen settings, 300 ms after the
   last change), then meta `exportImg.estimate`. Rust lowers a page that would exceed its pixel cap (ADR-049); then `info` 12 +
   `exportImg.capped`.

Last format, resolution and quality persist (settings); pages reset to All. Footer: secondary `output.cancel`, primary
`exportImg.go` (`aria-disabled` while the range is invalid). Go opens Rust's folder dialog (folder choice; cancelling it returns to the
dialog), then writes `{name}-p{n}.{ext}` (n zero-padded to the page count's width).

**States.** Progress: meta `exportImg.progress`; Cancel stops after the current page and keeps the files written (toast says how many).
Done: dialog closes, toast `exportImg.done` with ghost `split.show` (opens the folder in the OS file manager, Rust). Single page →
toast names the file.

**Keyboard / A11y.** Initial focus: Format. Enter activates Go when valid. Segmented controls are radiogroups (arrows, selection
follows focus). The estimate is not announced while it changes faster than every 1 s.

### 3.43 Create PDF from images (M6)

**Purpose:** combine PNG/JPEG images into a new document, one image per page.

**Entry.** More / macOS File `img2pdf.menu`; **empty state:** in the drop card, 16 below the Open row, a ghost md button `images`
16 + `img2pdf.menu` (its own row, centred; Open stays the one primary and the initial focus). Dropping only images (no PDF) on
the window or the empty state opens the dialog with them; a mix of PDFs and images opens the PDFs as today and ignores the
images with an info banner `img2pdf.mixedDrop`.

**Dialog** 560 w (`--sheet-width`): `images` tile | `img2pdf.title`. If opened from a menu, Rust's Open dialog (PNG, JPEG,
multi-select) runs first; Cancel there with no images closes everything.
1. **List** as §3.29 (`role=listbox`, max 5 rows, then scrolls; rows 56: `grip-vertical` 16 | thumbnail 32 × 40 on a white chip,
   `object-fit: contain`, radius 4 | name over meta `img2pdf.meta` | sm `x` `img2pdf.remove` on hover/focus). Rust decodes as
   hostile input (§3.36 limits); the UI gets previews only. Unreadable: `circle-alert` + `img2pdf.unreadable`, blocks Create until
   removed. Below: secondary sm `img2pdf.add` + meta `img2pdf.total`.
2. **Reorder:** pointer drag with the §3.28 drag card and 2 px marker (MOTION §4.5); Alt/Option+Up/Down moves the focused row
   (announced `organize.moved`); Delete removes it.
3. **Page** (16 below, label meta 600 over each, two columns of 240 at gap 16 for size | orientation; margin full width below):
   - **Size:** segmented `img2pdf.fit` · `A4` · `Letter`; default A4, or Letter where the OS region is US or CA (Rust).
   - **Orientation:** segmented `img2pdf.auto` (default; per image, landscape if wider) · `img2pdf.portrait` · `img2pdf.landscape`.
   - **Margin:** segmented `img2pdf.none` · `img2pdf.small` (12 mm / 0.5 in) · `img2pdf.large` (24 mm / 1 in); default Small.
   - With Fit, the page is the image at 72 dpi or its own dpi (no margin): orientation and margin stay visible, `aria-disabled`.
   Images scale to fit inside the margins, centred, aspect kept, never cropped. Choices persist.

Footer: secondary `output.cancel`, primary `img2pdf.create` (`aria-disabled` with no images or an unreadable one). **Result:** progress
as §3.41 (`img2pdf.progress`); then the dialog closes and a new tab `img2pdf.untitled` opens, unsaved (edited dot), as Merge (§3.29);
Save goes to Save As.

**Keyboard / A11y.** Initial focus: the list's first row (Add when empty). Empty list: centred meta `img2pdf.empty` in the list slot
(height of 2 rows). Forced colors: chips `Canvas` + `CanvasText` border.

### 3.44 Print (M6)

**Purpose:** hand the document to the OS print dialog. Copies, printer, duplex, paper and scaling belong to that dialog; we never copy it.

**Pre-step** dialog, 400 w (`--dialog-width`): `printer` tile | `print.title`.
1. Checkbox `print.annotations` (default on; persisted): off prints page content and form values only (content objects of §3.36
   are page content). Meta under it `print.annotationsHint`.
2. **Pages** (`radiogroup`): `exportImg.all` · `exportImg.current` · `exportImg.range` + field, as §3.42.

Footer: secondary `output.cancel`, primary `print.go` (initial focus; Enter prints). Go: progress (`print.preparing`, §3.41) while Rust
prepares the pages, then the dialog closes and the **native print dialog** takes over (modal to the window). Its own cancel
returns quietly. Primary+P inside the pre-step = Go, so Primary+P twice prints with the last choices.

### 3.45 Export a copy (M6)

**Purpose:** save a variant to a new file; the open document, its path and its unsaved state stay unchanged (unlike Save As).

**Dialog** 400 w: `file-output` tile | `copy.title`; 8 below meta `copy.body`. Checkboxes 8 apart:
`copy.annotations` (default on; off removes annotations, form values stay) · `copy.metadata` (default off; removes `/Info`, XMP and
document-level private data as §3.40) — when on, meta `copy.metadataHint` in its reserved slot. Not persisted.
Footer: secondary `output.cancel`, primary `copy.go` → Rust Save As, default name `copy.defaultName`. Done: toast `copy.done` + ghost
`split.show`. Initial focus: `copy.go`.

| Key | en | de |
|---|---|---|
| `output.cancel` / `.notAllowed` | Cancel / The document's permissions don't allow this. | Abbrechen / Die Berechtigungen des Dokuments erlauben das nicht. |
| `output.pendingRedact` | Unapplied redaction marks are not included. | Nicht angewendete Schwärzungen werden nicht übernommen. |
| `exportImg.menu` / `.title` / `.go` | Export as images… / Export as images / Export… | Als Bilder exportieren… / Als Bilder exportieren / Exportieren… |
| `exportImg.format` / `.pages` / `.resolution` / `.quality` | Format / Pages / Resolution / JPEG quality | Format / Seiten / Auflösung / JPEG-Qualität |
| `exportImg.all` / `.current` / `.range` | All pages / Current page / Pages | Alle Seiten / Aktuelle Seite / Seiten |
| `exportImg.custom` / `.qualityValue` / `.pngLossless` | Custom / Quality {n} % / PNG is lossless | Eigene / Qualität {n} % / PNG ist verlustfrei |
| `exportImg.estimate` | {n, plural, one {1 image} other {# images}}, about {size} | {n, plural, one {1 Bild} other {# Bilder}}, etwa {size} |
| `exportImg.capped` | Some large pages are exported at a lower resolution. | Einige große Seiten werden mit geringerer Auflösung exportiert. |
| `exportImg.progress` / `.done` | Exporting page {i} of {n} / {n, plural, one {1 image saved} other {# images saved}} | Exportiere Seite {i} von {n} / {n, plural, one {1 Bild gespeichert} other {# Bilder gespeichert}} |
| `img2pdf.menu` / `.title` | Create PDF from images… / Create PDF from images | PDF aus Bildern erstellen… / PDF aus Bildern erstellen |
| `img2pdf.add` / `.remove` / `.total` | Add images… / Remove {name} / {n, plural, one {1 page} other {# pages}} | Bilder hinzufügen… / {name} entfernen / {n, plural, one {1 Seite} other {# Seiten}} |
| `img2pdf.meta` / `.unreadable` / `.empty` | {w} × {h} px · {size} / Can't read this image / Add images to begin. | {w} × {h} px · {size} / Bild nicht lesbar / Fügen Sie Bilder hinzu. |
| `img2pdf.fit` / `.auto` / `.portrait` / `.landscape` | Fit to image / Auto / Portrait / Landscape | An Bild anpassen / Automatisch / Hochformat / Querformat |
| `img2pdf.size` / `.orientation` / `.margin` | Page size / Orientation / Margin | Seitengröße / Ausrichtung / Rand |
| `img2pdf.none` / `.small` / `.large` | None / Small / Large | Kein / Klein / Groß |
| `img2pdf.create` / `.progress` / `.untitled` | Create / Adding image {i} of {n} / Images | Erstellen / Füge Bild {i} von {n} hinzu / Bilder |
| `img2pdf.mixedDrop` | Images were not added. Use Create PDF from images for them. | Bilder wurden nicht hinzugefügt. Dafür „PDF aus Bildern erstellen“ verwenden. |
| `print.menu` / `.title` / `.go` | Print… / Print / Print… | Drucken… / Drucken / Drucken… |
| `print.annotations` / `.annotationsHint` | Print comments and markup / Form entries are always printed. | Kommentare und Markierungen drucken / Formulareinträge werden immer gedruckt. |
| `print.preparing` | Preparing page {i} of {n} | Bereite Seite {i} von {n} vor |
| `copy.menu` / `.title` / `.go` | Export a copy… / Export a copy / Save copy… | Kopie exportieren… / Kopie exportieren / Kopie speichern… |
| `copy.body` | The open document stays as it is. | Das geöffnete Dokument bleibt unverändert. |
| `copy.annotations` / `.metadata` | Include comments and markup / Remove document metadata | Kommentare und Markierungen einschließen / Dokument-Metadaten entfernen |
| `copy.metadataHint` / `.defaultName` / `.done` | Title, author and similar details are left out. / {name} (copy) / Copy saved | Titel, Autor und ähnliche Angaben werden weggelassen. / {name} (Kopie) / Kopie gespeichert |

**Tokens:** none new; §3.41–§3.45 reuse `--dialog-width`, `--dialog-width-md`, `--sheet-width`, §3.28 drag tokens and §3.30's bar.

### 3.46 Welcome tour: remaining steps (M7, F4)

**Purpose:** ship steps 4–7 of §3.14 (Highlight, Comment, Sign, Reorder). `shipped` flips to true for all four; the edition becomes
W · Z · M [4] · S [3] · E (5 pages, §3.14 Editions); both PDFs are regenerated. Everything not listed here stays as §3.14.

- **Step 5** anchors the Note tool (C): §3.22 named the tool "Note", so `tour.step.comment.*` says Note.
- **Step 6 (sign).** Phase a anchors Signature (S). While its popover, the creation sheet (§3.33, offered by `sign.add` when the
  library is empty) or the library is open, the card is hidden and the ring stays (§3.14 coexistence). Create or a popover item arms
  placement: phase b anchors the signature frame. Complete when a signature or initials has its centre in the frame, by placement
  **or by dragging** a placed one there (pointerup, or keyboard nudges once they settle, §3.23).
- **Step 7 (reorder).** Phase a anchors the left-panel toggle while the panel is collapsed, else the Thumbnails tab; phase b the
  thumbnail of page S. Organize mode (P) counts too: completion reads the page order, whatever moved it (drag, Alt+↑/↓, Move up). The
  success pulse sits on the moved thumbnail.
- **Tips** (§3.47) are suppressed while a tour runs; tools used in the tour are not marked as seen.
- **Restart** stays in Settings; the row becomes `settings.help` with two buttons (§3.47).

| Key | en | de |
|---|---|---|
| `tour.step.comment.title` / `.text` | Add a note / Choose Note, then click the dot. | Notiz hinzufügen / Wählen Sie Notiz und klicken Sie auf den Punkt. |
| `tour.step.reorder.text` | Open Thumbnails and drag page {from} above page {to}. | Öffnen Sie Miniaturen und ziehen Sie Seite {from} über Seite {to}. |

`{from}`/`{to}` are the thumbnail positions (4 and 3 in the M7 edition), filled from `steps.json` by the UI and the generator.

### 3.47 Tool tips (M7, F4)

**Purpose:** the first time a tool becomes active, one short tip says the one thing that is not obvious. Never twice.

**Trigger.** A tool turns active (any input) and its id is not in the setting `tipsSeen` (tool ids, ≤ 32), no tour runs, and no
coach card or other tip is visible. The id is written to `tipsSeen` *before* the tip shows (as `welcomeTour`, §3.14), so a crash
cannot repeat it. Tools with a tip: highlight, note, text, draw, shapes, sign, pages, insertText, crop, redact.

**Anatomy.** The coach-mark card (§3.14) in a compact form: G2 (solid mode `--surface-solid`), radius 16, width 304, padding 16, one
row, gap 8: `lightbulb` 16 in a 32 tile (radius 8) | tip text `--text-md` (≤ 90 characters en) | sm IconButton `x` `tip.dismiss`.
No title, no ring, no footer. Beak and placement as a §3.14 toolbar anchor (below the tool, 8 gap); a tool in overflow anchors More.

**Slot and layer:** `--z-popover`, clamped to the canvas slot inset 8; it covers page content only.

**States.** entering (opacity + scale .96 from the beak side, base) · shown · exiting (opacity, fast). It goes for good on `x`, Esc
inside it, releasing or changing the tool, or when a popover, menu or dialog opens. No timeout (WCAG 2.2.1).

**Keyboard.** Never takes focus. While shown it is the F6 stop after the toolbar (like the coach card). Esc inside dismisses and
returns focus to the canvas; Esc elsewhere follows §2.3 (releasing the tool also removes the tip).

**Accessibility.** `role="region"`, `aria-label` `tip.region`; the text goes once to the status bar's polite live region
(`tip.announce`); the tool gets `aria-describedby` → the text while shown. Forced colors as the coach card. Reduced motion: RM fade.

**Settings.** The tour row (§3.14 Restart) becomes label `settings.help` over two secondary sm buttons: `settings.tour.start` /
`.restart` and `settings.tips.reset` (`aria-disabled` while `tipsSeen` is empty; after a press, the hint reads
`settings.tips.resetDone`, polite).

| Key | en | de |
|---|---|---|
| `tip.region` / `.dismiss` / `.announce` | Tip / Dismiss tip / Tip: {text} | Tipp / Tipp ausblenden / Tipp: {text} |
| `tip.highlight` | Drag across text. Press H again for Underline or Strikethrough. | Über Text ziehen. H erneut drücken für Unterstreichen oder Durchstreichen. |
| `tip.note` | Click where the note belongs. Replies appear under Comments. | Klicken Sie dorthin, wo die Notiz hingehört. Antworten stehen unter Kommentare. |
| `tip.text` | Click to place a text box; drag to set its width. | Klicken platziert ein Textfeld, Ziehen legt die Breite fest. |
| `tip.draw` | Strokes drawn within a second become one drawing. | Striche innerhalb einer Sekunde werden eine Zeichnung. |
| `tip.shapes` | Hold Shift to keep proportions. Press R to switch the shape. | Umschalt hält die Proportionen. R wechselt die Form. |
| `tip.sign` | Saved signatures stay encrypted on this device. | Gespeicherte Unterschriften bleiben verschlüsselt auf diesem Gerät. |
| `tip.pages` | Drag to reorder. Shift or {mod} selects several pages. | Zum Ordnen ziehen. Umschalt oder {mod} wählt mehrere Seiten. |
| `tip.insertText` | Added text becomes page content, not a comment. | Hinzugefügter Text wird Seiteninhalt, kein Kommentar. |
| `tip.crop` | Drag the edges, or type exact margins in the panel. | Kanten ziehen oder genaue Ränder im Bereich eingeben. |
| `tip.redact` | Marks stay reviewable until you apply them. | Markierungen bleiben prüfbar, bis Sie sie anwenden. |
| `settings.help` | Help | Hilfe |
| `settings.tips.reset` / `.resetDone` | Show tips again / Tips will show again. | Tipps erneut zeigen / Tipps werden wieder gezeigt. |

### 3.48 Recents thumbnails (M7; amends §3.11)

**Purpose:** recognise a file at a glance. The row stays 56 h, padding 8; its leading slot is 32 × 40 (`--list-thumb-w` /
`--list-thumb-h`, new; §3.43 uses them too), radius 4.

| State | Treatment |
|---|---|
| image | first page, rendered by Rust at close and after Save into the app cache (64 × 80 px for DPR 2), keyed by the recents id; the UI fetches it by id (SHR1), never by path. White chip, `object-fit: contain` (landscape letterboxed on white), 1 px inset `--color-divider`, no shadow. The file's `/Rotate` applies, view rotation does not |
| placeholder | no cache yet, loading or failed: `--color-tile` fill, `file-text` 16 in `--color-tile-icon`, centred |
| protected | encrypted documents are never cached (a decrypted page must not land on disk): tile with `lock` 16 |
| missing | tile with `file-x` 16 in `--color-warning-icon` (3.12 on the tile), meta `File not found` as §3.11 |

The image fades in over the placeholder (base, MOTION §4.3); a cached image at mount shows without a fade; reduced motion: same
(opacity). The thumbnail stays the §4.6 clone source. Remove deletes its cached image once the Undo window ends; Clear deletes all.
`alt=""` (the row's name says it). Forced colors: chip `Canvas` + 1 px `CanvasText`. Hover, focus and keys: §3.11 unchanged.

| Key | en | de |
|---|---|---|
| `recents.privacy` | Recent files and their previews are stored only on this device. | Zuletzt verwendete Dateien und ihre Vorschauen werden nur auf diesem Gerät gespeichert. |

### 3.49 Updater (M7)

**Purpose:** opt-in, signed updates; the only feature that uses the network (rule 4). Off by default.

**Settings row** `settings.updates` (meta 600) over a segmented control `settings.updates.off` · `.on` (§3.13) and the meta hint
`settings.updates.hint`. When On, 8 below: status meta (`role=status`: `update.upToDate`, `update.checking` + 12 spinner, or
`update.checkFailed` in `--color-error-text`) | spacer | ghost sm `update.checkNow`. Switching On checks at once.

**Check.** Only while On: once per 24 h, 10 s after startup. An automatic check that fails is silent (logged locally).

**Notice.** Info banner (§3.12): `download` 16 tile, `update.available`, secondary sm `update.details` (opens the dialog), ghost sm
`update.later`. Later hides it until the next launch. It ranks below every document banner. Never a dialog by itself.

**Dialog** (§3.19 recipe, 400 w): `download` tile | `update.title`; meta `update.current`; release notes from the signed manifest as
plain text nodes (≤ 2000 chars) in a §3.21 box (≤ 8 lines, scrolls). Footer: ghost `update.skip` (leading; stores the skipped
version) · secondary `update.notNow` · primary `update.install` (initial focus).

| State | Treatment (body keeps its height; the notes yield to the §3.41 bar) |
|---|---|
| downloading | determinate bar, meta `update.downloading`; secondary becomes `output.cancel` (deletes the partial file) |
| verifying | indeterminate bar, `update.verifying` (minisign check in Rust) |
| ready | tile crossfades to `check` (fast); `update.ready`; primary `update.restart`, secondary `update.restartLater`. Restart runs the quit flow (§3.27; Cancel stops it). Later: the banner reads `update.readyBanner` with secondary sm `update.restart` |
| download failed | error line slot (16, reserved, `role=alert`): `circle-alert` 12 + `update.failedDownload`; primary becomes `update.retry` |
| not verified | `update.failedVerify`; only secondary `update.close`; this version is not offered again this session |
| install failed | next start, old version: error banner `update.failedInstall`, dismissible |

**Keyboard / A11y.** Dialog keys as §3.19; banner is an F6 region. Bar `role=progressbar` + `aria-valuetext`; ready is announced
politely. **Motion:** banner §3.12, dialog as About; reduced motion opacity only.

| Key | en | de |
|---|---|---|
| `settings.updates` / `.off` / `.on` | Updates / Off / Check automatically | Updates / Aus / Automatisch prüfen |
| `settings.updates.hint` | Contacts GitHub once a day. GitHub sees your IP address and app version; nothing else is sent. | Kontaktiert einmal täglich GitHub. GitHub sieht Ihre IP-Adresse und App-Version, sonst wird nichts gesendet. |
| `update.checkNow` / `.checking` / `.upToDate` / `.checkFailed` | Check now / Checking… / {app} is up to date. / Couldn't reach GitHub. | Jetzt prüfen / Prüfe… / {app} ist aktuell. / GitHub nicht erreichbar. |
| `update.available` / `.details` / `.later` | {app} {version} is available. / Details / Later | {app} {version} ist verfügbar. / Details / Später |
| `update.title` / `.current` | Update to {version} / You have {current}. | Auf {version} aktualisieren / Installiert: {current}. |
| `update.skip` / `.notNow` / `.install` | Skip this version / Not now / Download and install | Diese Version überspringen / Nicht jetzt / Laden und installieren |
| `update.downloading` / `.verifying` | Downloading {done} of {total} / Checking signature… | Lade {done} von {total} / Prüfe Signatur… |
| `update.ready` / `.restart` / `.restartLater` | Ready to install. / Restart to update / Later | Bereit zur Installation. / Neu starten und aktualisieren / Später |
| `update.readyBanner` | Update ready. It installs when {app} restarts. | Update bereit. Es wird beim Neustart von {app} installiert. |
| `update.failedDownload` / `.retry` | Download failed. Check your connection. / Try again | Download fehlgeschlagen. Verbindung prüfen. / Erneut versuchen |
| `update.failedVerify` / `.close` | The download couldn't be verified and was deleted. Nothing changed. / Close | Der Download ließ sich nicht prüfen und wurde gelöscht. Nichts wurde geändert. / Schließen |
| `update.failedInstall` | The update couldn't be installed. {app} is unchanged. | Das Update ließ sich nicht installieren. {app} ist unverändert. |

### 3.50 Crash recovery (M7)

**Purpose:** after an unexpected exit, offer the autosaved unsaved work per document. Never blocking: the app is usable at once, and
documents from the launch open as usual.

**Slot.** The banner row (§2), as a **recovery banner**: G1, radius 16, padding 8, not per tab. It outranks warning and info and
yields only to an error (then returns). Height = header 32 + 8 + rows; at most 3 rows visible, then the list scrolls inside.

**Anatomy.**
- Header: `life-buoy` 16 in a 32 tile (radius 8) | `recover.title` `--text-md` 600 over meta `recover.body` | spacer | with ≥ 2
  rows ghost sm `recover.discardAll` · secondary sm `recover.restoreAll` | sm `x` `recover.later`.
- Rows 40, radius 8, padding 0 8, indented 40 (aligned with the text): name `--text-md` (middle-truncated) + meta `recover.meta` |
  spacer | ghost sm `recover.discard` · secondary sm `recover.restore`.

| State | Treatment |
|---|---|
| default | as above |
| restoring | Restore shows a 16 spinner, row `aria-busy` |
| restored | the document opens (or activates) edited (tab dot, "Edited"); history starts at the recovered state; "Edited" pulses (MOTION §4.7, `recover.restored`); the row leaves |
| as copy | source missing or changed on disk: meta `recover.asCopy`; it opens untitled as `recover.copyName`, Save → Save As |
| failed | `circle-alert` 12 + `recover.failed` (`--color-error-text`, `role=alert`); Discard stays |
| discarded | the row leaves; toast `recover.discarded` + `recover.undo` (8 s); the record is deleted when the toast ends |

`x` (Later) hides the banner for this session; unresolved records stay for the next launch (retention: ADR-053). The banner goes
when its last row goes.

**Keyboard.** Never takes focus on appearing; F6 region; DOM order = visual order; Esc does not dismiss (§3.12).
**Accessibility.** `role="region"`, `aria-labelledby` the title; title + body announced once (polite); rows `role=group` named by
the document. **Motion.** Banner row slow in, base out (MOTION §4.2); a leaving row fades (fast), then the row height changes in
one step (only `grid-template-rows` animates). Reduced motion: RM fade, heights at once. Forced colors as §3.12.

| Key | en | de |
|---|---|---|
| `recover.title` | {app} closed unexpectedly | {app} wurde unerwartet beendet |
| `recover.body` | {n, plural, one {Unsaved changes in 1 document can be restored.} other {Unsaved changes in # documents can be restored.}} | {n, plural, one {Ungespeicherte Änderungen in 1 Dokument können wiederhergestellt werden.} other {Ungespeicherte Änderungen in # Dokumenten können wiederhergestellt werden.}} |
| `recover.meta` | Last change {time} | Letzte Änderung {time} |
| `recover.restore` / `.discard` / `.restoreAll` / `.discardAll` / `.later` | Restore / Discard / Restore all / Discard all / Decide later | Wiederherstellen / Verwerfen / Alle wiederherstellen / Alle verwerfen / Später entscheiden |
| `recover.asCopy` / `.copyName` | The file changed or is missing; restores as a copy. / {name} (recovered) | Die Datei wurde geändert oder fehlt; wird als Kopie wiederhergestellt. / {name} (wiederhergestellt) |
| `recover.failed` / `.restored` | Couldn't restore this document. / Restored: {name} | Dokument ließ sich nicht wiederherstellen. / Wiederhergestellt: {name} |
| `recover.discarded` / `.undo` | Changes to {name} discarded / Undo | Änderungen an {name} verworfen / Rückgängig |

### 3.51 Installer and disk-image artwork (M7, F5)

**Rules.** Generated from `assets/brand/logo.svg` by a deterministic script; outputs committed under `src-tauri/icons/installer/`.
**No text** in any bitmap: NSIS and Finder print the name in their own localized UI, so the art stays language-free and APP_NAME and
the trademark keep one source. Light only (classic Win32 wizard pages are light). Colours from §1.1/§1.10 only, flattened (no alpha).

| Asset | Size, format | Composition |
|---|---|---|
| NSIS header (`headerImage`) | 150 × 57, BMP 24-bit | `#FFFFFF` (the wizard's header strip); full-colour logo 40 × 40 at x 102, y 8; nothing else |
| NSIS sidebar (`sidebarImage`, welcome and finish pages) | 164 × 314, BMP 24-bit | `--bg-gradient` light (135°, `#E1E2FF` → `#F4F5FF`) + field a scaled to an ellipse 240 × 120 at 8 % 0 % (`rgba(142,142,242,.32)`) + field c 160 × 160 at 0 % 100 % (`rgba(201,202,255,.40)`); logo 96 × 96 at x 34, y 72; ground shadow 80 × 6 centred at (82, 180), `--ground-shadow` light |
| Installer icon | `.ico` | the app icon, unchanged |
| DMG background | 660 × 400 + @2x 1320 × 800, PNG | gradient + field a (720 × 240 at 8 % 0 %) + field c, as the app window; Finder icon size 128; app at centre (180, 184), Applications alias at (480, 184); between them a Lucide-style `chevron-right` 16 × 32, 3 px round stroke, `#8E8EF2` (iris-300), on the icons' centre line; window 660 × 400, no toolbar |

Rendered at exact pixel size (no scaling; NSIS stretches on high-DPI, accepted). Finder icon labels follow the system appearance:
verify both appearances in the B-001 macOS check.

### 3.52 Accessibility pass (M7)

Checklist, run per screen (empty state, document, organize, crop, redact, each dialog) in both themes, glass and solid:

| # | Check | Where |
|---|---|---|
| 1 | Focus order: toolbar → coach card or tip → tabs → banner (incl. recovery, update) → left panel → splitter → canvas → annotations → inspector → status bar; F6 restores each region's focus; dialogs take the initial focus their section names and return it to the trigger | §2.3, 3.14, 3.47, 3.49, 3.50, all dialogs |
| 2 | Names: every IconButton `aria-label` = tooltip; segmented controls are named radiogroups; thumbnails "Page n of m"; progress `aria-valuetext`; banners `role` per §3.12 | §3.2, 3.9, 3.10, 3.11, 3.13, 3.28, 3.33, 3.41–3.45 |
| 3 | Contrast per §4. Disabled toolbar icons (M6 review): `--opacity-disabled` goes; icons use `--color-icon-disabled` (≥ 3:1 on G1, §4), so the toolbar reads without a document; state also via `aria-disabled` and the tooltip reason | §3.3, 3.22, 3.36 |
| 4 | Reduced motion: every MOTION §4 row and §3.46–3.50 follow RM fade; float off | all |
| 5 | Forced colors: new surfaces `Canvas` + `CanvasText`, rings `Highlight`, thumbnail chips bordered | §3.47–3.50 |
| 6 | Targets ≥ 24 (2.5.8): recents `x`, tip `x`, recovery buttons | §3.11, 3.47, 3.50 |
| 7 | One polite live region (status bar); `alert` only for errors; no announcement faster than 1 s | §3.10, 3.42 |
| 8 | A key path for every pointer action: reorder (Alt+↑/↓), place (Enter), crop rect, drop (Open), tour steps | §3.23, 3.28, 3.34, 3.37, 3.46 |
| 9 | `<html lang>` follows the UI language; every key exists in en and de (`i18n` parity test) | i18n |
| 10 | Text weight (M6 review): same weights in both themes; macOS uses `-webkit-font-smoothing: antialiased` in both; Windows unchanged | §1.5 |

**Tokens (new, §3.46–§3.52):** `--list-thumb-w` 32, `--list-thumb-h` 40, `--color-icon-disabled` (ink-50 both themes; forced colors
`GrayText`); removed `--opacity-disabled`. The tip reuses the coach card's width.

### 3.53 i18n glossary (en / de)

Typography (de): ellipsis `…` (never three dots); quotes „…“; a no-break space (U+00A0) between a number and its unit or `%`
(`20 MB`, `72 × 72 Punkt`) and in thousands groups (`8 192`); a test enforces it. Dates and numbers go through `Intl` with the UI locale.

| English | German | Note |
|---|---|---|
| Text comment (free text annotation) | Textkommentar | the annotation; never "Textfeld" (that is a form field) |
| Insert text | Text einfügen | adds page content, not an annotation |
| Redact / redaction | Schwärzen / Schwärzung | irreversible removal; "geschwärzt" for done |
| Crop | Zuschneiden / Zuschnitt | hides, does not remove |
| Comment, highlight | Kommentar, Hervorhebung | |
| Page | Seite | |
| Sign / signature | Signieren / Signatur | visual signatures only |
| Form field | Formularfeld | |

## 4. Contrast verification

Worst points (ADR-020): `--surface` over the darkest field point (light `#C6C7FB` → glass `rgb(229,229,254)`; dark
`#2E2E6A` → glass `rgb(36,37,77)`); text directly on `--color-bg` below the 240 px band (light `rgb(220,221,255)`, dark
`rgb(33,33,85)`); `--surface-strong` over black (light) or white (dark) content. Text needs 4.5, non-text 3.

| Pairing | Light | Dark |
|---|---|---|
| text on solid / glass / strong / canvas / bg | 16.73 / 13.55 / 13.35 / 13.88 / 12.66 | 16.73 / 14.55 / 12.39 / 19.44 / 14.86 |
| text / muted / text-accent on fallback (solid-mode G1) | 15.82 / 5.84 / 8.37 | 16.13 / 6.58 / 10.27 |
| text on control-hover / pressed / selected | 13.17 / 10.66 / 13.17 | 13.30 / 10.82 / 12.03 |
| muted on solid / glass / strong / canvas / bg / selected | 6.17 / 4.99 / 4.92 / 5.12 / 4.67 / 4.86 | 6.82 / 5.93 / 5.05 / 7.93 / 6.06 / 4.90 |
| text-accent on solid / glass / strong / selected / canvas | 8.85 / 7.16 / 7.06 / 6.96 / 7.34 | 10.66 / 9.27 / 7.89 / 7.66 / 12.39 |
| tile icon on tile (tiles, pill badges) | 6.96 | 8.29 |
| on-accent on accent / hover / pressed | 5.37 / 6.85 / 8.85 | 5.82 / 10.66 / 4.77 |
| control border on solid / glass / strong / hover / fallback | 3.88 / 3.14 / 3.09 / 3.05 / 3.67 | 4.32 / 3.75 / 3.20 / 3.43 / 4.16 |
| focus, active fill, ring on solid / glass / canvas / strong / selected / bg | 5.37 / 4.35 / 4.45 / 4.28 / 4.22 / 4.06 | 5.82 / 5.06 / 6.76 / 4.31 / 4.18 / 5.17 |
| lock disc on accent / glyph on disc | 5.37 / 5.37 | 5.82 / 5.82 |
| success / warning / error text on solid / glass | 6.07 / 5.92 / 6.16 · 4.91 / 4.79 / 4.99 | 9.81 / 10.21 / 8.24 · 8.53 / 8.88 / 7.16 |
| same on strong | 4.84 / 4.72 / 4.92 | 7.26 / 7.56 / 6.10 |
| success / warning / error icon on solid (on glass: `-text`, row above) | 3.38 / 3.97 / 4.23 | 4.96 / 6.06 / 3.96 |
| accent icon (unboxed) on strong | 4.28 | 4.31 |
| tooltip text / keys | 16.73 / 6.82 | 13.62 / 5.55 |
| white glyph on close hover | 5.66 | 5.66 |
| disabled on solid (exempt) | 3.88 | 2.71 |
| `--color-icon-disabled` on G1 worst point / fallback (§3.52) | 3.13 / 3.66 | 3.75 / 4.17 |

Document layer: iris-500 on white page 5.37. **Fails, never use:** white on iris-400 3.51, `#D98A1F` text 2.76, ink-60
on iris-200 3.93, iris-500 text on canvas 4.45, iris-300 text in light 2.88, success-icon on light glass 2.73,
muted on light field a (`#C6C7FB`) 3.81 (hence the 240 px band), control border on a tinted `--surface-strong` < 3 (2.93 already at `#F8F8FF` base).

## 5. Brand

Logo `assets/brand/logo.svg` only. Wordmark "Sheer": system font 600, −0.02em, `--color-text`, icon gap 0.5 × cap
height. Monochrome tray variant: page path in `currentColor`, no tile. No other logo variants.

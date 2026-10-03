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
`--ease-float`, `--logo-hero` 160, `--logo-slot` 184, `--ground-shadow` (`radial-gradient(closest-side,
rgba(91,91,214,.24), transparent)` light, `rgba(0,0,0,.48)` dark).

## 2. Layout grid

| Row | Height |
|---|---|
| caption (Windows only) | 32 |
| toolbar-row (drag region) | 56 = toolbar 40 + 8 above/below |
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

Tab and F6/Shift+F6: toolbar → banner → left panel → splitter → canvas → inspector → status bar; F6 restores each region's
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

1. **Logo slot** (focal point, ADR-020): 184 h (`--logo-slot`), full column width, own grid row; nothing else sits in
   it. `assets/brand/logo.svg` at 160 (`--logo-hero`), centred, top inset 8 at rest, so the float (§1.10) stays inside
   the slot; ground shadow 96 × 8 (`--ground-shadow`), centred, bottom inset 4. Decorative: `alt=""`, `aria-hidden`,
   `pointer-events: none`; never a tab stop. Always the full-colour logo (Iris tile + sheet), both themes.
2. **Drop card**, 24 below: G1, radius 24, padding 40, content centred; no icon tile (the logo above replaces it);
   "Open a PDF" `--text-xl`; 8 below, "Drop a file anywhere in this window or choose one." muted; 24 below, primary lg
   "Open…" and, 8 right, the shortcut as a pill badge ("⌘O"/"Ctrl+O", §1.10).
3. **Recents**, 32 below: header "Recent" (meta 600) + ghost sm "Clear"; ≤ 8 rows, 56 h, radius 12, padding 8:
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
| 3 | zoom | Z | toolbar zoom in | a zoom commits at rest at ≥ 1.2 × the zoom at step start (button, keys, wheel, pinch, menu) | M1 |
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
| `tour.step.zoom.*` | Zoom in / Click + until the small print is easy to read. | Vergrößern / Klicken Sie auf +, bis die kleine Schrift gut lesbar ist. |
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
| `welcomePdf.nav.next` | Zoom waits on the next page. | Auf der nächsten Seite geht es ums Zoomen. |
| `welcomePdf.order` | Page numbers out of order? Step {n} fixes that. | Seitenzahlen durcheinander? Schritt {n} behebt das. |
| `welcomePdf.end.title` / `.text` | You're all set / Here is what to try next. | Alles erledigt / Das können Sie als Nächstes tun. |
| `welcomePdf.end.nextTitle` / `.keysTitle` | What next / Shortcuts | Wie weiter / Tastenkürzel |
| `welcomePdf.end.next.open` | Open your own PDF: Open… or drop a file on the window. | Eigene PDF öffnen: Öffnen… oder Datei auf das Fenster ziehen. |
| `welcomePdf.end.next.markup` / `.organize` / `.sign` | Highlight, comment and draw on any PDF. / Sort, rotate and delete pages. / Sign with a drawn, typed or image signature. | Markieren, kommentieren und zeichnen. / Seiten ordnen, drehen und löschen. / Unterschreiben: gezeichnet, getippt oder als Bild. |
| `welcomePdf.end.restart` | Restart this tour any time: Settings, then Welcome tour. | Tour jederzeit neu starten: Einstellungen, dann Willkommenstour. |
| `welcomePdf.key.open` / `.zoom` / `.page` / `.settings` | Ctrl+O / Cmd+O · Ctrl+Plus / Ctrl+Minus (Cmd on Mac) · Ctrl+Down / Ctrl+Up (Cmd on Mac) · Ctrl+Comma / Cmd+Comma | Strg+O / Cmd+O · Strg+Plus / Strg+Minus (Cmd am Mac) · Strg+Ab / Strg+Auf (Cmd am Mac) · Strg+Komma / Cmd+Komma |
| `welcomePdf.keyAction.open` / `.zoom` / `.page` / `.settings` | Open a file · Zoom in and out · Next and previous page · Settings | Datei öffnen · Vergrößern und verkleinern · Nächste und vorige Seite · Einstellungen |
| `welcomePdf.sign.title` / `.text` / `.label` | Sign and sort / Sign in the frame, then move this page up. / Signature | Unterschreiben und ordnen / Im Rahmen unterschreiben, dann Seite nach oben schieben. / Unterschrift |

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

Document layer: iris-500 on white page 5.37. **Fails, never use:** white on iris-400 3.51, `#D98A1F` text 2.76, ink-60
on iris-200 3.93, iris-500 text on canvas 4.45, iris-300 text in light 2.88, success-icon on light glass 2.73,
muted on light field a (`#C6C7FB`) 3.81 (hence the 240 px band), control border on a tinted `--surface-strong` < 3 (2.93 already at `#F8F8FF` base).

## 5. Brand

Logo `assets/brand/logo.svg` only. Wordmark "Sheer": system font 600, −0.02em, `--color-text`, icon gap 0.5 × cap
height. Monochrome tray variant: page path in `currentColor`, no tile. No other logo variants.

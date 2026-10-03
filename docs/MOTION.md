# Motion system (F3, ADR-022)

Binding for every animation in the app. Supersedes every duration, easing and motion note elsewhere in `DESIGN.md`
(§1.10 entry, §2, §2.4, §3); where they differ, this file wins. Raw values live in `src/styles/tokens.css`; the JS side
reads the same numbers from `src/lib/motion.ts`, and `tokens.test.ts` fails on drift (as with `LAYOUT`).

## 1. One curve

Every transition and every Motion animation uses one critically-near spring: **bounce .15** (damping ratio .85, mass 1).
Its peak overshoot is 0.6 %, invisible on opacity and on 8 px moves, so the same curve serves opacity, colour, transform
and grid tracks. The only exception is the empty-state float (`--ease-float`, DESIGN §1.10).

**CSS** (`--ease-spring`), the spring sampled over its visual duration (the 0.6 % tail after it is dropped):

```
linear(0, 0.029 5%, 0.102 10%, 0.198 15%, 0.303 20%, 0.409 25%, 0.509 30%,
       0.601 35%, 0.681 40%, 0.808 50%, 0.895 60%, 0.949 70%, 0.980 80%, 0.996 90%, 1)
```

Fallback where `linear()` is unsupported (WKWebView before Safari 17.2): `cubic-bezier(.25, .1, .25, 1)`, max deviation
0.01 from the spring. Chosen with `@supports not (transition-timing-function: linear(0, 1))`.

**Motion 14** (`motion`, MIT): `{ type: "spring", bounce: 0.15, visualDuration: d }` with `d` = the duration token in
seconds. Equivalent stiffness/damping (mass 1): fast 1904 / 74.2 · base 685 / 44.5 · slow 268 / 27.8. A CSS transition
of duration `d` with `--ease-spring` and a Motion spring of `visualDuration d` look the same; mix them freely.

`--ease-in` and `--ease-out` are removed. Exits use the same curve, just shorter (§3).

## 2. Three durations

| Token | ms | Name | Used for |
|---|---|---|---|
| `--motion-fast` | 120 | quick | hover, press, toggles, slider thumb, every small exit, all reduced-motion exits |
| `--motion-base` | 200 | standard | popover, menu, tooltip, toast, dialog enter; tab indicator; page render fades; zoom steps; exits of panels and the banner |
| `--motion-slow` | 320 | spatial | panel and inspector slide, banner row, fit commands, opening a document, drop, success pulse, scroll jumps |

Rule of thumb: the more of the window an animation moves, the longer it is. Nothing is longer than 320 ms (except the
float). No delays except the tooltip's (500 ms, keyboard 300) and the submenu hover intent (DESIGN §3.5).

## 3. Rules

**Enter.** Opacity 0 → 1 plus at most one spatial cue: `scale(--scale-enter .96)` from the anchor side, or
`translate(--offset-enter 8px)` from the slot's own edge. Never both, never from off-window, never a blur.

**Exit.** One step shorter than the enter (slow → base, base → fast, fast → fast) and opacity only: no scale or
translate back. Exception: panels (§4.2) slide out, because their track closes with them. An exiting element is `inert`
at once and leaves the accessibility tree when it ends.

**Interruptions.** Every animation is retargetable: a reversal starts from the current value and velocity (Motion
does this; CSS transitions reverse from the current value). Nothing queues; the newest intent wins.

**Layout change.** Only two layout properties may animate: `grid-template-columns` of the main row (left panel,
inspector) and `grid-template-rows` of the shell (banner row), one at a time. Everything else that changes size jumps
in one layout and is smoothed with transforms (FLIP). During a track animation:

1. Contents never reflow per frame: a panel keeps its final width and slides inside its clipped track; the canvas
   content keeps its zoom and is transform-scaled if it must change size (fit width).
2. **Scroll anchoring.** Before any layout change the canvas records an anchor: the document point under the pointer
   (pointer gestures) or under the viewport centre (everything else). After each layout step (per frame during a track
   animation, in a layout effect, before paint) it restores `scrollTop`/`scrollLeft` so that point stays at the same
   place in the viewport. Vertically, the page under the centre never moves. Horizontally, a page narrower than the
   canvas stays centred in its slot (rule 8), so it glides with the canvas centre in the same spring as the panel; a
   page wider than the canvas keeps the anchored point fixed. CSS scroll anchoring is off on the canvas
   (`overflow-anchor: none`); the app's anchor is the only one.
3. A real zoom commits once, at rest; the render pipeline then fades in the sharp frame (§4.3).

**Never animate:** blur radius or `backdrop-filter` on/off, `box-shadow` (fade a pseudo-element that carries the
shadow), `width`/`height`/`top`/`left` (except the tracks above), `filter` of any kind, scroll position over more than
two viewport heights.

## 4. Micro-interaction catalogue

Columns: trigger · animated properties · duration · reduced-motion form. "RM fade" = opacity only, enter base,
exit fast, same curve.

### 4.1 Controls

| Interaction | Trigger | Properties | Duration | Reduced motion |
|---|---|---|---|---|
| Hover | pointer enters (only `(hover: hover)`) | fill via a `::before` layer's opacity (colour for text) | fast in, fast out | same (no transform involved) |
| Press | pointerdown; Enter/Space keydown | `scale(--scale-press .97)` + pressed fill | fast down; release springs back in base | fill only |
| Toggle / tool on | `aria-pressed` flips | fill, ring opacity | fast | same |
| Tab indicator | tab selected | `translateX` + `scaleX` of the fill | base | jumps; fill fades fast |
| Slider thumb | hover, drag | `scale(--scale-thumb)` | fast | none |
| Tooltip | 500 ms rest (300 keyboard) | opacity | base in, fast out | same |
| Popover, menu, submenu | open | opacity + `scale(.96 → 1)`, origin = trigger side | base in, fast out | RM fade |
| Dialog | open | opacity + `scale(.96 → 1)`; backdrop opacity | base in, fast out | RM fade |
| Toast | show | opacity + `translateY(8 → 0)` | base in, fast out | RM fade |

### 4.2 Panels slide instead of appearing

| | Left panel | Inspector |
|---|---|---|
| Trigger | toggle, splitter Enter, auto-collapse/restore | toggle, selection or tool (`auto` ≥ 1280) |
| Track | its gutter + panel tracks 0 ↔ width | gap + 288 track 0 ↔ 288 |
| Panel | `translateX(-100% - 8px → 0)` from the leading edge, opacity 0 → 1 over the first 60 % | `translateX(100% + 8px → 0)` from the trailing edge, same opacity |
| Duration | open slow, close base (slides back out, then unmounts) | same |
| Canvas | anchored per §3; fit width is followed as a transform `scale(newFitWidth / startZoom)` around the anchor; the new zoom commits at the end with no visible change | same |
| Reduced motion | tracks change in one step (open: before the fade; close: after it), panel RM fade | same |

The track is `overflow: clip`, so the sliding panel never paints outside its slot. A splitter drag never animates.
Focus does not move into a panel that opens by itself (inspector `auto`).

**Banner row:** `grid-template-rows` 0 ↔ its height, slow in / base out; content opacity + `translateY(-8 → 0)`; the
canvas below keeps its anchor. Reduced motion: row at once, RM fade.

### 4.3 Pages load with a fade

| Step | Trigger | Properties | Duration | Reduced motion |
|---|---|---|---|---|
| Placeholder | page mounts | none: a white page of its real size and shadow is there at once | 0 | same |
| First frame | frame arrives | the image fades over the placeholder, opacity 0 → 1 | base | same (opacity) |
| Low-res → sharp | a better bucket or tile arrives over a stand-in | the sharp layer fades in on top; the stand-in is removed after | fast | same |

A frame already cached at mount shows without a fade. No shimmer: a placeholder is still. Tiles of one page fade as one group (the page waits up to
80 ms, ADR-018's settle time, for its tiles before fading), so a grid never pops in square by square.

### 4.4 Zoom

During every zoom animation the canvas content is transform-scaled around the anchor (compositor only); the real zoom,
layout and render request commit once at rest, then §4.3 fades in sharp frames.

| Input | Behaviour | Duration | Reduced motion |
|---|---|---|---|
| Pinch, Ctrl/Cmd + trackpad wheel | 1:1 with the fingers around the pointer, no lag | live | same (direct manipulation is not animation) |
| Gesture end (inertia) | velocity in log-zoom/s × 0.1 s projects a target, capped at ×1.5 / ÷1.5; the spring carries the zoom there from the current velocity | slow | commits the snapped value at once |
| Snap | if the projected target lies within ±8 % (log) of a **fit step** — fit width, fit page, 100 % — it becomes that step (fit modes take over) | — | snap still applies |
| Ctrl/Cmd + mouse-wheel notch | next preset step around the pointer; notches in flight retarget the spring | base | at once |
| Zoom in/out button, keys | next preset step around the viewport centre; fit steps between presets are stops too | base | at once |
| Fit width / fit page / actual size | spring to that zoom around the viewport centre | slow | at once |

Limits clamp the target (no rubber band); the readout updates at rest. **Opening zoom:** a document opens at fit width,
capped at 100 %: if fit width exceeds 100 %, it opens at 100 % (fixed zoom, centred); otherwise in fit-width mode.

### 4.5 Drag and drop

The webview never reads a dropped file (DESIGN §2.4); it only follows `ui.dropHover`.

| Phase | Trigger | Properties | Duration | Reduced motion |
|---|---|---|---|---|
| Enter | `dropHover` on | drop target (empty card ring, or G2 overlay in the canvas slot) fades in; a **preview card** appears centred in it, lifted: opacity 0 → 1, `translateY(-8)`, `scale(--scale-lift 1.04)`, `--shadow-3` layer at full opacity | base | RM fade, card at rest position, no lift |
| Leave | `dropHover` off without a drop | card and target fade out | fast | same |
| Drop | drop accepted | the card **falls**: `translateY(-8 → 0)`, `scale(1.04 → 1)`, shadow layer fades to `--shadow-1` | base | card fades out fast |
| Open | document opened (on error: fades out fast) | the card becomes the first page (§4.6) | slow | §4.6 |

Preview card: 160 × 208, `--surface-solid`, radius 8, a white sheet with a `file-text` 24 tile and the label "PDF"
(`--text-sm`); it sits in its own slot in the drop target's centre at `--z-drag` and never follows the pointer.

### 4.6 Opening: from thumbnail to page

A shared-element transition: a clone of the source sits at `--z-drag`, travels with `translate` + `scale` (FLIP, no
size properties) to the rect of the first visible page, and fades out over the last 40 % while the page's render fades
in under it; the clone is removed at the end.

| Source | From | Duration |
|---|---|---|
| Recents row | its 32 × 40 thumbnail; the empty state fades out (fast) | slow |
| Drop | the preview card | slow |
| Thumbnail panel (jump) | the thumbnail, into the target page after the scroll jump | slow |
| Open dialog, OS, second instance | no source: the first page fades in with `scale(.96 → 1)` | slow |

Other mounted pages use §4.3 only. Reduced motion: no clone; empty state out fast, page fades in base.

### 4.7 Success pulse (reusable)

Replaces confirmation dialogs; F4 onboarding uses it after each completed step.

- **API:** `pulse(target, message)` (`components/SuccessPulse`): one call, one pulse, never loops; a second call on the
  same target restarts it.
- **Anatomy:** a ring pseudo-layer on the target, radius = target radius + 2, 2 px `--color-accent`; optional glyph:
  `check` 16 in a tile replaces the target's icon for 1.2 s (status bar "Edited" → "Saved", coach-mark step).
- **Motion:** ring opacity 0 → .6 (fast), then `scale(1 → --pulse-scale 1.06)` with opacity → 0 (slow). Glyph swap:
  crossfade fast.
- **Accessibility:** `message` goes to the status bar's polite live region; focus never moves.
- **Reduced motion:** ring opacity 0 → .6 → 0, no scale. **Forced colors:** ring `Highlight`.

### 4.8 Scroll jumps

Outline, search hit, Go to page, thumbnail click: a target ≤ 2 viewport heights away scrolls with the spring (slow);
farther targets jump at once and the target page's frames fade per §4.3. Paged modes turn by crossfade (fast out,
base in). Reduced motion: always at once.

## 5. Budget

- **60 fps in the Tauri window.** For each scenario below, `node scripts/ui/cdp.mjs fps 1500 --during "<trigger>"`
  must report `avg_fps ≥ 58`, `p95 ≤ 18 ms`, and no frame above 33 ms, with a 500-page document open at 1280 × 800:
  left panel open/close, inspector open/close, banner show, fit width ↔ fit page, zoom step, open from recents, a
  popover, a toast, scrolling through 50 pages with fades.
- **Compositor first.** Animate `transform` and `opacity` only, apart from the two grid-track properties of §3 and
  hover colours. `will-change` is set when an animation starts and removed when it ends (the float sheet excepted).
- **Blur only on the toolbar and the panels** (left panel, inspector, banner, empty card: the G1 recipe). The canvas
  and everything over it carry no `filter` and no `backdrop-filter`: G2 surfaces (popover, menu, toast, drop overlay)
  are `--surface-strong` + edge + `--shadow-2` without blur. Blur radius never animates; a blurred surface only
  translates. If a panel slide misses the budget, it slides on `--surface-fallback` and its glass fades in at rest.
- **Reduced motion** (`prefers-reduced-motion: reduce`): opacity fades only, enter base, exit fast; layout changes in
  one step; zoom and scroll at once; the float stops. Motion runs under `<MotionConfig reducedMotion="user">`;
  CSS resets the transform tokens (`--scale-*`, `--offset-enter`, `--pulse-scale`, `--scale-lift` → 1 / 0).

## 6. Tokens

| Token | Value | RM |
|---|---|---|
| `--ease-spring` | the `linear()` of §1; fallback `cubic-bezier(.25,.1,.25,1)` | same |
| `--motion-fast` · `-base` · `-slow` | 120 · 200 · 320 ms | same |
| `--scale-press` · `--scale-enter` · `--scale-thumb` | .97 · .96 · 1.125 | 1 |
| `--offset-enter` | 8px | 0 |
| `--scale-lift` (new) | 1.04 | 1 |
| `--pulse-scale` (new) | 1.06 | 1 |
| `--pulse-opacity` (new) | .6 | .6 |
| `--drag-card-width` · `-height` (new) | 160 · 208 px | same |

`src/lib/motion.ts` (new): `SPRING.fast/base/slow` (Motion transitions), `ZOOM_SNAP_BAND` .08, `ZOOM_INERTIA_S` .1,
`ZOOM_INERTIA_CAP` 1.5, `JUMP_ANIMATE_MAX_VIEWPORTS` 2. Tailwind's default transition is `--ease-spring` at `--motion-fast`.

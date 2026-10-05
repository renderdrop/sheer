# Motion v2: "sheer." (v1.2, ADR-100)

Replaces the spring system of v1.1 (ADR-022). Source: `docs/REDESIGN_BRIEF.md` R5. Tokens live in `src/styles/tokens.css`; no duration, delay or curve outside them.

## 1. Rules

1. **One curve:** `--ease-out` = cubic-bezier(0.2, 0, 0, 1). No spring, overshoot or bounce. Loops are the exception: shimmer is linear; breathe and drift apply `--ease-out` to each half of an alternating keyframe pair.
2. **Three durations:** `--motion-fast` 120 ms (hover, press, colour), `--motion-base` 160 ms (position, layout, panels), `--motion-slow` 180 ms (entrances). **Exits are 40 ms shorter:** `--motion-fast-exit` 80, `--motion-base-exit` 120, `--motion-slow-exit` 140.
3. **Named exceptions (only these):** `--motion-check` 240 ms (spell 6), `--motion-scroll-max` 300 ms (spell 8), `--tooltip-delay` 400 ms (spell 16), `--stagger` 20 ms (spell 3), `--shimmer` 1200 ms (spell 15), `--breathe` 2000 ms (spell 10), `--drift` 60 s (spell 11), `--splash-max` 1500 ms (spell 10). Holds (not animations): `--hold-check` 600 ms (spell 6), `--tooltip-leave` 100 ms (spell 16), `--hold-outline` 1000 ms (spell 8, reduced motion), `--hold-shape` 500 ms (spell 20), `--saving-delay` 200 ms (spell 6).
4. **Scale ≤ 2 %** (`--scale-press` 0.98, `--scale-enter` 0.98, `--scale-lift` 1.02). Rotation only in spell 9.
5. **Nothing moves without a user action**, except the ambient glow (spell 11) and the splash glow (spell 10).
6. Animate `transform` and `opacity` only. Colour transitions are fine at `--motion-fast`. Never animate layout properties, `filter` or gradients' colour stops; glows move by `transform` on their own layer.
7. **Reduced motion** (`prefers-reduced-motion: reduce`): every spell becomes a plain opacity fade at `--motion-fast` or nothing; transforms, loops and smooth scroll are off. The variant for each spell is listed below.
8. **Budget:** 60 fps in the Tauri window; frame time p95 ≤ 16.8 ms in every spell's scenario, measured as in v1.1.
9. **Test of taste:** a spell that someone notices without looking for it is too much. Shorten or remove it.
10. Interrupting is always allowed: a new action retargets from the current value; nothing queues.

## 2. Spells

| # | Spell | Trigger | Motion | Timing | Reduced motion |
|---|---|---|---|---|---|
| 1 | Tool pill | another tool becomes active in the tool row | The Solar fill of the active tool is one shared element that glides along the horizontal tool row (translateX, width via FLIP) to the new tool; the 1 px Ink hairline travels with it; label weights swap at the end. Split chevrons and the "Mehr" overflow stay in place. Adapted to the ADR-102 tool row (no sidebar disclosures). | base 160, ease-out | fill appears at the new tool at once |
| 2 | Page indicator | current page changes | The 2 px Solar border is one element that travels between thumbnails (translateY); the page field and the chip count with `tabular-nums` (digits swap, no roll). Far jumps (> 1 viewport of thumbnails) skip the travel and fade in at the target. | base 160 | border fades at the target, fast |
| 3 | Document open | first render after open | Page 1 fades in from 8 px below (`--offset-enter`); thumbnails fade in staggered by 20 ms, at most 10 staggered, the rest appear with the 10th. | slow 180 per item, `--stagger` 20 | all fade together, fast, no offset |
| 4 | Drop zone | file dragged over the Home window | The `drop` glow's opacity follows cursor proximity to the window centre (0.35 at the edge to 1.0 at the centre, rAF, transform/opacity only, no layout shift). On drop a file card (`--drag-card-*`) fades in, settles 4 px down and cross-fades into the opening editor's page 1 (spell 3). | proximity: per frame; settle slow 180; card fade-out slow-exit 140 | glow at a fixed 0.6 while dragging; drop shows the editor with a fast fade |
| 5 | Marker trail | dragging across text with Markieren | A Solar strip at 45 % (multiply) follows the selection rectangles live, every pointer move, on the annotation layer. On release the strip's opacity eases 0.45→0.55→0.45 once ("drying ink") as the real highlight replaces it. | live; dry fast 120 | live strip stays; no dry pulse |
| 6 | Saved | save succeeds from the save status button (DESIGN §3.5 B1), File → Save or Ctrl/Cmd+S | No toast. In the status slot the Ink dot fades out, the Lucide check draws by `stroke-dashoffset` and "Saved" fades in; the check stays (it is the Saved state). "Saving…" appears only if the save takes longer than `--saving-delay`. | check 240 (the only one above 180), text fast | check and text appear with a fast fade; dot fades fast |
| 7 | Undo | undo/redo of a visible item | Undone item fades out while scaling to 0.98; redo fades in from 0.98 to 1. | fast-exit 80 out, fast 120 in | fade only |
| 8 | Comment jump | click a comment row | Canvas scrolls to the anchor (ease-out, duration scales with distance, capped at 300); then the highlight's opacity pulses once 1→0.4→1. | scroll ≤ `--motion-scroll-max`; pulse 2 × fast | instant jump; a 2 px Ink outline shows for 1 s, no pulse |
| 9 | Delete page | page deleted in the sidebar or organize grid | Thumbnail rotates 6° and fades out; neighbours slide into place (FLIP translate); the Undo toast enters. | fade/rotate base-exit 120; neighbours base 160; toast slow 180 | thumbnail fades fast; neighbours jump; toast fades |
| 10 | App start | cold start until the window is ready | Wordmark (secondary) centred on Canvas; behind it the `splash` glow breathes opacity 0.6→0.9→0.6. When ready: cross-fade into Home. Visible at most 1.5 s, never held longer than the real load. | breathe 2000 loop; cross-fade slow 180; max `--splash-max` | static glow at 0.75; cross-fade fast |
| 11 | Ambient glow | BrandSurface visible | Glow layers drift ±3 % of their container (translate) in a 60 s loop, phase offset per glow. Paused when the window is hidden or unfocused (`visibilitychange`, Tauri focus event). | `--drift` 60 s | no drift |
| 12 | Cursors | tool active over a page | SVG cursors at 2× DPR with exact hotspots: Markieren (marker), Zeichnen (pen), Formen/area tools (crosshair with a Solar dot ringed in Ink), Text (I-beam). Default cursor everywhere else. No followers, no particles. | none (cursor swap) | unchanged |
| 13 | Magnifier | hold `Z` over the canvas (not in text inputs) | Round 160 px lens with 2× content under the pointer, 1 px Ink border, `--shadow-floating`; follows the pointer in the same frame (no easing, no lag). Release hides it. | in fast 120, out fast-exit 80 | appears/disappears without fade; still follows the pointer |
| 14 | Sidebar toggle | the page sidebar opens/closes (top-bar button, edge grip, View → Sidebar) | The top-bar toggle icon swaps panel-left-open ↔ panel-left-close with a fast cross-fade; the column width animates via grid tracks; the grip stays. There is no tool sidebar (ADR-102). | base 160 | icon swaps; columns jump; content fades fast |
| 15 | Skeletons | a page or thumbnail is rendering | Sand block in the page's aspect ratio; a lighter diagonal band (`--shimmer-band`, White at 60 %, 20° slant) sweeps across. Rendered bitmap replaces it with a fast fade. | `--shimmer` 1200 loop | static Sand block, no sweep |
| 16 | Tooltips | hover or keyboard focus on a control | Appear after 400 ms; within a tooltip group (same toolbar or sidebar) moving to a neighbour shows the next one at once with no fade; shortcut as `<kbd>`. Leaves after the pointer has left for 100 ms. | delay 400; in fast 120; out fast-exit 80 | same delays, fade only |
| 17 | Zoom snap | pinch, Ctrl+wheel or zoom slider | Within ±3 % of 100 %, fit-width or fit-page the zoom snaps to that value; the readout counts with `tabular-nums`. Values outside the bands are kept exactly. | snap applied at gesture end, base 160 | snap applied instantly |
| 18 | Focus ring | focus moves by keyboard | One focus-ring overlay (`--ring-focus` geometry, follows the target's radius) glides from the previous target to the next (a positioned box moved and resized by FLIP with `transform`; the border is re-laid at the end so it never looks stretched). Pointer focus shows no ring. Jumps across containers (> 400 px) fade instead of glide. | base 160 | ring appears at the target, no glide |
| 20 | Shape snap (DESIGN §3.5 B11) | pointer held still `--hold-shape` 500 ms after a Zeichnen stroke | The freehand stroke fades to 0 while the recognised shape fades in at full opacity in the same place (cross-fade); nothing scales or travels. | fast 120 | shape replaces the stroke at once |
| 21 | Mode segment | another mode becomes active | The active segment's White fill and Stone border are one element that glides (translateX, width via FLIP) to the new segment; label weights swap at the end. Replaces the underline glide of DESIGN §3.2. | fast 120 | fill appears at the target at once |
| 22 | Bubble re-stack (DESIGN §3.5 B9) | a bubble is selected, added, resized or resolved | Other bubbles move to their new stacked position (translateY, FLIP); a new bubble fades in from 0.98. Scroll and zoom move bubbles with the page, never animated. | base 160; new bubble slow 180 | bubbles jump; new bubble fades fast |

Easter egg (optional, budget only): ten clicks on the wordmark's dot on Home move the hero glow to the dot (slow 180 ×2) and back. Reduced motion: none.

## 3. Implementation notes

- Shared-element moves (spells 1, 2, 18): Motion's layout animations or FLIP with `transform`; no `top`/`left` animation.
- Loops (10, 11, 15) run on their own compositor layer and stop when off-screen or the window is hidden.
- Each spell gets a recording in `docs/review/v1.2/motion/` plus its reduced-motion twin (R5 DoD).

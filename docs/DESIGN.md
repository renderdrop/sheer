# Design system

Seed from `ORCHESTRATOR_PROMPT.md` §3. The `designer` expands this into full component specs in Phase 3.
Source of truth for tokens in code: `src/styles/tokens.css`.

## Principles

Liquid-glass-inspired, restrained, lots of white space, thin dividers instead of borders, icons in small rounded tiles,
pill badges. **One hue family only: Iris.** Must look like 2026, not 2006. Nothing overlaps; every surface has a slot in the grid.

## Color tokens

| Token | Value | Use |
|---|---|---|
| `--iris-50` | `#F4F5FF` | light background gradient |
| `--iris-100` | `#E1E2FF` | tints, hover, tiles |
| `--iris-200` | `#C9CAFF` | tints, tiles |
| `--iris-300` | `#8E8EF2` | dark-mode accent |
| `--iris-400` | `#7B7CF0` | accent hover |
| `--iris-500` | `#5B5BD6` | accent: active tools, primary buttons, links, selection |
| `--iris-700` | `#3A3AAB` | text on tint, pressed |
| `--ink` | `#1C1C2E` | primary text |
| `--ink-60` | `#5F6072` | secondary text |
| `--ink-30` | `#B4B5C4` | disabled, dividers |
| `--surface` | `rgba(255,255,255,.72)` | glass |
| `--surface-solid` | `#FFFFFF` | glass fallback |
| success / warning / error | `#2E9E6B` / `#D98A1F` / `#D64B4B` | semantic only, never decorative |

Backgrounds: light `linear-gradient(135deg, #F4F5FF, #FAFAFF)`; dark `linear-gradient(135deg, #0F1020, #15162B)`,
dark glass `rgba(28,28,46,.62)`.

## Glass

`backdrop-filter: blur(24px) saturate(140%)`, 1 px inner edge `rgba(255,255,255,.6)`,
shadow `0 8px 32px rgba(28,28,46,.08)`. Radii: cards 20, panels 16–20, buttons 12, pills 999.
**Fallback:** without `backdrop-filter` support or with `prefers-reduced-transparency` → `--surface-solid`, identical layout.

## Typography and grid

System font stack (SF on macOS, Segoe UI Variable on Windows, `system-ui` fallback). Headings 600, body 400,
tracking −0.01em at ≥ 20 px. 8-pt grid.

## Icons and motion

Lucide (ISC). Motion 150–250 ms, spring easing, purposeful only (panels, hover, state changes, page transitions).
`prefers-reduced-motion` → no transform animations, opacity-only or instant.

## Layout (one window)

- Top: floating glass toolbar with tool groups (select, markup, comment, draw, form, sign, pages); active tool marked; tooltips with shortcut.
- Left: collapsible panel with tabs (thumbnails / outline / comments / search).
- Center: document canvas (smooth scroll, pinch and Ctrl/Cmd+scroll zoom).
- Right: contextual properties panel, only visible with a selection.
- Bottom: slim status bar (page x/y, zoom, file name).
- Empty state: drag-and-drop zone + recent files.
- Every main action has a keyboard shortcut; full operation without a mouse.

## Brand

Logo: `assets/brand/logo.svg`. Wordmark "Sheer": system font, weight 600, tracking −0.02em, color `--ink` (dark: `#FFFFFF`),
gap icon→text = 0.5 × cap height. Monochrome menu-bar/tray variant: page path only in `currentColor`, no tile.
No other logo variants.

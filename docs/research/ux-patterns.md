# Desktop UX patterns for Sheer (research, 2026-10-02)

Scope: offline PDF app, Tauri 2 webview, macOS + Windows. `[n]` = source URL below. "(unverified)" = no primary source confirmed it.

## 1. Materials and platform feel

### 1.1 Apple Liquid Glass

| Topic | Finding |
|---|---|
| Role | Glass is the control/navigation layer floating above content, never the content layer [1][2] |
| Variants | Regular (adaptive) by default. Clear only over media-rich content with a dimming layer (about 35% dark over bright content) [1][2] |
| Rules | No glass on glass; tint only primary actions; one scroll-edge effect per view (hard style on macOS); concentric radii (inner = parent minus padding) [2][3] |
| Criticism | NN/g: translucent controls blend into busy backgrounds, crowded targets [4]. Tahoe: contrast failures, inconsistent radii [5] |
| Apple's retreat | macOS 27 (22 Sep 2026): system-wide clear-to-tinted slider, default medium, reduced default transparency, edge-to-edge sidebars [5][6] |
| Accessibility | Reduce Transparency = frostier; Increase Contrast = near black/white plus borders; Reduce Motion removes elastic effects [2] |

### 1.2 Windows 11 Fluent

| Item | Guidance |
|---|---|
| Mica | Opaque base layer behind the app; solid fallback when transparency is off, Battery Saver, inactive window or high contrast [7][8] |
| Acrylic | Transient surfaces only (flyouts, menus) [7] |
| Radius | 8px windows/flyouts, 4px controls, 0 when maximized or snapped [9] |
| Title bar | 32px, empty area draggable, double-click maximizes [10] |

### 1.3 One webview design, native on both

| Layer | Shared | Per-platform adapter |
|---|---|---|
| Glass | CSS `backdrop-filter` over an opaque in-app gradient | Tauri `setEffects` offers Mica/Acrylic/vibrancy [11], but a transparent macOS window needs `macOSPrivateApi`, which blocks the Mac App Store [12]. Skip native transparency in v1. |
| Reduced transparency | Solid fallback token | WebView2 (Chromium 118+) supports `prefers-reduced-transparency`; WebKit does not [13][14]. On macOS read the OS flag in Rust and set a `data-` attribute (unverified approach). |
| Window chrome | Same toolbar | macOS: overlay title bar plus `trafficLightPosition`. Windows: `decorations: false` plus custom caption buttons; Snap Layouts need a plugin [15] |
| Menus | Same command set | macOS HIG requires every command in the menu bar [16]; use Tauri native menus |
| Labels | Same | Cmd/Option on macOS, Ctrl/Alt on Windows |

## 2. Toolbar and panel patterns

| Pattern | Guidance |
|---|---|
| Grouping | Max 3 groups, by function and frequency; do not mix symbols with text [3][17]. Our 7 groups → 4 plus "More". |
| Overflow | Order by importance; collapse to overflow as width shrinks; avoid default overflow [17][18] |
| Icons | Symbol-first, no bezels; one prominent primary action [17] |
| Active tool | `aria-pressed` toggle with accent fill plus shape change, never color alone [19] |
| Tooltips | Name plus shortcut; WCAG 1.4.13: dismissible (Esc), hoverable, persistent [20] |
| Toolbar keys | `role="toolbar"`, roving tabindex, arrows, Home/End [21] |
| Sidebar | Collapsible, not hidden by default; max 2 hierarchy levels; nothing critical at the bottom; button plus View-menu command [22] |
| Splitter | Arrows resize, Enter collapses/restores, `aria-valuenow`, persisted width [23] |
| Inspector | Apple puts inspector toggles on the trailing edge [17]. A selection-only panel risks canvas jump (recommendation: keep page centered, animate opacity only). |

## 3. Annotation UX

| Topic | Evidence and recommendation |
|---|---|
| Sticky vs one-shot | Acrobat is one-shot by default; persistence is buried ("Keep tool selected", double-click lock) [24]. Preview highlights the current selection immediately [25]. Recommend click = one-shot, double-click = locked with badge, Esc = Select. |
| Palette | Yellow highlight default; 6 swatches plus recents. Okabe-Ito colors are colorblind-safe [26]; name every swatch in text. Multiply-blend highlights (unverified). |
| Stroke | 3-4 named presets plus numeric field; typical viewer default 2 px lines [27] (exact values unverified) |
| Properties | Preview exposes border/fill, thickness, shadow, text style [25]. No selection edits tool defaults; selection edits the object. |
| Comments | Figma: pins, replies, resolve hides from canvas and list, filters (resolved, mine, this page), sort date/unread, list click jumps, key C [28]. PDF replies use `/IRT` [29]; write standard annotations. |

## 4. Onboarding, empty state, recents

| Topic | Guidance |
|---|---|
| Onboarding | NN/g: upfront tutorials are skipped and forgotten; prefer help triggered by user action [30]. Apple: brief, optional, skippable, never repeated [31]. |
| 3 screens max | (1) Offline, no account, Open. (2) Tool groups, command palette key. (3) Shortcuts and drag-drop. Skippable; then one tip per tool at first use. |
| Empty state | Status, learning cue, direct pathway [32] |
| Recents | Name, folder, last opened, thumbnail; Remove and Clear; handle missing files; "stored on this device" |
| Drag-drop | Tauri default `dragDropEnabled: true` yields file paths via `onDragDropEvent` but blocks HTML5 drag-drop in the webview on Windows [33]. Use pointer events for thumbnail reordering. |

## 5. Keyboard and focus

macOS: Command primary, Shift secondary, avoid Control, never repurpose standard keys [16]. Windows: Ctrl accelerators, F6 cycles panes, Esc closes transient UI only [34].

| Action | macOS | Windows |
|---|---|---|
| Open/Save/Print | Cmd+O/S/P | Ctrl+O/S/P |
| Find / next | Cmd+F / Cmd+G [35] | Ctrl+F / Enter |
| Zoom | Cmd+Plus/Minus | Ctrl+Plus/Minus |
| Fit page / width / 100% | Preview Cmd+9 / Cmd+0 (conflicts, unverified) | Ctrl+0 / 2 / 1 (Acrobat) [36] |
| Go to page | Opt+Cmd+G [35] | Ctrl+Shift+N [36] |
| Rotate | Cmd+L/R [35] | Ctrl+] / [ (Edge) |
| Sidebar | Opt+Cmd+1/2/3 [35] | F4 (unverified) |
| Tools | Single keys V, H, U, S, K (Acrobat) [36]; Figma C [28] | same; only when canvas focused |

Focus rules (recommendations):
- Tab order: toolbar, left panel, canvas, right panel, status bar; F6 jumps regions.
- Initial focus: Open button in empty state; never a destructive control [34].
- Closing a panel or dialog restores focus to its trigger; no traps.
- `scroll-padding-top` = toolbar height; sidebar tabs use `tablist`; page changes in a polite live region.

## 6. WCAG 2.2 AA applied

WCAG targets web content; apply to the webview UI by analogy.

| SC | Requirement | Sheer implication |
|---|---|---|
| 1.4.3 | 4.5:1 text, measured at the worst point behind it [37] | Test labels over page content scrolling under the toolbar |
| 1.4.11 | 3:1 for controls, states, focus rings; test least-contrasting area [38] | Ring and active fill must pass on glass, light and dark |
| 2.4.7 / 2.4.11 | Focus visible; not entirely hidden; floating toolbars judged at initial position [39] | Toolbar must not cover focus (2.4.13 is AAA) |
| 2.5.7 | Single-pointer alternative to every drag [40] | Reorder: Move up/down; resize: numeric fields; crop: click-click |
| 2.5.8 | 24x24 CSS px or spacing [41] | macOS default 28, minimum 20 [19]; use 32, never below 24 |
| 2.3.3 (AAA) | `prefers-reduced-motion` suffices [42] | Fades only, no blur animation [19] |

Token contrast (computed here; verify in tooling):

| Pair | Ratio | Verdict |
|---|---|---|
| iris-500 on white / iris-50 | 5.37 / 4.95 | text OK |
| iris-500 on iris-100 | 4.22 | icons only |
| white on iris-400 | 3.51 | fails text |
| iris-300 on white / on #0F1020 | 2.88 / 6.55 | dark mode only |
| ink-60 on white / iris-200 | 6.17 / 3.93 | not on iris-200 |
| ink-30 on white | 2.03 | dividers only, no control borders |
| success / warning / error on white | 3.38 / 2.76 / 4.23 | icons and fills, not small text |

## 7. Recommendations for Sheer

1. Glass only on toolbar, tab strip, inspector and popovers; page canvas opaque; never stack glass [1][2].
2. Raise default glass alpha above the 0.72 token (about 0.85, tune by contrast test); Apple moved toward opacity in macOS 27 [5][6].
3. Ship "Glass: Auto / Solid"; Solid applies automatically for forced-colors and OS reduced transparency (macOS via Rust).
4. Add a scroll-edge scrim under the floating toolbar so page text never sits under glass labels.
5. Four toolbar groups plus overflow; every item also in a native menu with its shortcut.
6. Active tool: accent fill plus pressed shape; one-shot by default, double-click locks with a badge, Esc returns to Select.
7. Toolbar is one roving tab stop; tooltips show name plus shortcut and close on Esc.
8. Left panel opens on Thumbnails; keyboard-resizable splitter, double-click resets, width persisted.
9. Right panel appears only with a selection and must not shift the page; with no selection, an options bar edits tool defaults.
10. Six Okabe-Ito-based swatches plus recents; three stroke presets plus numeric field; multiply highlights.
11. Comments tab: filter, sort, jump-to; replies saved as standard `/IRT` annotations.
12. Empty state: drop zone, Open button, recents with thumbnails and Remove/Clear.
13. At most 3 skippable onboarding screens, then per-tool tips; re-openable from Help.
14. Native drop for opening files; pointer events for in-app reordering.
15. Acrobat-style zoom keys on both OSes, Cmd on macOS as primary modifier.
16. Token fixes: no ink-30 borders, no warning/success small text, no white text on iris-400.
17. Windows custom caption buttons keep Snap Layouts and a 32px drag bar; macOS keeps traffic lights.
18. Reduced motion: opacity-only transitions.

## Sources

1. https://developer.apple.com/tutorials/data/design/human-interface-guidelines/materials.json
2. https://developer.apple.com/videos/play/wwdc2025/219/
3. https://developer.apple.com/videos/play/wwdc2025/356/
4. https://www.nngroup.com/articles/liquid-glass/
5. https://www.macrumors.com/2026/06/09/macos-golden-gate-liquid-glass/
6. https://9to5mac.com/2026/09/22/macos-27-gives-you-more-control-over-liquid-glass/
7. https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/materials
8. https://learn.microsoft.com/en-us/windows/apps/design/style/mica
9. https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/geometry
10. https://learn.microsoft.com/en-us/windows/apps/design/basics/titlebar-design
11. https://v2.tauri.app/reference/javascript/api/namespacewindow/
12. https://github.com/tauri-apps/tauri-docs/issues/463
13. https://developer.chrome.com/blog/css-prefers-reduced-transparency
14. https://caniuse.com/wf-prefers-reduced-transparency
15. https://github.com/clearlysid/tauri-plugin-decorum
16. https://developer.apple.com/tutorials/data/design/human-interface-guidelines/keyboards.json and https://developer.apple.com/tutorials/data/design/human-interface-guidelines/the-menu-bar.json
17. https://developer.apple.com/tutorials/data/design/human-interface-guidelines/toolbars.json
18. https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/command-bar
19. https://developer.apple.com/tutorials/data/design/human-interface-guidelines/accessibility.json
20. https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html
21. https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/
22. https://developer.apple.com/tutorials/data/design/human-interface-guidelines/sidebars.json
23. https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/
24. https://acrobatusers.com/tutorials/print/there-way-keep-tool-sticky/
25. https://support.apple.com/guide/preview/annotate-a-pdf-prvw11580/mac
26. https://scifig.ai/blog/okabe-ito-color-palette-hex-codes
27. https://help.syncfusion.com/document-processing/pdf/pdf-viewer/javascript-es5/annotations/customize-annotation
28. https://help.figma.com/hc/en-us/articles/360041547593-View-and-manage-comments
29. https://kb.itextpdf.com/it5kb/how-to-add-an-in-reply-to-annotation
30. https://www.nngroup.com/articles/onboarding-tutorials/
31. https://developer.apple.com/tutorials/data/design/human-interface-guidelines/onboarding.json
32. https://www.nngroup.com/articles/empty-state-interface-design/
33. https://takazudomodular.com/pj/zudo-tauri/docs/frontend/drag-drop/
34. https://learn.microsoft.com/en-us/windows/apps/design/input/keyboard-interactions
35. https://www.webnots.com/keyboard-shortcuts-for-preview-app-in-mac/
36. https://keyshortcuts.net/acrobat-shortcuts
37. https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
38. https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
39. https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html
40. https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html
41. https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
42. https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html

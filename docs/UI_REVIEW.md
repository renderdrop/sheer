# UI review tooling (dev only)

Screenshots, recordings and scripted input of the REAL Tauri window on Windows, for designer
reviews (ORCHESTRATOR_PROMPT 8.6) and docs/FEEDBACK.md F2/F3 acceptance. Nothing here is shipped;
no dependencies, no change to `tauri.conf.json` or capabilities. Output goes to `review/` (git-ignored).

## Start / stop

```
node scripts/ui/dev.mjs       # or bash scripts/ui/dev.sh: npm run tauri dev with WebView2 DevTools on 127.0.0.1:9222
```
Stop with Ctrl+C, or `taskkill /F /IM sheer.exe` and then end the vite/tauri processes when run in the background.

## Drive (Node 22, built-ins only)

```
node scripts/ui/cdp.mjs eval "document.title"
node scripts/ui/cdp.mjs theme dark            # light | dark | system, via the app's settings store
node scripts/ui/cdp.mjs fps 2000              # frame time p50/p95, min and avg fps from rAF
node scripts/ui/cdp.mjs fps 3000 --during "window.scrollBy(0, 4000)"
```
`theme` imports every served instance of `/src/stores/settings.ts` (Vite HMR can create several) and sets the theme on each.

## Capture (PowerShell)

```
powershell -File scripts/ui/shot.ps1 -Out review/empty-light.png
powershell -File scripts/ui/record.ps1 -Seconds 2 -Fps 15 -Out review/idle.png
```
Both bring the `sheer` window to about 1280x800 client size (per-monitor DPI aware) and use PrintWindow
with PW_RENDERFULLCONTENT. `record.ps1` writes an APNG with real frame delays plus `<name>-strip.png`
(8-frame filmstrip). The window must not be minimized.

## Open a document

The app is single-instance: a second launch forwards its argument to the running window.
```
src-tauri/target/debug/sheer.exe tests/fixtures/text.pdf
```
Wait about 1.5 s before capturing.

## Limits

- PrintWindow captures the window content, not OS effects behind it (acrylic/mica).
- Recording speed is bound by PrintWindow (about 10-20 fps); use `cdp.mjs fps` for real frame pacing.

## Smooth recording (CDP screencast)

```
node scripts/ui/cdp.mjs record 1500 --out review/x.png --delay 200 --scale 0.5 --during "<js>"
```

- Uses `Page.startScreencast`: the WebView content of the Tauri window only (no OS caption), smooth (about 60 fps).
- Writes an APNG with real frame delays plus `x-f01..f06.png` stills; prints frame count and capture fps.
- `record.ps1` (PrintWindow) captures the whole window incl. caption but is slow (about 11 fps); use it for static shots.

## Annotation smoke test (milestone DoD)

```
node scripts/ui/dev.mjs                 # in one terminal
node scripts/ui/annot-smoke.mjs         # in another; exit code 1 if any row fails
```
Opens `tests/fixtures/text.pdf` (second launch of the debug exe) and the welcome document (the app's `openWelcome`), and for each
of them makes one annotation per tool with real CDP mouse and keyboard input (`Input.dispatchMouseEvent`, `Input.insertText`):
Highlight on text, Note (click, type in the popover), Text comment (click, type, Esc), Draw, Rectangle, and the M4 Sign tool
(check mark, date, typed signature). Each row is verified against the annotations store and printed in a table. jsdom cannot see
hit-testing (a layer under a `pointer-events-none` parent is dead in the window and green in vitest, FEEDBACK F9), so this run is a
required step before a milestone tag. Only tool selection and arming the Sign item use the stores; everything else is real input.
Stop the dev window afterwards (`taskkill /F /IM sheer.exe`): a running exe blocks `cargo test` on Windows.

## Performance budget (M7 F3, ADR-053 section 4)

Targets: a 500-page PDF shows its first page in under 1 s; scrolling holds 60 fps (p95 frame time at most 20 ms).

Procedure (Tauri dev window, debug build, so a release build is only faster):

1. `node scripts/ui/gen-pdf.mjs <scratch>/p500.pdf 500` (not committed), then `node scripts/ui/dev.mjs` in the background.
2. Open it with `src-tauri/target/debug/sheer.exe <scratch>/p500.pdf` (single-instance forwards the path to the running window).
3. Time to first page: in-page poll for `[data-page="1"] img` loaded, against the launch time.
4. Scroll: `node scripts/ui/cdp.mjs fps 3300 --during "<script>"`, where the script sets `scrollTop` of `.overflow-auto` (the canvas region) from a rAF loop over 3 s.
5. Stop the window: `taskkill //F //IM sheer.exe`.

Result (2026-10-04, Windows 11, debug build, 500 Letter pages, region 632 px high, 497 208 px of content):

| Scenario | p50 | p95 | min fps | avg fps |
| --- | --- | --- | --- | --- |
| Scroll 6 000 px/s (about 7 pages/s) | 16.7 ms | 16.8 ms | 59.5 | 60.0 |
| Fling 60 000 px/s (about 70 pages/s) | 16.7 ms | 16.7 ms | 59.5 | 60.0 |
| Whole document in 3 s (500 pages) | 16.7 ms | 16.8 ms | 59.2 | 60.0 |

Time to first page: about 190 ms from launching the forwarding process to the first page image loaded (includes the second process start and the engine round trip).

Both targets are met. Unit budgets guard the frontend paths (`src/features/viewer/layout.perf.test.ts`: 500 and 5 000 pages, at most 24 mounted pages (strict); the timing asserts are deliberately generous, 1 s build and 8 ms per scroll frame, so shared CI runners do not flake; `src/engine/renderCache.test.ts`: cache stays within its byte budget over 500 pages).

### Interaction frame pacing (M7, 2026-10-04)

Same setup (Tauri dev window, debug build, WebView2, rAF frame times over 3 s via `cdp.mjs fps 3000 --during`). Interactions are real shortcuts
dispatched on `window` (Ctrl+Plus/Minus, Ctrl+2/Ctrl+0, F4, Shift+F4); the theme goes through the settings store. Zoom, fit and panel
changes were verified to take effect (page width 756 to 898 px, fit width, fit page, canvas width 828 to 1006 to 532 px).

| Scenario (500 pages and text.pdf alike) | p50 | p95 | min fps |
| --- | --- | --- | --- |
| Idle, 3 s | 16.7 ms | 16.7-16.8 ms | 58.8-59.5 |
| Zoom: 5 steps in, 5 steps out (every 250 ms) | 16.7 ms | 16.7-16.8 ms | 59.2-59.5 |
| Fit width / fit page toggled 6 times | 16.7 ms | 16.8 ms | 59.5 (one 34 ms frame in a first run) |
| Left panel open/close, 4 times | 16.7 ms | 16.8 ms | 59.2-59.5 |
| Inspector open/close, 4 times | 16.7 ms | 16.7-16.8 ms | 57.8-59.5 |
| Theme dark/light, 4 switches | 16.7 ms | 16.7-16.8 ms | 58.8-59.5 |

All scenarios hold 60 fps (p95 at most 16.8 ms, target 20 ms); no fix was needed. The webview caps rAF at the display rate, so a p95 of
16.7 ms means "no frame missed", not headroom. Isolated single frames of 30 ms or more can occur when a render or a rebuild runs in the background.
Note: `tauri dev` restarts the app when any file under `src-tauri` changes, so measure while no Rust work is in progress.

## CSP gate (milestone DoD)

```
npm run build
node scripts/ui/cdp.mjs csp            # exit code 1 on any violation
node scripts/ui/cdp.mjs csp --attach   # dev app with a PDF open: records inline-style writes the release CSP would block
```
Serves `dist/` with the release CSP (`style-src 'self'`, from `tauri.conf.json`) in headless Edge or Chrome with a stub backend and
collects `securitypolicyviolation` events. The stub backend opens a stub document (a 1x1 PNG render frame for each page), returns one recovery record and an update offer, and the run exercises the settings popover, the update details, the More-menu dialogs (export images, export copy, print, protect, properties), the tool keys, the inspector toggle, the Sign menu and every toolbar button. `--attach` covers
what the stub cannot (real pages, forms, the signature sheet content; it records `setAttribute('style')` and `<style>` elements; read `window.__csp` afterwards).
`CSP_SELFTEST=1` injects a known violation to prove the gate catches it. A milestone tag needs `violations=0` from both runs. DoD step for `--attach`: start `node scripts/ui/dev.mjs`, open a PDF, run the annotation tools, the output dialogs and the signature sheet by hand (or `annot-smoke.mjs`), then run `node scripts/ui/cdp.mjs csp --attach` against that window (the dev CSP stays, the probe logs what the release CSP would block) and read `window.__csp` with `cdp.mjs eval "JSON.stringify(window.__csp)"`; it must be empty.
Style props set by React and Motion go through the CSSOM and are allowed; inline `style="..."` markup, `<style>` elements and
`setAttribute('style', ...)` are not: use classes or CSS variables set with `element.style.setProperty`.

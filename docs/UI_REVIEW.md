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

Both targets are met. Unit budgets guard the frontend paths (`src/features/viewer/layout.perf.test.ts`: 500 and 5 000 pages, metrics build under 50 ms, under 0.5 ms per scroll frame, at most 24 mounted pages; `src/engine/renderCache.test.ts`: cache stays within its byte budget over 500 pages).

## CSP gate (milestone DoD)

```
npm run build
node scripts/ui/cdp.mjs csp            # exit code 1 on any violation
node scripts/ui/cdp.mjs csp --attach   # dev app with a PDF open: records inline-style writes the release CSP would block
```
Serves `dist/` with the release CSP (`style-src 'self'`, from `tauri.conf.json`) in headless Edge or Chrome with a stub backend and
collects `securitypolicyviolation` events across the empty state, the settings popover and every toolbar button. `--attach` covers
the surfaces that need a real document (it records `setAttribute('style')` and `<style>` elements; read `window.__csp` afterwards).
`CSP_SELFTEST=1` injects a known violation to prove the gate catches it. A milestone tag needs `violations=0` from both runs.
Style props set by React and Motion go through the CSSOM and are allowed; inline `style="..."` markup, `<style>` elements and
`setAttribute('style', ...)` are not: use classes or CSS variables set with `element.style.setProperty`.

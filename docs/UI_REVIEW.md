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
node scripts/ui/cdp.mjs fps 2000              # frame time p50/p95, min and avg fps from rAF
node scripts/ui/cdp.mjs fps 3000 --during "window.scrollBy(0, 4000)"
```

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
dispatched on `window` (Ctrl+Plus/Minus, Ctrl+2/Ctrl+0, F4, Shift+F4). Zoom, fit and panel
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

## Surface gate (milestone DoD, F17.10)

```
node scripts/ui/dev.mjs                      # in one terminal
node scripts/ui/surface-gate.mjs [--wide]    # exit code 1 on any violation; --wide adds 1280x800; --only <text> filters
```
Sets the viewport to 960x640 (CDP `Emulation.setDeviceMetricsOverride`), opens `tests/fixtures/text.pdf`, then opens every dialog and
sheet from the dev-only registry `window.__sheerSurfaces` (`src/dev/surfaces.ts`, imported by `main.tsx` behind `import.meta.env.DEV`;
`check.sh` fails the bundle guard if a release bundle names it) and every popover or menu trigger on screen (`aria-haspopup`, once per mode).
Per surface four checks, printed as a table: inside (the rect lies in the viewport), clipped (no button/input/select/textarea is cut by an
overflow ancestor or the viewport), scroll (no internal scroll except in `role=list|listbox|grid|tree` or `data-scroll="list"`), overlap
(no tooltip, tip or coach mark under it; a popover covers no control outside it; modals cover the inert app by design). Violations are
blockers. A new dialog or sheet needs an entry in the registry; a new popover is found by its trigger. The pure checks live in
`scripts/ui/surface-checks.mjs` (unit tests: `surface-checks.test.ts`). Stop the dev window afterwards (`taskkill /F /IM sheer.exe`).

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

## Acceptance build (ADR-131)

Acceptance runs only against the acceptance build, never the dev, release or installed Sheer (rule 15).

```
npm run build:acceptance                                  # src-tauri/target-acceptance/release/sheer-acceptance.exe
node scripts/ui/accept/example-edit-text.mjs              # CDP-driven example (v1.5.1 text-edit flow)
node scripts/ui/accept/smoke-real.mjs                     # the only real OS mouse/keyboard script, 5 min cap
```
The build has identifier `app.sheer.acceptance` (own data folder, recent list, single-instance channel) and the Cargo feature `automation`:
native dialogs are answered from a queue, print writes nothing. An empty queue is an error, never a native dialog.

Toolkit in `scripts/ui/accept/` (Node 22 built-ins only; pure helpers in `pure.mjs`, tests in `scripts/ui/accept.test.ts`):
- `launch.mjs`: starts the acceptance exe only (path check refuses anything else or an install path), sets
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<p> --remote-debugging-address=127.0.0.1`, waits for CDP, sets a 1280x800
  viewport. `session.close()` kills only its own process tree by pid.
- `cdp-input.mjs`: `click/dblclick/hover/drag` by `{selector,text,role,nth}` (scrolled into view, centre from the live rect) or `{x,y}`;
  `press(key, {ctrl,shift,alt})`, `insertText`, `waitFor`, `waitForTarget`, `screenshot(name)` into `review/`. All via `Input.dispatch*`.
- `dialogs.mjs`: `answerOpen/answerOpenMany/answerFolder/answerSave/answerMessage/answerPrint`, `cancelNext`, `lastPrint`, `lastError`,
  `openFile(path)` (queue + Ctrl+O). Calls `automation_queue_dialog` / `automation_state` through `window.__TAURI_INTERNALS__.invoke`.
- `guard.mjs` + `guard.ps1`: every 250 ms the foreground window and all top-level windows of the acceptance process tree are checked. A
  foreign foreground window (two snapshots in a row) or an unexpected window (`#32770` or any class outside the app's own) sends Esc to it,
  aborts the script and prints title, class, pid and the last step. It never clicks. Use `startGuard(pid)` and race `guard.aborted`.
- `smoke-real.mjs` + `os-input.ps1`: real OS input against the acceptance window only (refuses other processes, needs foreground), hard
  5-minute cap, start/end banner. Announce it in the chat before and after.

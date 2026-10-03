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

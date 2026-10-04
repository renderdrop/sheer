# STATE
phase: maintenance (F11 → v1.0.1, then F12 → v1.1.0)
version: 1.0.0
current_item: F11 wave 1 — packages A (redaction, backend), B (preview/tools), C (annotation edit + comments panel), D (tour tab + draw pad)
last_completed: v1.0.0 (6babe5f)
loop_count_this_session: 0
open_blockers: 3 human-only (B-001, B-002, B-005)
notes: Source docs/FEEDBACK.md F11/F12. Acceptance in the INSTALLED build with real OS mouse: build NSIS (`npm run tauri build`), install
  silently, launch with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223, drive with scripts/ui/mouse.ps1 (+ CDP_PORT=9223 cdp.mjs).
  Repro findings (installed 1.0.0): CreationLayer/PlacementLayer pass page size in pt to overlayBox (expects px) → preview shifted by
  (pxPerPt-1)*size/2; moving a new rectangle leaves the original (saved file has 2 /Square); tool falls back to Select after each annotation;
  tool options inspector toggles with the tool and re-fits zoom (115 %→78 %). Owner screenshots in review/owner/.

# STATE
phase: F12 → v1.1.0 "Structure and comfort"
version: 1.0.1
current_item: F12 wave 1 — P1 hub (§3.54), P2 toolbar/menu bar/sidebar/inspector (§3.55–3.57), P3 forms + Fill & Sign + signature fonts (§3.58, §3.60), P4 Word-style comments (§3.59)
last_completed: v1.0.1 (d6d7244, tag v1.0.1) — F11 accepted in the installed build
loop_count_this_session: 0
open_blockers: 3 human-only (B-001, B-002, B-005)
notes: Spec DESIGN §3.54–§3.60 + ADR-058 (designer SPEC: READY). Acceptance in the INSTALLED build with real mouse: `npm run tauri build`,
  install NSIS with /S, launch with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223, drive with scripts/ui/mouse.ps1
  (CDP_PORT=9223 for cdp.mjs). A crash recovery banner may appear after taskkill — click "Verwerfen" by mouse first.

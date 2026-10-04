# STATE
phase: done (v1.1.0)
version: 1.1.0
current_item: none — v1.1.0 released; next work only on the owner's request (FEEDBACK.md, ROADMAP "v1.2 polish")
last_completed: v1.0.1 (d6d7244, tag v1.0.1) — F11 accepted in the installed build
loop_count_this_session: 0
open_blockers: 3 human-only (B-001, B-002, B-005)
notes: Spec DESIGN §3.54–§3.60 + ADR-058 (designer SPEC: READY). Acceptance in the INSTALLED build with real mouse: `npm run tauri build`,
  install NSIS with /S, launch with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223, drive with scripts/ui/mouse.ps1
  (CDP_PORT=9223 for cdp.mjs). A crash recovery banner may appear after taskkill — click "Verwerfen" by mouse first.

# STATE
phase: done (v1.1.0)
version: 1.1.0
current_item: none — v1.1.0 released; next work only on the owner's request (FEEDBACK.md, ROADMAP "v1.2 polish")
last_completed: v1.1.0 (c086f82, tag v1.1.0); v1.0.1 (d6d7244)
loop_count_this_session: 0
open_blockers: 3 human-only (B-001, B-002, B-005)
notes: F11 (v1.0.1) and F12 (v1.1.0) done and accepted in the installed build with the real OS cursor (scripts/ui/mouse.ps1).
  Installed build on this machine = 1.1.0. Last completed CI on main green; the v1.1.0 CI + release runs were started by the tag push.
  Open: ROADMAP "v1.2 polish" (designer/reviewer/security minors), blockers B-001/B-002/B-005. .claude/state/DONE set.
  Acceptance recipe: npm run tauri build → NSIS /S → launch with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 →
  dismiss the recovery banner first (it shifts the layout) → measure, then drive with mouse.ps1; verify via the saved file, not IPC hooks.

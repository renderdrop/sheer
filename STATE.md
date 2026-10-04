# STATE
phase: done
version: 1.0.0
current_item: none — v1.0.0 released (tag v1.0.0 on 6babe5f). Further work only on the product owner's request (FEEDBACK.md, v1.1 backlog in ROADMAP.md).
last_completed: M7 Polish and ship → v1.0.0 (6babe5f)
loop_count_this_session: 0
open_blockers: 3 human-only (B-001 macOS UI never seen on a Mac; B-002 code signing/notarization; B-005 updater minisign key) — see docs/BLOCKERS.md incl. the signing guide
notes: Final report. All ROADMAP items M1–M7 are [x]; FEEDBACK F1–F10 done. v1.0.0 DoD: npm run check green (17 steps; check.sh caps cargo test jobs, os error 1455), tauri build --debug ok, CI run 37178695107 green on Windows + macOS, tester PASS, full security audit PASS (0 critical/high), designer PASS (no blockers), annot-smoke 16/16, CSP gate 0/0 (stub + attach), print gate ok, fuzz corpus green, manifests at 1.0.0, CHANGELOG 1.0.0.
  Releases 0.8.0, 0.8.1, 0.9.0 built by release.yml; v1.0.0 release run started by the tag push. Installers are unsigned until B-002; the updater refuses to run until the owner replaces src-tauri/updater/minisign.pub (B-005).
  v1.1 backlog: Unicode fonts for inserted text, editing existing text, JPEG pass-through, reveal in folder, native vector printing, disabled-icon contrast decision, menu tooltips, client-side estimate.
  .claude/state/DONE is set (stop condition 1). To resume: delete it, add items to docs/FEEDBACK.md or ROADMAP.md.
  Run `npm run check` from Git Bash. Rust in ~/.cargo/bin. Window checks: docs/UI_REVIEW.md (annot-smoke, csp, print gate).

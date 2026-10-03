# STATE
phase: M2
version: 0.4.0
current_item: M2 wave 1 — designer DESIGN §3.22–3.27 + P4 annotation model/undo (running); then wave 2: P5 markup+notes+free text, P6 ink+shapes+inspector, P7 save+AP+interop; then P8 comments panel+onboarding+Politur M2
last_completed: M1 Viewer released as v0.4.0 (tag v0.4.0); FEEDBACK F1–F6 done
loop_count_this_session: 0
open_blockers: 1 (B-001: macOS CI green; the UI has never been seen running on a Mac)
notes: docs/FEEDBACK.md (product owner) has priority over ROADMAP.md (§14). After every commit: git push origin main --tags, then check CI (§9); CI green on Windows + macOS is in the DoD (§8.6).
  Open for the product owner: repo setting "Dependabot security updates" is off (F6 note).
  Known: PDFium wedge cases until M7 (respawn ≤3); recents thumbnail deferred to M7. Run `npm run check` from Git Bash. Rust in ~/.cargo/bin.

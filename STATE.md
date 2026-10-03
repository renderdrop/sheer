# STATE
phase: M5
version: 0.7.0
current_item: M5 backend committed (0318988; A, D PASS). Running: B crop FIX round, C redaction FIX round (hidden document-level data), M5 UI seams (i18n, toolbar Edit cluster, More menu, mode store, stub components). Next: UI wave F1 insert | F2 crop | F3 redaction | F4 protect+properties (DESIGN §3.36–§3.40), then Politur M5 Rust half
last_completed: M5 backend wave (0318988)
loop_count_this_session: 0
open_blockers: 2 (B-001 UI never seen on a Mac, macOS keychain untested; B-002 code signing)
notes: Repository renderdrop/sheer is public with the rewritten history; doc hashes mapped to it (ADR-046). Old Actions run IDs refer to the old private repo.
  CI: every push to main runs Windows + macOS (docs-only skipped); tag pushes run only release.yml (ADR-046). Read CI once per milestone, never wait (ADR-030).
  FEEDBACK (product owner) before ROADMAP (§14). Push after every commit. Dependabot cargo run 37150881129 failed with 403 during the visibility switch — transient.
  Designer review: one round, only blockers → fix. fps + onboarding steps in M7. Should/Could → v1.1 backlog ([~]).
  Run `npm run check` from Git Bash. Rust in ~/.cargo/bin.

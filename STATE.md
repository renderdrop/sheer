# STATE
phase: M5
version: 0.7.0
current_item: M5 — cut packages, backend wave first (ADR-038); Politur M5 includes the M4 design/polish leftovers
last_completed: M4 Forms and signature released as v0.7.0 (tag v0.7.0); repository public, CI on both platforms per push (ADR-046)
loop_count_this_session: 0
open_blockers: 2 (B-001 UI never seen on a Mac, macOS keychain untested; B-002 code signing)
notes: Repository renderdrop/sheer is public with the rewritten history; doc hashes mapped to it (ADR-046). Old Actions run IDs refer to the old private repo.
  CI: every push to main runs Windows + macOS (docs-only skipped); tag pushes run only release.yml (ADR-046). Read CI once per milestone, never wait (ADR-030).
  FEEDBACK (product owner) before ROADMAP (§14). Push after every commit. Dependabot cargo run 37150881129 failed with 403 during the visibility switch — transient.
  Designer review: one round, only blockers → fix. fps + onboarding steps in M7. Should/Could → v1.1 backlog ([~]).
  Run `npm run check` from Git Bash. Rust in ~/.cargo/bin.

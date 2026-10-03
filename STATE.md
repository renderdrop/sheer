# STATE
phase: M5 (not started — product owner asked to stop after v0.7.0; .claude/state/STOP is set)
version: 0.7.0
current_item: next session: delete .claude/state/STOP only when the product owner says so; then M5 — backend wave first (ADR-038), Politur M5 includes the M4 design/polish leftovers
last_completed: M4 Forms and signature released as v0.7.0 (tag v0.7.0)
loop_count_this_session: 0
open_blockers: 2 (B-001 UI never seen on a Mac, macOS keychain untested; B-002 code signing)
notes: CI at tag time: the manual release-candidate run 37145839479 (Windows + macOS, ADR-043) was still running — read it once next session; the tag push runs both platforms again. The dispatch run and push runs on main share one concurrency group and cancel each other (fix: separate group for workflow_dispatch).
  FEEDBACK (product owner) before ROADMAP (§14). Push after every commit; CI checked once per milestone, never wait (ADR-030/043).
  Designer review: one round, only blockers → fix. fps + onboarding steps in M7. Should/Could → v1.1 backlog ([~]).
  If the `backend-implementer` agent type is not available, brief `implementer` and continue it at its turn limit.
  Run `npm run check` from Git Bash. Rust in ~/.cargo/bin.

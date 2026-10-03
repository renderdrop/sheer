# STATE
phase: M4
version: 0.6.0
current_item: M4 frontend wave: F1 form filling, F2 signature sheet, F3 place + Fill&Sign, F4 library screen + Politur M4 UI items; then Politur M4 backend (prescan mediums) + milestone end
last_completed: M4 backend wave (56568a0)
loop_count_this_session: 0
open_blockers: 2 (B-001 UI never seen on a Mac; B-002 code signing)
notes: FEEDBACK (product owner) before ROADMAP (§14). Push after every commit; CI checked once per milestone, never wait (ADR-030).
  Designer review: one round, only blockers → fix. fps + onboarding steps in M7. Should/Could → v1.1 backlog ([~]).
  Author name empty by default (ADR-034). Pre-scan = PDF tokenizer (ADR-040), defence in depth until the M7 engine process.
  If the `backend-implementer` agent type is not available in a session, brief `implementer` and say "maxTurns 160 intended".
  Run `npm run check` from Git Bash. Rust in ~/.cargo/bin.

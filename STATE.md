# STATE
phase: M4
version: 0.6.0
current_item: Politur M4 (Rust half + frontend half in parallel); then M4 milestone end (tester, full security, 4 screenshots, one designer round, CI once) → v0.7.0
last_completed: M4 UI wave (5dbd083)
loop_count_this_session: 0
open_blockers: 2 (B-001 UI never seen on a Mac; B-002 code signing)
notes: FEEDBACK (product owner) before ROADMAP (§14). Push after every commit; CI checked once per milestone, never wait (ADR-030).
  Designer review: one round, only blockers → fix. fps + onboarding steps in M7. Should/Could → v1.1 backlog ([~]).
  Author name empty by default (ADR-034). Pre-scan = PDF tokenizer (ADR-040), defence in depth until the M7 engine process.
  If the `backend-implementer` agent type is not available in a session, brief `implementer` and say "maxTurns 160 intended".
  Run `npm run check` from Git Bash. Rust in ~/.cargo/bin.

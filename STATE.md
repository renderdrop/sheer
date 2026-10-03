# STATE
phase: M4
version: 0.6.0
current_item: M4 backend wave (ADR-038): S1 forms model, S2 flatten, S3 signature/mark kinds + images + font, S4 encrypted library + keychain; frontend wave after their commands + src/api wrappers are committed
last_completed: M3 v0.6.0 (13b265d); ADR-041/042 M4 specs
loop_count_this_session: 0
open_blockers: 2 (B-001 UI never seen on a Mac; B-002 code signing)
notes: FEEDBACK (product owner) before ROADMAP (§14). Push after every commit; CI checked once per milestone, never wait (ADR-030).
  Designer review: one round, only blockers → fix. fps + onboarding steps in M7. Should/Could → v1.1 backlog ([~]).
  Author name empty by default (ADR-034). Pre-scan = PDF tokenizer (ADR-040), defence in depth until the M7 engine process.
  If the `backend-implementer` agent type is not available in a session, brief `implementer` and say "maxTurns 160 intended".
  Run `npm run check` from Git Bash. Rust in ~/.cargo/bin.

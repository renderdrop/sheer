#!/usr/bin/env bash
# Blockiert das Stoppen, solange offene ROADMAP-Punkte existieren und die Loop-Obergrenze nicht erreicht ist.
set -u
INPUT=$(cat)
# Normalize Windows backslash paths (Git Bash) — no-op on macOS/Linux. See ADR-000.
ROOT=$(printf '%s' "${CLAUDE_PROJECT_DIR:-$PWD}" | tr '\\' '/'); STATE="$ROOT/.claude/state"; mkdir -p "$STATE"
[ -f "$STATE/STOP" ] && exit 0                      # manueller Not-Aus
[ -f "$STATE/DONE" ] && exit 0                      # Ziel erreicht
[ -f "$ROOT/ROADMAP.md" ] || exit 0                 # noch kein Bootstrap: normales Verhalten
MAX="${CC_MAX_LOOPS:-60}"
STUCK_MAX=10                                        # loops without a new commit on main → stop
COUNT=$(cat "$STATE/loop_count" 2>/dev/null || echo 0)
# docs/FEEDBACK.md (product-owner feedback) goes before the roadmap (ORCHESTRATOR_PROMPT §14).
SRC="FEEDBACK"; NEXT=$(grep -m1 -E '^- \[ \]' "$ROOT/docs/FEEDBACK.md" 2>/dev/null || true)
[ -z "$NEXT" ] && { SRC="ROADMAP"; NEXT=$(grep -m1 -E '^- \[ \]' "$ROOT/ROADMAP.md" || true); }
[ -z "$NEXT" ] && exit 0                          # nichts offen → stoppen erlaubt
# Turn ended only to wait for agents (ORCHESTRATOR_PROMPT §7.6): not a loop, keep going.
if [ -f "$STATE/WAITING" ]; then
  rm -f "$STATE/WAITING"
  printf '{"decision":"block","reason":"Waiting for agents (loop not counted). Do not stop; continue when their results arrive."}'
  exit 0
fi
if [ "$COUNT" -ge "$MAX" ]; then
  echo "Loop cap $MAX reached; stopping. Update STATE.md before next session." >&2
  exit 0
fi
# Stuck detection: count loops since main last moved.
HEAD=$(git -C "$ROOT" rev-parse --verify -q refs/heads/main 2>/dev/null || echo none)
LAST=$(cat "$STATE/last_main" 2>/dev/null || echo "")
STALL=$(cat "$STATE/stall_count" 2>/dev/null || echo 0)
if [ "$HEAD" = "$LAST" ]; then STALL=$((STALL + 1)); else STALL=0; echo "$HEAD" > "$STATE/last_main"; fi
echo "$STALL" > "$STATE/stall_count"
if [ "$STALL" -ge "$STUCK_MAX" ]; then
  echo "Stuck: $STALL loops without a new commit on main; stopping. Record the blocker in STATE.md." >&2
  exit 0
fi
echo $((COUNT + 1)) > "$STATE/loop_count"
NEXT_CLEAN=$(printf '%s' "$NEXT" | tr -d '"\\' | head -c 200)
printf '{"decision":"block","reason":"Loop %s/%s. Do not stop. Update STATE.md, then run the Feature Loop (section 8.4) on the next work package (next open %s item: %s). If an item is blocked, record it in docs/BLOCKERS.md, tick it as [~] and take the next one."}' "$((COUNT + 1))" "$MAX" "$SRC" "$NEXT_CLEAN"
exit 0

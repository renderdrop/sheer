#!/usr/bin/env bash
# Blockiert das Stoppen, solange offene ROADMAP-Punkte existieren und die Loop-Obergrenze nicht erreicht ist.
set -u
INPUT=$(cat)
# Normalize Windows backslash paths (Git Bash) — no-op on macOS/Linux. See ADR-000.
ROOT=$(printf '%s' "${CLAUDE_PROJECT_DIR:-$PWD}" | tr '\\' '/'); STATE="$ROOT/.claude/state"; mkdir -p "$STATE"
[ -f "$STATE/STOP" ] && exit 0                      # manueller Not-Aus
[ -f "$STATE/DONE" ] && exit 0                      # Ziel erreicht
[ -f "$ROOT/ROADMAP.md" ] || exit 0                 # noch kein Bootstrap: normales Verhalten
MAX="${CC_MAX_LOOPS:-25}"
COUNT=$(cat "$STATE/loop_count" 2>/dev/null || echo 0)
NEXT=$(grep -m1 -E '^- \[ \]' "$ROOT/ROADMAP.md" || true)
[ -z "$NEXT" ] && exit 0                            # nichts offen → stoppen erlaubt
if [ "$COUNT" -ge "$MAX" ]; then
  echo "Loop cap $MAX reached; stopping. Update STATE.md before next session." >&2
  exit 0
fi
echo $((COUNT + 1)) > "$STATE/loop_count"
NEXT_CLEAN=$(printf '%s' "$NEXT" | tr -d '"\\' | head -c 200)
printf '{"decision":"block","reason":"Loop %s/%s. Do not stop. Update STATE.md, then run the Feature Loop (section 8.4) on the next open ROADMAP item: %s. If it is blocked, record it in docs/BLOCKERS.md, tick it as [~] in ROADMAP.md and take the next one."}' "$((COUNT + 1))" "$MAX" "$NEXT_CLEAN"
exit 0

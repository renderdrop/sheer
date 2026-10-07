#!/usr/bin/env bash
set -u
INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | sed -n 's/.*"command" *: *"\(.*\)".*/\1/p' | head -c 4000)
deny() { echo "BLOCKED by guard-bash: $1" >&2; exit 2; }
case "$CMD" in
  *"rm -rf /"*|*"rm -rf ~"*|*"rm -rf ."*|*"rm -rf .git"*) deny "destructive rm" ;;
  *"git push --force"*|*"git push -f"*)                     deny "force push" ;;
  *"git reset --hard"*|*"git checkout -- ."*|*"git clean -fd"*) deny "history/worktree destruction" ;;
  *"curl "*"| sh"*|*"curl "*"| bash"*|*"wget "*"| sh"*)    deny "piping remote scripts to shell" ;;
esac
# Rule 17 / ADR-136 (7): the orchestrator waits for agents event-driven (task notifications, run_in_background), never with a
# foreground sleep of more than 2 minutes, alone or as a `seq 1 N` / `{1..N}` loop around `sleep S` (N × S).
if ! printf '%s' "$INPUT" | grep -q '"run_in_background" *: *true'; then
  SLEEP=$(printf '%s' "$CMD" | grep -oE '(^|[^A-Za-z0-9_-])sleep +[0-9]+' | grep -oE '[0-9]+$' | sort -n | tail -1)
  LOOP=$(printf '%s' "$CMD" | grep -oE 'seq +1 +[0-9]+|\{1\.\.[0-9]+\}' | grep -oE '[0-9]+' | sort -n | tail -1)
  TOTAL=${SLEEP:-0}
  if [ -n "${SLEEP:-}" ] && [ -n "${LOOP:-}" ]; then TOTAL=$((SLEEP * LOOP)); fi
  if [ "$TOTAL" -gt 120 ]; then
    deny "foreground wait of ${TOTAL}s (> 120 s, rule 17): wait for agents through their notifications, or run the wait with run_in_background"
  fi
fi
exit 0

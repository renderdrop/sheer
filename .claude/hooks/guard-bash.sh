#!/usr/bin/env bash
set -u
CMD=$(cat | sed -n 's/.*"command" *: *"\(.*\)".*/\1/p' | head -c 4000)
deny() { echo "BLOCKED by guard-bash: $1" >&2; exit 2; }
case "$CMD" in
  *"rm -rf /"*|*"rm -rf ~"*|*"rm -rf ."*|*"rm -rf .git"*) deny "destructive rm" ;;
  *"git push --force"*|*"git push -f"*)                     deny "force push" ;;
  *"git reset --hard"*|*"git checkout -- ."*|*"git clean -fd"*) deny "history/worktree destruction" ;;
  *"curl "*"| sh"*|*"curl "*"| bash"*|*"wget "*"| sh"*)    deny "piping remote scripts to shell" ;;
esac
exit 0

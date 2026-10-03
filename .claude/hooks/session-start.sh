#!/usr/bin/env bash
set -u
INPUT=$(cat)
# Normalize Windows backslash paths (Git Bash) — no-op on macOS/Linux. See ADR-000.
ROOT=$(printf '%s' "${CLAUDE_PROJECT_DIR:-$PWD}" | tr '\\' '/')
STATE="$ROOT/.claude/state"
mkdir -p "$STATE"
if echo "$INPUT" | grep -q '"source" *: *"startup"'; then
  echo 0 > "$STATE/loop_count"
fi
# stdout wird als Kontext injiziert — bewusst kurz halten
if [ -f "$ROOT/STATE.md" ]; then
  echo "=== STATE.md ==="; cat "$ROOT/STATE.md"
  if grep -q -E '^- \[ \]' "$ROOT/docs/FEEDBACK.md" 2>/dev/null; then
    echo "=== open FEEDBACK items (before the roadmap) ==="; grep -m5 -E '^- \[ \]' "$ROOT/docs/FEEDBACK.md"
  fi
  echo "=== next open ROADMAP items ==="; grep -m5 -E '^- \[ \]' "$ROOT/ROADMAP.md" 2>/dev/null || true
else
  echo "No STATE.md found: this is a fresh repo. Execute Phase 0 (Bootstrap)."
fi
exit 0

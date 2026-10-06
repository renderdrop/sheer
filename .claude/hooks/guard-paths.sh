#!/usr/bin/env bash
# PreToolUse guard for Bash, PowerShell, Write, Edit (ADR-127, rule 14): writes, deletes and moves only inside the repo and the Claude
# temp folder; reads outside the repo are blocked (test material only from review/owner/, ADR-126). Exit 2 = blocked.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/guard-paths.mjs"

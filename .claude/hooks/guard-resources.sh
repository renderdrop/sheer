#!/usr/bin/env bash
# PreToolUse guard for Bash and PowerShell (rule 17, ADR-136): blocks build and test commands while less than 8 GB RAM or 40 GB disk
# is free. Exit 2 = blocked.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/guard-resources.mjs"

#!/usr/bin/env bash
set -u
# First file_path only; JSON-escaped Windows backslashes are normalized to "/" (see ADR-000).
FILE=$(cat | sed -n 's/.*"file_path" *: *"\([^"]*\)".*/\1/p' | head -1 | sed 's#\\\\#/#g; s#\\#/#g')
{ [ -z "$FILE" ] || [ ! -f "$FILE" ]; } && exit 0
# .claude/hooks/, tools/lint/ and the security baseline test name the very patterns they forbid.
case "$FILE" in *.md|*/tests/fixtures/*|*/docs/*|*/.claude/hooks/*|*/tools/lint/*|*/src-tauri/tests/security_baseline.rs) exit 0 ;; esac
HITS=$(grep -nE 'BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|dangerouslySetInnerHTML|\.innerHTML *=|\beval\(|new Function\(|dangerousRemoteDomainIpcAccess|withGlobalTauri": *true' "$FILE" | head -5)
if [ -n "$HITS" ]; then
  echo "guard-secrets: forbidden pattern in $FILE — remove or justify in docs/DECISIONS.md:" >&2
  echo "$HITS" >&2
  exit 2
fi
exit 0

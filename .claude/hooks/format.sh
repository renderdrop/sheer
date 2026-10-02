#!/usr/bin/env bash
set -u
# First file_path only; JSON-escaped Windows backslashes are normalized to "/" (see ADR-000).
FILE=$(cat | sed -n 's/.*"file_path" *: *"\([^"]*\)".*/\1/p' | head -1 | sed 's#\\\\#/#g; s#\\#/#g')
[ -z "$FILE" ] && exit 0
case "$FILE" in
  *.ts|*.tsx|*.css|*.json|*.md) command -v npx >/dev/null && npx --no-install prettier --log-level silent --write "$FILE" >/dev/null 2>&1 || true ;;
  *.rs)
    RUSTFMT=$(command -v rustfmt || echo "$HOME/.cargo/bin/rustfmt")
    [ -x "$RUSTFMT" ] && "$RUSTFMT" --edition 2021 "$FILE" >/dev/null 2>&1 || true ;;
esac
exit 0

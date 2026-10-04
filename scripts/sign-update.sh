#!/usr/bin/env bash
# Signs the update packages of a release and writes latest.json (ADR-053 section 3). Only the owner runs this, locally: the private
# key never goes to the repo or to CI (SECURITY T6, docs/BLOCKERS.md B-005).
#
#   SHEER_UPDATER_KEY=~/.sheer/updater.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD=... \
#     bash scripts/sign-update.sh <artifact-dir> <version>
#
# <artifact-dir> holds the release workflow's output: the NSIS installer (`*-setup.exe`) and the macOS `*.app.tar.gz`.
# Writes `<file>.sig` beside each and `latest.json` in the directory; upload all of them to the GitHub release v<version>.
set -euo pipefail

usage() {
  echo "usage: SHEER_UPDATER_KEY=<private key file> bash scripts/sign-update.sh <artifact-dir> <version>" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage
DIR="$1"
VERSION="$2"
[ -d "$DIR" ] || { echo "error: $DIR is not a directory" >&2; exit 2; }
DIR="$(cd "$DIR" && pwd)"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || { echo "error: version must be semver, got $VERSION" >&2; exit 2; }
[ -n "${SHEER_UPDATER_KEY:-}" ] && [ -f "$SHEER_UPDATER_KEY" ] || { echo "error: SHEER_UPDATER_KEY must name the private key file" >&2; exit 2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if grep -q "REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY" src-tauri/updater/minisign.pub; then
  echo "error: src-tauri/updater/minisign.pub is still the placeholder; replace it first (docs/BLOCKERS.md B-005)" >&2
  exit 2
fi

shopt -s nullglob
files=("$DIR"/*-setup.exe "$DIR"/*.app.tar.gz)
[ "${#files[@]}" -gt 0 ] || { echo "error: no *-setup.exe or *.app.tar.gz in $DIR" >&2; exit 2; }

for file in "${files[@]}"; do
  rm -f "$file.sig"
  npx --no-install tauri signer sign --private-key-path "$SHEER_UPDATER_KEY" "$file"
  [ -s "$file.sig" ] || { echo "error: no signature written for $file" >&2; exit 1; }
done

node scripts/latest-json.mjs "$DIR" "$VERSION"
echo "signed ${#files[@]} package(s); wrote $DIR/latest.json"

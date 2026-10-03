#!/usr/bin/env bash
# Prints the `## [x.y.z]` section of CHANGELOG.md (heading included, up to the next `## ` heading), for release notes.
# Usage: scripts/changelog-section.sh <version>   (a leading "v" is accepted). Exits 1 when the section is missing or empty.
set -euo pipefail

VERSION="${1:-}"
VERSION="${VERSION#v}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "usage: changelog-section.sh <version>" >&2
  exit 2
fi

FILE="${CHANGELOG_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/CHANGELOG.md}"

SECTION="$(awk -v head="## [$VERSION]" '
  index($0, head) == 1 { on = 1; print; next }
  on && /^## / { exit }
  on { print }
' "$FILE")"

if [[ -z "$(printf '%s' "$SECTION" | tr -d '[:space:]')" ]]; then
  echo "changelog-section.sh: no section for $VERSION in $FILE" >&2
  exit 1
fi
printf '%s\n' "$SECTION"

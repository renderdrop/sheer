#!/usr/bin/env bash
# Set the app version everywhere it is stored. This is the only supported way to change the version
# (CLAUDE.md, ORCHESTRATOR_PROMPT 8.3 step 5).
#
#   scripts/bump-version.sh X.Y.Z     write X.Y.Z to every file below
#   scripts/bump-version.sh X.Y.Z-pre a SemVer pre-release (e.g. 1.2.0-beta.1): dot-separated alphanumeric identifiers
#   scripts/bump-version.sh --check   fail unless every file already carries the same version
#
# Files: package.json, package-lock.json (root entry), src-tauri/Cargo.toml ([package]),
#        src-tauri/Cargo.lock (the `sheer` package), src-tauri/tauri.conf.json.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PACKAGE_JSON="package.json"
PACKAGE_LOCK="package-lock.json"
CARGO_TOML="src-tauri/Cargo.toml"
CARGO_LOCK="src-tauri/Cargo.lock"
TAURI_CONF="src-tauri/tauri.conf.json"
CRATE_NAME="sheer"

die() {
  echo "bump-version: $*" >&2
  exit 1
}

# --- readers: print the version a file currently carries -------------------------------------------------------

json_version() { # file, jq-like path: "version" | "lock"
  node -e '
    const fs = require("fs");
    const [file, mode] = process.argv.slice(1);
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const v = mode === "lock" ? [json.version, (json.packages?.[""] ?? {}).version] : [json.version];
    process.stdout.write(v.join(" "));
  ' "$1" "$2"
}

toml_package_version() { # Cargo.toml: first `version = "..."` inside [package]
  awk '
    /^\[/ { in_package = ($0 == "[package]") }
    in_package && /^version[[:space:]]*=/ { gsub(/^[^"]*"|".*$/, ""); print; exit }
  ' "$CARGO_TOML"
}

lock_crate_version() { # Cargo.lock: version line following `name = "sheer"`
  awk -v crate="$CRATE_NAME" '
    $0 == "name = \"" crate "\"" { found = 1; next }
    found && /^version = / { gsub(/^[^"]*"|".*$/, ""); print; exit }
  ' "$CARGO_LOCK"
}

report() {
  printf '  %-26s %s\n' "$PACKAGE_JSON" "$(json_version "$PACKAGE_JSON" version)"
  printf '  %-26s %s\n' "$PACKAGE_LOCK" "$(json_version "$PACKAGE_LOCK" lock)"
  printf '  %-26s %s\n' "$CARGO_TOML" "$(toml_package_version)"
  printf '  %-26s %s\n' "$CARGO_LOCK" "$(lock_crate_version)"
  printf '  %-26s %s\n' "$TAURI_CONF" "$(json_version "$TAURI_CONF" version)"
}

all_versions() {
  json_version "$PACKAGE_JSON" version; echo
  json_version "$PACKAGE_LOCK" lock | tr ' ' '\n'; echo
  toml_package_version
  lock_crate_version
  json_version "$TAURI_CONF" version; echo
}

check_in_sync() { # optional $1: the version every file must carry
  local distinct
  distinct="$(all_versions | sed '/^$/d' | sort -u)"
  if [ "$(printf '%s\n' "$distinct" | wc -l | tr -d ' ')" != "1" ] || { [ -n "${1:-}" ] && [ "$distinct" != "$1" ]; }; then
    echo "bump-version: versions are out of sync:" >&2
    report >&2
    return 1
  fi
}

# --- writers ---------------------------------------------------------------------------------------------------

# Replace the first top-level `"version": "..."` line; every other byte of the file stays as it was.
set_json_version() { # file, version
  node -e '
    const fs = require("fs");
    const [file, version] = process.argv.slice(1);
    const text = fs.readFileSync(file, "utf8");
    const next = text.replace(/^(  "version"\s*:\s*")[^"]*(")/m, `$1${version}$2`);
    if (next === text && !text.includes(`"version": "${version}"`)) {
      console.error(`bump-version: no top-level "version" found in ${file}`);
      process.exit(1);
    }
    fs.writeFileSync(file, next);
  ' "$1" "$2"
}

# package-lock.json repeats the version at the top and in packages[""]; npm writes it with JSON.stringify(_, null, 2).
set_lock_version() { # version
  node -e '
    const fs = require("fs");
    const [file, version] = process.argv.slice(1);
    const text = fs.readFileSync(file, "utf8");
    const json = JSON.parse(text);
    if (JSON.stringify(json, null, 2) + "\n" !== text) {
      console.error(`bump-version: ${file} is not in npm'"'"'s canonical format; run npm install first`);
      process.exit(1);
    }
    json.version = version;
    if (json.packages && json.packages[""]) json.packages[""].version = version;
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  ' "$PACKAGE_LOCK" "$1"
}

set_toml_package_version() { # version
  local tmp
  tmp="$(mktemp)"
  awk -v v="$1" '
    /^\[/ { in_package = ($0 == "[package]") }
    in_package && !done && /^version[[:space:]]*=/ { print "version = \"" v "\""; done = 1; next }
    { print }
  ' "$CARGO_TOML" > "$tmp"
  cat "$tmp" > "$CARGO_TOML"
  rm -f "$tmp"
}

set_lock_crate_version() { # version
  local tmp
  tmp="$(mktemp)"
  awk -v crate="$CRATE_NAME" -v v="$1" '
    $0 == "name = \"" crate "\"" { found = 1; print; next }
    found && !done && /^version = / { print "version = \"" v "\""; done = 1; next }
    { print }
  ' "$CARGO_LOCK" > "$tmp"
  cat "$tmp" > "$CARGO_LOCK"
  rm -f "$tmp"
}

# --- main ------------------------------------------------------------------------------------------------------

[ $# -eq 1 ] || die "usage: scripts/bump-version.sh X.Y.Z[-pre] | --check"

for f in "$PACKAGE_JSON" "$PACKAGE_LOCK" "$CARGO_TOML" "$CARGO_LOCK" "$TAURI_CONF"; do
  [ -f "$f" ] || die "missing $f"
done

if [ "$1" = "--check" ]; then
  check_in_sync || exit 1
  echo "bump-version: all files at $(all_versions | sed '/^$/d' | sort -u)"
  exit 0
fi

NEW="$1"
# X.Y.Z with an optional SemVer pre-release; no build metadata (+...), which Cargo and the bundlers treat inconsistently.
if ! [[ "$NEW" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$ ]]; then
  die "'$NEW' is not an X.Y.Z or X.Y.Z-pre version"
fi

# Only touch files whose version differs, so a no-op bump never rewrites (or races with edits to) a file.
[ "$(json_version "$PACKAGE_JSON" version)" = "$NEW" ] || set_json_version "$PACKAGE_JSON" "$NEW"
[ "$(json_version "$PACKAGE_LOCK" lock)" = "$NEW $NEW" ] || set_lock_version "$NEW"
[ "$(toml_package_version)" = "$NEW" ] || set_toml_package_version "$NEW"
[ "$(lock_crate_version)" = "$NEW" ] || set_lock_crate_version "$NEW"
[ "$(json_version "$TAURI_CONF" version)" = "$NEW" ] || set_json_version "$TAURI_CONF" "$NEW"

check_in_sync "$NEW" || die "write failed, review the files above"
echo "bump-version: all files at $NEW"
report

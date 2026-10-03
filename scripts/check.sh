#!/usr/bin/env bash
# Every quality gate in one command: `npm run check` (ORCHESTRATOR_PROMPT 8.3 step 5, 13.5). CI runs the same script.
#
# Runs all steps even when one fails and prints only the failing steps, each with its first three errors.
# The full output of a failed step is kept under the directory printed at the end.
#
# Steps: PDFium fetch, version sync, tsc, eslint, prettier, vitest, cargo fmt, clippy -D warnings, cargo test,
#        cargo deny, cargo audit, npm audit, network-crate guard, PDF-library import guard, secret scan.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Rust lives in ~/.cargo/bin, which is not always on PATH (Windows shells, fresh CI images).
export PATH="$HOME/.cargo/bin:$PATH"
export NO_COLOR=1 FORCE_COLOR=0 CARGO_TERM_COLOR=never CARGO_TERM_PROGRESS_WHEN=never

MANIFEST="src-tauri/Cargo.toml"
LOG_DIR="$(mktemp -d)"
FAILED=()
TOTAL=0

# --- reporting -------------------------------------------------------------------------------------------------

# Lines that look like an error, in every tool this script runs (rustc, tsc, ESLint, Prettier, vitest, audits, guards).
export ERROR_PATTERN='(^|[^A-Za-z0-9_])(error|Error|ERROR|FAIL|FAILED)([^A-Za-z0-9_]|$)|Diff in |\[warn\]|vulnerabilit|RUSTSEC|panicked at'

# First three distinct error lines of a log (the first three non-empty lines when nothing looks like an error).
# rustc's "--> file:line" location is appended to its error line. ESLint's stylish output lists problems under a
# file-name header; the file name is folded into each problem line.
first_errors() {
  local log="$1" cleaned hits esc root_dir
  esc="$(printf '\033')" # BSD sed (macOS) has no \x1b escape
  root_dir="$(pwd -W 2>/dev/null || pwd)" # forward-slash Windows path under Git Bash, plain path elsewhere
  cleaned="$(
    tr -d '\r' <"$log" | sed -e "s/${esc}\[[0-9;]*[A-Za-z]//g" |
      awk -v root="$root_dir" '
        /^[^ \t]/ { header = $0 }
        /^[ \t]+[0-9]+:[0-9]+[ \t]+(error|warning)/ {
          file = header
          gsub(/\\/, "/", file)
          if (index(file, root "/") == 1) file = substr(file, length(root) + 2)
          line = $0
          sub(/^[ \t]+/, "", line)
          print file ":" line
          next
        }
        { print }
      ' |
      grep -vE '^test .* \.\.\. (ok|ignored)' |
      cut -c1-220
  )"
  hits="$(
    printf '%s\n' "$cleaned" | awk '
      /^[ \t]*--> / && NR == last + 1 { loc = $0; sub(/^[ \t]*--> /, "", loc); entries[n] = entries[n] "  @ " loc; next }
      $0 ~ ENVIRON["ERROR_PATTERN"] { entries[++n] = $0; last = NR }
      END { for (i = 1; i <= n && shown < 3; i++) if (!seen[entries[i]]++) { print entries[i]; shown++ } }
    '
  )"
  if [ -z "$hits" ]; then
    hits="$(printf '%s\n' "$cleaned" | sed '/^[[:space:]]*$/d' | head -n 3)"
  fi
  printf '%s\n' "$hits" | sed 's/^/    /'
}

# step <name> <command...>: run quietly, remember the failure, show the first errors.
step() {
  local name="$1"
  shift
  TOTAL=$((TOTAL + 1))
  local log="$LOG_DIR/$TOTAL-${name//[^A-Za-z0-9]/-}.log"
  if "$@" >"$log" 2>&1; then
    return 0
  fi
  FAILED+=("$name")
  echo "FAIL  $name"
  first_errors "$log"
}

# --- guards ----------------------------------------------------------------------------------------------------

# Rule 4 (local only): no HTTP/WebSocket stack in the desktop build. Tauri lists reqwest (and hyper beneath it) in
# Cargo.lock for its Android/iOS targets only, so a plain grep of the lockfile would fail on day one. The guard
# therefore resolves the real dependency graph of the shipped targets and fails when a network crate is in it.
# The only permitted exception is the opt-in updater module: crates listed in NETWORK_ALLOWED_PARENTS may depend on
# them. Add the updater plugin there when it lands (and nothing else).
# tokio is not listed: it is the async runtime Tauri needs, and tauri-plugin-single-instance (Windows) enables its `net` feature for
# the named pipe / local socket it forwards a second launch over. That is local IPC, not HTTP or WebSocket (SECURITY T10); the
# crates below are the ones that would reach the network.
NETWORK_CRATES=(reqwest hyper ureq tauri-plugin-http tauri-plugin-websocket tungstenite)
NETWORK_ALLOWED_PARENTS=(tauri-plugin-updater)
DESKTOP_TARGETS=(x86_64-pc-windows-msvc aarch64-apple-darwin x86_64-apple-darwin)

guard_network_crates() {
  local target crate packages parents parent allowed a ok=1
  for target in "${DESKTOP_TARGETS[@]}"; do
    if ! packages="$(cargo tree --manifest-path "$MANIFEST" --locked --all-features -e normal,build \
      --target "$target" --prefix none --format '{p}' 2>&1)"; then
      echo "error: cargo tree failed for $target:"
      printf '%s\n' "$packages"
      return 1
    fi
    for crate in "${NETWORK_CRATES[@]}"; do
      printf '%s\n' "$packages" | grep -q "^$crate v" || continue
      parents="$(cargo tree --manifest-path "$MANIFEST" --locked --all-features -e normal,build \
        --target "$target" --prefix none --format '{p}' -i "$crate" --depth 1 2>/dev/null |
        awk -v crate="$crate" '$1 != crate { print $1 }' | sort -u)"
      for parent in $parents; do
        allowed=0
        for a in "${NETWORK_ALLOWED_PARENTS[@]}"; do
          [ "$parent" = "$a" ] && allowed=1
        done
        if [ "$allowed" -eq 0 ]; then
          echo "error: network crate '$crate' is part of the $target build via '$parent'"
          ok=0
        fi
      done
    done
  done
  [ "$ok" -eq 1 ]
}

# cargo deny once per shipped target. The lockfile also carries the Linux GTK stack (RUSTSEC-flagged glib and
# proc-macro-error), which Sheer does not ship, so the graph is limited to the desktop targets. The CLI accepts
# only one --target per run.
cargo_deny() {
  local target rc=0
  for target in "${DESKTOP_TARGETS[@]}"; do
    echo "== cargo deny --target $target"
    cargo deny --manifest-path "$MANIFEST" --config deny.toml --locked --target "$target" check \
      --hide-inclusion-graph || rc=1
  done
  return "$rc"
}

# Architecture rule: only the engine (PDFium) and pdfwrite (lopdf) modules may name the PDF libraries.
guard_pdf_imports() {
  local hits
  hits="$(
    grep -rnE --include='*.rs' --exclude-dir=target --exclude-dir=gen \
      '(^|[^A-Za-z0-9_])(pdfium_render|lopdf)([^A-Za-z0-9_]|$)' src-tauri 2>/dev/null |
      grep -vE '^src-tauri/src/(engine|pdfwrite)/' |
      grep -vE '^[^:]+:[0-9]+:[[:space:]]*//'
  )"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits" | sed 's|^|error: pdfium_render/lopdf used outside engine/ and pdfwrite/: |'
    return 1
  fi
}

# SECURITY C3: no secrets, tokens or private keys in the repo. Same patterns as .claude/hooks/guard-secrets.sh, which
# checks every edit; this scans everything that is committed (git grep: tracked files only, binary files skipped).
# Excluded like in the hook: docs/ and *.md (they quote the patterns), tests/fixtures/ (deliberately odd files) and
# .claude/hooks/ (the hook itself). The patterns do not match their own source text, so this script needs no exclusion.
# Only file:line is printed, never the matching line, so a hit does not copy the secret into logs.
SECRET_PATTERN='BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}'

guard_secrets() {
  local hits rc=0
  hits="$(git grep -nIE "$SECRET_PATTERN" -- . ':(exclude)docs' ':(exclude)*.md' ':(exclude)tests/fixtures' \
    ':(exclude).claude/hooks' 2>&1)" || rc=$?
  case "$rc" in
    0)
      printf '%s\n' "$hits" | cut -d: -f1,2 | sed 's|^|error: possible secret or private key at |'
      return 1
      ;;
    1) return 0 ;;
    *)
      echo "error: git grep failed (is this a git checkout?):"
      printf '%s\n' "$hits"
      return 1
      ;;
  esac
}

# --- run -------------------------------------------------------------------------------------------------------

# PDFium must be unpacked before any cargo step: tauri-build checks the bundled resources. The script is a no-op
# when the pinned build is already there.
step "fetch-pdfium" bash scripts/fetch-pdfium.sh
step "version sync" bash scripts/bump-version.sh --check

step "tsc" npm run --silent typecheck
step "eslint" npm run --silent lint
step "prettier" npm run --silent format:check
step "vitest" npm run --silent test

step "cargo fmt" cargo fmt --manifest-path "$MANIFEST" --check
step "cargo clippy" cargo clippy --manifest-path "$MANIFEST" --locked --all-targets -- -D warnings
step "cargo test" cargo test --manifest-path "$MANIFEST" --locked
step "cargo deny" cargo_deny
step "cargo audit" cargo audit --file src-tauri/Cargo.lock
step "npm audit" npm audit --audit-level=high

step "guard: network crates" guard_network_crates
step "guard: pdf imports" guard_pdf_imports
step "guard: secrets" guard_secrets

if [ "${#FAILED[@]}" -eq 0 ]; then
  rm -rf "$LOG_DIR"
  echo "check: all $TOTAL steps passed"
  exit 0
fi

echo "check: ${#FAILED[@]} of $TOTAL steps failed: $(printf '%s; ' "${FAILED[@]}" | sed 's/; $//')"
echo "check: full output in $LOG_DIR"
exit 1

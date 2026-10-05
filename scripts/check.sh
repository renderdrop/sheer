#!/usr/bin/env bash
# Every quality gate in one command: `npm run check` (ORCHESTRATOR_PROMPT 8.3 step 5, 13.5). CI runs the same script.
#
# Runs all steps even when one fails and prints only the failing steps, each with its first three errors.
# The full output of a failed step is kept under the directory printed at the end.
#
# SHEER_CHECK_PART selects the steps: `all` (default, what `npm run check` runs locally), `web` (platform-independent: version sync,
# tsc, eslint, prettier, vitest, audits, guards; no Rust compile; the Linux CI job) or `rust` (PDFium fetch, fmt, clippy, cargo test;
# the Windows/macOS CI matrix, ADR-123). Every step prints its duration.
#
# Steps: PDFium fetch, version sync, tsc, eslint, prettier, vitest, cargo fmt, clippy -D warnings, cargo test,
#        cargo deny, cargo audit, npm audit, network-crate guard, updater-scope guard, PDF-library import guard, secret scan, bundle URL guard.
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
PART="${SHEER_CHECK_PART:-all}"
case "$PART" in all | web | rust) ;; *)
  echo "check: SHEER_CHECK_PART must be all, web or rust (got '$PART')"
  exit 2
  ;;
esac
want() { [ "$PART" = all ] || [ "$PART" = "$1" ]; }

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
      # Rust prints the panic message on the line after "panicked at": keep it with its location (CI runs #71-#74 showed only
      # a backtrace frame).
      NR == panic + 1 && panic > 0 { msg = $0; sub(/^[ \t]+/, "", msg); entries[n] = entries[n] " " msg; panic = 0; next }
      $0 ~ ENVIRON["ERROR_PATTERN"] { entries[++n] = $0; last = NR; if ($0 ~ /panicked at/) panic = NR }
      END { for (i = 1; i <= n && shown < 3; i++) if (!seen[entries[i]]++) { print entries[i]; shown++ } }
    '
  )"
  if [ -z "$hits" ]; then
    hits="$(printf '%s\n' "$cleaned" | sed '/^[[:space:]]*$/d' | head -n 3)"
  fi
  printf '%s\n' "$hits" | sed 's/^/    /'
}

# Vitest reports an error outside any test (a timer or promise that outlives its test) as an "Unhandled Error" block that the
# generic first-errors view cuts off. Prints the first ~30 lines of that block.
unhandled_block() {
  local log="$1"
  tr -d '' <"$log" | awk '
    /Unhandled (Errors?|Rejections?)/ && !on { on = 1 }
    on && n < 30 { print; n++ }
  ' | cut -c1-220 | sed 's/^/    /'
}

# step <name> <command...>: run quietly, remember the failure, show the first errors.
step() {
  local name="$1"
  shift
  TOTAL=$((TOTAL + 1))
  local log="$LOG_DIR/$TOTAL-${name//[^A-Za-z0-9]/-}.log" started="$SECONDS" secs
  if "$@" >"$log" 2>&1; then
    printf 'ok    %s  %ss\n' "$name" "$((SECONDS - started))"
    return 0
  fi
  secs=$((SECONDS - started))
  FAILED+=("$name")
  echo "FAIL  $name  ${secs}s"
  first_errors "$log"
  if [ "$name" = vitest ]; then unhandled_block "$log"; fi
}

# --- guards ----------------------------------------------------------------------------------------------------

# Rule 4 (local only): no HTTP/WebSocket stack in the desktop build. Tauri lists reqwest (and hyper beneath it) in
# Cargo.lock for its Android/iOS targets only, so a plain grep of the lockfile would fail on day one. The guard
# therefore resolves the real dependency graph of the shipped targets and fails when a network crate is in it.
# The only permitted exception is the opt-in updater (ADR-053 section 3): the graph is resolved with the roots in
# NETWORK_ALLOWED_ROOTS pruned (`cargo tree --prune`), so the updater plugin and everything below it (reqwest, hyper,
# native-tls, ...) is allowed, but the same crate reached from anywhere else is not. guard_updater_scope then makes sure only
# src-tauri/src/update/ names those crates in code.
# tokio is not listed: it is the async runtime Tauri needs, and tauri-plugin-single-instance (Windows) enables its `net` feature for
# the named pipe / local socket it forwards a second launch over. That is local IPC, not HTTP or WebSocket (SECURITY T10); the
# crates below are the ones that would reach the network.
NETWORK_CRATES=(reqwest hyper ureq tauri-plugin-http tauri-plugin-websocket tungstenite)
NETWORK_ALLOWED_ROOTS=(tauri-plugin-updater)
DESKTOP_TARGETS=(x86_64-pc-windows-msvc aarch64-apple-darwin x86_64-apple-darwin)

guard_network_crates() {
  local target crate packages root ok=1
  local prune=()
  for root in "${NETWORK_ALLOWED_ROOTS[@]}"; do
    prune+=(--prune "$root")
  done
  for target in "${DESKTOP_TARGETS[@]}"; do
    if ! packages="$(cargo tree --manifest-path "$MANIFEST" --locked --all-features -e normal,build \
      --target "$target" --prefix none --format '{p}' "${prune[@]}" 2>&1)"; then
      echo "error: cargo tree failed for $target:"
      printf '%s\n' "$packages"
      return 1
    fi
    for crate in "${NETWORK_CRATES[@]}"; do
      if printf '%s\n' "$packages" | grep -q "^$crate v"; then
        echo "error: network crate '$crate' is part of the $target build outside the updater (${NETWORK_ALLOWED_ROOTS[*]})"
        ok=0
      fi
    done
  done
  [ "$ok" -eq 1 ]
}

# ADR-121 section 2, SECURITY S7: the certificate crypto is pure Rust. No C-backed provider (ring, aws-lc-rs, openssl) may be part of the
# desktop build outside the updater, and the crypto crates (direct and transitive names) may be named only in src-tauri/src/pdfsig/ (comment
# lines are ignored). src-tauri/tests is excluded on purpose: the integration tests build and verify real signatures and name the crates
# (they are not part of the shipped binary).
CRYPTO_BANNED=(ring aws-lc-rs openssl)
CRYPTO_PATTERN='(^|[^A-Za-z0-9_])(der|spki|pkcs8|x509_cert|cms|rsa|p256|p384|sha1|p12_keystore|ecdsa|elliptic_curve|pkcs1|pkcs5|pkcs12|x509_parser|signature|crypto_bigint|const_oid|pbkdf2|primeorder|rfc6979|rc2|des|cbc|hmac)::'

guard_crypto_crates() {
  local target crate packages root ok=1 hits
  local prune=()
  for root in "${NETWORK_ALLOWED_ROOTS[@]}"; do
    prune+=(--prune "$root")
  done
  for target in "${DESKTOP_TARGETS[@]}"; do
    if ! packages="$(cargo tree --manifest-path "$MANIFEST" --locked --all-features -e normal,build       --target "$target" --prefix none --format '{p}' "${prune[@]}" 2>&1)"; then
      echo "error: cargo tree failed for $target:"
      printf '%s
' "$packages"
      return 1
    fi
    for crate in "${CRYPTO_BANNED[@]}"; do
      if printf '%s
' "$packages" | grep -q "^$crate v"; then
        echo "error: C-backed crypto crate '$crate' is part of the $target build outside the updater"
        ok=0
      fi
    done
  done
  hits="$(
    grep -rnE --include='*.rs' "$CRYPTO_PATTERN" src-tauri/src 2>/dev/null |
      grep -vE '^src-tauri/src/pdfsig/' |
      grep -vE '^[^:]+:[0-9]+:[[:space:]]*//'
  )"
  if [ -n "$hits" ]; then
    printf '%s
' "$hits" | sed 's|^|error: crypto crate named outside pdfsig/: |'
    ok=0
  fi
  [ "$ok" -eq 1 ]
}

# The updater and HTTP crates may be named in code only under src-tauri/src/update/ (comment lines are ignored). Takes the source
# directory as an argument so the test (src-tauri/tests/updater_scope.rs) can point it at a scratch tree.
UPDATER_SCOPE_PATTERN='(^|[^A-Za-z0-9_])(tauri_plugin_updater|tauri_plugin_http|tauri_plugin_websocket|reqwest|hyper|ureq|tungstenite|minisign_verify)([^A-Za-z0-9_]|$)'

guard_updater_scope() {
  local dir="${1:-src-tauri/src}" hits
  dir="${dir%/}"
  hits="$(
    grep -rnE --include='*.rs' "$UPDATER_SCOPE_PATTERN" "$dir" 2>/dev/null |
      grep -vF "$dir/update/" |
      grep -vE '^.+:[0-9]+:[[:space:]]*//'
  )"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits" | sed 's|^|error: updater/HTTP crate named outside update/: |'
    return 1
  fi
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

# SECURITY T2: the built bundle names no remote host except XML namespace identifiers (never fetched) and the error-code page that
# React's production build prints inside a message, and the DOI resolver that formatted references print (ADR-119; text, never loaded;
# the CSP allows no remote host anyway). Takes the bundle directory as an argument. Prints the host only, never the surrounding code.
DIST_URL_ALLOWED='^(www\.w3\.org|react\.dev|doi\.org)$'

guard_dist_urls() {
  local dir="${1:-dist}" hosts host rc=0
  if [ ! -d "$dir" ]; then
    echo "error: no bundle at $dir"
    return 1
  fi
  hosts="$(grep -rhoE --binary-files=without-match 'https?://[A-Za-z0-9.-]+' "$dir" | sed -E 's#^https?://##' | sort -u)"
  for host in $hosts; do
    if ! printf '%s' "$host" | grep -qE "$DIST_URL_ALLOWED"; then
      echo "error: remote URL host '$host' in the bundle ($dir)"
      rc=1
    fi
  done
  return "$rc"
}

build_and_guard_dist() {
  local out="$LOG_DIR/dist"
  npx --no-install vite build --outDir "$out" --emptyOutDir || return 1
  guard_dist_urls "$out"
}

# `source scripts/check.sh` with SHEER_CHECK_SOURCE_ONLY=1 only defines the functions (src-tauri/tests/updater_scope.rs).
if [ "${SHEER_CHECK_SOURCE_ONLY:-}" = 1 ]; then return 0 2>/dev/null || exit 0; fi

# --- run -------------------------------------------------------------------------------------------------------

# PDFium must be unpacked before any cargo step that builds: tauri-build checks the bundled resources. The script is a no-op
# when the pinned build is already there.
if want rust; then step "fetch-pdfium" bash scripts/fetch-pdfium.sh; fi
if want web; then step "version sync" bash scripts/bump-version.sh --check; fi

if want web; then
  step "tsc" npm run --silent typecheck
  step "eslint" npm run --silent lint
  step "prettier" npm run --silent format:check
  step "vitest" npm run --silent test
fi

if want rust; then
  step "cargo fmt" cargo fmt --manifest-path "$MANIFEST" --check
  step "cargo clippy" cargo clippy --manifest-path "$MANIFEST" --locked --all-targets -- -D warnings
  # Linking ~40 integration-test binaries in parallel can exhaust the commit limit on Windows (os error 1455);
  # SHEER_TEST_JOBS caps the build jobs (default 4).
  step "cargo test" cargo test --manifest-path "$MANIFEST" --locked --jobs "${SHEER_TEST_JOBS:-4}"
fi

if want web; then
  step "cargo deny" cargo_deny
  step "cargo audit" cargo audit --file src-tauri/Cargo.lock
  step "npm audit" npm audit --audit-level=high

  step "guard: network crates" guard_network_crates
  step "guard: updater scope" guard_updater_scope
  step "guard: crypto crates" guard_crypto_crates
  step "guard: pdf imports" guard_pdf_imports
  step "guard: secrets" guard_secrets
  step "guard: bundle urls" build_and_guard_dist
fi

if [ "${#FAILED[@]}" -eq 0 ]; then
  rm -rf "$LOG_DIR"
  echo "check: all $TOTAL steps passed ($PART, ${SECONDS}s)"
  exit 0
fi

echo "check: ${#FAILED[@]} of $TOTAL steps failed: $(printf '%s; ' "${FAILED[@]}" | sed 's/; $//')"
echo "check: full output in $LOG_DIR"
exit 1

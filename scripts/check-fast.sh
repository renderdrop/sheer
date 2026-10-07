#!/usr/bin/env bash
# `npm run check:fast [-- <base>]` (rule 17, ADR-136): the quick check agents run while they work (target < 60 s on a warm build).
# Only what the change touches, against <base> (default HEAD: uncommitted and untracked files):
#   web:  tsc (whole project, when TS changed), eslint + prettier on the changed files, `vitest related` for the changed sources
#   rust: cargo fmt --check, clippy -D warnings, and `cargo test` filtered to the changed modules (src/a/b.rs → a::b; lib.rs, main.rs
#         or build.rs → the whole lib suite; tests/x.rs → --test x)
#   guards: PDF-library imports, secrets, owner-corpus names
# The full `npm run check` runs once before every commit, by the orchestrator.
set -uo pipefail
SHEER_CHECK_SOURCE_ONLY=1 source "$(dirname "${BASH_SOURCE[0]}")/check.sh"

BASE="${1:-HEAD}"
CHANGED=()
while IFS= read -r f; do
  [ -f "$f" ] && CHANGED+=("$f")
done < <({
  git diff --name-only "$BASE" --
  git ls-files --others --exclude-standard
} | sort -u)

if [ "${#CHANGED[@]}" -eq 0 ]; then
  echo "check:fast: nothing changed against $BASE"
  exit 0
fi

LINT=() PRETTY=() SOURCES=() TS=0 RUST=0 LIB_ALL=0 FILTERS=() ITESTS=()
for f in "${CHANGED[@]}"; do
  case "$f" in
    *.ts | *.tsx) TS=1 ;;
  esac
  case "$f" in
    *.ts | *.tsx | *.js | *.mjs | *.cjs) LINT+=("$f") ;;
  esac
  case "$f" in
    *.ts | *.tsx | *.js | *.mjs | *.cjs | *.css | *.json | *.md | *.html | *.yml | *.yaml) PRETTY+=("$f") ;;
  esac
  case "$f" in
    src/*.ts | src/*.tsx | scripts/*.ts | scripts/*.mjs) SOURCES+=("$f") ;;
  esac
  case "$f" in
    src-tauri/src/lib.rs | src-tauri/src/main.rs | src-tauri/build.rs | src-tauri/Cargo.toml | src-tauri/Cargo.lock) RUST=1 LIB_ALL=1 ;;
    src-tauri/src/*.rs)
      RUST=1
      m="${f#src-tauri/src/}"
      m="${m%.rs}"
      m="${m%/mod}"
      FILTERS+=("${m//\//::}")
      ;;
    src-tauri/tests/*.rs)
      RUST=1
      t="${f#src-tauri/tests/}"
      ITESTS+=("${t%.rs}")
      ;;
    src-tauri/*.rs | src-tauri/examples/*) RUST=1 ;;
  esac
done

if [ "$TS" -eq 1 ]; then step "tsc" npm run --silent typecheck; fi
if [ "${#LINT[@]}" -gt 0 ]; then step "eslint (changed)" npx --no-install eslint --no-warn-ignored "${LINT[@]}"; fi
if [ "${#PRETTY[@]}" -gt 0 ]; then step "prettier (changed)" npx --no-install prettier --check --ignore-unknown "${PRETTY[@]}"; fi
if [ "${#SOURCES[@]}" -gt 0 ]; then
  step "vitest related" npx --no-install vitest related --run --passWithNoTests "${SOURCES[@]}"
fi

if [ "$RUST" -eq 1 ]; then
  step "cargo fmt" cargo fmt --manifest-path "$MANIFEST" --check
  step "cargo clippy" cargo clippy --manifest-path "$MANIFEST" --locked --all-targets -- -D warnings
  if [ "$LIB_ALL" -eq 1 ]; then
    step "cargo test --lib" cargo test --manifest-path "$MANIFEST" --locked --lib
  elif [ "${#FILTERS[@]}" -gt 0 ]; then
    step "cargo test --lib ${FILTERS[*]}" cargo test --manifest-path "$MANIFEST" --locked --lib -- "${FILTERS[@]}"
  fi
  for t in "${ITESTS[@]}"; do
    step "cargo test --test $t" cargo test --manifest-path "$MANIFEST" --locked --test "$t"
  done
fi

step "guard: pdf imports" guard_pdf_imports
step "guard: secrets" guard_secrets
step "guard: owner corpus names" guard_owner_corpus

if [ "${#FAILED[@]}" -eq 0 ]; then
  rm -rf "$LOG_DIR"
  echo "check:fast: all $TOTAL steps passed (${#CHANGED[@]} changed files, ${SECONDS}s)"
  exit 0
fi
echo "check:fast: ${#FAILED[@]} of $TOTAL steps failed: $(printf '%s; ' "${FAILED[@]}" | sed 's/; $//')"
echo "check:fast: full output in $LOG_DIR"
exit 1

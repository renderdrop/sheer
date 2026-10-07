#!/usr/bin/env bash
# Rule 17 / ADR-136: the build environment of every local cargo run a repo script starts. Source it after ROOT is set:
#   ROOT=... ; source "$ROOT/scripts/build-env.sh"
# - Rust lives in ~/.cargo/bin, which is not always on PATH (Windows shells, fresh CI images).
# - At most six rustc jobs (also in src-tauri/.cargo/config.toml, which cargo reads only inside src-tauri/).
# - Local only (not in CI): this shell and everything it starts run at below-normal priority, and rustc goes through the repo-local
#   sccache in .tools/ when it is installed (`npm run tools:install`), with its cache in .tools/sccache (20 GB cap).

# A failing stage must never be hidden by a pipe (ADR-139); every caller already runs with pipefail.
set -o pipefail

export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-6}"

if [ -z "${CI:-}" ]; then
  for sccache in "$ROOT/.tools/bin/sccache.exe" "$ROOT/.tools/bin/sccache"; do
    if [ -x "$sccache" ] && [ -z "${RUSTC_WRAPPER:-}" ]; then
      export RUSTC_WRAPPER="$sccache"
      export SCCACHE_DIR="$ROOT/.tools/sccache"
      export SCCACHE_CACHE_SIZE="${SCCACHE_CACHE_SIZE:-20G}"
      break
    fi
  done
  # Below-normal priority for this shell; on Windows, child processes (cargo, rustc, node) inherit the class.
  if [ -r "/proc/$$/winpid" ]; then
    node -e 'const os = require("os"); os.setPriority(Number(process.argv[1]), os.constants.priority.PRIORITY_BELOW_NORMAL)' \
      "$(cat "/proc/$$/winpid")" 2>/dev/null || true
  else
    renice -n 10 -p $$ >/dev/null 2>&1 || true
  fi
fi

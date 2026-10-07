#!/usr/bin/env bash
# `npm run cargo -- <args>` (rule 17, ADR-136): cargo for src-tauri with the shared build environment (six jobs, and locally
# below-normal priority + sccache). Agents use this instead of a bare `cargo`, e.g. `npm run cargo -- test --lib ocr::service`.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/build-env.sh
source "$ROOT/scripts/build-env.sh"
cd "$ROOT/src-tauri" || exit 1
exec cargo "$@"

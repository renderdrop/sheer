#!/usr/bin/env bash
# `npm run tools:install` (rule 17, ADR-136): installs the local build tools into the git-ignored .tools/ (rule 14: nothing outside the
# repo): sccache without remote backends (local disk cache only) and cargo-sweep. Pinned versions, --locked. Not used in CI.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"
cargo install --locked --jobs 6 --root "$ROOT/.tools" --version 0.8.0 cargo-sweep
cargo install --locked --jobs 6 --root "$ROOT/.tools" --version 0.18.0 --no-default-features sccache
echo "tools: $(ls "$ROOT/.tools/bin" | tr '\n' ' ')"

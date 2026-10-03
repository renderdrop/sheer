#!/usr/bin/env bash
# Dev only: run the real Tauri window with the WebView2 DevTools protocol on 127.0.0.1:9222.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.cargo/bin:$PATH"
export WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
exec npm run tauri dev

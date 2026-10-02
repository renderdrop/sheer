#!/usr/bin/env bash
# Fetch the pinned PDFium binary for one platform, verify its SHA256, and unpack it to
# src-tauri/pdfium/<platform>/ (gitignored). Tauri bundles that directory as a resource.
#
# Source:  https://github.com/bblanchon/pdfium-binaries (BSD-3-Clause + third-party notices in the archive)
# Variant: plain build. No V8 (no JavaScript) and no XFA. The script refuses archives whose args.gn says otherwise.
# Policy:  pinned release tag + per-platform SHA256 (the release asset digests). Never downloaded at runtime.
#
# Usage:   scripts/fetch-pdfium.sh [platform]     platform: win-x64 | win-arm64 | mac-x64 | mac-arm64
#          Default: detected from the host. Override with PDFIUM_PLATFORM=...
# To bump the pin: change PDFIUM_TAG and every SHA256 below from the new release's asset digests
# (gh api repos/bblanchon/pdfium-binaries/releases/tags/<tag> --jq '.assets[] | [.name, .digest]'),
# update the pdfium_<n> feature of pdfium-render in src-tauri/Cargo.toml, and docs/LICENSES.md.
set -euo pipefail

PDFIUM_TAG="chromium/7881"
BASE_URL="https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F7881"

# SHA256 of pdfium-<platform>.tgz in release chromium/7881 (plain build, not the pdfium-v8-* assets).
expected_sha256() {
  case "$1" in
    win-x64)   echo "73cc0de638ac2095e7445bf56a38200a5b7c7ca0e9f4ba144598f2457377ac08" ;;
    win-arm64) echo "d3035d4d2cacac6ecd1a2ece197a3d702a1b2a58466276b9f870b8cb278a9d84" ;;
    mac-x64)   echo "6dedf83990e0e3d6b7c93c9e7589c5a126b0ae14b7464d76120cff7a26afb18b" ;;
    mac-arm64) echo "52e94ca5aa8847934330daf3f8150c190682c5ca93831468794f8b90d4392e40" ;;
    *) return 1 ;;
  esac
}

# Path of the dynamic library inside the archive.
library_in_archive() {
  case "$1" in
    win-*) echo "bin/pdfium.dll" ;;
    mac-*) echo "lib/libpdfium.dylib" ;;
    *) return 1 ;;
  esac
}

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    MINGW*|MSYS*|CYGWIN*)
      arch="${PROCESSOR_ARCHITEW6432:-${PROCESSOR_ARCHITECTURE:-$arch}}"
      case "$arch" in
        AMD64|amd64|x86_64) echo "win-x64" ;;
        ARM64|arm64|aarch64) echo "win-arm64" ;;
        *) return 1 ;;
      esac ;;
    Darwin)
      case "$arch" in
        arm64) echo "mac-arm64" ;;
        x86_64) echo "mac-x64" ;;
        *) return 1 ;;
      esac ;;
    *) return 1 ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

PLATFORM="${1:-${PDFIUM_PLATFORM:-}}"
if [ -z "$PLATFORM" ]; then
  PLATFORM="$(detect_platform)" || { echo "fetch-pdfium: unsupported host; pass a platform explicitly" >&2; exit 2; }
fi
EXPECTED="$(expected_sha256 "$PLATFORM")" || { echo "fetch-pdfium: unknown platform '$PLATFORM'" >&2; exit 2; }
LIB_IN_ARCHIVE="$(library_in_archive "$PLATFORM")"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_PARENT="$ROOT/src-tauri/pdfium"
DEST="$DEST_PARENT/$PLATFORM"
STAMP="$PDFIUM_TAG $EXPECTED"

if [ -f "$DEST/.pin" ] && [ "$(cat "$DEST/.pin")" = "$STAMP" ] && [ -f "$DEST/$(basename "$LIB_IN_ARCHIVE")" ]; then
  echo "fetch-pdfium: $PLATFORM already at $PDFIUM_TAG"
  exit 0
fi

STAGE="$DEST_PARENT/.stage-$PLATFORM"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$STAGE"' EXIT

ARCHIVE="$TMP/pdfium-$PLATFORM.tgz"
echo "fetch-pdfium: downloading pdfium-$PLATFORM.tgz ($PDFIUM_TAG)"
curl --fail --silent --show-error --location --retry 3 --proto '=https' --tlsv1.2 \
  --output "$ARCHIVE" "$BASE_URL/pdfium-$PLATFORM.tgz"

ACTUAL="$(sha256_of "$ARCHIVE")"
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "fetch-pdfium: SHA256 mismatch for pdfium-$PLATFORM.tgz" >&2
  echo "  expected $EXPECTED" >&2
  echo "  actual   $ACTUAL" >&2
  exit 1
fi
echo "fetch-pdfium: SHA256 verified"

mkdir "$TMP/extract"
tar -xzf "$ARCHIVE" -C "$TMP/extract"

# Plain build only: the archive must say it was built without V8 and XFA.
for flag in pdf_enable_v8 pdf_enable_xfa; do
  if ! grep -Eq "^[[:space:]]*$flag[[:space:]]*=[[:space:]]*false" "$TMP/extract/args.gn"; then
    echo "fetch-pdfium: args.gn does not say $flag = false; refusing this archive" >&2
    exit 1
  fi
done

# Keep only what the app needs: the library and its license notices.
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp "$TMP/extract/$LIB_IN_ARCHIVE" "$STAGE/"
cp "$TMP/extract/LICENSE" "$TMP/extract/VERSION" "$TMP/extract/args.gn" "$STAGE/"
cp -R "$TMP/extract/licenses" "$STAGE/licenses"
printf '%s' "$STAMP" > "$STAGE/.pin"

rm -rf "$DEST"
mv "$STAGE" "$DEST"
echo "fetch-pdfium: $PLATFORM ready in src-tauri/pdfium/$PLATFORM"

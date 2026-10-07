#!/usr/bin/env bash
# Builds the macOS OCR sidecar `sheer-ocr` (sidecar/ocr-macos, Swift + Apple Vision; ADR-134, ADR-137) as one universal binary
# (arm64 + x86_64), ad-hoc signs it, and puts it where Tauri's `bundle.externalBin` ("binaries/sheer-ocr", tauri.macos.conf.json)
# looks for it: src-tauri/binaries/sheer-ocr-<target triple>. tauri-build needs the file for the triple of every cargo build on macOS,
# so run this once before `cargo build/test` or `tauri build` on a Mac. The universal binary is copied under all three names.
# The Developer ID signature of a release comes from Tauri's bundle signing; the ad-hoc one here keeps the unsigned CI builds runnable.
#
# Usage: scripts/build-sidecar-macos.sh        (macOS with Xcode or the Swift toolchain only)
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-sidecar-macos.sh: macOS only" >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package="$root/sidecar/ocr-macos"
out="$root/src-tauri/binaries"

swift build --package-path "$package" -c release --arch arm64 --arch x86_64 --product sheer-ocr
built="$package/.build/apple/Products/Release/sheer-ocr"
[ -f "$built" ] || { echo "build-sidecar-macos.sh: $built not found" >&2; exit 1; }

mkdir -p "$out"
for triple in aarch64-apple-darwin x86_64-apple-darwin universal-apple-darwin; do
  cp "$built" "$out/sheer-ocr-$triple"
  codesign --force --sign - "$out/sheer-ocr-$triple"
done
lipo -info "$out/sheer-ocr-universal-apple-darwin"
echo "sidecar ready: $out/sheer-ocr-universal-apple-darwin"

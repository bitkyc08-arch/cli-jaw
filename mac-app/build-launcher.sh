#!/bin/bash
# Build universal jaw-launcher (arm64 + x86_64) into mac-app/prebuilt/.
# Used by CI; also runnable locally for a release build.
# Runtime PATH pin is injected by postinstall; prebuilt bakes a safe
# default used only when postinstall fails to find clang.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/mac-app/jaw-launcher.m"
OUT="$ROOT/mac-app/prebuilt"
mkdir -p "$OUT"

# Safe default PATH baked into prebuilt fallback. postinstall recompiles
# with a detected PATH so the user's real layout wins.
DEFAULT_PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'

build_arch() {
    local triple="$1"
    local suffix="$2"
    clang \
        -target "$triple" \
        -framework Foundation \
        -O2 \
        -DPINNED_PATH="\"$DEFAULT_PATH\"" \
        -o "$OUT/jaw-launcher-$suffix" \
        "$SRC"
    codesign --sign - --force --timestamp=none "$OUT/jaw-launcher-$suffix"
}

build_arch "arm64-apple-macos11"  arm64
build_arch "x86_64-apple-macos11" x86_64

# Universal binary (convenience — not used by postinstall directly)
lipo -create \
    "$OUT/jaw-launcher-arm64" \
    "$OUT/jaw-launcher-x86_64" \
    -output "$OUT/jaw-launcher-universal"
codesign --sign - --force --timestamp=none "$OUT/jaw-launcher-universal"

ls -la "$OUT"
echo "build-launcher: done"

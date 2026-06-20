#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

STAGING=".dist-staging"
OLD=".dist-old"

rm -rf "$STAGING"
npx tsc --outDir "$STAGING"
case "$(uname -s 2>/dev/null || true)" in
    MINGW*|MSYS*|CYGWIN*) ;;
    *) [ -f "$STAGING/bin/cli-jaw.js" ] && chmod +x "$STAGING/bin/cli-jaw.js" ;;
esac
# cp -R instead of rsync: staging is always fresh (rm -rf above), and
# Git Bash on Windows runners has no rsync.
mkdir -p "$STAGING/src/prompt/templates" "$STAGING/prompts" "$STAGING/src/browser/adaptive-fetch/vendor"
cp -R src/prompt/templates/. "$STAGING/src/prompt/templates/"
cp -R prompts/. "$STAGING/prompts/"
cp -R src/browser/adaptive-fetch/vendor/. "$STAGING/src/browser/adaptive-fetch/vendor/"

# jawcode TUI bundle + Bun shim + native addon (macOS only)
if [ -f src/lib/tui/jawcode-tui-bundle.mjs ]; then
    mkdir -p "$STAGING/src/lib/tui" "$STAGING/src/lib/native"
    cp src/lib/tui/bun-shim.mjs "$STAGING/src/lib/tui/"
    cp src/lib/tui/jawcode-tui-bundle.mjs "$STAGING/src/lib/tui/"
    [ -f src/lib/tui/jawcode-interactive-bundle.mjs ] && cp src/lib/tui/jawcode-interactive-bundle.mjs "$STAGING/src/lib/tui/"
    NATIVE_TAG="$(node -p '`${process.platform}-${process.arch}`')"
    NATIVE_FILE="pi_natives.${NATIVE_TAG}.node"
    NATIVE_SRC=""
    for candidate in \
        "src/lib/native/$NATIVE_FILE" \
        "electron/sidecar/server/node_modules/@jawcode-dev/natives/native/$NATIVE_FILE" \
        "node_modules/@jawcode-dev/natives/native/$NATIVE_FILE" \
        "node_modules/@jawcode-internal/natives/native/$NATIVE_FILE" \
        "electron/sidecar/server/dist/src/lib/native/$NATIVE_FILE" \
        "electron/dist/mac-arm64/cli-jaw.app/Contents/Resources/server/dist/src/lib/native/$NATIVE_FILE"; do
        if [ -f "$candidate" ]; then
            NATIVE_SRC="$candidate"
            break
        fi
    done
    if [ -n "$NATIVE_SRC" ]; then
        cp "$NATIVE_SRC" "$STAGING/src/lib/native/$NATIVE_FILE"
    elif [ "$NATIVE_TAG" = "darwin-arm64" ]; then
        echo "[atomic-build] warning: $NATIVE_FILE not found; jawcode TUI bundle will use fallback/no-native path" >&2
    fi
fi

# Atomic swap with rollback on failure
rm -rf "$OLD"
if [ -d dist ]; then
    mv dist "$OLD"
    if ! mv "$STAGING" dist; then
        echo "[atomic-build] swap failed — rolling back" >&2
        mv "$OLD" dist
        exit 1
    fi
    rm -rf "$OLD" &
else
    mv "$STAGING" dist
fi
echo "[atomic-build] dist/ swapped successfully"

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

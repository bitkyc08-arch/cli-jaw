#!/usr/bin/env bash
set -euo pipefail

PLATFORM="${1:?Usage: bundle-sidecar.sh <platform> <arch>}"
ARCH="${2:?Usage: bundle-sidecar.sh <platform> <arch>}"
NODE_VERSION="24.17.0"

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIDECAR_DIR="$PROJECT_ROOT/electron/sidecar/server"

install_locked_production_dependencies() {
  if [ -f package-lock.json ]; then
    npm ci --omit=dev --ignore-scripts
  else
    npm install --omit=dev --ignore-scripts
  fi
}

echo "=== Bundling sidecar: $PLATFORM-$ARCH ==="

rm -rf "$SIDECAR_DIR"
mkdir -p "$SIDECAR_DIR/bin"

NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
case "$PLATFORM-$ARCH" in
  darwin-arm64)  NODE_PKG="node-v${NODE_VERSION}-darwin-arm64" ;;
  darwin-x64)    NODE_PKG="node-v${NODE_VERSION}-darwin-x64" ;;
  win32-x64)     NODE_PKG="node-v${NODE_VERSION}-win-x64" ;;
  linux-x64)     NODE_PKG="node-v${NODE_VERSION}-linux-x64" ;;
  *) echo "Unsupported: $PLATFORM-$ARCH"; exit 1 ;;
esac

echo "Downloading Node.js $NODE_VERSION ($PLATFORM-$ARCH)..."
if [[ "$PLATFORM" == "win32" ]]; then
  curl -fsSL "$NODE_URL/${NODE_PKG}.zip" -o /tmp/node-sidecar.zip
  unzip -qo /tmp/node-sidecar.zip -d /tmp/
  cp "/tmp/${NODE_PKG}/node.exe" "$SIDECAR_DIR/node.exe"
else
  curl -fsSL "$NODE_URL/${NODE_PKG}.tar.gz" | tar -xz -C /tmp
  cp "/tmp/${NODE_PKG}/bin/node" "$SIDECAR_DIR/node"
  chmod +x "$SIDECAR_DIR/node"
fi

echo "Building project..."
cd "$PROJECT_ROOT"
npm run build
npm run build:frontend

echo "Copying server artifacts..."
cp -r dist "$SIDECAR_DIR/dist"
cp -r public "$SIDECAR_DIR/public"
cp package.json "$SIDECAR_DIR/package.json"
cp package-lock.json "$SIDECAR_DIR/package-lock.json" 2>/dev/null || true

echo "Installing production dependencies..."
cd "$SIDECAR_DIR"
install_locked_production_dependencies

echo "Pruning frontend-only dependencies..."
# NOTE: only genuinely frontend-only packages belong here. Anything imported by
# dist/src/** is a SERVER dependency and pruning it makes the packaged sidecar
# crash at import time with ERR_MODULE_NOT_FOUND. `node-fetch` was in this list
# by mistake even though src/telegram/bot.ts imports it, which killed every
# packaged instance that touched the Telegram path.
PRUNE_PKGS=(
  "@codemirror/autocomplete" "@codemirror/lang-markdown" "@codemirror/language"
  "@codemirror/language-data" "@codemirror/state" "@codemirror/view"
  "@lezer/highlight" "@lucide/icons" "@milkdown/kit" "@replit/codemirror-vim"
  # react-virtual goes with virtual-core. Pruning only the inner one left a
  # half-package in the bundle: @tanstack/react-virtual present, its own
  # dependency gone. Nothing on the server imports either, but a package that
  # cannot resolve its own dependency is a trap for the next person.
  "@tanstack/react-virtual" "@tanstack/virtual-core"
  "@uiw/react-codemirror" "@xterm/addon-fit" "@xterm/xterm"
  "d3" "dompurify" "katex" "marked-highlight" "mermaid"
  "react" "react-dom" "react-markdown" "rehype-katex" "rehype-sanitize"
  "remark-breaks" "remark-gfm" "remark-math"
)

# `highlight.js` was in this list by mistake. It is not frontend-only: the
# packaged CLI loads dist/bin/commands/chat.js -> src/cli/tui/highlight.js,
# which imports it. The guard at scripts/qa/sidecar-deps-guard.mjs proves the
# prune list and the packaged runtime's imports no longer intersect.
for pkg in "${PRUNE_PKGS[@]}"; do
  rm -rf "$SIDECAR_DIR/node_modules/$pkg" 2>/dev/null || true
done
# Remove transitive-only packages (types, build tools)
# Remove only confirmed build-tooling packages. The guard proved the rest are
# runtime dependencies: @babel/runtime is needed by downshift, and lodash by
# discord.js's @sapphire/shapeshift. Removing them is the web-streams-polyfill
# shape one level deeper — a transitive server dep taken by a scope-wide rm.
rm -rf "$SIDECAR_DIR/node_modules/typescript" 2>/dev/null || true
rm -rf "$SIDECAR_DIR/node_modules/@types" 2>/dev/null || true
# web-streams-polyfill is NOT frontend-only: node-fetch -> fetch-blob declares
# it. It does not throw on the bundled Node 24, because fetch-blob only falls
# back to the polyfill when globalThis.ReadableStream is missing — but it is a
# package the server's tree asks for and the bundle does not have, which is the
# same shape as the node-fetch mistake one level deeper.

echo "Removing stale .bin symlinks after dependency pruning..."
find "$SIDECAR_DIR/node_modules/.bin" -type l ! -exec test -e {} \; -print -delete 2>/dev/null || true

echo "Verifying the prune did not take a server dependency..."
# The note above the prune list is a rule; this enforces it. `node-fetch` was
# pruned once and killed every packaged instance on the Telegram path. The same
# shape came back one level deeper through fetch-blob -> web-streams-polyfill.
node "$PROJECT_ROOT/scripts/verify-sidecar-deps.mjs" "$SIDECAR_DIR"

# The dependency closure check proves resolution. It does not prove the prune
# list never names a package the packaged runtime imports — node-fetch and
# highlight.js both slipped past a package.json-only check. This guard scans
# the actual dist/bin imports and fails the build if the prune list names one.
node "$PROJECT_ROOT/scripts/qa/sidecar-deps-guard.mjs" "$PROJECT_ROOT"

NODE_BIN="$SIDECAR_DIR/node"
if [[ "$PLATFORM" == "win32" ]]; then
  NODE_BIN="$SIDECAR_DIR/node.exe"
fi

PYTHON_BIN="${PYTHON:-}"
if [ -z "$PYTHON_BIN" ] && [ -x /usr/bin/python3 ]; then
  PYTHON_BIN="/usr/bin/python3"
fi
if [ -z "$PYTHON_BIN" ] && command -v python3.11 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3.11)"
fi
if [ -z "$PYTHON_BIN" ]; then
  PYTHON_BIN="$(command -v python3)"
fi

echo "Rebuilding better-sqlite3 for bundled Node $NODE_VERSION..."
while IFS= read -r pkg_json; do
  pkg_dir="$(dirname "$pkg_json")"
  echo "  rebuild: ${pkg_dir#$SIDECAR_DIR/}"
  (
    cd "$pkg_dir"
    PYTHON="$PYTHON_BIN" \
    npm_config_python="$PYTHON_BIN" \
    npm_config_runtime=node \
    npm_config_target="$NODE_VERSION" \
    npm_config_disturl="https://nodejs.org/dist" \
    npm_config_build_from_source=true \
      npm run install --foreground-scripts
  )
done < <(find "$SIDECAR_DIR/node_modules" -path '*/better-sqlite3/package.json' -print | sort)

echo "Verifying better-sqlite3 opens with bundled Node..."
"$NODE_BIN" -e "const Database = require('better-sqlite3'); new Database(':memory:').close()" && echo "  better-sqlite3 OK" || {
  echo "ERROR: better-sqlite3 failed to open with bundled Node"
  exit 1
}

echo "Cleaning up Node extract..."
rm -rf "/tmp/${NODE_PKG}" /tmp/node-sidecar.zip 2>/dev/null || true

NATIVE_BIN="$PROJECT_ROOT/native/claude-e/target/release/jaw-claude-i"
LEGACY_NATIVE_BIN="$PROJECT_ROOT/native/jaw-claude-i/target/release/jaw-claude-i"
if [ -f "$NATIVE_BIN" ]; then
  echo "Copying jaw-claude-i..."
  cp "$NATIVE_BIN" "$SIDECAR_DIR/bin/jaw-claude-i"
  chmod +x "$SIDECAR_DIR/bin/jaw-claude-i"
elif [ -f "$LEGACY_NATIVE_BIN" ]; then
  echo "Copying jaw-claude-i from legacy native path..."
  cp "$LEGACY_NATIVE_BIN" "$SIDECAR_DIR/bin/jaw-claude-i"
  chmod +x "$SIDECAR_DIR/bin/jaw-claude-i"
else
  echo "WARN: jaw-claude-i not found, skipping (optional)"
fi

echo "Creating CLI shims..."
if [[ "$PLATFORM" == "win32" ]]; then
  cat > "$SIDECAR_DIR/bin/jaw.cmd" << 'SHIM'
@echo off
set "DIR=%~dp0.."
"%DIR%\node.exe" "%DIR%\dist\bin\cli-jaw.js" %*
SHIM
else
  cat > "$SIDECAR_DIR/bin/jaw" << 'SHIM'
#!/bin/sh
DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec "$DIR/node" "$DIR/dist/bin/cli-jaw.js" "$@"
SHIM
  chmod +x "$SIDECAR_DIR/bin/jaw"
fi

node "$PROJECT_ROOT/scripts/check-electron-sidecar-no-jwc.cjs" --server-root "$SIDECAR_DIR"

# Boot proof, not just dependency resolution: the sidecar's telegram path
# resolves node-fetch hermetically, and bin/jaw serve actually boots and
# answers health. This is the check that would have caught the original
# ERR_MODULE_NOT_FOUND before the app shipped.
node "$PROJECT_ROOT/scripts/qa/sidecar-boot-proof.mjs" "$SIDECAR_DIR"

echo "=== Sidecar ready ==="
du -sh "$SIDECAR_DIR"

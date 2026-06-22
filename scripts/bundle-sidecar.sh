#!/usr/bin/env bash
set -euo pipefail

PLATFORM="${1:?Usage: bundle-sidecar.sh <platform> <arch>}"
ARCH="${2:?Usage: bundle-sidecar.sh <platform> <arch>}"
NODE_VERSION="24.17.0"

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIDECAR_DIR="$PROJECT_ROOT/electron/sidecar/server"
JAWCODE_SRC="${CLI_JAW_LOCAL_JAWCODE:-}"

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

if [ -n "$JAWCODE_SRC" ]; then
  if [ ! -f "$JAWCODE_SRC/package.json" ]; then
    echo "ERROR: CLI_JAW_LOCAL_JAWCODE must point to a jawcode package directory with package.json" >&2
    echo "       got: $JAWCODE_SRC" >&2
    exit 1
  fi
  JAWCODE_SRC="$(cd "$JAWCODE_SRC" && pwd)"

  BUN_BIN="${BUN_BIN:-bun}"
  if ! command -v "$BUN_BIN" >/dev/null 2>&1; then
    echo "ERROR: bun is required when CLI_JAW_LOCAL_JAWCODE is set" >&2
    exit 1
  fi

  echo "Using local jawcode override: $JAWCODE_SRC"
  echo "Building jawcode Node SDK..."
  (cd "$JAWCODE_SRC" && "$BUN_BIN" run build:node)

  echo "Packing jawcode local dependency..."
  JAWCODE_TARBALL="$(basename "$(npm pack "$JAWCODE_SRC" --pack-destination "$SIDECAR_DIR" --silent)")"

  node "$PROJECT_ROOT/scripts/prepare-sidecar-package-json.cjs" \
    --package-json "$SIDECAR_DIR/package.json" \
    --remove-dependency jawcode
  npm install --omit=dev --ignore-scripts
  npm install --omit=dev --ignore-scripts "./$JAWCODE_TARBALL"
  rm -f "$SIDECAR_DIR/$JAWCODE_TARBALL"
else
  echo "Using package-lock pinned jawcode dependency."
  install_locked_production_dependencies
fi

if [ ! -f "$SIDECAR_DIR/node_modules/jawcode/package.json" ]; then
  echo "ERROR: jawcode dependency did not resolve inside sidecar" >&2
  exit 1
fi

echo "Pruning frontend-only dependencies..."
PRUNE_PKGS=(
  "@codemirror/autocomplete" "@codemirror/lang-markdown" "@codemirror/language"
  "@codemirror/language-data" "@codemirror/state" "@codemirror/view"
  "@lezer/highlight" "@lucide/icons" "@milkdown/kit" "@replit/codemirror-vim"
  "@tanstack/virtual-core" "@uiw/react-codemirror" "@xterm/addon-fit" "@xterm/xterm"
  "d3" "dompurify" "highlight.js" "katex" "marked-highlight" "mermaid"
  "react" "react-dom" "react-markdown" "rehype-katex" "rehype-sanitize"
  "remark-breaks" "remark-gfm" "remark-math" "node-fetch"
)
for pkg in "${PRUNE_PKGS[@]}"; do
  rm -rf "$SIDECAR_DIR/node_modules/$pkg" 2>/dev/null || true
done
# Remove transitive-only packages (types, build tools)
rm -rf "$SIDECAR_DIR/node_modules/typescript" 2>/dev/null || true
rm -rf "$SIDECAR_DIR/node_modules/@types" 2>/dev/null || true
rm -rf "$SIDECAR_DIR/node_modules/@babel" 2>/dev/null || true
rm -rf "$SIDECAR_DIR/node_modules/@vue" 2>/dev/null || true
rm -rf "$SIDECAR_DIR/node_modules/cytoscape" 2>/dev/null || true
rm -rf "$SIDECAR_DIR/node_modules/cytoscape-fcose" 2>/dev/null || true
rm -rf "$SIDECAR_DIR/node_modules/es-toolkit" 2>/dev/null || true
rm -rf "$SIDECAR_DIR/node_modules/lodash" 2>/dev/null || true
rm -rf "$SIDECAR_DIR/node_modules/web-streams-polyfill" 2>/dev/null || true

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

echo "Verifying jawcode SDK import with bundled Node..."
if "$NODE_BIN" --input-type=module <<'NODE'
const sdk = await import("jawcode/sdk");
if (typeof sdk.createAgentSession !== "function") {
  throw new Error("missing createAgentSession");
}
NODE
then
  echo "  jawcode SDK OK"
else
  echo "ERROR: jawcode SDK failed to import with bundled Node"
  exit 1
fi

echo "Cleaning up Node extract..."
rm -rf "/tmp/${NODE_PKG}" /tmp/node-sidecar.zip 2>/dev/null || true

NATIVE_BIN="$PROJECT_ROOT/native/jaw-claude-i/target/release/jaw-claude-i"
if [ -f "$NATIVE_BIN" ]; then
  echo "Copying jaw-claude-i..."
  cp "$NATIVE_BIN" "$SIDECAR_DIR/bin/jaw-claude-i"
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
  cat > "$SIDECAR_DIR/bin/jwc.cmd" << 'SHIM'
@echo off
set "DIR=%~dp0.."
"%DIR%\node.exe" "%DIR%\node_modules\jawcode\bin\jwc.js" %*
SHIM
else
  cat > "$SIDECAR_DIR/bin/jaw" << 'SHIM'
#!/bin/sh
DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec "$DIR/node" "$DIR/dist/bin/cli-jaw.js" "$@"
SHIM
  chmod +x "$SIDECAR_DIR/bin/jaw"
  cat > "$SIDECAR_DIR/bin/jwc" << 'SHIM'
#!/bin/sh
DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec "$DIR/node" "$DIR/node_modules/jawcode/bin/jwc.js" "$@"
SHIM
  chmod +x "$SIDECAR_DIR/bin/jwc"
fi

node "$PROJECT_ROOT/scripts/check-electron-sidecar-jwc.cjs" --server-root "$SIDECAR_DIR"

echo "=== Sidecar ready ==="
du -sh "$SIDECAR_DIR"

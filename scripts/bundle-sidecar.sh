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

# Refuse to build a sidecar whose prune list would strip a runtime dependency.
# Failing here costs a few seconds; failing later costs a shipped app that dies
# on first use, which is exactly what happened with node-fetch.
node "$PROJECT_ROOT/scripts/check-sidecar-prune-safety.mjs"

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
# Every entry here is deleted from the bundled sidecar, so a package the server
# imports must never appear. It did: node-fetch sat in this list from the commit
# that created this script while src/telegram/bot.ts imports it, and every
# packaged desktop app died with ERR_MODULE_NOT_FOUND the moment that module
# loaded. check-sidecar-prune-safety.mjs now fails the build when this list and
# the server's real imports disagree.
PRUNE_PKGS=(
  "@codemirror/autocomplete" "@codemirror/lang-markdown" "@codemirror/language"
  "@codemirror/language-data" "@codemirror/state" "@codemirror/view"
  "@lezer/highlight" "@lucide/icons" "@milkdown/kit" "@replit/codemirror-vim"
  "@tanstack/virtual-core" "@uiw/react-codemirror" "@xterm/addon-fit" "@xterm/xterm"
  "d3" "dompurify" "katex" "marked-highlight" "mermaid"
  "react" "react-dom" "react-markdown" "rehype-katex" "rehype-sanitize"
  "remark-breaks" "remark-gfm" "remark-math"
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

echo "Removing stale .bin symlinks after dependency pruning..."
find "$SIDECAR_DIR/node_modules/.bin" -type l ! -exec test -e {} \; -print -delete 2>/dev/null || true

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
  # better-sqlite3 >= 13 is Node-API: it ships prebuilds/ inside the package,
  # has NO scripts.install (`npm run install` dies with "Missing script"), and
  # the prebuild is ABI-independent, so no per-Node rebuild is needed at all.
  # v12 keeps the old install script ("prebuild-install || node-gyp rebuild").
  # The verification step below opens the DB with the bundled Node either way.
  has_install_script="$("$NODE_BIN" -e 'const p=require(process.argv[1]);process.stdout.write(p.scripts&&p.scripts.install?"yes":"no")' "$pkg_json")"
  if [ "$has_install_script" = "no" ]; then
    echo "  skip rebuild (v13+ bundled prebuilds): ${pkg_dir#$SIDECAR_DIR/}"
    continue
  fi
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
  echo "  bundled prebuild failed to load — building from source (v13 build-release)..."
  sidecar_bsql_dir="$SIDECAR_DIR/node_modules/better-sqlite3"
  if [ -d "$sidecar_bsql_dir" ]; then
    (
      cd "$sidecar_bsql_dir"
      PYTHON="$PYTHON_BIN" \
      npm_config_python="$PYTHON_BIN" \
      npm_config_runtime=node \
      npm_config_target="$NODE_VERSION" \
      npm_config_disturl="https://nodejs.org/dist" \
        npm run build-release --foreground-scripts
    )
  fi
  "$NODE_BIN" -e "const Database = require('better-sqlite3'); new Database(':memory:').close()" && echo "  better-sqlite3 OK (source build)" || {
    echo "ERROR: better-sqlite3 failed to open with bundled Node"
    exit 1
  }
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

# Static prune analysis runs before the build; this runs after, on the artifact
# that will actually ship. The prune guard reasons about bare specifiers and
# cannot see a computed `import(spec)`, so it can only ever be as complete as
# its manual RUNTIME_LOADED list. Importing the critical modules for real
# closes that gap by construction — a dashboard returning 200 never proved the
# Telegram bot could load.
node "$PROJECT_ROOT/scripts/check-sidecar-smoke.mjs" --server-root "$SIDECAR_DIR"

# Sidecar install-state receipt. The sidecar is deliberately built with
# --ignore-scripts, so postinstall-guard never runs here and its receipt would
# be absent — which the runtime integrity check would misread as a blocked
# install and nag every desktop user. This is a controlled build: writing the
# receipt ourselves, with the sidecar's own package version, is the honest
# record of what happened.
echo "Writing sidecar install-state receipt..."
"$NODE_BIN" -e '
const fs = require("fs"), path = require("path");
const root = process.argv[1];
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
fs.writeFileSync(path.join(root, ".jaw-install-state.json"), JSON.stringify({
  schema: 1,
  state: "completed",
  sidecar: true,
  packageVersion,
  ranAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
}, null, 2));
' "$SIDECAR_DIR"

echo "=== Sidecar ready ==="
du -sh "$SIDECAR_DIR"

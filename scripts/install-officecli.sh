#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  install-officecli.sh — Install OfficeCLI binary (fork-first, CJK-enhanced)
#  Default: lidge-jun/OfficeCLI (includes CJK font handling)
#  Override: --upstream to install vanilla iOfficeAI/OfficeCLI
#  Override: OFFICECLI_REPO=other/repo to use a different source
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

# ── Colors ──
CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'

info()  { echo -e "${CYAN}▸${NC} $*"; }
ok()    { echo -e "${GREEN}✔${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
fail()  { echo -e "${RED}✖${NC} $*"; exit 1; }

ENV_REPO="${OFFICECLI_REPO:-}"
REPO="${ENV_REPO:-lidge-jun/OfficeCLI}"
INSTALL_DIR="${HOME}/.local/bin"
TARGET_BIN="${INSTALL_DIR}/officecli"
DOWNLOAD_BIN="${INSTALL_DIR}/officecli.download"

UPSTREAM=false
FORCE=false
UPDATE=false
for arg in "$@"; do
  case "$arg" in
    --upstream)
      if [ -n "$ENV_REPO" ]; then
        fail "--upstream cannot be combined with OFFICECLI_REPO"
      fi
      UPSTREAM=true
      REPO="iOfficeAI/OfficeCLI"
      ;;
    --force)    FORCE=true ;;
    --update)   UPDATE=true ;;
    -h|--help)
      cat <<'EOF'
Usage: ./scripts/install-officecli.sh [--force] [--update] [--upstream]

Options:
  --force      Reinstall even when officecli already exists
  --update     Reinstall only when the installed version is older than latest
  --upstream   Use vanilla iOfficeAI/OfficeCLI instead of the CJK-enhanced fork
EOF
      exit 0
      ;;
    *)
      fail "Unknown argument: ${arg}"
      ;;
  esac
done

command -v curl >/dev/null 2>&1 || fail "curl is required"

# ── Detect platform ──
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  darwin)
    case "$ARCH" in
      arm64)  ASSET="officecli-mac-arm64" ;;
      x86_64) ASSET="officecli-mac-x64" ;;
      *) fail "Unsupported macOS architecture: $ARCH" ;;
    esac
    ;;
  linux)
    LIBC="gnu"
    if command -v ldd &>/dev/null && ldd --version 2>&1 | grep -qi musl; then
      LIBC="musl"
    elif [ -f /etc/alpine-release ]; then
      LIBC="musl"
    fi
    case "$ARCH" in
      x86_64)
        [ "$LIBC" = "musl" ] && ASSET="officecli-linux-alpine-x64" || ASSET="officecli-linux-x64" ;;
      aarch64|arm64)
        [ "$LIBC" = "musl" ] && ASSET="officecli-linux-alpine-arm64" || ASSET="officecli-linux-arm64" ;;
      *) fail "Unsupported Linux architecture: $ARCH" ;;
    esac
    ;;
  *) fail "Unsupported OS: $OS" ;;
esac

info "Platform: ${OS}/${ARCH} → ${ASSET}"

normalize_version() {
  printf '%s' "${1:-}" | sed 's/^v//'
}

get_latest_version() {
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n 1
}

# ── Check existing installation ──
if [ -f "$TARGET_BIN" ] && [ "$FORCE" = "false" ] && [ "$UPDATE" = "false" ]; then
  if CURRENT=$("$TARGET_BIN" --version 2>/dev/null); then
    ok "officecli already installed: v${CURRENT}"
    echo "  Use --force to reinstall or --update to refresh only when outdated"
    exit 0
  fi

  warn "Existing officecli is not executable; reinstalling"
fi

if [ -f "$TARGET_BIN" ] && [ "$FORCE" = "false" ] && [ "$UPDATE" = "true" ]; then
  CURRENT=$("$TARGET_BIN" --version 2>/dev/null || true)
  LATEST=$(get_latest_version)
  if [ -n "$CURRENT" ] && [ -n "$LATEST" ] && [ "$(normalize_version "$CURRENT")" = "$(normalize_version "$LATEST")" ]; then
    ok "officecli already up to date: v$(normalize_version "$CURRENT")"
    exit 0
  fi
  if [ -n "$CURRENT" ] && [ -n "$LATEST" ]; then
    info "Updating officecli v$(normalize_version "$CURRENT") → v$(normalize_version "$LATEST")"
  else
    warn "Could not compare installed version with latest release; reinstalling"
  fi
fi

# ── Download ──
mkdir -p "$INSTALL_DIR"
DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
CHECKSUM_URL="https://github.com/${REPO}/releases/latest/download/SHA256SUMS"

info "Downloading officecli from ${REPO}..."
trap 'rm -f "$DOWNLOAD_BIN"' EXIT
curl -fsSL "$DOWNLOAD_URL" -o "$DOWNLOAD_BIN" || fail "Download failed: $DOWNLOAD_URL"
chmod +x "$DOWNLOAD_BIN"

if [ "$OS" = "darwin" ]; then
  if command -v xattr >/dev/null 2>&1; then
    xattr -d com.apple.quarantine "$DOWNLOAD_BIN" >/dev/null 2>&1 || true
  fi
  if command -v codesign >/dev/null 2>&1; then
    codesign --force --deep --sign - "$DOWNLOAD_BIN" >/dev/null 2>&1 || warn "Ad-hoc codesign failed; continuing"
  fi
fi

# ── Verify checksum (best-effort) ──
if command -v shasum &>/dev/null || command -v sha256sum &>/dev/null; then
  EXPECTED=$(curl -fsSL "$CHECKSUM_URL" 2>/dev/null | grep "$ASSET" | awk '{print $1}')
  if [ -n "$EXPECTED" ]; then
    if command -v shasum &>/dev/null; then
      ACTUAL=$(shasum -a 256 "$DOWNLOAD_BIN" | awk '{print $1}')
    else
      ACTUAL=$(sha256sum "$DOWNLOAD_BIN" | awk '{print $1}')
    fi
    if [ "$EXPECTED" = "$ACTUAL" ]; then
      ok "Checksum verified"
    else
      warn "Checksum mismatch (expected: ${EXPECTED:0:12}…, got: ${ACTUAL:0:12}…)"
    fi
  fi
fi

# ── Verify binary runs ──
VERSION=$("$DOWNLOAD_BIN" --version 2>/dev/null) || fail "Binary exists but won't execute"
mv "$DOWNLOAD_BIN" "$TARGET_BIN"
ok "officecli v${VERSION} installed → ${TARGET_BIN}"

# ── Source info ──
echo "Installed: $("$TARGET_BIN" --version 2>/dev/null || echo 'unknown')"
if [ "$UPSTREAM" = "true" ]; then
  echo "Source: ${REPO} (upstream)"
elif [ -n "$ENV_REPO" ]; then
  echo "Source: ${REPO} (custom override)"
else
  echo "Source: ${REPO} (CJK-enhanced fork)"
fi

# ── PATH hint ──
if ! command -v officecli &>/dev/null; then
  echo ""
  warn "officecli is not on your PATH. Add this to your shell profile:"
  echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
fi

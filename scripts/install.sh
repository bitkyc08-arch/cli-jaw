#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  🦈 CLI-JAW — One-Click Installer (macOS / Linux)
#  Usage:  curl -fsSL https://raw.githubusercontent.com/lidge-jun/cli-jaw/master/scripts/install.sh | bash
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

# ── Colors ──
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}▸${NC} $*"; }
ok()    { echo -e "${GREEN}✔${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
fail()  { echo -e "${RED}✖${NC} $*"; exit 1; }

echo ""
echo -e "${CYAN}${BOLD}"
echo "   ██████╗██╗     ██╗      ██╗ █████╗ ██╗    ██╗"
echo "  ██╔════╝██║     ██║      ██║██╔══██╗██║    ██║"
echo "  ██║     ██║     ██║█████╗██║███████║██║ █╗ ██║"
echo "  ██║     ██║     ██║╚════╝██║██╔══██║██║███╗██║"
echo "  ╚██████╗███████╗██║      ██║██║  ██║╚███╔███╔╝"
echo "   ╚═════╝╚══════╝╚═╝      ╚═╝╚═╝  ╚═╝ ╚══╝╚══╝"
echo -e "${NC}"
echo -e "${DIM}  One-Click Installer${NC}"
echo ""

NODE_MAJOR=22

# ═══════════════════════════════════════
#  Step 1: Ensure Node.js ≥ 22
# ═══════════════════════════════════════
ensure_node() {
  # Already have Node.js ≥ 22?
  if command -v node &>/dev/null; then
    local ver
    ver=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$ver" -ge "$NODE_MAJOR" ] 2>/dev/null; then
      ok "Node.js $(node -v) detected — good to go"
      return 0
    fi
    warn "Node.js $(node -v) found but need ≥ ${NODE_MAJOR}"
  fi

  info "Node.js ≥ ${NODE_MAJOR} not found — installing..."

  # Strategy: brew → nvm → fail
  if command -v brew &>/dev/null; then
    info "Homebrew detected — installing Node.js via brew"
    brew install node@${NODE_MAJOR}
    # brew link if needed
    brew link --overwrite node@${NODE_MAJOR} 2>/dev/null || true
    ok "Node.js installed via Homebrew"
    return 0
  fi

  # No brew → install nvm + Node.js
  info "No Homebrew — installing via nvm"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi

  # Source nvm
  # shellcheck source=/dev/null
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

  if ! command -v nvm &>/dev/null; then
    fail "nvm installation failed. Please install Node.js ≥ ${NODE_MAJOR} manually from https://nodejs.org"
  fi

  nvm install "$NODE_MAJOR"
  nvm use "$NODE_MAJOR"
  nvm alias default "$NODE_MAJOR"
  ok "Node.js $(node -v) installed via nvm"

  # Remind user to add nvm to their shell
  local shell_rc
  case "${SHELL:-/bin/bash}" in
    */zsh)  shell_rc="~/.zshrc" ;;
    */bash) shell_rc="~/.bashrc" ;;
    *)      shell_rc="your shell config" ;;
  esac
  echo ""
  warn "For future sessions, nvm is auto-added to ${shell_rc}"
  echo -e "${DIM}   If 'node' is not found after restarting terminal, run: source ${shell_rc}${NC}"
}

# ═══════════════════════════════════════
#  Step 2: Install CLI-JAW
# ═══════════════════════════════════════
install_cli_jaw() {
  info "Installing CLI-JAW..."
  npm install -g cli-jaw
  ok "CLI-JAW $(jaw --version 2>/dev/null || echo '') installed"
}

# ═══════════════════════════════════════
#  Step 3: Browser skill deps (Chromium + playwright-core)
# ═══════════════════════════════════════
install_browser_deps() {
  info "Installing browser skill dependencies..."

  # playwright-core (CDP client)
  # Check global install via npm root -g (matches doctor.ts approach)
  PW_FOUND=false
  if command -v npm &>/dev/null; then
    GLOBAL_ROOT="$(npm root -g 2>/dev/null)"
    if [ -d "$GLOBAL_ROOT/playwright-core" ]; then
      PW_FOUND=true
    fi
  fi
  # Fallback: require.resolve for local installs
  if ! $PW_FOUND && node -e "require.resolve('playwright-core')" 2>/dev/null; then
    PW_FOUND=true
  fi
  if $PW_FOUND; then
    ok "playwright-core already installed"
  else
    npm install -g playwright-core
    ok "playwright-core installed"
  fi

  # Chromium (headless browser) — use --version to verify actual execution (snap transitional may pass command -v but fail to run)
  if (chromium-browser --version &>/dev/null 2>&1) || (chromium --version &>/dev/null 2>&1) || (google-chrome-stable --version &>/dev/null 2>&1) || (google-chrome --version &>/dev/null 2>&1); then
    ok "Browser already installed"
    return 0
  fi

  case "$(uname -s)" in
    Darwin)
      # macOS: Chrome 설치 안내 (수동)
      if [ -d "/Applications/Google Chrome.app" ]; then
        ok "Google Chrome found"
      else
        warn "Google Chrome not found — install from https://google.com/chrome"
      fi
      ;;
    Linux)
      # Linux: 자동 설치 시도
      # Determine privilege escalation method
      local SUDO=""
      if [ "$(id -u)" -eq 0 ]; then
        SUDO=""  # already root
      elif command -v sudo &>/dev/null; then
        SUDO="sudo"
      else
        warn "No sudo available and not running as root — skipping Chromium install"
        warn "Install manually: apt install chromium-browser (as root)"
        return 0
      fi

      if command -v apt-get &>/dev/null; then
        info "Installing Chromium via apt..."
        $SUDO apt-get update -qq
        $SUDO apt-get install -y -qq chromium-browser 2>/dev/null \
          || $SUDO apt-get install -y -qq chromium 2>/dev/null \
          || true
        # Verify install actually succeeded (--version confirms binary actually runs)
        if (chromium-browser --version &>/dev/null 2>&1) || (chromium --version &>/dev/null 2>&1); then
          ok "Chromium installed"
        else
          warn "Chromium install failed — install manually: sudo apt install chromium-browser"
        fi
      elif command -v dnf &>/dev/null; then
        info "Installing Chromium via dnf..."
        $SUDO dnf install -y chromium || true
        if (chromium-browser --version &>/dev/null 2>&1) || (chromium --version &>/dev/null 2>&1); then
          ok "Chromium installed"
        else
          warn "Chromium install failed — install manually: sudo dnf install chromium"
        fi
      else
        warn "Could not auto-install Chromium — install manually for your distro"
      fi
      ;;
  esac
}

# ═══════════════════════════════════════
#  Run
# ═══════════════════════════════════════
ensure_node
install_cli_jaw
install_browser_deps

echo ""
echo -e "${GREEN}${BOLD}  🎉 All done!${NC}"
echo ""
echo -e "  Start your AI assistant:"
echo -e "  ${CYAN}${BOLD}jaw serve${NC}"
echo -e "  ${DIM}→ http://localhost:3457${NC}"
echo ""

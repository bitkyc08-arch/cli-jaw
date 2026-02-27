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
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash
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
#  Run
# ═══════════════════════════════════════
ensure_node
install_cli_jaw

echo ""
echo -e "${GREEN}${BOLD}  🎉 All done!${NC}"
echo ""
echo -e "  Start your AI assistant:"
echo -e "  ${CYAN}${BOLD}jaw serve${NC}"
echo -e "  ${DIM}→ http://localhost:3457${NC}"
echo ""

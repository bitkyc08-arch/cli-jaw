#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  🦈 CLI-JAW — WSL One-Click Installer
#  Usage:  curl -fsSL https://raw.githubusercontent.com/lidge-jun/cli-jaw/master/scripts/install-wsl.sh | bash
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
echo -e "${DIM}  WSL One-Click Installer${NC}"
echo ""

NODE_MAJOR=22

# ═══════════════════════════════════════
#  Step 1: Node.js version manager
# ═══════════════════════════════════════
install_node() {
  # Check if Node.js >= 22 already exists
  if command -v node &>/dev/null; then
    local ver
    ver=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$ver" -ge "$NODE_MAJOR" ] 2>/dev/null; then
      ok "Node.js $(node -v) already installed (>= $NODE_MAJOR)"
      return 0
    else
      warn "Node.js $(node -v) found but < $NODE_MAJOR — upgrading..."
    fi
  fi

  # Prefer fnm (fast, single binary), fall back to nvm if already present
  if command -v fnm &>/dev/null; then
    info "fnm detected — installing Node.js $NODE_MAJOR..."
    fnm install "$NODE_MAJOR" && fnm use "$NODE_MAJOR" && fnm default "$NODE_MAJOR"
  elif command -v nvm &>/dev/null || [ -s "$HOME/.nvm/nvm.sh" ]; then
    info "nvm detected — installing Node.js $NODE_MAJOR..."
    # shellcheck disable=SC1091
    [ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
    nvm install "$NODE_MAJOR" && nvm alias default "$NODE_MAJOR"
  else
    info "Installing fnm (Fast Node Manager)..."
    curl -fsSL https://fnm.vercel.app/install | bash

    # Load fnm into current session
    export PATH="$HOME/.local/share/fnm:$PATH"
    eval "$(fnm env)"

    info "Installing Node.js $NODE_MAJOR via fnm..."
    fnm install "$NODE_MAJOR" && fnm use "$NODE_MAJOR" && fnm default "$NODE_MAJOR"
  fi

  # Verify
  if command -v node &>/dev/null; then
    ok "Node.js $(node -v) ready"
  else
    fail "Node.js installation failed. Please install manually: https://nodejs.org"
  fi
}

# ═══════════════════════════════════════
#  Step 2: Install cli-jaw
# ═══════════════════════════════════════
install_jaw() {
  if command -v jaw &>/dev/null; then
    ok "cli-jaw already installed ($(jaw --version 2>/dev/null || echo 'unknown version'))"
    info "Updating to latest..."
    npm install -g cli-jaw@latest
  else
    info "Installing cli-jaw globally..."
    npm install -g cli-jaw
  fi

  ok "cli-jaw installed: $(jaw --version 2>/dev/null || echo 'done')"
}

# ═══════════════════════════════════════
#  Step 3: Doctor check
# ═══════════════════════════════════════
run_doctor() {
  info "Running diagnostics..."
  jaw doctor || true
}

# ═══════════════════════════════════════
#  Main
# ═══════════════════════════════════════
main() {
  info "Starting CLI-JAW installation on WSL..."
  echo ""

  install_node
  echo ""

  install_jaw
  echo ""

  run_doctor
  echo ""

  echo -e "${GREEN}${BOLD}═══════════════════════════════════════${NC}"
  echo -e "${GREEN}${BOLD}  🦈 CLI-JAW is ready!${NC}"
  echo -e "${GREEN}${BOLD}═══════════════════════════════════════${NC}"
  echo ""
  echo -e "  Run:  ${CYAN}jaw serve${NC}"
  echo -e "  Open: ${CYAN}http://localhost:3457${NC}"
  echo ""
  echo -e "${DIM}  Tip: Authenticate at least one AI engine:${NC}"
  echo -e "${DIM}    gh auth login        # GitHub Copilot (free)${NC}"
  echo -e "${DIM}    claude auth           # Anthropic Claude${NC}"
  echo -e "${DIM}    codex login           # OpenAI Codex${NC}"
  echo ""
}

main "$@"

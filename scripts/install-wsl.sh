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
SUDO=""
HAS_SUDO=false

ensure_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    HAS_SUDO=true
    SUDO=""
    ok "Running as root — full system install available"
    return 0
  fi

  if ! command -v sudo &>/dev/null; then
    warn "sudo not found — system package install will be skipped"
    return 0
  fi

  info "Requesting sudo once for WSL system setup..."
  if sudo -v; then
    HAS_SUDO=true
    SUDO="sudo"
    ok "sudo ready — system dependencies can be installed"
  else
    warn "sudo authentication failed — continuing with user-space setup only"
  fi
}

# ═══════════════════════════════════════
#  Step 0: System prerequisites
# ═══════════════════════════════════════
install_prerequisites() {
  local packages=(
    curl
    unzip
    git
    ca-certificates
    build-essential
    python3
    make
    g++
    pkg-config
    xdg-utils
    file
    fonts-noto-cjk
  )

  if [ "$HAS_SUDO" = true ]; then
    info "Installing WSL system prerequisites..."
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq "${packages[@]}"
    ok "System prerequisites installed"
  else
    warn "Skipping apt prerequisites (sudo unavailable)"
    warn "Recommended packages: ${packages[*]}"
  fi
}

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
#  Step 2: Configure user-local npm prefix
# ═══════════════════════════════════════
configure_npm_prefix() {
  local prefix="$HOME/.local"
  mkdir -p "$prefix/bin" "$prefix/lib"
  npm config set prefix "$prefix"
  export PATH="$prefix/bin:$PATH"

  local profile="$HOME/.bashrc"
  [ -f "$HOME/.zshrc" ] && profile="$HOME/.zshrc"
  if ! grep -q 'export PATH="$HOME/.local/bin:$PATH"' "$profile" 2>/dev/null; then
    {
      echo ''
      echo '# CLI-JAW: user-local npm global bin'
      echo 'export PATH="$HOME/.local/bin:$PATH"'
    } >> "$profile"
    ok "Added ~/.local/bin to $profile"
  fi

  ok "npm global prefix set to $(npm config get prefix)"
}

# ═══════════════════════════════════════
#  Step 3: Install cli-jaw
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
#  Step 4: Browser + Office dependencies
# ═══════════════════════════════════════
install_browser_deps() {
  info "Installing browser dependencies..."
  npm install -g playwright-core
  ok "playwright-core installed"

  if [ "$HAS_SUDO" = true ]; then
    info "Installing Chromium (best effort)..."
    $SUDO apt-get install -y -qq chromium-browser 2>/dev/null \
      || $SUDO apt-get install -y -qq chromium 2>/dev/null \
      || warn "Chromium package unavailable — Windows Chrome fallback will be used if present"
  else
    warn "Skipping Chromium apt install (sudo unavailable)"
  fi
}

install_officecli() {
  local global_root
  global_root="$(npm root -g 2>/dev/null || true)"
  local installer="${global_root}/cli-jaw/scripts/install-officecli.sh"
  if [ ! -f "$installer" ]; then
    warn "OfficeCLI installer not found in global package — skipping"
    return 0
  fi

  info "Installing OfficeCLI..."
  bash "$installer" || warn "OfficeCLI install failed — rerun later: bash \"$installer\""
}

# ═══════════════════════════════════════
#  Step 5: Doctor check
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

  ensure_sudo
  echo ""

  install_prerequisites
  echo ""

  install_node
  echo ""

  configure_npm_prefix
  echo ""

  install_jaw
  echo ""

  install_browser_deps
  echo ""

  install_officecli
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

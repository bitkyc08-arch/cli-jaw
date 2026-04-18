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

extract_semver() {
  printf '%s' "${1:-}" | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true
}

resolve_cmd() {
  command -v "$1" 2>/dev/null || true
}

get_installed_jaw_binary() {
  local jaw_bin
  jaw_bin="$(resolve_cmd jaw)"
  if [ -n "$jaw_bin" ]; then
    printf '%s\n' "$jaw_bin"
    return 0
  fi

  local cli_jaw_bin
  cli_jaw_bin="$(resolve_cmd cli-jaw)"
  if [ -n "$cli_jaw_bin" ]; then
    printf '%s\n' "$cli_jaw_bin"
    return 0
  fi

  return 1
}

get_binary_version() {
  local bin_path="${1:-}"
  if [ -z "$bin_path" ]; then
    return 0
  fi
  extract_semver "$("$bin_path" --version 2>/dev/null | head -n1)"
}

get_latest_cli_jaw_version() {
  extract_semver "$(npm view cli-jaw version 2>/dev/null || true)"
}

realpath_fallback() {
  local target="${1:-}"
  if [ -z "$target" ]; then
    return 0
  fi
  node -e "const fs=require('fs');const p=process.argv[1];try{console.log(fs.realpathSync(p));}catch{console.log(p)}" "$target" 2>/dev/null || printf '%s\n' "$target"
}

# Shell-level Claude install classifier — mirrors src/core/claude-install.ts
# Returns: native | node-managed | unknown
classify_claude_install_sh() {
  local bin_path="${1:-}"
  local real_path="${2:-}"
  if [ -z "$bin_path" ]; then
    echo "unknown"
    return 0
  fi

  # Check native paths
  case "$bin_path" in
    "$HOME/.local/bin/claude"|"$HOME/.claude/local/bin/claude")
      echo "native"
      return 0
      ;;
  esac

  # Check realpath for node_modules or native
  if [ -n "$real_path" ]; then
    case "$real_path" in
      */node_modules/@anthropic-ai/claude-code/*)
        echo "node-managed"
        return 0
        ;;
      */.claude/local/*)
        echo "native"
        return 0
        ;;
    esac
  fi

  # Check bun bin
  case "$bin_path" in
    */.bun/bin/claude)
      echo "node-managed"
      return 0
      ;;
  esac

  echo "unknown"
}

print_cli_dependency_guidance() {
  echo ""
  info "CLI dependency guidance"

  warn "Claude Code users who need computer-use MCP should prefer Anthropic's native installer:"
  echo -e "${DIM}   curl -fsSL https://claude.ai/install.sh | bash${NC}"
  echo -e "${DIM}   or run: claude install${NC}"

  local claude_bin claude_real claude_kind
  claude_bin="$(resolve_cmd claude)"
  if [ -n "$claude_bin" ]; then
    claude_real="$(realpath_fallback "$claude_bin")"
    claude_kind="$(classify_claude_install_sh "$claude_bin" "$claude_real")"
    case "$claude_kind" in
      native)
        ok "Claude CLI looks native (${claude_bin})"
        ;;
      node-managed)
        warn "Claude CLI appears npm/bun-managed (${claude_bin})"
        warn "For computer-use MCP, reinstall Claude natively or run: claude install"
        ;;
      *)
        warn "Claude CLI detected at ${claude_bin} — verify it is native if you need computer-use MCP"
        ;;
    esac
  else
    warn "Claude CLI not detected — install only if you plan to use Claude"
  fi

  local codex_bin
  codex_bin="$(resolve_cmd codex)"
  if [ -n "$codex_bin" ]; then
    ok "Codex CLI detected (${codex_bin}) — npm/bun/global installs are fine"
  else
    info "Optional: install Codex with npm or bun if you want OpenAI as a backend"
  fi
}

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
  local installed_bin installed_version latest_version
  installed_bin="$(get_installed_jaw_binary || true)"
  installed_version="$(get_binary_version "$installed_bin")"
  latest_version="$(get_latest_cli_jaw_version)"

  # If npm view failed (network issue) and we already have a working install, skip
  if [ -z "$latest_version" ] && [ -n "$installed_bin" ] && [ -n "$installed_version" ]; then
    warn "Could not fetch latest version (network issue?) — keeping existing ${installed_version}"
    ok "CLI-JAW ${installed_version} at ${installed_bin} — skipping update"
    return 0
  fi

  if [ -n "$installed_bin" ] && [ -n "$installed_version" ] && [ -n "$latest_version" ] && [ "$installed_version" = "$latest_version" ]; then
    ok "CLI-JAW ${installed_version} already installed at ${installed_bin} — skipping npm install"
    return 0
  fi

  # Detect package manager from existing install path to avoid shared-path contamination
  local pkg_cmd="npm install -g cli-jaw"
  if [ -n "$installed_bin" ]; then
    case "$installed_bin" in
      *"/.bun/bin/"*)
        pkg_cmd="bun add -g cli-jaw"
        info "Detected bun-managed install — using bun"
        ;;
      *)
        info "Using npm for global install"
        ;;
    esac
  fi

  if [ -n "$installed_bin" ] && [ -n "$installed_version" ]; then
    info "Updating CLI-JAW ${installed_version} → ${latest_version:-latest}"
  else
    info "Installing CLI-JAW..."
  fi
  eval "$pkg_cmd"

  # Post-install verification: re-resolve and check version
  local new_bin new_ver
  new_bin="$(get_installed_jaw_binary || true)"
  new_ver="$(get_binary_version "$new_bin")"
  if [ -n "$new_bin" ] && [ -n "$new_ver" ]; then
    ok "CLI-JAW ${new_ver} installed at ${new_bin}"
  else
    warn "CLI-JAW install completed but binary not responding — check your PATH"
  fi
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
print_cli_dependency_guidance

echo ""
echo -e "${GREEN}${BOLD}  🎉 All done!${NC}"
echo ""
echo -e "  Start your AI assistant:"
echo -e "  ${CYAN}${BOLD}jaw serve${NC}"
echo -e "  ${DIM}→ http://localhost:3457${NC}"
echo ""

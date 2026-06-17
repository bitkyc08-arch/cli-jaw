#!/usr/bin/env bash
# Verify a completed CLI-JAW fresh install from a newly opened macOS/Linux shell.
set -euo pipefail

SKIP_DOCTOR=0
for arg in "$@"; do
  case "$arg" in
    --skip-doctor) SKIP_DOCTOR=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

fail() {
  echo "✖ $*" >&2
  exit 1
}

ok() {
  echo "✔ $*"
}

run_version() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || fail "$name is not on PATH"
  local resolved
  resolved="$(command -v "$name")"
  case "$(uname -s 2>/dev/null || true)" in
    MINGW*|MSYS*|CYGWIN*) ;;
    *) [ -x "$resolved" ] || fail "$name is on PATH but not executable: $resolved" ;;
  esac
  "$name" --version >/dev/null 2>&1 || fail "$name is on PATH but '$name --version' failed"
  ok "$name works: $resolved"
}

run_optional_version() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1 && "$name" --version >/dev/null 2>&1; then
    ok "$name works: $(command -v "$name")"
    return 0
  fi
  if [ "${CLI_JAW_REQUIRE_OPTIONAL_RUNTIMES:-0}" = "1" ] || [ "${CLI_JAW_REQUIRE_OPTIONAL_RUNTIMES:-}" = "true" ]; then
    fail "$name optional runtime is missing or not runnable"
  fi
  ok "$name optional runtime not available; continuing"
}

path_contains() {
  local needle="$1"
  case ":${PATH:-}:" in
    *":$needle:"*) return 0 ;;
    *) return 1 ;;
  esac
}

should_check_zsh() {
  command -v zsh >/dev/null 2>&1 || return 1

  case "$(uname -s 2>/dev/null || true)" in
    Darwin) return 0 ;;
  esac

  case "${SHELL:-}" in
    */zsh) return 0 ;;
  esac

  [ -f "$HOME/.zshrc" ] || [ -f "$HOME/.zprofile" ]
}

is_wsl() {
  [ -n "${WSL_DISTRO_NAME:-}" ] && return 0
  grep -qi microsoft /proc/version 2>/dev/null
}

echo "CLI-JAW fresh-install verification"
echo "shell=${SHELL:-unknown}"
echo "path=${PATH:-}"

run_version node
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1 \
  || fail "node version is below 22: $(node --version 2>/dev/null || echo unknown)"
ok "node version is >=22: $(node --version)"

run_version npm
run_version jaw
run_version cli-jaw
run_optional_version ai-e
run_optional_version claude-e

if command -v npm >/dev/null 2>&1; then
  npm_prefix="$(npm prefix -g 2>/dev/null || true)"
  npm_bin="${npm_prefix%/}/bin"
  if [ -n "$npm_prefix" ] && [ -d "$npm_bin" ]; then
    path_contains "$npm_bin" || fail "npm global bin is not on PATH: $npm_bin"
    ok "npm global bin is on PATH: $npm_bin"
  fi
fi

if [ -x "$HOME/.local/bin/claude" ]; then
  path_contains "$HOME/.local/bin" || fail "~/.local/bin contains claude but is not on PATH"
  "$HOME/.local/bin/claude" --version >/dev/null 2>&1 || fail "native claude exists but failed --version"
  ok "native claude path is usable"
fi

if should_check_zsh; then
  zsh -ic 'command -v node >/dev/null && command -v npm >/dev/null && command -v jaw >/dev/null && command -v cli-jaw >/dev/null' >/dev/null 2>&1 \
    || fail "interactive zsh cannot resolve node/npm/jaw/cli-jaw"
  ok "interactive zsh resolves node/npm/jaw/cli-jaw"

  zsh -lc 'command -v node >/dev/null && command -v npm >/dev/null && command -v jaw >/dev/null && command -v cli-jaw >/dev/null' >/dev/null 2>&1 \
    || fail "login zsh cannot resolve node/npm/jaw/cli-jaw"
  ok "login zsh resolves node/npm/jaw/cli-jaw"
fi

if is_wsl; then
  bash -lc 'command -v node >/dev/null && node --version >/dev/null && command -v npm >/dev/null && npm --version >/dev/null && command -v jaw >/dev/null && jaw --version >/dev/null && command -v cli-jaw >/dev/null && cli-jaw --version >/dev/null' >/dev/null 2>&1 \
    || fail "WSL bash login shell cannot resolve node/npm/jaw/cli-jaw"
  ok "WSL bash login shell resolves node/npm/jaw/cli-jaw"
fi

if [ "$SKIP_DOCTOR" != "1" ]; then
  jaw doctor >/dev/null 2>&1 || fail "jaw doctor failed"
  ok "jaw doctor completed"
else
  ok "jaw doctor skipped"
fi

echo "ALL PASS"

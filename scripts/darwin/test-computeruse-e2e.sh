#!/bin/bash
# test-computeruse-e2e.sh
# End-to-end smoke test for the Computer Use integration on macOS.
# Mirrors the R1..R10 matrix in devlog/_plan/computeruse/36_rollout_validation.md.
#
# Each check either PASSES, SKIPS (environment missing), or FAILS.
# The script returns exit 0 only when no check FAILS.
#
# Usage:
#   bash scripts/darwin/test-computeruse-e2e.sh           # full run
#   bash scripts/darwin/test-computeruse-e2e.sh --fast    # skip network/MCP checks
#   VERBOSE=1 bash scripts/darwin/test-computeruse-e2e.sh # show intermediate output

set -u

BOLD='\033[1m'
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
DIM='\033[2m'
OFF='\033[0m'

FAST=0
if [ "${1:-}" = "--fast" ]; then FAST=1; fi
VERBOSE=${VERBOSE:-0}

PASS=0
FAIL=0
SKIP=0

hr() { printf '%s\n' '----------------------------------------'; }

check() {
    local name="$1"; shift
    local status="$1"; shift
    local detail="${*:-}"
    case "$status" in
        PASS)  printf "%b[PASS]%b %s %b%s%b\n" "$GREEN" "$OFF" "$name" "$DIM" "$detail" "$OFF"; PASS=$((PASS+1));;
        FAIL)  printf "%b[FAIL]%b %s %b%s%b\n" "$RED"   "$OFF" "$name" "$DIM" "$detail" "$OFF"; FAIL=$((FAIL+1));;
        SKIP)  printf "%b[SKIP]%b %s %b%s%b\n" "$YELLOW" "$OFF" "$name" "$DIM" "$detail" "$OFF"; SKIP=$((SKIP+1));;
    esac
}

require_cmd() {
    command -v "$1" >/dev/null 2>&1
}

printf "%bcli-jaw · Computer Use E2E smoke%b\n" "$BOLD" "$OFF"
hr

# ─── A. Platform + core binaries ──────────────────────────────

if [ "$(uname -s)" = "Darwin" ]; then
    check "darwin platform" PASS "$(uname -sr)"
else
    check "darwin platform" FAIL "$(uname -sr) — this test is darwin-only"
    printf "\nExiting early on non-darwin host.\n"
    exit 2
fi

if require_cmd cli-jaw; then
    check "cli-jaw in PATH" PASS "$(command -v cli-jaw)"
else
    check "cli-jaw in PATH" FAIL "install: npm i -g cli-jaw"
fi

if require_cmd /usr/bin/clang; then
    check "clang available" PASS
else
    check "clang available" SKIP "prebuilt fallback will be used"
fi

# ─── B. Jaw.app + launcher ────────────────────────────────────

JAW_APP=/Applications/Jaw.app
LAUNCHER="$JAW_APP/Contents/MacOS/jaw-launcher"

if [ -d "$JAW_APP" ]; then
    check "Jaw.app installed" PASS "$JAW_APP"
else
    check "Jaw.app installed" FAIL "run: jaw init  (postinstall ensureJawAppInstall)"
fi

if [ -x "$LAUNCHER" ]; then
    if file "$LAUNCHER" 2>/dev/null | grep -q "Mach-O"; then
        check "jaw-launcher is Mach-O" PASS "$(file "$LAUNCHER" | cut -d: -f2- | xargs)"
    else
        check "jaw-launcher is Mach-O" FAIL "not a Mach-O binary — TCC attribution will break"
    fi
else
    check "jaw-launcher executable" FAIL "missing: $LAUNCHER"
fi

BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$JAW_APP/Contents/Info.plist" 2>/dev/null || echo "")
if [ "$BUNDLE_ID" = "com.cli-jaw.agent" ]; then
    check "Info.plist bundle id" PASS "$BUNDLE_ID"
else
    check "Info.plist bundle id" FAIL "got '$BUNDLE_ID' — expected com.cli-jaw.agent"
fi

if /usr/bin/codesign --verify --deep --strict "$JAW_APP" >/dev/null 2>&1; then
    check "Jaw.app codesign" PASS
else
    check "Jaw.app codesign" FAIL "run: codesign --sign - --force --deep $JAW_APP"
fi

# ─── C. Codex Computer Use.app ─────────────────────────────────

CUA_APP="/Applications/Codex Computer Use.app"
if [ -d "$CUA_APP" ]; then
    check "Codex Computer Use.app" PASS
else
    check "Codex Computer Use.app" FAIL "run: jaw doctor --tcc --fix"
fi

# ─── D. launchd plist (if registered) ──────────────────────────

LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
LAUNCHD_PLIST=$(ls -1 "$LAUNCH_AGENTS"/com.cli-jaw.*.plist 2>/dev/null | head -1)

if [ -n "$LAUNCHD_PLIST" ]; then
    if grep -q "<key>SessionCreate</key>" "$LAUNCHD_PLIST" \
       && grep -q "<true/>" "$LAUNCHD_PLIST" \
       && grep -q "<string>Interactive</string>" "$LAUNCHD_PLIST"; then
        check "launchd plist SessionCreate + Interactive" PASS "$LAUNCHD_PLIST"
    else
        check "launchd plist SessionCreate + Interactive" FAIL "re-run: jaw launchd"
    fi
    if grep -q "CLI_JAW_RUNTIME" "$LAUNCHD_PLIST"; then
        check "plist CLI_JAW_RUNTIME env" PASS
    else
        check "plist CLI_JAW_RUNTIME env" FAIL "plist is stale — jaw launchd"
    fi
    if grep -q "$JAW_APP/Contents/MacOS/jaw-launcher" "$LAUNCHD_PLIST"; then
        check "plist ProgramArguments → Jaw.app launcher" PASS
    else
        check "plist ProgramArguments → Jaw.app launcher" SKIP "legacy plist still points at node directly"
    fi
else
    check "launchd plist registered" SKIP "run: jaw launchd (optional for foreground mode)"
fi

# ─── E. desktop-control skill installed ────────────────────────

SKILL_DIR="$HOME/.cli-jaw/skills/desktop-control"
if [ -f "$SKILL_DIR/SKILL.md" ]; then
    check "desktop-control skill active" PASS "$SKILL_DIR"
    missing=""
    for ref in cdp.md computer-use.md vision-click.md intent-routing.md; do
        [ -f "$SKILL_DIR/reference/$ref" ] || missing="$missing $ref"
    done
    if [ -z "$missing" ]; then
        check "desktop-control reference/ complete" PASS
    else
        check "desktop-control reference/ complete" FAIL "missing:$missing"
    fi
else
    check "desktop-control skill active" FAIL "expected $SKILL_DIR/SKILL.md"
fi

# ─── F. prompt anchors baked in A-1.md ─────────────────────────

A1_DISK="$HOME/.cli-jaw/prompts/A-1.md"
if [ -f "$A1_DISK" ]; then
    if grep -q "anchor:desktop-control" "$A1_DISK"; then
        check "A-1.md desktop-control anchor" PASS
    else
        check "A-1.md desktop-control anchor" FAIL "restart jaw serve to trigger safe-append"
    fi
else
    check "A-1.md on disk" SKIP "first-run only (jaw serve will create it)"
fi

# ─── G. Server reachable (optional) ────────────────────────────

if [ "$FAST" -eq 0 ]; then
    if require_cmd curl; then
        if curl -sfm 2 http://localhost:3457/api/health >/dev/null 2>&1; then
            check "jaw serve reachable on :3457" PASS
        else
            check "jaw serve reachable on :3457" SKIP "start: jaw serve (or jaw launchd)"
        fi
    fi
fi

# ─── H. Computer Use MCP probe (requires codex) ────────────────

if [ "$FAST" -eq 0 ]; then
    if require_cmd codex; then
        check "codex CLI available" PASS "$(command -v codex)"
    else
        check "codex CLI available" SKIP "Computer Use MCP unreachable without codex"
    fi
fi

hr
printf "%bResult%b  pass=%d  fail=%d  skip=%d\n" "$BOLD" "$OFF" "$PASS" "$FAIL" "$SKIP"

if [ "$FAIL" -gt 0 ]; then
    printf "%b✗ one or more checks failed%b\n" "$RED" "$OFF"
    exit 1
fi
printf "%b✓ all required checks passed%b\n" "$GREEN" "$OFF"
exit 0

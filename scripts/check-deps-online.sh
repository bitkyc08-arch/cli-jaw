#!/usr/bin/env bash
# ─── Online Dependency Check ─────────────────────────
# Phase 9.7 — npm audit + outdated + semgrep (네트워크 필요)
set -euo pipefail

mkdir -p .artifacts

echo '[online] npm audit'
npm audit --json > .artifacts/npm-audit.json 2>&1 || {
    echo '[online] audit failed (network or registry issue)'
    cat .artifacts/npm-audit.json
    # non-fatal — offline gate에서 이미 검증됨
}

echo '[online] npm outdated'
npm outdated --json > .artifacts/npm-outdated.json 2>&1 || true

if command -v semgrep >/dev/null; then
    echo '[online] semgrep scan'
    semgrep ci --json --json-output .artifacts/semgrep.json 2>/dev/null || true
    semgrep ci --sarif --sarif-output .artifacts/semgrep.sarif 2>/dev/null || true
else
    echo '[online] semgrep not installed — skipping'
fi

echo '[online] done — check .artifacts/'

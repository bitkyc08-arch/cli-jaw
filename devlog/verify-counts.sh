#!/usr/bin/env bash
# verify-counts.sh — devlog/str_func.md에 기록된 라인 수와 실제 wc -l 비교
# Usage: bash devlog/verify-counts.sh [--fix]
#   --fix: str_func.md의 틀린 값을 자동 수정 (sed)

set -euo pipefail
cd "$(dirname "$0")/.."  # cli-claw root

DOC="devlog/str_func.md"
FIX=false
[[ "${1:-}" == "--fix" ]] && FIX=true

RED='\033[0;31m'
GREEN='\033[0;32m'
DIM='\033[0;90m'
BOLD='\033[1m'
RESET='\033[0m'

PASS=0
FAIL=0
FIXED=0

# ─── "grep_key|filepath" pairs ──────────────────────────
# grep_key = str_func.md에서 해당 파일을 찾는 고유 문자열
# filepath = 실제 파일 경로
declare -a CHECKS=(
  "server.js.*라우트|server.js"
  "mcp-sync.js|lib/mcp-sync.js"
  "upload.js|lib/upload.js"
  "config.js.*CLAW_HOME|src/core/config.js"
  "db.js.*SQLite|src/core/db.js"
  "bus.js.*WS|src/core/bus.js"
  "logger.js|src/core/logger.js"
  "i18n.js|src/core/i18n.js"
  "settings-merge.js|src/core/settings-merge.js"
  "events.js.*NDJSON|src/agent/events.js"
  "spawn.js.*CLI spawn|src/agent/spawn.js"
  "args.js.*인자|src/agent/args.js"
  "pipeline.js.*Plan|src/orchestrator/pipeline.js"
  "parser.js.*triage|src/orchestrator/parser.js"
  "builder.js.*프롬프트|src/prompt/builder.js"
  "commands.js.*슬래시|src/cli/commands.js"
  "handlers.js.*핸들러|src/cli/handlers.js"
  "registry.js.*CLI|src/cli/registry.js"
  "acp-client.js|src/cli/acp-client.js"
  "bot.js.*Telegram|src/telegram/bot.js"
  "forwarder.js.*포워딩|src/telegram/forwarder.js"
  "heartbeat.js|src/memory/heartbeat.js"
  "memory.js.*Persistent|src/memory/memory.js"
  "worklog.js|src/memory/worklog.js"
  "connection.js.*Chrome|src/browser/connection.js"
  "actions.js.*snapshot|src/browser/actions.js"
  "vision.js.*vision-click|src/browser/vision.js"
  "index.js.*re-export|src/browser/index.js"
  "quota.js.*할당|src/routes/quota.js"
  "browser.js.*라우트|src/routes/browser.js"
  "path-guards.js|src/security/path-guards.js"
  "decode.js|src/security/decode.js"
  "response.js.*ok|src/http/response.js"
  "async-handler.js|src/http/async-handler.js"
  "error-middleware.js|src/http/error-middleware.js"
  "catalog.js|src/command-contract/catalog.js"
  "policy.js.*getVisible|src/command-contract/policy.js"
  "help-renderer.js|src/command-contract/help-renderer.js"
  "index.html|public/index.html"
  "variables.css.*커스텀|public/css/variables.css"
  "postinstall.js|bin/postinstall.js"
  "chat.js.*TUI|bin/commands/chat.js"
)

echo -e "${BOLD}📐 str_func.md 라인 카운트 검증${RESET}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

for entry in "${CHECKS[@]}"; do
  grep_key="${entry%%|*}"
  filepath="${entry##*|}"

  if [[ ! -f "$filepath" ]]; then
    echo -e "  ${DIM}⏭️  $filepath — 파일 없음${RESET}"
    continue
  fi

  actual=$(wc -l < "$filepath" | tr -d ' ')

  # grep로 해당 줄 찾고, NNNL 다음에 ) 또는 , 오는 패턴 (tail -1: 마지막 = 라인 수)
  doc_match=$(grep -E "$grep_key" "$DOC" | grep -oE '[0-9]+L[),]' | tail -1 || true)

  if [[ -z "$doc_match" ]]; then
    echo -e "  ${DIM}⏭️  $filepath — str_func.md에 라인 수 미기재${RESET}"
    continue
  fi

  documented=$(echo "$doc_match" | grep -oE '[0-9]+')

  if [[ "$actual" == "$documented" ]]; then
    echo -e "  ${GREEN}✅ $filepath — ${actual}L${RESET}"
    ((PASS++))
  else
    diff=$((actual - documented))
    sign=""
    [[ $diff -gt 0 ]] && sign="+"
    echo -e "  ${RED}❌ $filepath — 문서: ${documented}L → 실제: ${actual}L (${sign}${diff})${RESET}"
    ((FAIL++))

    if $FIX; then
      # grep_key로 해당 줄만 찾아서 그 줄의 NNNL을 교체
      line_num=$(grep -nE "$grep_key" "$DOC" | head -1 | cut -d: -f1)
      if [[ -n "$line_num" ]]; then
        sed -i '' "${line_num}s/${documented}L/${actual}L/" "$DOC"
        echo -e "     ${GREEN}🔧 수정: ${documented}L → ${actual}L (line ${line_num})${RESET}"
        ((FIXED++))
      fi
    fi
  fi
done

# ─── Aggregates ──────────────────────────────────────────
echo ""
echo -e "${BOLD}📊 집계 항목${RESET}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# public/ total
pub_actual=$(find public -name '*.js' -o -name '*.css' -o -name '*.html' | xargs wc -l | tail -1 | awk '{print $1}')
pub_doc=$(grep -oE '~[0-9]+L\)' "$DOC" | head -1 | grep -oE '[0-9]+' || true)
if [[ -n "$pub_doc" ]]; then
  if [[ "$pub_actual" == "$pub_doc" ]]; then
    echo -e "  ${GREEN}✅ public/ total — ${pub_actual}L${RESET}"
    ((PASS++))
  else
    echo -e "  ${RED}❌ public/ total — 문서: ~${pub_doc}L → 실제: ${pub_actual}L${RESET}"
    ((FAIL++))
  fi
fi

# public/ file count
pub_files=$(find public -name '*.js' -o -name '*.css' -o -name '*.html' | wc -l | tr -d ' ')
pub_files_doc=$(grep -oE '[0-9]+ files' "$DOC" | head -1 | grep -oE '[0-9]+' || true)
if [[ -n "$pub_files_doc" ]]; then
  if [[ "$pub_files" == "$pub_files_doc" ]]; then
    echo -e "  ${GREEN}✅ public/ files — ${pub_files}개${RESET}"
    ((PASS++))
  else
    echo -e "  ${RED}❌ public/ files — 문서: ${pub_files_doc}개 → 실제: ${pub_files}개${RESET}"
    ((FAIL++))
  fi
fi

# skills_ref dir count
if [[ -d "skills_ref" ]]; then
  skill_dirs=$(find skills_ref -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ')
  skill_doc=$(grep -oE '[0-9]+개 디렉토리' "$DOC" | grep -oE '[0-9]+' | head -1 || true)
  if [[ -n "$skill_doc" ]]; then
    if [[ "$skill_dirs" == "$skill_doc" ]]; then
      echo -e "  ${GREEN}✅ skills_ref/ dirs — ${skill_dirs}개${RESET}"
      ((PASS++))
    else
      echo -e "  ${RED}❌ skills_ref/ dirs — 문서: ${skill_doc}개 → 실제: ${skill_dirs}개${RESET}"
      ((FAIL++))
    fi
  fi
fi

# registry.json entries
if [[ -f "skills_ref/registry.json" ]]; then
  reg_actual=$(grep -c '"name"' skills_ref/registry.json || true)
  reg_doc=$(grep -oE '[0-9]+항목' "$DOC" | grep -oE '[0-9]+' | head -1 || true)
  if [[ -n "$reg_doc" ]]; then
    if [[ "$reg_actual" == "$reg_doc" ]]; then
      echo -e "  ${GREEN}✅ registry.json — ${reg_actual}항목${RESET}"
      ((PASS++))
    else
      echo -e "  ${RED}❌ registry.json — 문서: ${reg_doc}항목 → 실제: ${reg_actual}항목${RESET}"
      ((FAIL++))
    fi
  fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ $FAIL -eq 0 ]]; then
  echo -e "  ${GREEN}${BOLD}🎉 ALL PASS — ${PASS}개 항목 전부 일치${RESET}"
else
  echo -e "  ✅ 일치: ${PASS}  ${RED}❌ 불일치: ${FAIL}${RESET}  🔧 수정: ${FIXED}"
  if ! $FIX; then
    echo ""
    echo -e "  ${DIM}💡 자동 수정: bash devlog/verify-counts.sh --fix${RESET}"
  fi
fi

exit $FAIL

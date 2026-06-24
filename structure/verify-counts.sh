#!/usr/bin/env bash
# verify-counts.sh — str_func.md에 기록된 라인 수/집계값 검증
# Usage: bash structure/verify-counts.sh [--fix]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Portable matcher: prefer ripgrep, fall back to grep -E when rg is not on PATH.
# Non-interactive shells frequently lack `rg`; without this fallback the
# `rg ... || true` guards below silently swallow every match, so every line-count
# check is skipped ("미기재") and the whole script becomes a vacuous pass.
if ! command -v rg >/dev/null 2>&1; then
  rg() { grep -E "$@"; }
fi

DOC="structure/str_func.md"
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

# "grep_key|filepath"
declare -a CHECKS=(
  "server.ts.*clearAllEmployeeSessions startup|server.ts"
  "mcp-sync.ts|lib/mcp-sync.ts"
  "upload.ts|lib/upload.ts"
  "config.ts.*JAW_HOME|src/core/config.ts"
  "db.ts.*SQLite|src/core/db.ts"
  "bus.ts.*WS|src/core/bus.ts"
  "logger.ts|src/core/logger.ts"
  "i18n.ts.*서버사이드 번역|src/core/i18n.ts"
  "settings-merge.ts|src/core/settings-merge.ts"
  "events.ts.*NDJSON|src/agent/events.ts"
  "spawn.ts.*CLI spawn|src/agent/spawn.ts"
  "args.ts.*인자|src/agent/args.ts"
  "pipeline.ts.*PABCD orchestration|src/orchestrator/pipeline.ts"
  "state-machine.ts.*IPABCD|src/orchestrator/state-machine.ts"
  "parser.ts.*triage|src/orchestrator/parser.ts"
  "distribute.ts|src/orchestrator/distribute.ts"
  "gateway.ts.*submitMessage|src/orchestrator/gateway.ts"
  "collect.ts.*orchestrateAndCollect|src/orchestrator/collect.ts"
  "sanitize.ts.*Interview tracker strip|src/orchestrator/sanitize.ts"
  "attestation.ts.*PABCD evidence gate|src/orchestrator/attestation.ts"
  "builder.ts.*프롬프트|src/prompt/builder.ts"
  "commands.ts.*레지스트리|src/cli/commands.ts"
  "handlers.ts.*핸들러|src/cli/handlers.ts"
  "handlers-workflows.ts|src/cli/handlers-workflows.ts"
  "registry.ts.*CLI/모델 단일 소스|src/cli/registry.ts"
  "acp-client.ts|src/cli/acp-client.ts"
  "command-context.ts.*공유 커맨드|src/cli/command-context.ts"
  "bot.ts.*Telegram|src/telegram/bot.ts"
  "forwarder.ts.*createForwarder|src/telegram/forwarder.ts"
  "heartbeat.ts.*잡 스케줄|src/memory/heartbeat.ts"
  "memory.ts.*Persistent|src/memory/memory.ts"
  "worklog.ts|src/memory/worklog.ts"
  "connection.ts.*Chrome|src/browser/connection.ts"
  "actions.ts.*snapshot|src/browser/actions.ts"
  "vision.ts.*vision-click|src/browser/vision.ts"
  "index.ts.*re-export|src/browser/index.ts"
  "quota.ts.*할당|src/routes/quota.ts"
  "browser.ts.*라우트|src/routes/browser.ts"
  "orchestrate.ts.*reset/state/workers|src/routes/orchestrate.ts"
  "path-guards.ts|src/security/path-guards.ts"
  "decode.ts|src/security/decode.ts"
  "response.ts.*ok\(|src/http/response.ts"
  "async-handler.ts|src/http/async-handler.ts"
  "error-middleware.ts|src/http/error-middleware.ts"
  "catalog.ts|src/command-contract/catalog.ts"
  "policy.ts.*getVisible|getVisibleCommands|src/command-contract/policy.ts"
  "help-renderer.ts|src/command-contract/help-renderer.ts"
  "index.html|public/index.html"
  "variables.css.*Arctic Cyan|public/css/variables.css"
  "postinstall.ts|bin/postinstall.ts"
  "serve.ts|bin/commands/serve.ts"
  "dispatch.ts|bin/commands/dispatch.ts"
  "orchestrate.ts.*IPABCD 상태 제어 CLI|bin/commands/orchestrate.ts"
  "chat.ts.*TUI|bin/commands/chat.ts"
)

echo -e "${BOLD}📐 str_func.md 라인 카운트 검증${RESET}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ ! -f "$DOC" ]]; then
  echo -e "  ${RED}❌ 문서 없음: $DOC${RESET}"
  exit 1
fi

for entry in "${CHECKS[@]}"; do
  grep_key="${entry%%|*}"
  filepath="${entry##*|}"

  if [[ ! -f "$filepath" ]]; then
    echo -e "  ${DIM}⏭️  $filepath — 파일 없음${RESET}"
    continue
  fi

  actual=$(wc -l < "$filepath" | tr -d ' ')
  doc_line_matches=$( (rg -n "$grep_key" "$DOC" || true) | rg '←' || true)
  doc_match=$(echo "$doc_line_matches" | rg -o '[0-9]+L[),]' | tail -1 || true)

  if [[ -z "$doc_match" ]]; then
    echo -e "  ${DIM}⏭️  $filepath — str_func.md에 라인 수 미기재${RESET}"
    continue
  fi

  documented=$(echo "$doc_match" | rg -o '[0-9]+')

  if [[ "$actual" == "$documented" ]]; then
    echo -e "  ${GREEN}✅ $filepath — ${actual}L${RESET}"
    PASS=$((PASS + 1))
  else
    diff=$((actual - documented))
    sign=""
    [[ $diff -gt 0 ]] && sign="+"
    echo -e "  ${RED}❌ $filepath — 문서: ${documented}L → 실제: ${actual}L (${sign}${diff})${RESET}"
    FAIL=$((FAIL + 1))

    if $FIX; then
      line_num=$(echo "$doc_line_matches" | head -1 | cut -d: -f1)
      if [[ -n "$line_num" ]]; then
        sed -i '' "${line_num}s/${documented}L/${actual}L/" "$DOC"
        echo -e "     ${GREEN}🔧 수정: ${documented}L → ${actual}L (line ${line_num})${RESET}"
        FIXED=$((FIXED + 1))
      fi
    fi
  fi
done

echo ""
echo -e "${BOLD}📐 str_func.md 전체 파일 트리 항목${RESET}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

tree_tmp=$(mktemp)
FIX_MODE=0
$FIX && FIX_MODE=1
FIX_MODE="$FIX_MODE" node <<'NODE' > "$tree_tmp"
const fs = require('fs');

const doc = 'structure/str_func.md';
const fix = process.env.FIX_MODE === '1';
const text = fs.readFileSync(doc, 'utf8');
const lines = text.split('\n');
const stack = [];
let ok = 0;
let fail = 0;
let fixed = 0;
let skipped = 0;
const messages = [];

function wcLineCount(file) {
  const buf = fs.readFileSync(file);
  let count = 0;
  for (const byte of buf) {
    if (byte === 10) count += 1;
  }
  return count;
}

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  const match = line.match(/^([│ ]*)(?:├──|└──)\s+([^←\s]+)/);
  if (!match) continue;

  const depth = Math.floor(match[1].length / 4);
  const name = match[2];
  if (name.endsWith('/')) {
    stack[depth] = name.slice(0, -1);
    stack.length = depth + 1;
    continue;
  }
  if (!line.includes('←')) continue;

  const countMatch = line.match(/\(([0-9]+)L\)/);
  if (!countMatch) continue;

  const rel = [...stack.slice(0, depth), name].filter(Boolean).join('/');
  if (!fs.existsSync(rel) || !fs.statSync(rel).isFile()) {
    skipped += 1;
    continue;
  }

  const documented = Number(countMatch[1]);
  const actual = wcLineCount(rel);
  if (documented === actual) {
    ok += 1;
    continue;
  }

  if (fix) {
    lines[i] = line.replace(`(${documented}L)`, `(${actual}L)`);
    fixed += 1;
    ok += 1;
    messages.push(`FIXED\t${rel}\t${documented}\t${actual}\t${i + 1}`);
  } else {
    fail += 1;
    messages.push(`FAIL\t${rel}\t${documented}\t${actual}\t${i + 1}`);
  }
}

if (fix && fixed > 0) {
  fs.writeFileSync(doc, lines.join('\n'), 'utf8');
}

for (const message of messages) {
  console.log(message);
}
console.log(`SUMMARY\t${ok}\t${fail}\t${fixed}\t${skipped}`);
NODE

while IFS=$'\t' read -r kind path documented actual line; do
  case "$kind" in
    FAIL)
      diff=$((actual - documented))
      sign=""
      [[ $diff -gt 0 ]] && sign="+"
      echo -e "  ${RED}❌ $path — 문서: ${documented}L → 실제: ${actual}L (${sign}${diff}, line ${line})${RESET}"
      ;;
    FIXED)
      echo -e "  ${GREEN}🔧 $path — ${documented}L → ${actual}L (line ${line})${RESET}"
      ;;
    SUMMARY)
      tree_ok="$path"
      tree_fail="$documented"
      tree_fixed="$actual"
      tree_skipped="$line"
      if [[ "$tree_fail" == "0" ]]; then
        echo -e "  ${GREEN}✅ 파일 트리 항목 — ${tree_ok}개 일치, ${tree_skipped}개 경로 스킵${RESET}"
        PASS=$((PASS + tree_ok))
      else
        FAIL=$((FAIL + tree_fail))
      fi
      FIXED=$((FIXED + tree_fixed))
      ;;
  esac
done < "$tree_tmp"
rm -f "$tree_tmp"

echo ""
echo -e "${BOLD}📊 집계 항목${RESET}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# public/ total lines (source/assets only; exclude Vite build output)
a_pub_total=$(find public -type f ! -path 'public/dist/*' ! -path 'public/public/dist/*' | xargs wc -l | tail -1 | awk '{print $1}')
d_pub_total=$( (rg '^├── public/.*~[0-9]+L' "$DOC" || true) | head -1 | rg -o '~[0-9]+L' | rg -o '[0-9]+' | tail -1 || true)
if [[ -n "${d_pub_total:-}" ]]; then
  diff_pub_total=$((a_pub_total - d_pub_total))
  if [[ $diff_pub_total -lt 0 ]]; then
    diff_pub_total=$(( -diff_pub_total ))
  fi
  # 문서 표기가 ~NNNL 이므로 오차 허용 (±200L)
  if [[ $diff_pub_total -le 200 ]]; then
    echo -e "  ${GREEN}✅ public/ total — 문서 ~${d_pub_total}L / 실제 ${a_pub_total}L (허용 오차)${RESET}"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}❌ public/ total — 문서: ~${d_pub_total}L → 실제: ${a_pub_total}L${RESET}"
    FAIL=$((FAIL + 1))
  fi
fi

# public/ file count (source/assets only; exclude Vite build output)
a_pub_files=$(find public -type f ! -path 'public/dist/*' ! -path 'public/public/dist/*' | wc -l | tr -d ' ')
d_pub_files=$( (rg '^├── public/.*[0-9]+ files' "$DOC" || true) | head -1 | rg -o '[0-9]+ files' | head -1 | rg -o '[0-9]+' || true)
if [[ -n "${d_pub_files:-}" ]]; then
  if [[ "$a_pub_files" == "$d_pub_files" ]]; then
    echo -e "  ${GREEN}✅ public/ files — ${a_pub_files}개${RESET}"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}❌ public/ files — 문서: ${d_pub_files}개 → 실제: ${a_pub_files}개${RESET}"
    FAIL=$((FAIL + 1))
  fi
fi

# summary line (server.ts / src / tests / public)
summary_line=$( (rg -n '^> server.ts [0-9]+L / src [0-9]+ files / top-level module dirs [0-9]+ / tests [0-9]+ files / public tree [0-9]+ files' "$DOC" || true) | head -1)
if [[ -n "$summary_line" ]]; then
  d_src_files=$(echo "$summary_line" | rg -o 'src [0-9]+ files' | rg -o '[0-9]+' | head -1)
  d_src_dirs=$(echo "$summary_line" | rg -o 'top-level module dirs [0-9]+' | rg -o '[0-9]+' | head -1)
  d_tests_files=$(echo "$summary_line" | rg -o 'tests [0-9]+ files' | rg -o '[0-9]+' | head -1)
  d_public_files=$(echo "$summary_line" | rg -o 'public tree [0-9]+ files' | rg -o '[0-9]+' | head -1)
  a_src_files=$(find src -type f | wc -l | tr -d ' ')
  a_src_dirs=$(find src -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
  a_tests_files=$(find tests -type f | wc -l | tr -d ' ')

  if [[ "$a_src_files" == "$d_src_files" ]]; then
    echo -e "  ${GREEN}✅ src files — ${a_src_files}개${RESET}"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}❌ src files — 문서: ${d_src_files}개 → 실제: ${a_src_files}개${RESET}"
    FAIL=$((FAIL + 1))
  fi

  if [[ "$a_src_dirs" == "$d_src_dirs" ]]; then
    echo -e "  ${GREEN}✅ src subdirs — ${a_src_dirs}개${RESET}"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}❌ src subdirs — 문서: ${d_src_dirs}개 → 실제: ${a_src_dirs}개${RESET}"
    FAIL=$((FAIL + 1))
  fi

  if [[ "$a_tests_files" == "$d_tests_files" ]]; then
    echo -e "  ${GREEN}✅ tests files — ${a_tests_files}개${RESET}"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}❌ tests files — 문서: ${d_tests_files}개 → 실제: ${a_tests_files}개${RESET}"
    FAIL=$((FAIL + 1))
  fi

  if [[ "$a_pub_files" == "$d_public_files" ]]; then
    echo -e "  ${GREEN}✅ public summary files — ${a_pub_files}개${RESET}"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}❌ public summary files — 문서: ${d_public_files}개 → 실제: ${a_pub_files}개${RESET}"
    FAIL=$((FAIL + 1))
  fi
fi

# bin/commands total
a_bin_cmds=$(find bin/commands -type f | wc -l | tr -d ' ')
d_bin_cmds=$( (rg -n '^│   └── commands/.*[0-9]+ files' "$DOC" || true) | head -1 | rg -o '[0-9]+ files' | head -1 | rg -o '[0-9]+' || true)
if [[ -n "${d_bin_cmds:-}" ]]; then
  if [[ "$a_bin_cmds" == "$d_bin_cmds" ]]; then
    echo -e "  ${GREEN}✅ bin/commands files — ${a_bin_cmds}개${RESET}"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}❌ bin/commands files — 문서: ${d_bin_cmds}개 → 실제: ${a_bin_cmds}개${RESET}"
    FAIL=$((FAIL + 1))
  fi
fi

# public/dist build output
a_pub_dist=$(find public/dist -type f | wc -l | tr -d ' ')
d_pub_dist=$( (rg -n 'public/dist build output [0-9]+ files' "$DOC" || true) | head -1 | rg -o 'build output [0-9]+ files' | rg -o '[0-9]+' | head -1 || true)
if [[ -n "${d_pub_dist:-}" ]]; then
  if [[ "$a_pub_dist" == "$d_pub_dist" ]]; then
    echo -e "  ${GREEN}✅ public/dist files — ${a_pub_dist}개${RESET}"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}❌ public/dist files — 문서: ${d_pub_dist}개 → 실제: ${a_pub_dist}개${RESET}"
    FAIL=$((FAIL + 1))
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
    echo -e "  ${DIM}💡 자동 수정: bash structure/verify-counts.sh --fix${RESET}"
  fi
fi

exit $FAIL

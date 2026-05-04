#!/usr/bin/env bash
# check-doc-drift.sh — CI gate for structure docs drift detection
# Validates: commands.md, server_api.md, websocket events, str_func line counts
# Exit: 0 = all pass, 1 = drift detected
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
DIM='\033[0;90m'
RESET='\033[0m'

FAIL=0
PASS=0
SKIP=0

pass() { echo -e "  ${GREEN}✅ $1${RESET}"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}❌ $1${RESET}"; FAIL=$((FAIL + 1)); }
skip() { echo -e "  ${DIM}⏭️  $1${RESET}"; SKIP=$((SKIP + 1)); }
info() { echo -e "  ${DIM}   $1${RESET}"; }

check_commands_doc() {
  echo ""
  echo -e "${BOLD}📋 1/4 — commands.md command counts${RESET}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if node <<'NODE'
const fs = require('fs');

const commandsDoc = fs.readFileSync('structure/commands.md', 'utf8');
const commandLines = fs.readFileSync('src/cli/commands.ts', 'utf8').split(/\r?\n/);
const catalog = fs.readFileSync('src/command-contract/catalog.ts', 'utf8');

const entries = [];
for (const line of commandLines) {
  const match = line.match(/^\s*\{\s*name: '([^']+)'/);
  if (!match) continue;
  const ifaceMatch = line.match(/interfaces: \[([^\]]*)\]/);
  const interfaces = ifaceMatch
    ? ifaceMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
    : [];
  const hidden = /hidden:\s*true/.test(line);
  entries.push({ name: match[1], interfaces, hidden });
}

const hiddenMatch = catalog.match(/CMDLINE_HIDDEN = new Set\(\[([\s\S]*?)\]\);/);
if (!hiddenMatch) {
  console.error('commands.md drift: CMDLINE_HIDDEN set not found in src/command-contract/catalog.ts');
  process.exit(1);
}
const cmdlineHidden = hiddenMatch[1]
  .split(',')
  .map((s) => s.trim().replace(/^'|'$/g, ''))
  .filter(Boolean);

const visible = (iface) => entries.filter((entry) => entry.interfaces.includes(iface) && !entry.hidden).length;
const actual = {
  total: entries.length,
  cli: visible('cli'),
  web: visible('web'),
  telegram: visible('telegram'),
  discord: visible('discord'),
  cmdline: entries.length - cmdlineHidden.length,
};

const summary = commandsDoc.split(/\r?\n/).find((line) => /개 커맨드/.test(line) && /CLI \d+/.test(line));
if (!summary) {
  console.error('commands.md drift: summary line not found');
  process.exit(1);
}

const doc = {
  total: Number((summary.match(/(\d+)개 커맨드/) || [])[1]),
  cli: Number((summary.match(/CLI (\d+)/) || [])[1]),
  web: Number((summary.match(/Web (\d+)/) || [])[1]),
  telegram: Number((summary.match(/Telegram (\d+)/) || [])[1]),
  discord: Number((summary.match(/Discord (\d+)/) || [])[1]),
  cmdline: Number((summary.match(/(\d+)개가 보인다/) || [])[1]),
};

const labels = [
  ['total', 'total command count'],
  ['cli', 'CLI visible count'],
  ['web', 'Web visible count'],
  ['telegram', 'Telegram visible count'],
  ['discord', 'Discord visible count'],
  ['cmdline', 'cmdline visible count'],
];

const mismatches = labels
  .filter(([key]) => doc[key] !== actual[key])
  .map(([key, label]) => `${label}: doc ${doc[key]} vs actual ${actual[key]}`);

if (mismatches.length) {
  console.error('commands.md drift:');
  for (const line of mismatches) console.error(`  - ${line}`);
  process.exit(1);
}
NODE
  then
    pass "commands.md — command totals match live registry"
  else
    fail "commands.md — command totals drifted"
    info "Fix: update the summary line in structure/commands.md"
  fi
}

check_server_api_doc() {
  echo ""
  echo -e "${BOLD}📋 2/4 — server_api.md route table${RESET}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if node <<'NODE'
const fs = require('fs');
const path = require('path');

const doc = fs.readFileSync('structure/server_api.md', 'utf8');

function extractRoutes(text) {
  const routes = [];
  for (const match of text.matchAll(/app\.(get|post|put|delete|patch)\('([^']+)'/g)) {
    const method = match[1].toUpperCase();
    const route = match[2].split('?')[0];
    routes.push(`${method} ${route}`);
  }
  return routes;
}

function collectTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const serverText = fs.readFileSync('server.ts', 'utf8');
const routeTexts = collectTsFiles('src/routes')
  .map((file) => fs.readFileSync(file, 'utf8'));
const browserText = fs.readFileSync('src/routes/browser.ts', 'utf8');
const actualRoutes = new Set([
  ...extractRoutes(serverText),
  ...routeTexts.flatMap(extractRoutes),
].filter((route) => route !== 'GET /'));

function expandDocRoutes(token) {
  const [methodsPart, ...rest] = token.trim().split(/\s+/);
  if (!rest.length) return [];
  let routePart = rest.join(' ').replace(/\?.*$/, '');
  const methods = methodsPart.split('/').map((s) => s.trim()).filter(Boolean);
  const paths = routePart.includes(',')
    ? (() => {
        const idx = routePart.lastIndexOf('/');
        const prefix = idx >= 0 ? routePart.slice(0, idx + 1) : '';
        return routePart.slice(idx + 1).split(',').map((part) => prefix + part.trim()).filter(Boolean);
      })()
    : [routePart];
  const out = [];
  for (const method of methods) {
    for (const route of paths) {
      out.push(`${method} ${route}`);
    }
  }
  return out;
}

const lines = doc.split(/\r?\n/);
const start = lines.findIndex((line) => line.trim() === '## REST API');
const wsIndex = lines.findIndex((line) => line.trim() === '## WebSocket Events');
if (start === -1 || wsIndex === -1) {
  console.error('server_api.md drift: REST API or WebSocket Events section not found');
  process.exit(1);
}

const docRoutes = new Set();
for (const line of lines.slice(start, wsIndex)) {
  if (!line.startsWith('|')) continue;
  const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
  if (!cells[1] || cells[1] === 'Endpoints' || cells[1].startsWith('-')) continue;
  for (const token of cells[1].match(/`([^`]+)`/g) || []) {
    for (const route of expandDocRoutes(token.slice(1, -1))) {
      docRoutes.add(route);
    }
  }
}

const summary = lines.find((line) => /총 \d+개 route handler 기준이다\./.test(line));
if (!summary) {
  console.error('server_api.md drift: route summary line not found');
  process.exit(1);
}

const docCounts = {
  totalHandlers: Number((summary.match(/총 (\d+)개 route handler/) || [])[1]),
  apiEndpoints: Number((summary.match(/API 엔드포인트는 (\d+)개/) || [])[1]),
  browserRoutes: Number((summary.match(/Browser API (\d+)개/) || [])[1]),
};

const actualCounts = {
  totalHandlers: actualRoutes.size + 1,
  apiEndpoints: actualRoutes.size,
  browserRoutes: extractRoutes(browserText).length,
};

const countLabels = [
  ['totalHandlers', 'total route handlers'],
  ['apiEndpoints', 'API endpoints'],
  ['browserRoutes', 'browser endpoint count'],
];

const countMismatches = countLabels
  .filter(([key]) => docCounts[key] !== actualCounts[key])
  .map(([key, label]) => `${label}: doc ${docCounts[key]} vs actual ${actualCounts[key]}`);

const missing = [...actualRoutes].filter((route) => !docRoutes.has(route));
const extra = [...docRoutes].filter((route) => !actualRoutes.has(route));

if (countMismatches.length || missing.length || extra.length) {
  console.error('server_api.md drift:');
  for (const line of countMismatches) console.error(`  - ${line}`);
  if (missing.length) {
    console.error('  missing routes:');
    for (const route of missing) console.error(`    - ${route}`);
  }
  if (extra.length) {
    console.error('  extra routes:');
    for (const route of extra) console.error(`    - ${route}`);
  }
  process.exit(1);
}
NODE
  then
    pass "server_api.md — route table matches live handlers"
  else
    fail "server_api.md — route table drifted"
    info "Fix: update the REST API table and summary lines in structure/server_api.md"
  fi
}

check_websocket_doc() {
  echo ""
  echo -e "${BOLD}📋 3/4 — server_api.md websocket events${RESET}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if node <<'NODE'
const fs = require('fs');
const path = require('path');

const doc = fs.readFileSync('structure/server_api.md', 'utf8');

function collectTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const actual = new Set();
for (const file of ['server.ts', ...collectTsFiles('src')]) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/broadcast\('([^']+)'/g)) {
    actual.add(match[1]);
  }
}

const lines = doc.split(/\r?\n/);
const start = lines.findIndex((line) => line.trim() === '## WebSocket Events');
if (start === -1) {
  console.error('server_api.md drift: websocket section not found');
  process.exit(1);
}

const docEvents = new Set();
for (const line of lines.slice(start + 1)) {
  if (line.startsWith('## ')) break;
  if (!line.startsWith('|')) continue;
  const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
  const typeCell = cells[0];
  if (!typeCell || typeCell === 'Type' || typeCell.startsWith('-')) continue;
  for (const group of (typeCell.match(/`([^`]+)`/g) || [])) {
    for (const eventName of group.slice(1, -1).split(/\s*\/\s*/)) {
      if (eventName) docEvents.add(eventName);
    }
  }
}

const missing = [...actual].filter((event) => !docEvents.has(event));
const extra = [...docEvents].filter((event) => !actual.has(event));

if (actual.size !== docEvents.size || missing.length || extra.length) {
  console.error('server_api.md websocket drift:');
  console.error(`  counts: doc ${docEvents.size} vs actual ${actual.size}`);
  if (missing.length) {
    console.error('  missing events:');
    for (const event of missing) console.error(`    - ${event}`);
  }
  if (extra.length) {
    console.error('  extra events:');
    for (const event of extra) console.error(`    - ${event}`);
  }
  process.exit(1);
}
NODE
  then
    pass "server_api.md — websocket event list matches live broadcasts"
  else
    fail "server_api.md — websocket event list drifted"
    info "Fix: update the WebSocket Events table in structure/server_api.md"
  fi
}

check_str_func_counts() {
  echo ""
  echo -e "${BOLD}📋 4/4 — str_func.md line counts${RESET}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if [[ ! -f structure/verify-counts.sh ]]; then
    skip "verify-counts.sh — not found"
    return
  fi

  if bash structure/verify-counts.sh >/tmp/check-doc-drift.verify.log 2>&1; then
    pass "verify-counts.sh — all line counts match"
  else
    VC_EXIT=$?
    cat /tmp/check-doc-drift.verify.log
    fail "verify-counts.sh — ${VC_EXIT} line count(s) drifted"
    info "Fix: bash structure/verify-counts.sh --fix"
  fi
  rm -f /tmp/check-doc-drift.verify.log
}

check_commands_doc
check_server_api_doc
check_websocket_doc
check_str_func_counts

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ $FAIL -eq 0 ]]; then
  echo -e "  ${GREEN}${BOLD}🎉 DOC DRIFT CHECK PASSED — ${PASS} check(s) OK, ${SKIP} skipped${RESET}"
  exit 0
else
  echo -e "  ${RED}${BOLD}💥 DOC DRIFT CHECK FAILED — ${FAIL} issue(s) found${RESET}"
  echo -e "  ${DIM}   ${PASS} passed, ${SKIP} skipped${RESET}"
  echo ""
  echo -e "  ${YELLOW}${BOLD}How to fix:${RESET}"
  echo -e "  ${DIM}  1. Read the ❌ messages above${RESET}"
  echo -e "  ${DIM}  2. Update the docs to match reality${RESET}"
  echo -e "  ${DIM}  3. For line counts: bash structure/verify-counts.sh --fix${RESET}"
  exit 1
fi

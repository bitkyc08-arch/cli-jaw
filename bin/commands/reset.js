/**
 * cli-claw reset — factory reset via API
 * Usage:
 *   cli-claw reset [--yes] [--port 3457]
 */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { getServerUrl } from '../../src/config.js';

const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
        port: { type: 'string', default: process.env.PORT || '3457' },
        yes: { type: 'boolean', short: 'y', default: false },
        help: { type: 'boolean', default: false },
    },
    strict: false,
});

function printHelp() {
    console.log(`
  Usage:
    cli-claw reset [--yes] [--port 3457]

  Description:
    Factory reset: MCP sync + skill reset + employee reset + session clear.
    Prompts for confirmation unless --yes is passed.
`);
}

async function apiJson(baseUrl, path, init = {}) {
    const res = await fetch(baseUrl + path, { ...init, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

async function confirm(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(question, ans => {
            rl.close();
            resolve(ans.trim().toLowerCase() === 'y');
        });
    });
}

if (values.help) {
    printHelp();
    process.exit(0);
}

const baseUrl = getServerUrl(values.port);
const hasConfirm = values.yes || process.argv.slice(3).includes('confirm');

// Check server is running
try {
    await fetch(`${baseUrl}/api/session`, { signal: AbortSignal.timeout(2000) });
} catch {
    console.error(`  ❌ 서버에 연결할 수 없습니다 (localhost:${values.port})`);
    console.error(`  cli-claw serve 를 먼저 실행하세요.`);
    process.exit(1);
}

if (!hasConfirm) {
    const ok = await confirm('  ⚠️  MCP, 스킬, 직원, 세션을 기본값으로 초기화합니다. 계속? (y/N) ');
    if (!ok) {
        console.log('  취소됨.');
        process.exit(0);
    }
}

const results = [];
try {
    await apiJson(baseUrl, '/api/skills/reset', { method: 'POST' });
    results.push('스킬');
} catch (e) { console.error(`  ⚠️  스킬 초기화 실패: ${e.message}`); }

try {
    await apiJson(baseUrl, '/api/employees/reset', { method: 'POST' });
    results.push('직원');
} catch (e) { console.error(`  ⚠️  직원 초기화 실패: ${e.message}`); }

try {
    await apiJson(baseUrl, '/api/mcp/sync', { method: 'POST' });
    results.push('MCP');
} catch (e) { console.error(`  ⚠️  MCP 동기화 실패: ${e.message}`); }

try {
    await apiJson(baseUrl, '/api/clear', { method: 'POST' });
    results.push('세션');
} catch (e) { console.error(`  ⚠️  세션 초기화 실패: ${e.message}`); }

if (results.length) {
    console.log(`  ✅ 초기화 완료: ${results.join(', ')}`);
} else {
    console.error('  ❌ 초기화 실패');
    process.exitCode = 1;
}

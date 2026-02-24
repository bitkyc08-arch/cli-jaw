/**
 * cli-claw employee — employee utilities
 * Usage:
 *   cli-claw employee reset [--port 3457]
 */
import { parseArgs } from 'node:util';
import { getServerUrl } from '../../src/core/config.ts';

const sub = String(process.argv[3] || '').toLowerCase();
const isHelpSubcommand = sub === '--help' || sub === '-h' || sub === 'help';
const { values } = parseArgs({
    args: process.argv.slice(4),
    options: {
        port: { type: 'string', default: process.env.PORT || '3457' },
        help: { type: 'boolean', default: false },
    },
    strict: false,
});

function printHelp() {
    console.log(`
  Usage:
    cli-claw employee reset [--port 3457]

  Description:
    Reset employees to default 5 profiles (frontend/backend/data/docs/qa).
`);
}

async function apiJson(baseUrl, path, init = {}) {
    const headers = { ...(init.headers || {}) };
    let body = init.body;
    if (body && typeof body !== 'string') {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(body);
    }
    const res = await fetch(baseUrl + path, { ...init, headers, body, signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

if (values.help || !sub || isHelpSubcommand) {
    printHelp();
    process.exit(0);
}

const baseUrl = getServerUrl(values.port);

switch (sub) {
    case 'reset': {
        try {
            const result = await apiJson(baseUrl, '/api/employees/reset', { method: 'POST' });
            console.log(`✅ employees reset complete (${result.seeded ?? 0} seeded)`);
        } catch (err) {
            console.error(`❌ employee reset failed: ${err.message}`);
            process.exitCode = 1;
        }
        break;
    }
    default:
        console.error(`❌ Unknown employee subcommand: ${sub}`);
        printHelp();
        process.exitCode = 1;
        break;
}

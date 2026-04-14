#!/usr/bin/env node
// bin/commands/dispatch.ts — CLI: jaw dispatch --agent <name> --task <task>
// Dispatches a jaw employee via the server API (pipe-mode compatible).

import { loadSettings, getServerUrl } from '../../src/core/config.js';
import { cliFetch, getCliAuthToken } from '../../src/cli/api-auth.js';

loadSettings();

if (process.env.JAW_EMPLOYEE_MODE === '1') {
    console.error('❌ jaw employee sessions cannot dispatch other employees. Complete the assigned task directly.');
    process.exit(2);
}

const portIdx = process.argv.indexOf('--port');
const PORT = (portIdx !== -1 && process.argv[portIdx + 1]) ? process.argv[portIdx + 1] : undefined;
const BASE = getServerUrl(PORT);

function getFlag(name: string): string | undefined {
    const idx = process.argv.indexOf(name);
    if (idx === -1 || !process.argv[idx + 1]) return undefined;
    return process.argv[idx + 1];
}

const agent = getFlag('--agent');
const task = getFlag('--task');

if (!agent || !task) {
    console.error('Usage: jaw dispatch --agent <name> --task <task>');
    console.error('  --agent   Employee name (e.g., Frontend, Backend, Research, Docs)');
    console.error('  --task    Task description to assign');
    process.exit(1);
}

await getCliAuthToken(PORT);
try {
    console.log(`🚀 Dispatching to ${agent}...`);
    const res = await cliFetch(`${BASE}/api/orchestrate/dispatch`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Jaw-Dispatch-Source': process.env.JAW_EMPLOYEE_MODE === '1' ? 'employee' : 'boss',
        },
        body: JSON.stringify({ agent, task }),
    });
    const body = await res.json() as any;
    if (!res.ok) {
        console.error(`❌ ${body.error || `Failed: ${res.status}`}`);
        process.exit(1);
    }
    console.log(`✅ ${agent} completed (${body.result?.status || 'done'})`);
    if (body.result?.text) {
        console.log('\n--- Employee Response ---');
        console.log(body.result.text);
    }
} catch (e: any) {
    if (e.cause?.code === 'ECONNREFUSED') {
        console.error(`❌ Server not running. Start with: jaw serve`);
    } else {
        console.error(`❌ Error: ${e.message}`);
    }
    process.exit(1);
}

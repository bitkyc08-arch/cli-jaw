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

// Phase 8: boss-only dispatch. Token must be inherited from the server process.
const bossToken = process.env.JAW_BOSS_TOKEN || '';
if (!bossToken) {
    console.error('❌ JAW_BOSS_TOKEN missing. This session is not authorized to dispatch employees.');
    console.error('   Employees cannot dispatch. If you are the boss, ensure cli-jaw serve is running and this process inherited its env.');
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
    console.error('  --agent   Employee name (e.g., Frontend, Backend, Data, Docs)');
    console.error('  --task    Task description to assign');
    process.exit(1);
}

const STARTUP_RETRY_DELAYS_MS = [500, 1000, 1500, 2000, 3000];

function isConnRefused(error: any): boolean {
    return error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED';
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

await getCliAuthToken(PORT);
try {
    console.log(`🚀 Dispatching to ${agent}...`);

    let res: Response | undefined;
    let lastError: unknown;

    for (let attempt = 0; attempt <= STARTUP_RETRY_DELAYS_MS.length; attempt++) {
        try {
            res = await cliFetch(`${BASE}/api/orchestrate/dispatch`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Jaw-Boss-Token': bossToken,
                },
                body: JSON.stringify({ agent, task }),
            });
            break;
        } catch (e: unknown) {
            lastError = e;
            if (!isConnRefused(e) || attempt === STARTUP_RETRY_DELAYS_MS.length) break;
            if (attempt === 0) console.error('⏳ Server starting up, retrying...');
            await sleep(STARTUP_RETRY_DELAYS_MS[attempt]!);
        }
    }

    if (!res) {
        if (isConnRefused(lastError)) {
            console.error(
                `❌ Cannot reach ${BASE}. If running as launchd/systemd, wait a few seconds after reboot. `
                + 'For foreground mode: jaw serve',
            );
        } else {
            console.error(`❌ Error: ${(lastError as Error)?.message || lastError}`);
        }
        process.exit(1);
    }

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
    if (body.orchestration) {
        const o = body.orchestration;
        const verdict = o.verdict ? String(o.verdict).toUpperCase() : 'none';
        const persisted = o.statusPersisted
            ? `persisted to ${o.persistedField}`
            : `not persisted (state=${o.currentState || 'unknown'}, ctx=${o.ctxPresent ? 'true' : 'false'})`;
        console.log(`\nOrchestration verdict: ${verdict} ${persisted}`);
    }
} catch (e: any) {
    console.error(`❌ Error: ${e.message}`);
    process.exit(1);
}

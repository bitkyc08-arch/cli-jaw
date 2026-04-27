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

async function resolveAgentId(name: string): Promise<string | null> {
    const res = await cliFetch(`${BASE}/api/employees`);
    if (!res.ok) return null;
    const employees = await res.json() as Array<Record<string, any>>;
    const found = employees.find(e => e.name === name || e.id === name);
    return found?.id || null;
}

async function pollWorkerResult(agentId: string): Promise<any> {
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
        const res = await cliFetch(`${BASE}/api/orchestrate/worker/${encodeURIComponent(agentId)}/result`);
        const body = await res.json() as any;
        if (!res.ok) throw new Error(body.error || `poll failed: ${res.status}`);
        if (body.state !== 'running') return body;
        await sleep(2_000);
    }
    throw new Error(`Timed out waiting for worker result: ${agentId}`);
}

function resultStatus(body: any): string {
    if (typeof body?.result?.status === 'string') return body.result.status;
    if (typeof body?.state === 'string') return body.state;
    return 'done';
}

function resultText(body: any): string | undefined {
    if (typeof body?.result?.text === 'string') return body.result.text;
    if (typeof body?.result === 'string') return body.result;
    return undefined;
}

function dispatchExitCode(body: any): number {
    const status = resultStatus(body);
    return status === 'error' || status === 'failed' || status === 'cancelled' ? 1 : 0;
}

function printDispatchResult(agentName: string, body: any): void {
    console.log(`✅ ${agentName} completed (${resultStatus(body)})`);
    const text = resultText(body);
    if (text !== undefined) {
        console.log('\n--- Employee Response ---');
        console.log(text || '(empty response)');
    }
    if (body.orchestration) {
        const o = body.orchestration;
        const verdict = o.verdict ? String(o.verdict).toUpperCase() : 'none';
        const persisted = o.statusPersisted
            ? `persisted to ${o.persistedField}`
            : `not persisted (state=${o.currentState || 'unknown'}, ctx=${o.ctxPresent ? 'true' : 'false'})`;
        console.log(`\nOrchestration verdict: ${verdict} ${persisted}`);
    }
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
        const pollAgentId = body?.worker?.agentId || body?.existing?.agentId || await resolveAgentId(agent);
        if (res.status === 409 && pollAgentId) {
            console.error(`⏳ ${agent} is already running, polling worker result...`);
            const polled = await pollWorkerResult(pollAgentId);
            printDispatchResult(agent, polled);
            process.exit(dispatchExitCode(polled));
        }
        console.error(`❌ ${body.error || `Failed: ${res.status}`}`);
        process.exit(1);
    }
    printDispatchResult(agent, body);
    process.exit(dispatchExitCode(body));
} catch (e: any) {
    console.error(`❌ Error: ${e.message}`);
    process.exit(1);
}

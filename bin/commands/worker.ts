#!/usr/bin/env node
// bin/commands/worker.ts — inspect employee worker progress.

import { loadSettings, getServerUrl } from '../../src/core/config.js';
import { cliFetch, getCliAuthToken } from '../../src/cli/api-auth.js';
import { shouldShowHelp, printAndExit } from '../helpers/help.js';
import { errString, isConnRefused } from '../_http-client.js';
import {
    displayShellCommand,
    displayShellCommandDetail,
} from '../../src/shared/shell-command-display.js';
import { unwrapEmployeeSummaries } from './dispatch-helpers.js';

if (shouldShowHelp(process.argv)) printAndExit(`
  jaw worker — inspect employee progress

  Usage:
    jaw worker status [agent|runId] [--json]
    jaw worker watch [agent|runId]

  Examples:
    jaw worker status
    jaw worker status Backend
    jaw worker status wr_backend_...
    jaw worker watch Backend
`);

loadSettings();

const args = process.argv.slice(3);
const command = args.find(arg => !arg.startsWith('--')) || 'status';
const json = args.includes('--json');
const portIdx = args.indexOf('--port');
const PORT = portIdx !== -1 && args[portIdx + 1] ? args[portIdx + 1] : undefined;
const BASE = getServerUrl(PORT);
const agentArg = args.find((arg, index) => {
    if (arg.startsWith('--')) return false;
    if (index > 0 && args[index - 1] === '--port') return false;
    return arg !== command;
});

interface WorkerToolEntry {
    icon?: string;
    label?: string;
    detail?: string;
    status?: string;
    stepRef?: string;
    toolType?: string;
}

interface WorkerRun {
    runId?: string;
    agentId?: string;
    employeeName?: string;
    state?: string;
    taskPreview?: string;
    phase?: string | null;
    phaseLabel?: string | null;
    startedAt?: number;
    completedAt?: number | null;
    resultPreview?: string;
    attention?: {
        kind?: string;
        message?: string;
        exitCode?: number | null;
        attempts?: number;
    };
    tools?: WorkerToolEntry[];
}

interface WorkerProgressSnapshot {
    runId?: string | null;
    agentId?: string;
    employeeName?: string;
    current?: WorkerRun | null;
    previous?: WorkerRun | null;
}

interface ProgressListBody {
    ok?: boolean;
    workers?: WorkerProgressSnapshot[];
    progress?: WorkerProgressSnapshot | null;
    error?: string;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function resolveAgentId(nameOrId: string): Promise<string> {
    const res = await cliFetch(`${BASE}/api/employees`);
    if (!res.ok) return nameOrId;
    const employees = unwrapEmployeeSummaries(await res.json() as unknown);
    const found = employees.find(e => e.name === nameOrId || e.id === nameOrId);
    return found?.id || nameOrId;
}

async function fetchProgress(agentId?: string): Promise<ProgressListBody> {
    const url = agentId
        ? `${BASE}/api/orchestrate/worker-progress/${encodeURIComponent(agentId)}`
        : `${BASE}/api/orchestrate/worker-progress`;
    const res = await cliFetch(url);
    const body = await res.json() as ProgressListBody;
    if (!res.ok) throw new Error(body.error || `worker progress failed: ${res.status}`);
    return body;
}

function runOf(snapshot: WorkerProgressSnapshot): WorkerRun | null {
    return snapshot.current || snapshot.previous || null;
}

function formatToolLine(tool: WorkerToolEntry, index: number): string {
    const icon = tool.icon || '';
    const status = tool.status ? ` [${tool.status}]` : '';
    const label = displayShellCommand(tool.label || tool.toolType || 'tool');
    const detail = displayShellCommandDetail(tool.detail || '');
    const preview = detail && detail.trim() !== label.trim()
        ? ` — ${detail.replace(/\s+/g, ' ').trim().slice(0, 120)}`
        : '';
    return `${index}. ${icon} ${label}${status}${preview}`.replace(/\s+/g, ' ').trim();
}

function printRun(snapshot: WorkerProgressSnapshot): void {
    const run = runOf(snapshot);
    if (!run) return;
    const name = snapshot.employeeName || run.employeeName || snapshot.agentId || run.agentId || 'worker';
    console.log(`${name}: ${run.state || 'unknown'}`);
    if (run.runId || snapshot.runId) console.log(`runId: ${run.runId || snapshot.runId}`);
    if (run.agentId || snapshot.agentId) console.log(`agentId: ${run.agentId || snapshot.agentId}`);
    if (run.taskPreview) console.log(`task: ${run.taskPreview}`);
    if (run.phase || run.phaseLabel) console.log(`phase: ${run.phaseLabel || run.phase}`);
    if (run.attention?.message) {
        const detail = [
            run.attention.kind,
            run.attention.exitCode !== undefined ? `exit=${run.attention.exitCode}` : '',
            run.attention.attempts !== undefined ? `attempts=${run.attention.attempts}` : '',
        ].filter(Boolean).join(' ');
        console.log(`attention: ${run.attention.message}${detail ? ` (${detail})` : ''}`);
    }
    if (run.resultPreview) console.log(`result: ${run.resultPreview}`);
    const tools = run.tools || [];
    if (tools.length > 0) {
        console.log('process:');
        tools.slice(-20).forEach((tool, index) => console.log(formatToolLine(tool, index + 1)));
    }
}

function printProgress(body: ProgressListBody): void {
    if (body.progress) {
        printRun(body.progress);
        return;
    }
    const workers = body.workers || [];
    if (workers.length === 0) {
        console.log('No worker progress.');
        return;
    }
    workers.forEach((snapshot, index) => {
        if (index > 0) console.log('');
        printRun(snapshot);
    });
}

function progressKey(snapshot: WorkerProgressSnapshot, tool: WorkerToolEntry, index: number): string {
    return `${snapshot.agentId || snapshot.employeeName || 'worker'}:${tool.stepRef || `${index}:${tool.label || ''}:${tool.status || ''}:${tool.detail || ''}`}`;
}

function printNewTools(body: ProgressListBody, printed: Set<string>): boolean {
    const snapshots = body.progress ? [body.progress] : body.workers || [];
    let sawCurrent = false;
    for (const snapshot of snapshots) {
        if (snapshot.current) sawCurrent = true;
        const run = runOf(snapshot);
        const tools = run?.tools || [];
        for (const [index, tool] of tools.entries()) {
            const key = progressKey(snapshot, tool, index);
            if (printed.has(key)) continue;
            printed.add(key);
            console.log(formatToolLine(tool, index + 1));
        }
    }
    return sawCurrent;
}

await getCliAuthToken(PORT);

try {
    if (!['status', 'watch'].includes(command)) {
        console.error(`Unknown worker command: ${command}`);
        process.exit(1);
    }

    const agentId = agentArg ? await resolveAgentId(agentArg) : undefined;
    if (command === 'status') {
        const body = await fetchProgress(agentId);
        if (json) console.log(JSON.stringify(body, null, 2));
        else printProgress(body);
        process.exit(0);
    }

    const printed = new Set<string>();
    while (true) {
        const body = await fetchProgress(agentId);
        const hasCurrent = printNewTools(body, printed);
        if (!hasCurrent) {
            if (printed.size === 0) printProgress(body);
            break;
        }
        await sleep(2_000);
    }
} catch (e: unknown) {
    if (isConnRefused(e)) {
        console.error(`Server not running on port ${PORT || '(configured)'}. Start with: jaw serve`);
    } else {
        console.error(`Error: ${errString(e)}`);
    }
    process.exit(1);
}

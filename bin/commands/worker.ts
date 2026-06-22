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
    jaw worker status [agent|runId] [--recent N] [--json]
    jaw worker watch [agent|runId] [--json]
    jaw worker read <runId> [--offset N --limit N] [--json]
    jaw worker read <runId> [--tail N]

  Examples:
    jaw worker status
    jaw worker status Backend
    jaw worker status wr_backend_...
    jaw worker watch Backend
    jaw worker read wr_backend_...
    jaw worker read wr_backend_... --tail 80
`);

loadSettings();

const args = process.argv.slice(3);
const command = args.find(arg => !arg.startsWith('--')) || 'status';
const json = args.includes('--json');
const portIdx = args.indexOf('--port');
const PORT = portIdx !== -1 && args[portIdx + 1] ? args[portIdx + 1] : undefined;
const BASE = getServerUrl(PORT);
const VALUE_FLAGS = new Set(['--port', '--recent', '--offset', '--limit', '--tail']);
const agentArg = args.find((arg, index) => {
    if (arg.startsWith('--')) return false;
    if (index > 0 && VALUE_FLAGS.has(args[index - 1] || '')) return false;
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

interface WorkerRunRecord {
    runId: string;
    agentId: string;
    employeeName: string;
    status: string;
    updatedAt: number;
    completedAt: number | null;
    outputBytes: number;
    hasOutput: boolean;
    safeSummary?: string;
    taskPreview?: string;
}

interface WorkerRunListBody {
    ok?: boolean;
    runs?: WorkerRunRecord[];
    error?: string;
}

interface WorkerRunRecordBody {
    ok?: boolean;
    run?: WorkerRunRecord;
    error?: string;
}

interface WorkerOutputRead {
    runId: string;
    offset: number;
    limit: number;
    nextOffset: number;
    outputBytes: number;
    eof: boolean;
    text: string;
}

interface WorkerRunOutputBody {
    ok?: boolean;
    output?: WorkerOutputRead;
    error?: string;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function flagValue(name: string): string | undefined {
    const idx = args.indexOf(name);
    if (idx === -1) return undefined;
    const value = args[idx + 1];
    return value && !value.startsWith('--') ? value : undefined;
}

function numericFlag(name: string): number | undefined {
    const raw = flagValue(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
    return Math.floor(value);
}

function requireRunId(runId: string | undefined): string {
    if (!runId) throw new Error('Usage: cli-jaw worker read <runId> [--offset N --limit N] [--tail N]');
    if (!runId.startsWith('wr_')) {
        throw new Error(`worker read requires an explicit runId (expected wr_...). Try: cli-jaw worker status "${runId}"`);
    }
    return runId;
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

async function fetchRunRecords(): Promise<WorkerRunRecord[]> {
    const res = await cliFetch(`${BASE}/api/orchestrate/worker-runs`);
    const body = await res.json() as WorkerRunListBody;
    if (!res.ok) throw new Error(body.error || `worker runs failed: ${res.status}`);
    return body.runs || [];
}

async function fetchRunRecord(runId: string): Promise<WorkerRunRecord> {
    const res = await cliFetch(`${BASE}/api/orchestrate/worker-runs/${encodeURIComponent(runId)}`);
    const body = await res.json() as WorkerRunRecordBody;
    if (!res.ok || !body.run) throw new Error(body.error || `worker run not found: ${runId}`);
    return body.run;
}

async function fetchRunOutput(runId: string, input: { offset?: number; limit?: number } = {}): Promise<WorkerOutputRead> {
    const params = new URLSearchParams();
    if (input.offset !== undefined) params.set('offset', String(input.offset));
    if (input.limit !== undefined) params.set('limit', String(input.limit));
    const query = params.toString();
    const res = await cliFetch(`${BASE}/api/orchestrate/worker-runs/${encodeURIComponent(runId)}/output${query ? `?${query}` : ''}`);
    const body = await res.json() as WorkerRunOutputBody;
    if (!res.ok || !body.output) throw new Error(body.error || `worker output not found: ${runId}`);
    return body.output;
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

function printRunRecord(run: WorkerRunRecord): void {
    console.log(`${run.employeeName || run.agentId}: ${run.status}`);
    console.log(`runId: ${run.runId}`);
    console.log(`agentId: ${run.agentId}`);
    if (run.taskPreview) console.log(`task: ${run.taskPreview}`);
    console.log(`output: ${run.hasOutput ? `${run.outputBytes} bytes` : 'none'}`);
    if (run.safeSummary) console.log(`summary: ${run.safeSummary}`);
}

function printRunRecords(runs: WorkerRunRecord[]): void {
    if (runs.length === 0) {
        console.log('No worker runs.');
        return;
    }
    runs.forEach((run, index) => {
        if (index > 0) console.log('');
        printRunRecord(run);
    });
}

function printReadOutput(output: WorkerOutputRead): void {
    if (output.outputBytes === 0 && output.text.length === 0) {
        console.error(`No output captured for worker run ${output.runId}.`);
        return;
    }
    process.stdout.write(output.text);
    if (output.text && !output.text.endsWith('\n')) process.stdout.write('\n');
    if (!output.eof) {
        console.error(`More output available: cli-jaw worker read ${output.runId} --offset ${output.nextOffset}`);
    }
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
    if (!['status', 'watch', 'read'].includes(command)) {
        console.error(`Unknown worker command: ${command}`);
        process.exit(1);
    }

    if (command === 'read') {
        const runId = requireRunId(agentArg);
        const tail = numericFlag('--tail');
        const offsetFlag = numericFlag('--offset');
        const limitFlag = numericFlag('--limit');
        if (tail !== undefined && (offsetFlag !== undefined || limitFlag !== undefined)) {
            throw new Error('Use either --tail N or --offset/--limit, not both');
        }
        let output: WorkerOutputRead;
        if (tail !== undefined) {
            const run = await fetchRunRecord(runId);
            if (!run.hasOutput || run.outputBytes <= 0) {
                output = { runId, offset: 0, limit: tail, nextOffset: 0, outputBytes: 0, eof: true, text: '' };
            } else {
                const offset = Math.max(0, run.outputBytes - tail);
                output = await fetchRunOutput(runId, { offset, limit: tail });
            }
        } else {
            const readInput: { offset?: number; limit?: number } = {};
            if (offsetFlag !== undefined) readInput.offset = offsetFlag;
            if (limitFlag !== undefined) readInput.limit = limitFlag;
            output = await fetchRunOutput(runId, readInput);
        }
        if (json) console.log(JSON.stringify({ ok: true, output }, null, 2));
        else printReadOutput(output);
        process.exit(0);
    }

    const recent = numericFlag('--recent');
    const agentId = agentArg ? await resolveAgentId(agentArg) : undefined;
    if (command === 'status') {
        if (recent !== undefined) {
            const runs = await fetchRunRecords();
            const filtered = agentArg
                ? runs.filter(run => run.runId === agentArg || run.agentId === agentId || run.employeeName === agentArg)
                : runs;
            const limited = filtered.slice(0, recent);
            if (json) console.log(JSON.stringify({ ok: true, runs: limited }, null, 2));
            else printRunRecords(limited);
            process.exit(0);
        }
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
        if (command === 'read' && agentArg && errString(e).includes('worker run not found')) {
            console.error(`Try: cli-jaw worker status ${agentArg}`);
        }
    }
    process.exit(1);
}

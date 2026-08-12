#!/usr/bin/env node
// bin/commands/dispatch.ts — CLI: jaw dispatch --agent <name> --task <task>
// Dispatches a jaw employee via the server API (pipe-mode compatible).

import { loadSettings, getServerUrl } from '../../src/core/config.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { cliFetch, getCliAuthToken } from '../../src/cli/api-auth.js';
import { shouldShowHelp, printAndExit } from '../helpers/help.js';
import { errString, isConnRefused } from '../_http-client.js';
import { unwrapEmployeeSummaries, readTaskFile, parseTaskTagsFlag } from './dispatch-helpers.js';
import { printBatchDispatchSummary, type BatchDispatchResultSummary } from './dispatch-batch-summary.js';
import {
    displayShellCommand,
    displayShellCommandDetail,
} from '../../src/shared/shell-command-display.js';

if (shouldShowHelp(process.argv)) printAndExit(`
  jaw dispatch — send task to an employee agent

  Usage: jaw dispatch --agent "Name" (--task "instruction" | --task-file <path>) [--async] [--quiet]
         jaw dispatch --virtual "security" --task "audit this change" [--role "security"]
         jaw dispatch --batch (--agents '<JSON array>' | --agents-file <path>) [--async]
  Options:
    --agent <name>      Employee name (must match settings.json employees)
    --virtual <name>    Ephemeral virtual employee name or role preset (security, testing)
    --role <text>       Virtual role preset or freeform role prompt
    --cli <name>        CLI for virtual employee (default: current CLI)
    --model <name>      Model for virtual employee (default: registry default for CLI)
    --task <text>       Task instruction to send
    --task-file <path>  Read the task instruction from a file (recommended for
                        multi-line briefs — no shell quoting; max 1MB)
    --task-tags <csv>   Methodology overlays forwarded as task_tags (e.g. "tdd,security")
    --mutable           Allow employee to write/modify files (default: read-only)
    --scope <path>      Restrict writes to a subdirectory (optional, requires --mutable)
    --async             Do not wait for the result: print runId + recovery commands
                        and exit. Recommended for work that may exceed 2 minutes —
                        omitting it blocks up to 10 minutes while polling.
                        Retrieve later: cli-jaw worker status/read <runId>
    --watch             Print live sanitized employee progress until completion (default for human output)
    --quiet             Suppress live progress summaries
    --json              JSON output; suppresses human progress lines
  Batch mode:
    --batch             Enable batch parallel dispatch
    --agents <json>     JSON array of {agent|virtual, task, role?, cli?, model?, parallel?, mutable?, scope?, affected_files?, task_tags?}
    --agents-file <path> Read the JSON array from a file (no shell quoting)
  Result is returned via stdout. Employee names are case-sensitive.

  Examples:
    jaw dispatch --agent "Frontend" --task "Fix CSS bug in header"
    jaw dispatch --agent "Backend" --task-file /tmp/brief.md --task-tags "tdd" --async
    jaw dispatch --virtual "security" --task "Review this branch for auth and secret leaks" --watch
    jaw dispatch --batch --agents-file /tmp/batch.json --async
`);

loadSettings();

if (process.env["JAW_EMPLOYEE_MODE"] === '1') {
    console.error('❌ jaw employee sessions cannot dispatch other employees. Complete the assigned task directly.');
    process.exit(2);
}

// Phase 8: boss-only dispatch. Token must be inherited from the server process.
const bossToken = process.env["JAW_BOSS_TOKEN"] || '';
if (!bossToken) {
    console.error('❌ JAW_BOSS_TOKEN missing. This session is not authorized to dispatch employees.');
    // The old wording told users to "ensure this process inherited its env",
    // which cannot work: the boss token is generated inside the running serve
    // process and never written to disk, so a separately opened shell has
    // nothing to inherit from. Saying so plainly beats sending people to look
    // for a file that does not exist (#276).
    console.error('   The boss token lives only in the serve process\'s memory — it is never written to disk,');
    console.error('   so a separately opened shell cannot inherit it. $JAW_HOME/token is the API bearer');
    console.error('   token, not this capability.');
    console.error('');
    console.error('   To dispatch: run this from the agent session that serve spawned.');
    console.error('   To send an ordinary prompt instead: jaw ask "<text>"');
    process.exit(2);
}

const portIdx = process.argv.indexOf('--port');
const PORT = (portIdx !== -1 && process.argv[portIdx + 1]) ? process.argv[portIdx + 1] : undefined;
const BASE = getServerUrl(PORT);

type BatchAgentRequest = { agent?: string; virtual?: string; role?: string; cli?: string; model?: string; task: string; parallel?: boolean; mutable?: boolean; scope?: string; affected_files?: string[]; task_tags?: string[] };

function getFlag(name: string): string | undefined {
    const idx = process.argv.indexOf(name);
    if (idx === -1 || !process.argv[idx + 1]) return undefined;
    return process.argv[idx + 1];
}

const agent = getFlag('--agent');
const virtual = getFlag('--virtual');
const role = getFlag('--role');
const cli = getFlag('--cli');
const model = getFlag('--model');
const inlineTask = getFlag('--task');
const taskFile = getFlag('--task-file');
const taskTags = parseTaskTagsFlag(getFlag('--task-tags'));
const isAsync = process.argv.includes('--async');
const mutable = process.argv.includes('--mutable');
const scope = getFlag('--scope');
const quiet = process.argv.includes('--quiet');
const json = process.argv.includes('--json');
const isBatch = process.argv.includes('--batch');
const inlineAgentsRaw = getFlag('--agents');
const agentsFile = getFlag('--agents-file');

// 260703 dispatch affordance: file-based briefs remove shell-quoting failures.
if (inlineTask && taskFile) {
    console.error('❌ Pass either --task or --task-file, not both.');
    process.exit(1);
}
if (inlineAgentsRaw && agentsFile) {
    console.error('❌ Pass either --agents or --agents-file, not both.');
    process.exit(1);
}
let task = inlineTask;
if (taskFile) {
    const r = readTaskFile(taskFile);
    if (!r.ok || !r.content) {
        console.error(`❌ ${r.error || 'task file read failed'}`);
        process.exit(1);
    }
    task = r.content;
}
let batchAgentsRaw = inlineAgentsRaw;
if (agentsFile) {
    const r = readTaskFile(agentsFile);
    if (!r.ok || !r.content) {
        console.error(`❌ ${r.error || 'agents file read failed'}`);
        process.exit(1);
    }
    batchAgentsRaw = r.content;
}

// `batchRun:` lets each exit below break out instead of calling process.exit().
// Tearing the process down while the fetch transport is still closing is the
// likely source of the libuv UV_HANDLE_CLOSING assertion in #276.
if (isBatch) batchRun: {
    if (!batchAgentsRaw) {
        console.error('Usage: jaw dispatch --batch (--agents \'[{"agent":"Name","task":"..."}]\' | --agents-file <path>)');
        process.exitCode = 1;
        break batchRun;
    }
    let batchAgents: BatchAgentRequest[];
    try {
        batchAgents = JSON.parse(batchAgentsRaw);
        if (!Array.isArray(batchAgents) || batchAgents.length === 0) throw new Error('empty');
    } catch {
        console.error('❌ --agents must be a non-empty JSON array');
        process.exitCode = 1;
        break batchRun;
    }
    const BASE = getServerUrl();
    await getCliAuthToken();
    if (!json && !quiet) console.log(`🚀 Batch dispatching ${batchAgents.length} agents...`);
    try {
        const res = await cliFetch(`${BASE}/api/orchestrate/dispatch/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Jaw-Boss-Token': bossToken },
            // --async sends wait:false → server pre-claims slots, answers 202
            // with runIds, and executes detached (results via worker status/read
            // or the boss's pending-replay drain).
            body: JSON.stringify({ agents: batchAgents, ...(isAsync ? { wait: false } : {}) }),
        });
        const { body, nonJsonError } = await readJsonResponse<BatchDispatchBody>(res, 'batch dispatch endpoint');
        if (nonJsonError || !body.ok) {
            printNonOkResponse(body, res.status);
            // Every exit below this point runs while the fetch transport is
            // still closing, so they set exitCode and return instead of tearing
            // the process down mid-teardown (#276 libuv assertion).
            process.exitCode = 1;
            break batchRun;
        }
        if (res.status === 202) {
            const workers = body.workers || [];
            const allAccepted = workers.length > 0 && workers.every(w => w.accepted);
            if (json) {
                console.log(JSON.stringify(body));
                process.exitCode = allAccepted ? 0 : 1;
                break batchRun;
            }
            printBatchAsyncWorkers(workers);
            process.exitCode = allAccepted ? 0 : 1;
            break batchRun;
        }
        if (json) {
            console.log(JSON.stringify(body));
            process.exitCode = (body.results || []).every(r => r.ok) ? 0 : 1;
            break batchRun;
        }
        if (quiet) {
            process.exitCode = (body.results || []).every(r => r.ok) ? 0 : 1;
            break batchRun;
        }
        process.exitCode = printBatchDispatchSummary(body.results || []);
    } catch (e: unknown) {
        console.error(`❌ Error: ${errString(e)}`);
        process.exitCode = 1;
    }
}

if ((!agent && !virtual) || (agent && virtual) || !task) {
    console.error('Usage: jaw dispatch (--agent <name> | --virtual <name>) (--task <task> | --task-file <path>)');
    console.error('  --agent     Employee name (e.g., Frontend, Backend, Data, Docs)');
    console.error('  --virtual   Ephemeral virtual employee name or role preset (security, testing)');
    console.error('  --role      Virtual role preset or freeform role prompt');
    console.error('  --cli       CLI for virtual employee (default: current CLI)');
    console.error('  --model     Model for virtual employee (default: registry default for CLI)');
    console.error('  --task      Task description to assign');
    console.error('  --task-file Read the task description from a file (no shell quoting)');
    process.exit(1);
}

const targetName = virtual || agent || '';

const STARTUP_RETRY_DELAYS_MS = [500, 1000, 1500, 2000, 3000];

type DispatchToolEntry = {
    icon?: string; label?: string; detail?: string; toolType?: string;
    status?: string; stepRef?: string; isEmployee?: boolean;
};
type WorkerProgressRunBody = { runId?: string; agentId?: string; state?: string; tools?: DispatchToolEntry[] };
type WorkerProgressSnapshotBody = {
    runId?: string | null; agentId?: string;
    current?: WorkerProgressRunBody | null; previous?: WorkerProgressRunBody | null;
};
type WorkerProgressResponseBody = { ok?: boolean; progress?: WorkerProgressSnapshotBody | null; error?: string };
type DispatchResultBody = {
    state?: string; result?: { status?: string; text?: string; tools?: DispatchToolEntry[] } | string;
    tools?: DispatchToolEntry[]; progress?: WorkerProgressSnapshotBody | null; progressUpdatedAt?: number | null;
    error?: string; message?: string; hint?: string; runId?: string; agentId?: string;
    worker?: { agentId?: string; runId?: string; employeeName?: string; startedAt?: number };
    existing?: { agentId?: string; runId?: string };
    orchestration?: {
        verdict?: string; statusPersisted?: boolean; persistedField?: string; currentState?: string; ctxPresent?: boolean;
    };
};
type BatchAsyncWorker = { agent: string; accepted: boolean; agentId?: string; runId?: string; error?: string };
type BatchDispatchBody = {
    ok?: boolean; results?: BatchDispatchResultSummary[]; error?: string; message?: string; hint?: string;
    state?: string; workers?: BatchAsyncWorker[];
};

// 202 workers-shape printer (--async batch). printBatchDispatchSummary consumes
// completed results (ok/status/preview) and cannot render pre-claimed slots.
function printBatchAsyncWorkers(workers: BatchAsyncWorker[]): void {
    const accepted = workers.filter(w => w.accepted).length;
    console.log(`🚀 Batch accepted — ${accepted}/${workers.length} workers running (async)`);
    for (const w of workers) {
        if (w.accepted && w.runId) {
            console.log(`  ✅ ${w.agent} — runId: ${w.runId}`);
            console.log(`     status: cli-jaw worker status ${w.runId}`);
            console.log(`     output: cli-jaw worker read ${w.runId} --tail 80`);
        } else {
            console.log(`  ❌ ${w.agent} — ${w.error || 'not accepted'}`);
        }
    }
}

function responsePreview(raw: string): string {
    return raw.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function nonJsonResponseError(res: Response, raw: string, context: string): string {
    const contentType = res.headers.get('content-type') || 'unknown content-type';
    const preview = responsePreview(raw);
    const suffix = preview ? `; body preview: ${preview}` : '';
    return `${context} returned non-JSON HTTP ${res.status} (${contentType}); server may be stale or missing this route${suffix}`;
}

async function readJsonResponse<T>(res: Response, context: string): Promise<{ body: T; nonJsonError?: string }> {
    const raw = await res.text();
    if (!raw.trim()) return { body: {} as T };
    try {
        return { body: JSON.parse(raw) as T };
    } catch {
        const nonJsonError = nonJsonResponseError(res, raw, context);
        return { body: { error: nonJsonError } as T, nonJsonError };
    }
}

async function resolveAgentId(name: string): Promise<string | null> {
    const res = await cliFetch(`${BASE}/api/employees`);
    if (!res.ok) return null;
    const parsed = await readJsonResponse<unknown>(res, 'employees endpoint');
    if (parsed.nonJsonError) return null;
    const employees = unwrapEmployeeSummaries(parsed.body);
    const found = employees.find(e => e.name === name || e.id === name);
    return found?.id || null;
}

class DispatchPollError extends Error {
    constructor(message: string, public readonly agentId: string, public readonly agentName: string, public readonly runId?: string) {
        super(message);
        this.name = 'DispatchPollError';
    }
}

// A single transient fetch failure (ECONNRESET, brief event-loop stall) used
// to kill a 10-minute poll loop on its first throw (devlog 260613 doc 08).
const POLL_RETRY_DELAYS_MS = [500, 1000, 2000];

async function pollFetch(url: string, agentId: string, agentName: string, label: string, runId?: string): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= POLL_RETRY_DELAYS_MS.length; attempt++) {
        try {
            return await cliFetch(url);
        } catch (fetchErr) {
            lastErr = fetchErr;
            if (attempt < POLL_RETRY_DELAYS_MS.length) await sleep(POLL_RETRY_DELAYS_MS[attempt]!);
        }
    }
    throw new DispatchPollError(`${label}: ${errString(lastErr)}`, agentId, agentName, runId);
}

function runIdFromBody(body: DispatchResultBody): string | undefined {
    return body.runId || body.worker?.runId || body.existing?.runId || progressRun(body.progress)?.runId || undefined;
}

async function pollWorkerResult(agentId: string, agentName = '', runId?: string): Promise<DispatchResultBody> {
    const deadline = Date.now() + 600_000;
    let lastState = 'unknown';
    let knownRunId = runId;
    while (Date.now() < deadline) {
        const res = await pollFetch(`${BASE}/api/orchestrate/worker/${encodeURIComponent(agentId)}/result`, agentId, agentName, 'dispatch poll failed', knownRunId);
        const { body, nonJsonError } = await readJsonResponse<DispatchResultBody>(res, 'worker result endpoint');
        knownRunId = runIdFromBody(body) || knownRunId;
        if (nonJsonError) throw new DispatchPollError(nonJsonError, agentId, agentName, knownRunId);
        if (!res.ok) throw new DispatchPollError(body.error || `poll failed: ${res.status}`, agentId, agentName, knownRunId);
        lastState = body.state || 'unknown';
        if (body.state !== 'running') return body;
        await sleep(2_000);
    }
    throw new DispatchPollError(`timed out after 10 minutes (last state: ${lastState})`, agentId, agentName, knownRunId);
}

async function fetchWorkerProgress(agentId: string, agentName = '', runId?: string): Promise<WorkerProgressSnapshotBody | null> {
    const res = await pollFetch(`${BASE}/api/orchestrate/worker-progress/${encodeURIComponent(agentId)}`, agentId, agentName, 'worker progress fetch failed', runId);
    const { body, nonJsonError } = await readJsonResponse<WorkerProgressResponseBody>(res, 'worker progress endpoint');
    const bodyRunId = body.progress ? progressRun(body.progress)?.runId : undefined;
    if (nonJsonError) throw new DispatchPollError(nonJsonError, agentId, agentName, bodyRunId || runId);
    if (res.status === 404) return null;
    if (!res.ok) throw new DispatchPollError(body.error || `progress fetch failed: ${res.status}`, agentId, agentName, bodyRunId || runId);
    return body.progress || null;
}

function resultStatus(body: DispatchResultBody): string {
    if (typeof body.result === 'object' && typeof body.result?.status === 'string') return body.result.status;
    if (typeof body.state === 'string') return body.state;
    return 'done';
}

function resultText(body: DispatchResultBody): string | undefined {
    if (typeof body.result === 'object' && typeof body.result?.text === 'string') return body.result.text;
    if (typeof body.result === 'string') return body.result;
    return undefined;
}

function resultTools(body: DispatchResultBody): DispatchToolEntry[] {
    const progressTools = progressRun(body.progress)?.tools;
    if (Array.isArray(progressTools)) return progressTools;
    if (typeof body.result === 'object' && Array.isArray(body.result?.tools)) return body.result.tools;
    if (Array.isArray(body.tools)) return body.tools;
    return [];
}

function dispatchExitCode(body: DispatchResultBody): number {
    const status = resultStatus(body);
    return status === 'error' || status === 'failed' || status === 'cancelled' ? 1 : 0;
}

function formatToolLine(tool: DispatchToolEntry, index: number): string {
    const icon = tool.icon || '';
    const status = tool.status ? ` [${tool.status}]` : '';
    const label = displayShellCommand(tool.label || tool.toolType || 'tool');
    const detail = displayShellCommandDetail(tool.detail || '');
    const detailPreview = detail && detail.trim() !== label.trim()
        ? ` — ${detail.replace(/\s+/g, ' ').trim().slice(0, 120)}`
        : '';
    return `${index}. ${icon} ${label}${status}${detailPreview}`.replace(/\s+/g, ' ').trim();
}

function printEmployeeProcess(body: DispatchResultBody): void {
    const tools = resultTools(body);
    if (tools.length === 0) return;
    const max = 20;
    const omitted = Math.max(0, tools.length - max);
    const visible = tools.slice(-max);
    console.log('\n--- Employee Process ---');
    if (omitted > 0) console.log(`(${omitted} earlier step${omitted === 1 ? '' : 's'} omitted)`);
    visible.forEach((tool, idx) => {
        console.log(formatToolLine(tool, omitted + idx + 1));
    });
}

function progressRun(progress: WorkerProgressSnapshotBody | null | undefined): WorkerProgressRunBody | null {
    return progress?.current || progress?.previous || null;
}

function progressToolKey(tool: DispatchToolEntry, index: number): string {
    return tool.stepRef || `${index}:${tool.label || ''}:${tool.status || ''}:${tool.detail || ''}`;
}

function printProgressSnapshot(progress: WorkerProgressSnapshotBody | null | undefined, printed: Set<string>): void {
    const run = progressRun(progress);
    const tools = run?.tools || [];
    if (tools.length === 0) return;
    let printedHeader = printed.has('__header__');
    if (!printedHeader) {
        console.log('\n--- Employee Process (live) ---');
        printed.add('__header__');
        printedHeader = true;
    }
    void printedHeader;
    tools.forEach((tool, index) => {
        const key = progressToolKey(tool, index);
        if (printed.has(key)) return;
        printed.add(key);
        console.log(formatToolLine(tool, index + 1));
    });
}

async function pollAndPrintWorker(agentId: string, agentName: string, runId?: string): Promise<DispatchResultBody> {
    const deadline = Date.now() + 600_000;
    const printed = new Set<string>();
    let lastState = 'unknown';
    let knownRunId = runId;
    while (Date.now() < deadline) {
        const progress = await fetchWorkerProgress(agentId, agentName, knownRunId);
        knownRunId = progressRun(progress)?.runId || knownRunId;
        printProgressSnapshot(progress, printed);
        const body = await pollWorkerResultOnce(agentId, agentName, knownRunId);
        knownRunId = runIdFromBody(body) || knownRunId;
        lastState = body.state || lastState;
        printProgressSnapshot(body.progress, printed);
        if (body.state !== 'running') return body;
        await sleep(2_000);
    }
    throw new DispatchPollError(`timed out after 10 minutes (last state: ${lastState})`, agentId, agentName, knownRunId);
}

async function pollWorkerResultOnce(agentId: string, agentName = '', runId?: string): Promise<DispatchResultBody> {
    const res = await pollFetch(`${BASE}/api/orchestrate/worker/${encodeURIComponent(agentId)}/result`, agentId, agentName, 'dispatch poll failed', runId);
    const { body, nonJsonError } = await readJsonResponse<DispatchResultBody>(res, 'worker result endpoint');
    const knownRunId = runIdFromBody(body) || runId;
    if (nonJsonError) throw new DispatchPollError(nonJsonError, agentId, agentName, knownRunId);
    if (!res.ok) throw new DispatchPollError(body.error || `poll failed: ${res.status}`, agentId, agentName, knownRunId);
    return body;
}

function printDispatchResult(agentName: string, body: DispatchResultBody, opts: { skipProcess?: boolean } = {}): void {
    console.log(`✅ ${agentName} completed (${resultStatus(body)})`);
    if (!opts.skipProcess) printEmployeeProcess(body);
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

function printJsonResult(body: DispatchResultBody): void {
    console.log(JSON.stringify(body, null, 2));
}

function shouldPrintLiveProgress(): boolean {
    return !json && !quiet;
}

function printFetchErrorWithRecovery(message: string): void {
    console.error(`❌ Error: ${message}`);
    if (!message.includes('fetch failed')) return;
    console.error(`  status:  cli-jaw worker status`);
    console.error(`  target:  cli-jaw worker status "${targetName}"`);
}

function printNonOkResponse(body: { error?: string; message?: string; hint?: string }, status: number): void {
    console.error(`❌ ${body.error || `Failed: ${status}`} (${BASE})`);
    if (body.message) console.error(`  message: ${body.message}`);
    if (body.hint) console.error(`  hint: ${body.hint}`);
}

function printPollErrorWithRecovery(e: DispatchPollError): void {
    console.error(`❌ ${e.message}`);
    console.error(`  agentId:  ${e.agentId}`);
    if (e.runId) console.error(`  runId:    ${e.runId}`);
    console.error(`  agent:    ${e.agentName || targetName}`);
    if (e.runId) {
        console.error(`  status:   cli-jaw worker status ${e.runId}`);
        console.error(`  output:   cli-jaw worker read ${e.runId} --tail 80`);
    } else console.error(`  status:   cli-jaw worker status "${e.agentName || targetName}"`);
    console.error(`  poll:     curl -s ${BASE}/api/orchestrate/worker/${encodeURIComponent(e.agentId)}/result`);
}

await getCliAuthToken(PORT);
// Labeled block so the paths below can stop work with `break` instead of
// process.exit(). This module is top level, so `return` is not available and
// an early exit here would kill the process mid-teardown (#276).
dispatchRun: {
try {
    if (!json && !quiet) console.log(`🚀 Dispatching to ${targetName}...`);

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
                body: JSON.stringify({
                    ...(agent ? { agent } : { virtual }),
                    task,
                    mutable,
                    scope,
                    ...(taskTags.length ? { task_tags: taskTags } : {}),
                    ...(role ? { role } : {}),
                    ...(cli ? { cli } : {}),
                    ...(model ? { model } : {}),
                    // 260613 60: always poll. Blocking wait=true held the
                    // response past undici's 5-min headersTimeout for long
                    // workers — CLI died with "fetch failed" while the worker
                    // kept running, and the result came back later as a
                    // confusing pendingReplay re-injection (devlog doc 08).
                    wait: false,
                }),
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
            printFetchErrorWithRecovery(errString(lastError));
        }
        process.exit(1);
    }

    const { body, nonJsonError } = await readJsonResponse<DispatchResultBody>(res, 'dispatch endpoint');
    if (nonJsonError) {
        console.error(`❌ ${nonJsonError}`);
        // Post-response: the socket is still draining. Same reason as the paths below.
        process.exitCode = 1;
        break dispatchRun;
    }
    if (res.status === 202) {
        // --async: worker is claimed and running server-side — print the handle
        // and return the turn instead of blocking up to 10 minutes.
        if (isAsync) {
            // exitCode + break, not process.exit(): the response body is already
            // read, so exiting here tears the process down while the pooled HTTP
            // socket is still closing. That is the pattern the 200 and 409 paths
            // below deliberately avoid as the libuv UV_HANDLE_CLOSING candidate
            // in #276; this path had been left behind.
            if (json) { printJsonResult(body); process.exitCode = 0; break dispatchRun; }
            console.log(`🚀 ${targetName} dispatched (async)`);
            const w = body.worker;
            if (w?.runId) {
                console.log(`  runId: ${w.runId}`);
                console.log(`  status: cli-jaw worker status ${w.runId}`);
                console.log(`  output: cli-jaw worker read ${w.runId} --tail 80`);
            } else {
                // Defensive: a 202 without worker metadata still leaves a handle.
                console.log(`  status: cli-jaw worker status "${targetName}"`);
            }
            process.exitCode = 0;
            break dispatchRun;
        }
        const pollAgentId = body?.worker?.agentId || (agent ? await resolveAgentId(agent) : null);
        if (!pollAgentId) { console.error('❌ dispatch started but worker id was not returned'); process.exitCode = 1; break dispatchRun; }
        const pollRunId = body?.worker?.runId;
        const liveProgress = shouldPrintLiveProgress();
        const polled = liveProgress ? await pollAndPrintWorker(pollAgentId, targetName, pollRunId) : await pollWorkerResult(pollAgentId, targetName, pollRunId);
        if (json) printJsonResult(polled);
        else printDispatchResult(targetName, polled, liveProgress ? { skipProcess: true } : {});
        // Exit AFTER the response body has been read. process.exit() here would tear
        // the process down while the pooled HTTP socket is still closing — the
        // strongest candidate for the libuv UV_HANDLE_CLOSING assertion in #276.
        // Setting exitCode lets the transport drain and still yields the same status.
        process.exitCode = dispatchExitCode(polled);
        break dispatchRun;
    }
    if (!res.ok) {
        if (res.status === 409) {
            const pollAgentId = body?.worker?.agentId || body?.existing?.agentId || (agent ? await resolveAgentId(agent) : null);
            // exitCode + return, not process.exit(): killing the process while
            // the fetch transport is still closing is the likely source of the
            // libuv UV_HANDLE_CLOSING assertion reported in #276.
            if (!pollAgentId) { printNonOkResponse(body, res.status); process.exitCode = 1; break dispatchRun; }
            const pollRunId = body?.worker?.runId || body?.existing?.runId;
            if (isAsync) {
                // Do not fall into the 10-minute poll on --async: report the
                // in-flight worker and exit non-zero so the caller can decide.
                if (json) { printJsonResult(body); process.exitCode = 1; break dispatchRun; }
                console.error(`⏳ ${targetName} is already running (agentId: ${pollAgentId}${pollRunId ? `, runId: ${pollRunId}` : ''})`);
                if (pollRunId) {
                    console.error(`  status: cli-jaw worker status ${pollRunId}`);
                    console.error(`  output: cli-jaw worker read ${pollRunId} --tail 80`);
                }
                process.exitCode = 1;
                break dispatchRun;
            }
            if (!json && !quiet) {
                console.error(`⏳ ${targetName} is already running (agentId: ${pollAgentId}${pollRunId ? `, runId: ${pollRunId}` : ''}), polling worker result...`);
            }
            const liveProgress = shouldPrintLiveProgress();
            const polled = liveProgress ? await pollAndPrintWorker(pollAgentId, targetName, pollRunId) : await pollWorkerResult(pollAgentId, targetName, pollRunId);
            if (json) printJsonResult(polled);
            else printDispatchResult(targetName, polled, liveProgress ? { skipProcess: true } : {});
            process.exitCode = dispatchExitCode(polled);
            break dispatchRun;
        }
        printNonOkResponse(body, res.status);
        process.exitCode = 1;
        break dispatchRun;
    }
    if (json) printJsonResult(body);
    else printDispatchResult(targetName, body);
    process.exitCode = dispatchExitCode(body);
} catch (e: unknown) {
    if (e instanceof DispatchPollError) {
        printPollErrorWithRecovery(e);
    } else {
        printFetchErrorWithRecovery(errString(e));
    }
    process.exitCode = 1;
}
}

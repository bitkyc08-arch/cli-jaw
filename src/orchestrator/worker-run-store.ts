import fs from 'node:fs';
import { join } from 'node:path';
import { broadcast } from '../core/bus.js';
import type { SanitizedToolLogEntry } from '../shared/tool-log-sanitize.js';
import { previewText, type WorkerProgressAttention, type WorkerRunState } from './worker-progress.js';
import {
    ensureWorkerRunDir,
    readWorkerOutput,
    WORKER_RUNS_DIR,
    writeWorkerOutput,
    workerRunDir,
    type WorkerOutputRead,
} from './worker-output-store.js';

export type WorkerRunEventType =
    | 'worker_run_started'
    | 'worker_run_progress'
    | 'worker_run_attention'
    | 'worker_run_done'
    | 'worker_run_failed'
    | 'worker_run_cancelled';

export interface WorkerRunRecordInput {
    runId: string;
    agentId: string;
    employeeName: string;
    taskPreview: string;
    startedAt: number;
}

export interface WorkerRunRecord extends WorkerRunRecordInput {
    status: WorkerRunState;
    updatedAt: number;
    completedAt: number | null;
    outputFile?: string;
    outputBytes: number;
    eventSeq: number;
    safeSummary?: string;
}

export interface PublicWorkerRunRecord extends Omit<WorkerRunRecord, 'outputFile'> {
    hasOutput: boolean;
}

export interface WorkerRunEvent {
    runId: string;
    seq: number;
    event: WorkerRunEventType;
    ts: number;
    data: Record<string, unknown>;
}

const LIST_LIMIT = 100;

function metaPath(runId: string): string { return join(workerRunDir(runId), 'meta.json'); }
function eventsPath(runId: string): string { return join(workerRunDir(runId), 'events.jsonl'); }

function toPublicRecord(record: WorkerRunRecord): PublicWorkerRunRecord {
    const { outputFile: _outputFile, ...safe } = record;
    void _outputFile;
    return { ...safe, hasOutput: record.outputBytes > 0 };
}

function readRecord(runId: string): WorkerRunRecord | null {
    try {
        const file = metaPath(runId);
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8')) as WorkerRunRecord;
    } catch {
        return null;
    }
}

function writeRecord(record: WorkerRunRecord): void {
    ensureWorkerRunDir(record.runId);
    fs.writeFileSync(metaPath(record.runId), `${JSON.stringify(record, null, 2)}\n`);
}

function updateRecord(runId: string, update: Partial<WorkerRunRecord>): WorkerRunRecord | null {
    const existing = readRecord(runId);
    if (!existing) return null;
    const next = { ...existing, ...update, updatedAt: Date.now() };
    writeRecord(next);
    return next;
}

function safeEventData(record: WorkerRunRecord, extra: Record<string, unknown>): Record<string, unknown> {
    return {
        runId: record.runId,
        agentId: record.agentId,
        employeeName: record.employeeName,
        status: record.status,
        outputBytes: record.outputBytes,
        ...extra,
    };
}

export function createWorkerRunRecord(input: WorkerRunRecordInput): PublicWorkerRunRecord {
    const now = Date.now();
    const record: WorkerRunRecord = {
        ...input,
        status: 'running',
        updatedAt: now,
        completedAt: null,
        outputBytes: 0,
        eventSeq: 0,
    };
    writeRecord(record);
    appendWorkerRunEvent(input.runId, 'worker_run_started', { taskPreview: input.taskPreview });
    return toPublicRecord(readRecord(input.runId) || record);
}

export function appendWorkerRunEvent(
    runId: string,
    event: WorkerRunEventType,
    data: Record<string, unknown> = {},
): WorkerRunEvent | null {
    const record = readRecord(runId);
    if (!record) return null;
    const seq = record.eventSeq + 1;
    const entry: WorkerRunEvent = { runId, seq, event, ts: Date.now(), data };
    fs.appendFileSync(eventsPath(runId), `${JSON.stringify(entry)}\n`);
    const updated = updateRecord(runId, { eventSeq: seq }) || record;
    broadcast(event, safeEventData(updated, { seq, ...data }));
    return entry;
}

export function recordWorkerRunProgress(runId: string, tools: SanitizedToolLogEntry[]): void {
    const safeTools = tools.slice(-20);
    appendWorkerRunEvent(runId, 'worker_run_progress', { tools: safeTools, toolCount: tools.length });
}

export function recordWorkerRunAttention(runId: string, attention: WorkerProgressAttention | null): void {
    appendWorkerRunEvent(runId, 'worker_run_attention', { attention });
}

export function completeWorkerRun(runId: string, status: Exclude<WorkerRunState, 'running'>, outputText: string): void {
    const record = readRecord(runId);
    if (!record) return;
    const output = outputText ? writeWorkerOutput(runId, outputText) : { outputFile: undefined, outputBytes: 0 };
    const completedAt = Date.now();
    const safeSummary = output.outputBytes > 0
        ? `${status} output captured (${output.outputBytes} bytes)`
        : previewText(status, 240);
    const update: Partial<WorkerRunRecord> = {
        status,
        completedAt,
        outputBytes: output.outputBytes,
    };
    if (safeSummary) update.safeSummary = safeSummary;
    if (output.outputFile) update.outputFile = output.outputFile;
    const updated = updateRecord(runId, update) || record;
    const event: WorkerRunEventType = status === 'done'
        ? 'worker_run_done'
        : status === 'failed'
            ? 'worker_run_failed'
            : 'worker_run_cancelled';
    appendWorkerRunEvent(runId, event, {
        completedAt,
        outputBytes: updated.outputBytes,
        ...(safeSummary ? { safeSummary } : {}),
    });
}

export function listWorkerRunRecords(): PublicWorkerRunRecord[] {
    if (!fs.existsSync(WORKER_RUNS_DIR)) return [];
    return fs.readdirSync(WORKER_RUNS_DIR, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => readRecord(entry.name))
        .filter((record): record is WorkerRunRecord => Boolean(record))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, LIST_LIMIT)
        .map(toPublicRecord);
}

export function getWorkerRunRecord(runId: string): PublicWorkerRunRecord | null {
    const record = readRecord(runId);
    return record ? toPublicRecord(record) : null;
}

export function listWorkerRunEvents(runId: string): WorkerRunEvent[] {
    const file = eventsPath(runId);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as WorkerRunEvent);
}

export function readWorkerRunOutput(runId: string, input: { offset?: number; limit?: number } = {}): WorkerOutputRead {
    return readWorkerOutput(runId, input);
}

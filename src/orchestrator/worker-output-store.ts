import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { JAW_HOME } from '../core/config.js';

export const WORKER_RUNS_DIR = join(JAW_HOME, 'worker-runs');
export const DEFAULT_WORKER_OUTPUT_LIMIT = 64 * 1024;
export const MAX_WORKER_OUTPUT_LIMIT = 256 * 1024;

const WORKER_RUN_ID_RE = /^wr_[A-Za-z0-9_-]{1,128}$/;

export interface WorkerOutputWrite {
    outputFile: string;
    outputBytes: number;
}

export interface WorkerOutputRead {
    runId: string;
    offset: number;
    limit: number;
    nextOffset: number;
    outputBytes: number;
    eof: boolean;
    text: string;
}

export function assertWorkerRunId(runId: string): string {
    if (!WORKER_RUN_ID_RE.test(runId)) throw new Error(`invalid worker run id: ${runId}`);
    return runId;
}

export function workerRunDir(runId: string): string {
    const safeRunId = assertWorkerRunId(runId);
    const base = resolve(WORKER_RUNS_DIR);
    const dir = resolve(base, safeRunId);
    if (!dir.startsWith(base + '/') && dir !== base) throw new Error(`unsafe worker run path: ${runId}`);
    return dir;
}

export function workerOutputPath(runId: string): string {
    return join(workerRunDir(runId), 'output.txt');
}

export function ensureWorkerRunDir(runId: string): string {
    const dir = workerRunDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function writeWorkerOutput(runId: string, text: string): WorkerOutputWrite {
    ensureWorkerRunDir(runId);
    const outputFile = workerOutputPath(runId);
    fs.writeFileSync(outputFile, text, 'utf8');
    return { outputFile, outputBytes: Buffer.byteLength(text, 'utf8') };
}

export function readWorkerOutput(runId: string, input: { offset?: number; limit?: number } = {}): WorkerOutputRead {
    const outputFile = workerOutputPath(runId);
    const outputBytes = fs.existsSync(outputFile) ? fs.statSync(outputFile).size : 0;
    const offset = Math.max(0, Math.min(Number(input.offset || 0), outputBytes));
    const requestedLimit = Number(input.limit || DEFAULT_WORKER_OUTPUT_LIMIT);
    const limit = Math.max(1, Math.min(
        Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_WORKER_OUTPUT_LIMIT,
        MAX_WORKER_OUTPUT_LIMIT,
    ));
    if (outputBytes === 0) {
        return { runId, offset, limit, nextOffset: offset, outputBytes, eof: true, text: '' };
    }
    const fd = fs.openSync(outputFile, 'r');
    try {
        const length = Math.max(0, Math.min(limit, outputBytes - offset));
        const buffer = Buffer.alloc(length);
        const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
        const nextOffset = offset + bytesRead;
        return {
            runId,
            offset,
            limit,
            nextOffset,
            outputBytes,
            eof: nextOffset >= outputBytes,
            text: buffer.subarray(0, bytesRead).toString('utf8'),
        };
    } finally {
        fs.closeSync(fd);
    }
}

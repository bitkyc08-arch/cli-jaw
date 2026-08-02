#!/usr/bin/env -S npx tsx

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
    DEFAULT_PI_PROFILE,
    DEFAULT_PI_SETTINGS,
    ensurePiRuntimeConfig,
    parsePiRpcRecord,
    resolvePiCommand,
    type PiCommand,
} from '../src/agent/pi-runtime.js';
import { JAW_HOME } from '../src/core/config.js';
import {
    classifySecondPromptOutcome,
    type PiRpcVerdict,
    type PiRpcVerdictRecord,
} from '../src/agent/pi-rpc-verdict.js';

const GET_STATE_ID = 1;
const FIRST_PROMPT_ID = 2;
const SECOND_PROMPT_ID = 3;
const THIRD_PROMPT_ID = 4;
const ABORT_ID = 5;
const FIRST_TIMEOUT_MS = 60_000;
const SECOND_TIMEOUT_MS = 30_000;
const ABORT_START_TIMEOUT_MS = 30_000;
const ABORT_TERMINAL_TIMEOUT_MS = 15_000;

type RawRecord = Record<string, unknown>;
type ObservedRecord = { raw: RawRecord; normalized: PiRpcVerdictRecord };
type WaitResult = { matched: boolean; closed: boolean; timedOut: boolean };
type AttemptResult = {
    verdict: PiRpcVerdict;
    abortEffective: boolean;
    firstPromptSucceeded: boolean;
    selfExited: boolean;
    secondTimedOut: boolean;
    recordCount: number;
};

function normalizeRecord(raw: RawRecord): PiRpcVerdictRecord {
    const parsed = parsePiRpcRecord(raw);
    const normalized: PiRpcVerdictRecord = {};
    if (typeof raw['id'] === 'number') normalized.id = raw['id'];
    if (typeof raw['type'] === 'string') normalized.type = raw['type'];
    if (raw['type'] === 'response') {
        if (typeof raw['command'] === 'string') normalized.command = raw['command'];
        if (typeof raw['success'] === 'boolean') normalized.success = raw['success'];
    }
    const error = raw['error'];
    if (error && typeof error === 'object') {
        const message = (error as Record<string, unknown>)['message'];
        normalized.error = typeof message === 'string' ? { message } : {};
    }
    if (parsed.done !== undefined) normalized.done = parsed.done;
    if (parsed.text !== undefined) normalized.text = parsed.text;
    if (raw['type'] === 'agent_end') {
        // user echo 추출 — 모델이 text 파트를 생략하는 비결정성에 강건한 턴 상관 증거
        const messages = raw['messages'];
        if (Array.isArray(messages)) {
            normalized.userEcho = messages
                .filter((entry) => !!entry && typeof entry === 'object' && (entry as Record<string, unknown>)['role'] === 'user')
                .map((entry) => extractProbeText((entry as Record<string, unknown>)['content']))
                .join('');
        }
    }
    return normalized;
}

function extractProbeText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(extractProbeText).join('');
    if (!value || typeof value !== 'object') return '';
    const obj = value as Record<string, unknown>;
    if (obj['type'] === 'thinking') return '';
    return extractProbeText(obj['text']) || extractProbeText(obj['content']) || '';
}

function isSuccessfulStateResponse(record: ObservedRecord): boolean {
    return record.normalized.id === GET_STATE_ID
        && record.raw['type'] === 'response'
        && record.raw['command'] === 'get_state'
        && record.raw['success'] === true;
}

function isGenerationEvent(record: ObservedRecord): boolean {
    const type = record.raw['type'];
    if (type === 'agent_end') return false;
    if (record.normalized.text) return true;
    return typeof type === 'string' && type !== 'response';
}

function isAbortAccepted(record: ObservedRecord): boolean {
    return record.normalized.id === ABORT_ID
        && record.raw['type'] === 'response'
        && record.raw['command'] === 'abort'
        && record.raw['success'] === true;
}

function isTerminalRecord(record: ObservedRecord): boolean {
    if (record.normalized.done) return true;
    const data = record.raw['data'];
    if (!data || typeof data !== 'object') return false;
    const state = data as Record<string, unknown>;
    if (state['running'] === false || state['isRunning'] === false) return true;
    return typeof state['state'] === 'string' && !['running', 'active', 'generating'].includes(state['state'].toLowerCase());
}

class RpcProbeProcess {
    readonly records: ObservedRecord[] = [];
    readonly child: ChildProcessWithoutNullStreams;
    private readonly listeners = new Set<() => void>();
    private buffer = '';
    private readonly decoder = new StringDecoder('utf8');
    private closed = false;
    private closeCode: number | null = null;

    constructor(command: PiCommand, runtimeDir: string) {
        const args = [
            ...command.baseArgs,
            '--mode', 'rpc',
            '--no-context-files',
            '--provider', DEFAULT_PI_PROFILE.id,
            '--model', DEFAULT_PI_PROFILE.model,
            '--api-key', DEFAULT_PI_PROFILE.apiKey || 'dummy',
        ];
        console.log(`[probe:spawn] ${JSON.stringify([command.command, ...args])}`);
        this.child = spawn(command.command, args, {
            cwd: process.cwd(),
            env: { ...process.env, PI_CODING_AGENT_DIR: runtimeDir },
            stdio: ['pipe', 'pipe', 'pipe'],
            ...(process.platform === 'win32' && !command.command.toLowerCase().endsWith('.exe') ? { shell: true } : {}),
        });
        this.child.stdout.on('data', (chunk: Buffer) => this.consumeStdout(chunk));
        this.child.stderr.on('data', (chunk: Buffer) => process.stderr.write(`[probe:stderr] ${chunk.toString()}`));
        this.child.on('error', (error) => {
            console.error(`[probe:error] ${error.message}`);
            this.notify();
        });
        this.child.on('close', (code) => {
            this.buffer += this.decoder.end();
            if (this.buffer.trim()) this.consumeLine(this.buffer.trim());
            this.buffer = '';
            this.closed = true;
            this.closeCode = code;
            console.log(`[probe:close] code=${String(code)}`);
            this.notify();
        });
    }

    get didClose(): boolean { return this.closed; }
    get exitedNormally(): boolean { return this.closed && this.closeCode === 0; }

    send(id: number, type: string, fields: RawRecord = {}): Promise<void> {
        const line = JSON.stringify({ id, type, ...fields });
        console.log(`[probe:send] ${line}`);
        return new Promise((resolve, reject) => {
            if (!this.child.stdin.writable) {
                reject(new Error('pi rpc stdin is not writable'));
                return;
            }
            this.child.stdin.write(`${line}\n`, (error) => error ? reject(error) : resolve());
        });
    }

    async waitFrom(start: number, predicate: (records: ObservedRecord[]) => boolean, timeoutMs: number): Promise<WaitResult> {
        if (predicate(this.records.slice(start))) return { matched: true, closed: this.closed, timedOut: false };
        if (this.closed) return { matched: false, closed: true, timedOut: false };
        return new Promise((resolve) => {
            const finish = (result: WaitResult) => {
                clearTimeout(timer);
                this.listeners.delete(check);
                resolve(result);
            };
            const check = () => {
                if (predicate(this.records.slice(start))) finish({ matched: true, closed: this.closed, timedOut: false });
                else if (this.closed) finish({ matched: false, closed: true, timedOut: false });
            };
            const timer = setTimeout(() => finish({ matched: false, closed: this.closed, timedOut: true }), timeoutMs);
            this.listeners.add(check);
        });
    }

    async stop(): Promise<void> {
        try { this.child.stdin.end(); } catch { /* already closed */ }
        if (this.closed) return;
        if (!this.child.killed) this.child.kill('SIGTERM');
        const stopped = await this.waitFrom(this.records.length, () => false, 2_000);
        if (!stopped.closed) {
            this.child.kill('SIGKILL');
            await this.waitFrom(this.records.length, () => false, 1_000);
        }
    }

    private consumeStdout(chunk: Buffer): void {
        this.buffer += this.decoder.write(chunk);
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) this.consumeLine(line.trim());
    }

    private consumeLine(line: string): void {
        process.stdout.write(`${line}\n`);
        try {
            const raw = JSON.parse(line) as unknown;
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
            this.records.push({ raw: raw as RawRecord, normalized: normalizeRecord(raw as RawRecord) });
            this.notify();
        } catch {
            console.error(`[probe:parse-error] ${line.slice(0, 200)}`);
        }
    }

    private notify(): void {
        for (const listener of [...this.listeners]) listener();
    }
}

async function probeAbort(rpc: RpcProbeProcess): Promise<boolean> {
    if (rpc.didClose) return false;
    const thirdStart = rpc.records.length;
    try {
        await rpc.send(THIRD_PROMPT_ID, 'prompt', { message: 'Write a very long story, at least 2000 words.' });
    } catch (error) {
        console.error(`[probe:abort] third prompt write failed: ${(error as Error).message}`);
        return false;
    }
    const started = await rpc.waitFrom(thirdStart, (records) => records.some(isGenerationEvent), ABORT_START_TIMEOUT_MS);
    if (!started.matched || rpc.didClose) return false;

    const abortStart = rpc.records.length;
    try {
        await rpc.send(ABORT_ID, 'abort');
    } catch (error) {
        console.error(`[probe:abort] abort write failed: ${(error as Error).message}`);
        return false;
    }
    const terminal = await rpc.waitFrom(abortStart, (records) => {
        const accepted = records.some(isAbortAccepted);
        return accepted && records.some(isTerminalRecord);
    }, ABORT_TERMINAL_TIMEOUT_MS);
    return terminal.matched;
}

async function runAttempt(command: PiCommand, attempt: number): Promise<AttemptResult> {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `cli-jaw-pi-rpc-probe-${attempt}-`));
    const runtimeDir = ensurePiRuntimeConfig(DEFAULT_PI_SETTINGS, DEFAULT_PI_PROFILE.id, '', tempRoot);
    const rpc = new RpcProbeProcess(command, runtimeDir);
    let firstPromptSucceeded = false;
    let selfExited = false;
    let secondTimedOut = false;
    let abortEffective = false;
    let secondRecords: ObservedRecord[] = [];
    try {
        const stateStart = rpc.records.length;
        await rpc.send(GET_STATE_ID, 'get_state');
        const state = await rpc.waitFrom(stateStart, (records) => records.some(isSuccessfulStateResponse), 15_000);
        if (!state.matched) {
            return { verdict: 'inconclusive', abortEffective, firstPromptSucceeded, selfExited, secondTimedOut: state.timedOut, recordCount: rpc.records.length };
        }

        const firstStart = rpc.records.length;
        await rpc.send(FIRST_PROMPT_ID, 'prompt', { message: 'Reply with the single token: FIRST' });
        const first = await rpc.waitFrom(firstStart, (records) => records.some((record) => record.normalized.done === true), FIRST_TIMEOUT_MS);
        firstPromptSucceeded = first.matched;

        const secondStart = rpc.records.length;
        if (firstPromptSucceeded) {
            try {
                await rpc.send(SECOND_PROMPT_ID, 'prompt', { message: 'Reply with the single token: SECOND' });
            } catch (error) {
                console.error(`[probe:second] write failed: ${(error as Error).message}`);
                selfExited = rpc.exitedNormally;
            }
            if (!selfExited) {
                const second = await rpc.waitFrom(secondStart, (records) => records.some((record) =>
                    record.normalized.done === true
                    || (record.normalized.id === SECOND_PROMPT_ID && record.normalized.error !== undefined)
                ), SECOND_TIMEOUT_MS);
                secondTimedOut = second.timedOut;
                secondRecords = rpc.records.slice(secondStart);
                if (second.closed && rpc.exitedNormally && !second.matched) selfExited = true;
                if (!secondTimedOut && !rpc.didClose) abortEffective = await probeAbort(rpc);
            }
        }

        const verdict = classifySecondPromptOutcome({
            records: secondRecords.map((record) => record.normalized),
            secondPromptId: SECOND_PROMPT_ID,
            timedOut: secondTimedOut,
            selfExited,
            firstPromptSucceeded,
        });
        if (process.env['PI_RPC_PROBE_DEBUG']) {
            console.error(`[probe:debug] classifier input: ${JSON.stringify({
                firstPromptSucceeded, selfExited, secondTimedOut,
                doneRecords: secondRecords.filter((r) => r.normalized.done).map((r) => r.normalized),
                secondRecordCount: secondRecords.length,
            })}`);
        }
        return { verdict, abortEffective, firstPromptSucceeded, selfExited, secondTimedOut, recordCount: rpc.records.length };
    } catch (error) {
        console.error(`[probe:attempt-${attempt}] ${(error as Error).stack || String(error)}`);
        return { verdict: 'inconclusive', abortEffective, firstPromptSucceeded, selfExited, secondTimedOut, recordCount: rpc.records.length };
    } finally {
        await rpc.stop();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function resolveCommandIdentity(command: PiCommand): string {
    const result = spawnSync(command.command, [...command.baseArgs, '--version'], {
        encoding: 'utf8',
        env: process.env,
        timeout: 15_000,
    });
    const version = `${result.stdout || ''}\n${result.stderr || ''}`.trim() || `exit:${String(result.status)}`;
    return JSON.stringify({ source: command.source, command: command.command, baseArgs: command.baseArgs, version });
}

function writeCapability(commandId: string, result: AttemptResult, attempts: AttemptResult[]): void {
    const targetDir = path.join(JAW_HOME, 'pi');
    const target = path.join(targetDir, 'rpc-capabilities.json');
    const temp = `${target}.${process.pid}.tmp`;
    const evidence = attempts.map((attempt, index) =>
        `attempt=${index + 1},verdict=${attempt.verdict},first=${attempt.firstPromptSucceeded},selfExited=${attempt.selfExited},secondTimedOut=${attempt.secondTimedOut},abort=${attempt.abortEffective},records=${attempt.recordCount}`
    ).join('; ');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify({
        schemaVersion: 1,
        commandId,
        probedAt: new Date().toISOString(),
        profileId: DEFAULT_PI_PROFILE.id,
        abortEffective: result.abortEffective,
        evidence,
    }, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, target);
    console.log(`[probe:capabilities] ${target}`);
}

async function main(): Promise<void> {
    const command = resolvePiCommand();
    const commandId = resolveCommandIdentity(command);
    const attempts: AttemptResult[] = [];
    attempts.push(await runAttempt(command, 1));
    if (attempts[0]?.verdict === 'inconclusive') attempts.push(await runAttempt(command, 2));
    const result = attempts.at(-1);
    if (!result) throw new Error('pi rpc probe produced no result');
    writeCapability(commandId, result, attempts);
    console.log(`[probe:verdict] ${result.verdict} abortEffective=${result.abortEffective}`);
    process.exitCode = result.verdict === 'supported' ? 0 : result.verdict === 'proven-unsupported' ? 1 : 2;
}

void main().catch((error: unknown) => {
    console.error(`[probe:fatal] ${(error as Error).stack || String(error)}`);
    process.exitCode = 2;
});

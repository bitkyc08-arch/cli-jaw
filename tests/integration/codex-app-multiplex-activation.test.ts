import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type {
    CodexAppClientOptions,
    CodexAppScopedTurnHandlers,
    CodexAppTurnHandlers,
    CodexThreadOptions,
} from '../../src/agent/codex-app-client.ts';

const ACTIVATION_ENABLED = process.env['CLI_JAW_CODEX_APP_ACTIVATION'] === '1';
const INITIALIZE_TIMEOUT_MS = 15_000;
const STARTED_TIMEOUT_MS = 60_000;
const INTERRUPT_SETTLE_TIMEOUT_MS = 30_000;
const COMPLETION_TIMEOUT_MS = 180_000;
const RESTART_TIMEOUT_MS = 120_000;
const TEARDOWN_TIMEOUT_MS = 15_000;

type ActivationScope = 'A' | 'B';
type CapturePhase = 'request' | 'response' | 'notification' | 'lifecycle';
type CaptureRecord = {
    sequence: number;
    timestamp: string;
    generation: number;
    pid: number | null;
    scope: string;
    method: string;
    phase: CapturePhase;
    requestId?: number;
    listenerRole?: 'lifecycle' | 'consumer';
    ownerThreadId?: string;
    ownerTurnId?: string;
};

class ActivationEvidence {
    readonly records: CaptureRecord[] = [];
    readonly stderrRecords: CaptureRecord[] = [];
    readonly summary: Record<string, unknown> = { status: 'running' };
    private sequence = 0;
    private requestSequence = 0;

    nextRequestId(): number { return ++this.requestSequence; }

    add(input: Omit<CaptureRecord, 'sequence' | 'timestamp'>): CaptureRecord {
        const record = { sequence: ++this.sequence, timestamp: new Date().toISOString(), ...input };
        this.records.push(record);
        return record;
    }

    addStderr(input: Omit<CaptureRecord, 'sequence' | 'timestamp'>): void {
        const record = { sequence: ++this.sequence, timestamp: new Date().toISOString(), ...input };
        this.stderrRecords.push(record);
    }

    write(directory: string): void {
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'activation.jsonl'), this.records.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
        writeFileSync(join(directory, 'summary.json'), JSON.stringify(this.summary, null, 2) + '\n');
        writeFileSync(join(directory, 'stderr.log'), this.stderrRecords.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    }
}

function activationArtifactDir(): string {
    const configured = process.env['CLI_JAW_CODEX_APP_ACTIVATION_ARTIFACT_DIR'];
    const directory = configured ? resolve(configured) : mkdtempSync(join(tmpdir(), 'cli-jaw-codex-app-activation-'));
    const devlog = resolve(import.meta.dirname, '../../devlog');
    const fromDevlog = relative(devlog, directory);
    if (fromDevlog === '' || (!fromDevlog.startsWith(`..${sep}`) && !isAbsolute(fromDevlog))) {
        throw new Error('Activation artifacts must not be written under devlog/');
    }
    return directory;
}

function hasCodexAuthentication(): boolean {
    const codexHome = process.env['CODEX_HOME'] ? resolve(process.env['CODEX_HOME']) : join(homedir(), '.codex');
    try {
        const parsed = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf8')) as Record<string, unknown>;
        const tokens = parsed['tokens'];
        const accessToken = tokens && typeof tokens === 'object'
            ? (tokens as Record<string, unknown>)['access_token']
            : null;
        return (typeof accessToken === 'string' && accessToken.length > 0)
            || (typeof parsed['OPENAI_API_KEY'] === 'string' && parsed['OPENAI_API_KEY'].length > 0);
    } catch {
        return false;
    }
}

async function bounded<T>(pending: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`${label} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    });
    try {
        return await Promise.race([pending, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`${label} timed out after ${timeoutMs}ms`);
        await new Promise<void>((done) => { setTimeout(done, 20); });
    }
}

async function terminateProcess(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit').then(() => undefined);
    child.kill('SIGTERM');
    try {
        await bounded(exited, 10_000, 'generation process exit');
    } catch {
        child.kill('SIGKILL');
        await bounded(exited, 5_000, 'generation process SIGKILL exit');
    }
}

test('real codex-app multiplex keeps two scoped turns isolated across cancel and restart', {
    skip: !ACTIVATION_ENABLED,
    timeout: 480_000,
}, async (t) => {
    const { detectCli } = await import('../../src/core/cli-detection.ts');
    const detected = detectCli('codex-app');
    assert.ok(detected.available && detected.path, 'codex binary is required for activation');
    const version = execFileSync(detected.path, ['--version'], {
        encoding: 'utf8', timeout: INITIALIZE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    assert.equal(version, 'codex-cli 0.146.0', 'activation requires codex-cli 0.146.0');
    if (!hasCodexAuthentication()) {
        t.skip('Codex authentication is absent from the current CODEX_HOME');
        return;
    }

    const artifactDir = activationArtifactDir();
    const evidence = new ActivationEvidence();
    const clients: CapturingCodexAppClient[] = [];
    const pendingRuns: Array<Promise<unknown>> = [];
    const scopeKeyByLane = new Map<string, string>();
    const startedProcesses = new Map<string, ChildProcess | null>();
    let generationSequence = 0;
    let activeProcessForScope: ((scopeKey: string) => ChildProcess | null) | null = null;
    let shutdownHostPool: ((options: { deadlineAt: number; reserveMs?: number; reason?: string }) => Promise<void>) | null = null;
    let killScope: ((scopeKey: string, reason: string) => boolean) | null = null;

    const realClient = await import('../../src/agent/codex-app-client.ts');
    class CapturingCodexAppClient extends realClient.CodexAppClient {
        readonly activationGeneration = ++generationSequence;
        private readonly listenerCounts = new Map<string, number>();

        constructor(options: CodexAppClientOptions = {}) {
            super(options);
            clients.push(this);
            evidence.add({ generation: this.activationGeneration, pid: null, scope: 'host', method: 'client/create', phase: 'lifecycle' });
        }

        override spawn(): void {
            super.spawn();
            const pid = this.proc?.pid ?? null;
            evidence.add({ generation: this.activationGeneration, pid, scope: 'host', method: 'process/spawn', phase: 'lifecycle' });
            this.proc?.once('exit', () => {
                evidence.add({ generation: this.activationGeneration, pid, scope: 'host', method: 'process/exit', phase: 'lifecycle' });
            });
        }

        override async initialize(): Promise<unknown> {
            const requestId = evidence.nextRequestId();
            this.capture('host', 'initialize', 'request', requestId);
            const result = await bounded(super.initialize(), INITIALIZE_TIMEOUT_MS, 'codex app-server initialize');
            this.capture('host', 'initialize', 'response', requestId);
            return result;
        }

        override async startThread(
            scopeOrOptions: string | Partial<CodexThreadOptions> = {},
            scopedOptions?: CodexThreadOptions,
        ): Promise<string> {
            const scope = typeof scopeOrOptions === 'string' ? scopeOrOptions : 'legacy/default';
            const requestId = evidence.nextRequestId();
            this.capture(scope, 'thread/start', 'request', requestId);
            const threadId = typeof scopeOrOptions === 'string'
                ? await super.startThread(scopeOrOptions, scopedOptions!)
                : await super.startThread(scopeOrOptions);
            this.capture(scope, 'thread/start', 'response', requestId, threadId);
            return threadId;
        }

        override async resumeThread(
            scopeOrThreadId: string,
            threadIdOrOptions: string | Partial<CodexThreadOptions> = {},
            scopedOptions?: CodexThreadOptions,
        ): Promise<string> {
            const scoped = typeof threadIdOrOptions === 'string';
            const scope = scoped ? scopeOrThreadId : 'legacy/default';
            const requestedThreadId = scoped ? threadIdOrOptions : scopeOrThreadId;
            const requestId = evidence.nextRequestId();
            this.capture(scope, 'thread/resume', 'request', requestId, requestedThreadId);
            const threadId = scoped
                ? await super.resumeThread(scopeOrThreadId, threadIdOrOptions, scopedOptions!)
                : await super.resumeThread(scopeOrThreadId, threadIdOrOptions);
            this.capture(scope, 'thread/resume', 'response', requestId, threadId);
            return threadId;
        }

        override async startTurn(scopeOrPrompt: string, scopedPrompt?: string): Promise<void> {
            const scope = scopedPrompt === undefined ? 'legacy/default' : scopeOrPrompt;
            const requestId = evidence.nextRequestId();
            this.capture(scope, 'turn/start', 'request', requestId);
            if (scopedPrompt === undefined) await super.startTurn(scopeOrPrompt);
            else await super.startTurn(scopeOrPrompt, scopedPrompt);
            this.capture(scope, 'turn/start', 'response', requestId);
        }

        override async interruptTurn(scope?: string): Promise<void> {
            const laneScope = scope ?? 'legacy/default';
            const requestId = evidence.nextRequestId();
            this.capture(laneScope, 'turn/interrupt', 'request', requestId,
                this.getThreadId(laneScope) ?? undefined, this.getActiveTurnId(laneScope) ?? undefined);
            if (scope === undefined) await super.interruptTurn();
            else await super.interruptTurn(scope);
            this.capture(laneScope, 'turn/interrupt', 'response', requestId);
        }

        override listenTurn(handlers: CodexAppTurnHandlers): { dispose(): void };
        override listenTurn(scope: string, handlers: CodexAppScopedTurnHandlers): { dispose(): void };
        override listenTurn(
            scopeOrHandlers: string | CodexAppTurnHandlers,
            scopedHandlers?: CodexAppScopedTurnHandlers,
        ): { dispose(): void } {
            const scope = typeof scopeOrHandlers === 'string' ? scopeOrHandlers : 'legacy/default';
            const handlers = typeof scopeOrHandlers === 'string' ? scopedHandlers! : scopeOrHandlers;
            const count = (this.listenerCounts.get(scope) ?? 0) + 1;
            this.listenerCounts.set(scope, count);
            const listenerRole = typeof scopeOrHandlers === 'string'
                ? scopedHandlers!.role
                : count === 1 ? 'lifecycle' as const : 'consumer' as const;
            const wrapped: CodexAppTurnHandlers = {
                ...handlers,
                onNotification: (method, params, owner) => {
                    if (method === 'turn/started') {
                        const scopeKey = scopeKeyByLane.get(scope);
                        if (scopeKey) startedProcesses.set(
                            `${this.activationGeneration}:${scope}`,
                            activeProcessForScope?.(scopeKey) ?? null,
                        );
                    }
                    evidence.add({
                        generation: this.activationGeneration,
                        pid: this.proc?.pid ?? null,
                        scope,
                        method,
                        phase: 'notification',
                        listenerRole,
                        ...(owner?.threadId ? { ownerThreadId: owner.threadId } : {}),
                        ...(owner?.turnId ? { ownerTurnId: owner.turnId } : {}),
                    });
                    handlers.onNotification(method, params, owner);
                },
                onStderr: (text) => {
                    evidence.addStderr({ generation: this.activationGeneration, pid: this.proc?.pid ?? null,
                        scope, method: 'stderr', phase: 'notification', listenerRole });
                    handlers.onStderr(text);
                },
            };
            return typeof scopeOrHandlers === 'string'
                ? super.listenTurn(scopeOrHandlers, { ...wrapped, role: scopedHandlers!.role })
                : super.listenTurn(wrapped);
        }

        private capture(
            scope: string,
            method: string,
            phase: Exclude<CapturePhase, 'notification'>,
            requestId: number,
            ownerThreadId?: string,
            ownerTurnId?: string,
        ): void {
            evidence.add({
                generation: this.activationGeneration,
                pid: this.proc?.pid ?? null,
                scope,
                method,
                phase,
                requestId,
                ...(ownerThreadId ? { ownerThreadId } : {}),
                ...(ownerTurnId ? { ownerTurnId } : {}),
            });
        }
    }

    t.mock.module('../../src/agent/codex-app-client.js', {
        namedExports: { ...realClient, CodexAppClient: CapturingCodexAppClient },
    });

    try {
        const { settings } = await import('../../src/core/config.ts');
        const { getSessionBucket } = await import('../../src/core/db.ts');
        const { resolveCodexAppLaneKey, resolveScopedSessionBucket } = await import('../../src/agent/args.ts');
        const hostPool = await import('../../src/agent/codex-host-pool.ts');
        const spawn = await import('../../src/agent/spawn.ts');
        shutdownHostPool = hostPool.shutdownCodexAppHostPool;
        killScope = spawn.killActiveAgent;
        activeProcessForScope = (scopeKey) => spawn.activeMainProcesses.get(scopeKey)?.process ?? null;

        const scopeKeys = { A: 'codex-app-activation-a', B: 'codex-app-activation-b' } as const;
        const model = 'gpt-5.5';
        const effort = 'low';
        const workingDir = process.env['CLI_JAW_HOME']!;
        // The prompt builder writes B.md on every fresh spawn and does not create
        // its own directory, so an isolated home needs it before the first run.
        mkdirSync(join(workingDir, 'prompts'), { recursive: true });
        settings['cli'] = 'codex-app';
        settings['model'] = model;
        settings['workingDir'] = workingDir;
        settings['fallbackOrder'] = [];
        settings['activeOverrides'] = {};
        settings['perCli'] = { ...settings['perCli'], 'codex-app': { model, effort } };
        settings['multiSession'] = {
            enabled: true,
            maxConcurrent: 4,
            midRunPolicy: 'steer',
            channels: { telegram: true, discord: true, slack: true },
        };
        settings['runtime'] = {
            ...settings['runtime'],
            codexApp: { ...settings['runtime']?.codexApp, multiplex: true },
        };
        process.env['CODEX_APP_ACQUIRE_WAIT_MS'] = String(STARTED_TIMEOUT_MS);
        process.env['CODEX_APP_TURN_IDLE_MS'] = String(COMPLETION_TIMEOUT_MS);
        process.env['CODEX_APP_TURN_ABS_MS'] = String(COMPLETION_TIMEOUT_MS);

        const lanes = {
            A: resolveCodexAppLaneKey(scopeKeys.A, model, effort, 'fallback'),
            B: resolveCodexAppLaneKey(scopeKeys.B, model, effort, 'fallback'),
        };
        scopeKeyByLane.set(lanes.A, scopeKeys.A);
        scopeKeyByLane.set(lanes.B, scopeKeys.B);
        const buckets = {
            A: resolveScopedSessionBucket('codex-app', model, 'codex-app', scopeKeys.A, effort, 'fallback'),
            B: resolveScopedSessionBucket('codex-app', model, 'codex-app', scopeKeys.B, effort, 'fallback'),
        };
        const marker = { A: 'ACTIVATION_SCOPE_A_OK', B: 'ACTIVATION_SCOPE_B_OK' } as const;
        // A model may wrap or bullet its answer, so the marker can arrive split
        // across lines. What matters is which scope's marker came back, not how
        // it was formatted, so compare against text with the noise removed.
        const carries = (text: string, value: string): boolean =>
            text.replace(/[\s\-*_`]+/g, '').includes(value.replace(/_/g, ''));
        const spawnRun = (scope: ActivationScope, prompt: string) => {
            const run = spawn.spawnAgent(prompt, {
                cli: 'codex-app', model, effort, scopeKey: scopeKeys[scope],
                chatSessionId: `activation-chat-${scope.toLowerCase()}`,
                origin: 'activation', _skipInsert: true, _skipHistory: true,
            });
            pendingRuns.push(run.promise);
            return run;
        };
        const consumerRecords = (generation: number, scope: ActivationScope, method?: string) => evidence.records.filter((entry) =>
            entry.generation === generation && entry.scope === lanes[scope] && entry.listenerRole === 'consumer'
            && entry.phase === 'notification' && (!method || entry.method === method));
        const sessionId = (bucket: string): string => {
            const row = getSessionBucket.get(bucket) as { session_id?: unknown } | undefined;
            const value = row?.session_id;
            if (typeof value !== 'string') assert.fail(`missing persisted session for ${bucket}`);
            return value;
        };

        const firstA = spawnRun('A', `Do not use tools. Carefully reason through a long checklist, then reply with exactly ${marker.A}.`);
        const firstB = spawnRun('B', `Do not use tools. Carefully verify your answer, then reply with exactly ${marker.B}.`);
        await waitFor(() => consumerRecords(1, 'A', 'turn/started').length > 0
            && consumerRecords(1, 'B', 'turn/started').length > 0, STARTED_TIMEOUT_MS, 'two initial turn/started notifications');

        assert.equal(clients.length, 1, 'initial A/B must create one client');
        const firstClient = clients[0]!;
        const firstProcessA = startedProcesses.get(`1:${lanes.A}`);
        const firstProcessB = startedProcesses.get(`1:${lanes.B}`);
        assert.ok(firstProcessA && firstProcessB);
        assert.equal(firstProcessA, firstProcessB);
        assert.equal(firstProcessA, firstClient.proc);
        assert.equal(firstProcessA.pid, firstProcessB.pid);
        assert.equal(evidence.records.filter((entry) => entry.generation === 1 && entry.method === 'process/spawn').length, 1);
        const firstStartedA = consumerRecords(1, 'A', 'turn/started')[0]!;
        const firstStartedB = consumerRecords(1, 'B', 'turn/started')[0]!;
        assert.ok(firstStartedA.ownerThreadId && firstStartedA.ownerTurnId);
        assert.ok(firstStartedB.ownerThreadId && firstStartedB.ownerTurnId);
        assert.notEqual(firstStartedA.ownerThreadId, firstStartedB.ownerThreadId);
        assert.notEqual(firstStartedA.ownerTurnId, firstStartedB.ownerTurnId);
        assert.equal(firstClient.getActiveTurnId(lanes.A), firstStartedA.ownerTurnId);
        assert.equal(firstClient.getActiveTurnId(lanes.B), firstStartedB.ownerTurnId);
        assert.equal(consumerRecords(1, 'A', 'turn/completed').length + consumerRecords(1, 'B', 'turn/completed').length, 0,
            'both turns must be active before the first completion');

        assert.equal(spawn.killActiveAgent(scopeKeys.A, 'interrupt'), true);
        const firstASettled = bounded(firstA.promise, INTERRUPT_SETTLE_TIMEOUT_MS, 'A interrupt settle');
        const firstBSettled = bounded(firstB.promise, COMPLETION_TIMEOUT_MS, 'B completion');
        const [, firstBResult] = await Promise.all([firstASettled, firstBSettled]);
        assert.equal(firstBResult.code, 0);
        assert.ok(carries(firstBResult.text, marker.B), firstBResult.text);
        assert.ok(!carries(firstBResult.text, marker.A), firstBResult.text);

        const interrupts = evidence.records.filter((entry) => entry.generation === 1
            && entry.method === 'turn/interrupt' && entry.phase === 'request');
        assert.equal(interrupts.length, 1);
        assert.equal(interrupts[0]?.scope, lanes.A);
        assert.equal(interrupts[0]?.ownerThreadId, firstStartedA.ownerThreadId);
        assert.equal(interrupts[0]?.ownerTurnId, firstStartedA.ownerTurnId);
        assert.equal(consumerRecords(1, 'B', 'turn/completed').length, 1);
        assert.equal(consumerRecords(1, 'B', 'turn/completed')[0]?.pid, firstProcessB.pid);

        const firstThreads = { A: sessionId(buckets.A), B: sessionId(buckets.B) };
        assert.equal(firstThreads.A, firstStartedA.ownerThreadId);
        assert.equal(firstThreads.B, firstStartedB.ownerThreadId);
        const firstPid = firstClient.proc?.pid ?? null;
        assert.ok(firstClient.proc);
        await terminateProcess(firstClient.proc);
        await waitFor(() => hostPool.codexAppHostPoolStats().hosts === 0, INITIALIZE_TIMEOUT_MS, 'old host invalidation');

        const restartDeadline = Date.now() + RESTART_TIMEOUT_MS;
        const secondA = spawnRun('A', `Do not use tools. Reply with exactly ${marker.A}.`);
        const secondB = spawnRun('B', `Do not use tools. Reply with exactly ${marker.B}.`);
        await waitFor(() => consumerRecords(2, 'A', 'turn/started').length > 0
            && consumerRecords(2, 'B', 'turn/started').length > 0,
            Math.min(STARTED_TIMEOUT_MS, Math.max(1, restartDeadline - Date.now())), 'two resumed turn/started notifications');
        assert.equal(clients.length, 2, 'restart A/B must create exactly one replacement client');
        const secondClient = clients[1]!;
        const secondProcessA = startedProcesses.get(`2:${lanes.A}`);
        const secondProcessB = startedProcesses.get(`2:${lanes.B}`);
        assert.ok(secondProcessA && secondProcessB);
        assert.equal(secondProcessA, secondProcessB);
        assert.equal(secondProcessA, secondClient.proc);
        assert.notEqual(secondProcessA.pid, firstPid);
        assert.equal(evidence.records.filter((entry) => entry.generation === 2 && entry.method === 'process/spawn').length, 1);

        const resumed = evidence.records.filter((entry) => entry.generation === 2
            && entry.method === 'thread/resume' && entry.phase === 'response');
        assert.equal(resumed.length, 2);
        assert.deepEqual(new Set(resumed.map((entry) => `${entry.scope}:${entry.ownerThreadId}`)), new Set([
            `${lanes.A}:${firstThreads.A}`, `${lanes.B}:${firstThreads.B}`,
        ]));
        assert.equal(evidence.records.filter((entry) => entry.generation === 2
            && entry.method === 'thread/start' && entry.phase === 'response').length, 0,
        'restart must resume both persisted threads without fresh-thread fallback');

        const [secondAResult, secondBResult] = await bounded(
            Promise.all([secondA.promise, secondB.promise]), Math.max(1, restartDeadline - Date.now()),
            'restart and two resumed completions');
        assert.equal(secondAResult.code, 0);
        assert.equal(secondBResult.code, 0);
        assert.ok(carries(secondAResult.text, marker.A), secondAResult.text);
        assert.ok(!carries(secondAResult.text, marker.B), secondAResult.text);
        assert.ok(carries(secondBResult.text, marker.B), secondBResult.text);
        assert.ok(!carries(secondBResult.text, marker.A), secondBResult.text);
        assert.equal(sessionId(buckets.A), firstThreads.A);
        assert.equal(sessionId(buckets.B), firstThreads.B);

        const secondStarted = {
            A: consumerRecords(2, 'A', 'turn/started')[0]!,
            B: consumerRecords(2, 'B', 'turn/started')[0]!,
        };
        for (const scope of ['A', 'B'] as const) {
            const records = consumerRecords(2, scope);
            assert.ok(records.length > 0);
            for (const record of records) {
                assert.equal(record.ownerThreadId, firstThreads[scope], `${scope} received another bucket's thread`);
                if (record.ownerTurnId) assert.equal(record.ownerTurnId, secondStarted[scope].ownerTurnId,
                    `${scope} received another turn's notification`);
            }
        }

        const firstCompletion = evidence.records.find((entry) => entry.generation === 1
            && entry.phase === 'notification' && entry.listenerRole === 'consumer' && entry.method === 'turn/completed');
        assert.ok(firstCompletion);
        evidence.summary['status'] = 'passed';
        evidence.summary['oldPid'] = firstPid;
        evidence.summary['newPid'] = secondClient.proc?.pid ?? null;
        evidence.summary['generation'] = { old: 1, next: 2 };
        evidence.summary['scopes'] = {
            A: { bucketKey: buckets.A, threadId: firstThreads.A,
                turnIds: { initial: firstStartedA.ownerTurnId, resumed: secondStarted.A.ownerTurnId } },
            B: { bucketKey: buckets.B, threadId: firstThreads.B,
                turnIds: { initial: firstStartedB.ownerTurnId, resumed: secondStarted.B.ownerTurnId } },
        };
        evidence.summary['overlap'] = {
            startedAt: [firstStartedA, firstStartedB].sort((a, b) => b.sequence - a.sequence)[0]!.timestamp,
            endedAt: firstCompletion.timestamp,
        };
        evidence.summary['interrupt'] = {
            scope: 'A', ownerThreadId: interrupts[0]!.ownerThreadId, ownerTurnId: interrupts[0]!.ownerTurnId,
        };
        evidence.summary['resumeRequestIds'] = resumed.map((entry) => entry.requestId);
        evidence.summary['timeouts'] = {
            initialize: { budgetMs: INITIALIZE_TIMEOUT_MS, passed: true },
            started: { budgetMs: STARTED_TIMEOUT_MS, passed: true },
            interruptSettle: { budgetMs: INTERRUPT_SETTLE_TIMEOUT_MS, passed: true },
            completion: { budgetMs: COMPLETION_TIMEOUT_MS, passed: true },
            restart: { budgetMs: RESTART_TIMEOUT_MS, passed: true },
            total: { budgetMs: 480_000, passed: true },
        };
        evidence.summary['isolation'] = { output: true, notification: true, persistence: true };
    } finally {
        if (evidence.summary['status'] !== 'passed') evidence.summary['status'] = 'failed';
        for (const scope of ['codex-app-activation-a', 'codex-app-activation-b']) killScope?.(scope, 'interrupt');
        if (shutdownHostPool) {
            await bounded(shutdownHostPool({ deadlineAt: Date.now() + 10_000, reserveMs: 2_000,
                reason: 'activation test teardown' }), TEARDOWN_TIMEOUT_MS, 'activation host-pool teardown');
        }
        for (const client of clients) {
            if (client.proc && client.proc.exitCode === null && client.proc.signalCode === null) client.proc.kill('SIGKILL');
        }
        await bounded(Promise.allSettled(pendingRuns), TEARDOWN_TIMEOUT_MS, 'activation run teardown').catch(() => {});
        evidence.write(artifactDir);
    }
});

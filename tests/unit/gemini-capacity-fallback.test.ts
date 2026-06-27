import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { classifyExitError } from '../../src/agent/error-classifier.ts';
import { handleAgentExit, setSpawnAgent } from '../../src/agent/lifecycle-handler.ts';
import { shouldPersistMainSession } from '../../src/agent/session-persistence.ts';
import { addBroadcastListener, clearAllBroadcastListeners } from '../../src/core/bus.ts';
import { settings } from '../../src/core/config.ts';
import { clearEmployeeSession, getEmployeeSession, upsertEmployeeSession } from '../../src/core/db.ts';
import { clearErrors, recordError } from '../../src/agent/alert-escalation.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSrc(rel: string): string {
    return fs.readFileSync(join(__dirname, rel), 'utf8');
}

function baseExitParams(overrides: Record<string, any> = {}) {
    let resolved: any = null;
    let queued = false;
    const params = {
        ctx: {
            fullText: 'done',
            sessionId: null,
            toolLog: [],
            traceLog: [],
            stderrBuf: '',
        },
        code: 0,
        cli: 'grok',
        model: 'grok-build',
        resumeKey: null,
        agentLabel: 'main',
        mainManaged: true,
        origin: 'test',
        prompt: 'test',
        opts: {},
        cfg: { effort: '' },
        ownerGeneration: 0,
        forceNew: false,
        empSid: null,
        isResume: false,
        wasKilled: false,
        wasSteer: false,
        smokeResult: { isSmoke: false, confidence: 'low' },
        effortDefault: '',
        costLine: '',
        resolve: (value: any) => { resolved = value; },
        activeProcesses: new Map(),
        setActiveProcess: () => {},
        retryState: {
            timer: null,
            resolve: null,
            origin: null,
            setTimer: () => {},
            setResolve: () => {},
            setOrigin: () => {},
            setIsEmployee: () => {},
        },
        fallbackState: new Map(),
        fallbackMaxRetries: 3,
        processQueue: () => { queued = true; },
        ...overrides,
    };
    return { params, getResolved: () => resolved, wasQueued: () => queued };
}

function installFakeGrokTraceExporter(sessionId: string, chatHistoryJsonl: string): { binDir: string; cleanup: () => void } {
    const root = fs.mkdtempSync(join(tmpdir(), 'jaw-grok-trace-'));
    const traceDir = join(root, sessionId);
    const binDir = join(root, 'bin');
    const archivePath = join(root, 'trace.tar.gz');
    fs.mkdirSync(traceDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(join(traceDir, 'chat_history.jsonl'), chatHistoryJsonl);
    execFileSync('tar', ['-czf', archivePath, '-C', root, sessionId]);
    const script = [
        '#!/bin/sh',
        `printf '%s\\n' '${JSON.stringify({ local_path: archivePath })}'`,
    ].join('\n');
    fs.writeFileSync(join(binDir, 'grok'), script);
    fs.chmodSync(join(binDir, 'grok'), 0o755);
    return {
        binDir,
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
}

test('Gemini capacity classifier separates MODEL_CAPACITY_EXHAUSTED from auth/quota', () => {
    const result = classifyExitError(
        'gemini',
        1,
        'Attempt 1 failed with status 429',
        undefined,
        'MODEL_CAPACITY_EXHAUSTED: No capacity available for model gemini-3.1-pro-preview',
    );

    assert.equal(result.is429, true);
    assert.equal(result.isModelCapacity, true);
    assert.equal(result.isAuth, false);
    assert.match(result.message, /capacity/);
});

test('Claude rate-limit text is not classified as Jaw-level 429 retry', () => {
    for (const cli of ['claude', 'claude-e', 'ai-e']) {
        const result = classifyExitError(
            cli,
            1,
            '429 Too Many Requests: Claude is rate limited and retrying',
        );

        assert.equal(result.is429, false, `${cli} should let Claude own rate-limit pacing`);
        assert.equal(result.isClaudeRateLimit, true);
        assert.match(result.message, /429 Too Many Requests/);
    }
});

test('watchdog kill broadcasts its stall reason instead of resolving as a generic no-response', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    clearAllBroadcastListeners();
    addBroadcastListener((type, data) => events.push({ type, data }));

    try {
        const reason = 'unsafe AGY run_command broad home search (conversation test-run)';
        const { params, getResolved, wasQueued } = baseExitParams({
            code: 124,
            cli: 'agy',
            model: 'gemini-3.5-flash',
            wasKilled: true,
            ctx: {
                fullText: '',
                sessionId: null,
                toolLog: [],
                traceLog: [],
                stderrBuf: '',
                stallReason: reason,
            },
        });

        await handleAgentExit(params as any);

        const done = events.find(event => event.type === 'agent_done');
        assert.ok(done);
        assert.equal(done.data["error"], true);
        assert.match(String(done.data["text"]), /unsafe AGY run_command broad home search/);
        assert.match(getResolved().diagnostic, /unsafe AGY run_command broad home search/);
        assert.equal(wasQueued(), true);
    } finally {
        clearAllBroadcastListeners();
    }
});

test('Claude rate-limit retry is restored but fallback is suppressed', () => {
    const lifecycle = readSrc('../../src/agent/lifecycle-handler.ts');
    assert.match(lifecycle, /const\s+suppressClaudeRateLimitFallback\s*=\s*isClaudeRateLimit/);
    assert.match(lifecycle, /const\s+effectiveIs429\s*=\s*is429\s*\|\|\s*isClaudeRateLimit/);
    assert.match(lifecycle, /effectiveIs429\s*&&\s*mainAttempt\s*<\s*MAIN_MAX_RETRIES/);
    assert.match(lifecycle, /!\s*suppressClaudeRateLimitFallback\)\s*\{/);
});

test('Claude rate-limit process exit broadcasts retry but suppresses fallback', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const originalFallbackOrder = settings["fallbackOrder"];
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    clearErrors('claude');
    clearAllBroadcastListeners();
    addBroadcastListener((type, data) => events.push({ type, data }));
    settings["fallbackOrder"] = ['node'];

    try {
        await handleAgentExit({
            ctx: {
                fullText: '',
                sessionId: null,
                toolLog: [],
                traceLog: [],
                stderrBuf: '429 Too Many Requests: Claude is rate limited and retrying',
            },
            code: 1,
            cli: 'claude',
            model: 'claude-sonnet',
            resumeKey: null,
            agentLabel: 'main',
            mainManaged: true,
            origin: 'test',
            prompt: 'test',
            opts: {},
            cfg: { effort: '' },
            ownerGeneration: 0,
            forceNew: false,
            empSid: null,
            isResume: false,
            wasKilled: false,
            wasSteer: false,
            smokeResult: { isSmoke: false, confidence: 'low' },
            effortDefault: 'medium',
            costLine: '',
            resolve: () => {},
            activeProcesses: new Map(),
            setActiveProcess: () => {},
            retryState: {
                timer: null,
                resolve: null,
                origin: null,
                setTimer: (t: any) => { retryTimer = t; },
                setResolve: () => {},
                setOrigin: () => {},
                setIsEmployee: () => {},
            },
            fallbackState: new Map(),
            fallbackMaxRetries: 3,
            processQueue: () => {},
        });

        assert.ok(events.some(event => event.type === 'agent_retry'), 'Claude 429 exit should trigger same-engine retry');
        assert.equal(events.some(event => event.type === 'agent_fallback'), false, 'Claude 429 exit should NOT trigger fallback');
        const retryEvent = events.find(event => event.type === 'agent_retry');
        const retryDelay = retryEvent?.data["delay"] as number;
        assert.ok(retryDelay >= 3 && retryDelay <= 5, `backoff delay should be 3-5s on first attempt, got ${retryDelay}`);
    } finally {
        if (retryTimer) clearTimeout(retryTimer);
        settings["fallbackOrder"] = originalFallbackOrder;
        clearErrors('claude');
        clearAllBroadcastListeners();
    }
});

test('ai-e error classification uses effective provider, not selector name', async () => {
    let resolved: any = null;
    clearAllBroadcastListeners();
    try {
        await handleAgentExit({
            ctx: {
                fullText: '',
                sessionId: null,
                toolLog: [],
                traceLog: [],
                stderrBuf: '429 Too Many Requests',
            },
            code: 1,
            cli: 'ai-e',
            effectiveProvider: 'codex',
            model: 'gpt-5.4',
            resumeKey: null,
            agentLabel: 'main',
            mainManaged: true,
            origin: 'test',
            prompt: 'test',
            opts: { _retryAttempt: 3 },
            cfg: { effort: '' },
            ownerGeneration: 0,
            forceNew: false,
            empSid: null,
            isResume: false,
            wasKilled: false,
            wasSteer: false,
            smokeResult: { isSmoke: false, confidence: 'low' },
            effortDefault: 'medium',
            costLine: '',
            resolve: (value: any) => { resolved = value; },
            activeProcesses: new Map(),
            setActiveProcess: () => {},
            retryState: {
                timer: null,
                resolve: null,
                origin: null,
                setTimer: () => {},
                setResolve: () => {},
                setOrigin: () => {},
                setIsEmployee: () => {},
            },
            fallbackState: new Map(),
            fallbackMaxRetries: 3,
            processQueue: () => {},
        });

        assert.ok(resolved);
        assert.equal(resolved.code, 1);
        assert.match(resolved.diagnostic, /API 용량 초과/);
    } finally {
        clearAllBroadcastListeners();
    }
});

test('ai-e Claude provider triggers same-engine retry but suppresses fallback on 429', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    clearAllBroadcastListeners();
    addBroadcastListener((type, data) => events.push({ type, data }));
    try {
        await handleAgentExit({
            ctx: {
                fullText: '',
                sessionId: null,
                toolLog: [],
                traceLog: [],
                stderrBuf: '429 Too Many Requests: Claude is rate limited and retrying',
            },
            code: 1,
            cli: 'ai-e',
            effectiveProvider: 'claude',
            model: 'sonnet',
            resumeKey: null,
            agentLabel: 'main',
            mainManaged: true,
            origin: 'test',
            prompt: 'test',
            opts: {},
            cfg: { effort: '' },
            ownerGeneration: 0,
            forceNew: false,
            empSid: null,
            isResume: false,
            wasKilled: false,
            wasSteer: false,
            smokeResult: { isSmoke: false, confidence: 'low' },
            effortDefault: 'medium',
            costLine: '',
            resolve: () => {},
            activeProcesses: new Map(),
            setActiveProcess: () => {},
            retryState: {
                timer: null,
                resolve: null,
                origin: null,
                setTimer: (t: any) => { retryTimer = t; },
                setResolve: () => {},
                setOrigin: () => {},
                setIsEmployee: () => {},
            },
            fallbackState: new Map(),
            fallbackMaxRetries: 3,
            processQueue: () => {},
        });

        assert.ok(events.some(event => event.type === 'agent_retry'), 'ai-e+claude 429 should trigger same-engine retry');
        assert.equal(events.some(event => event.type === 'agent_fallback'), false, 'ai-e+claude 429 should NOT trigger fallback');
    } finally {
        if (retryTimer) clearTimeout(retryTimer);
        clearAllBroadcastListeners();
    }
});

test('Grok successful lifecycle backfills omitted tool events before agent_done', async () => {
    const sessionId = 'grok-trace-test-session';
    const fake = installFakeGrokTraceExporter(sessionId, [
        JSON.stringify({ type: 'assistant', tool_calls: [{ id: 'call-1', name: 'run_terminal_command', arguments: { command: 'pwd' } }] }),
        JSON.stringify({ type: 'tool_result', tool_call_id: 'call-1', content: 'exit: 0\n/Users/jun\n' }),
    ].join('\n'));
    const originalPath = process.env["PATH"];
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    clearAllBroadcastListeners();
    addBroadcastListener((type, data) => events.push({ type, data }));

    try {
        process.env["PATH"] = `${fake.binDir}:${originalPath || ''}`;
        const { params, getResolved } = baseExitParams({
            ctx: {
                fullText: 'done',
                sessionId,
                toolLog: [],
                traceLog: [],
                stderrBuf: '',
            },
        });
        await handleAgentExit(params as any);

        const resolved = getResolved();
        assert.equal(resolved.tools.length, 1);
        assert.equal(resolved.tools[0].stepRef, 'grok:tool:call-1');
        const done = events.find(event => event.type === 'agent_done');
        assert.ok(done);
        const toolLog = done.data["toolLog"] as Array<Record<string, unknown>>;
        assert.equal(toolLog[0]?.["label"], 'run_terminal_command');
        assert.equal(toolLog[0]?.["status"], 'done');
    } finally {
        process.env["PATH"] = originalPath;
        clearAllBroadcastListeners();
        fake.cleanup();
    }
});

test('ai-e Grok lifecycle uses effective provider for trace backfill', async () => {
    const sessionId = 'aie-grok-trace-test-session';
    const fake = installFakeGrokTraceExporter(sessionId, [
        JSON.stringify({ type: 'assistant', tool_calls: [{ id: 'call-aie', name: 'run_terminal_command', arguments: { command: 'pwd' } }] }),
        JSON.stringify({ type: 'tool_result', tool_call_id: 'call-aie', content: 'exit: 0\n/Users/jun\n' }),
    ].join('\n'));
    const originalPath = process.env["PATH"];
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    clearAllBroadcastListeners();
    addBroadcastListener((type, data) => events.push({ type, data }));

    try {
        process.env["PATH"] = `${fake.binDir}:${originalPath || ''}`;
        const { params, getResolved } = baseExitParams({
            cli: 'ai-e',
            effectiveProvider: 'grok',
            ctx: {
                fullText: 'done',
                sessionId,
                toolLog: [],
                traceLog: [],
                stderrBuf: '',
            },
        });
        await handleAgentExit(params as any);

        const resolved = getResolved();
        assert.equal(resolved.tools[0]?.stepRef, 'grok:tool:call-aie');
        const done = events.find(event => event.type === 'agent_done');
        assert.ok(done);
        const toolLog = done.data["toolLog"] as Array<Record<string, unknown>>;
        assert.equal(toolLog[0]?.["label"], 'run_terminal_command');
    } finally {
        process.env["PATH"] = originalPath;
        clearAllBroadcastListeners();
        fake.cleanup();
    }
});

test('session persistence can be skipped for transient Gemini Auto fallback', () => {
    assert.equal(shouldPersistMainSession({
        ownerGeneration: 0,
        sessionId: 'transient-auto-session',
        skipSessionPersist: true,
        cli: 'gemini',
        model: 'default',
        effort: '',
    }), false);
});

test('Gemini capacity fallback branch precedes generic same-model 429 retry', () => {
    const src = readSrc('../../src/agent/lifecycle-handler.ts');
    const capacityIdx = src.indexOf('Gemini model capacity: one-request Auto fallback');
    const retryIdx = src.indexOf('429 delay retry');

    assert.ok(capacityIdx > 0, 'capacity fallback branch must exist');
    assert.ok(retryIdx > 0, 'generic 429 retry branch must exist');
    assert.ok(capacityIdx < retryIdx, 'capacity fallback must run before same-model 429 retry');
});

test('Gemini capacity fallback keeps main ownership and skips only resume/session persistence', () => {
    const lifecycle = readSrc('../../src/agent/lifecycle-handler.ts');
    const branch = lifecycle.slice(
        lifecycle.indexOf('Gemini model capacity: one-request Auto fallback'),
        lifecycle.indexOf('429 delay retry'),
    );

    assert.match(branch, /model:\s*'default'/);
    assert.match(branch, /_skipResume:\s*true/);
    assert.match(branch, /_skipSessionPersist:\s*true/);
    assert.match(branch, /_isCapacityFallback:\s*true/);
    assert.doesNotMatch(branch, /forceNew:\s*true/);
});

test('Gemini resumed capacity fallback clears stale bucket before retrying without resume', () => {
    const lifecycle = readSrc('../../src/agent/lifecycle-handler.ts');
    const branch = lifecycle.slice(
        lifecycle.indexOf('Gemini resumed capacity failure'),
        lifecycle.indexOf('Gemini model capacity: one-request Auto fallback'),
    );

    assert.match(branch, /isResume/);
    assert.match(branch, /const\s+bucket\s*=\s*resolveSessionBucket\(cli,\s*model,\s*effectiveProvider\)/);
    assert.match(branch, /clearSessionBucket\.run\(bucket\)/);
    assert.match(branch, /_skipResume:\s*true/);
    assert.match(branch, /_skipSessionPersist:\s*true/);
    assert.match(branch, /_isCapacityFallback:\s*true/);
});

test('Gemini high-turn compact coordination clears session bucket like Codex/OpenCode', () => {
    const lifecycle = readSrc('../../src/agent/lifecycle-handler.ts');
    assert.match(lifecycle, /runtimeCli\s*===\s*'codex'\s*\|\|\s*runtimeCli\s*===\s*'opencode'\s*\|\|\s*runtimeCli\s*===\s*'gemini'/);
});

test('Gemini capacity fallback disables resume without letting employees become main-managed', () => {
    const spawn = readSrc('../../src/agent/spawn.ts');

    assert.match(spawn, /const\s+mainManaged\s*=\s*!forceNew\s*&&\s*!opts\.agentId\s*&&\s*!empSid\s*&&\s*!opts\.internal/);
    assert.match(spawn, /!\s*opts\._skipResume\s*&&\s*!forceNew\s*&&\s*!!bucketSessionId/);
});

test('model capacity alert does not tell the user to re-login', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    clearAllBroadcastListeners();
    addBroadcastListener((type, data) => events.push({ type, data }));

    const cli = `gemini-capacity-test-${Date.now()}`;
    recordError(cli, 'model_capacity');
    recordError(cli, 'model_capacity');
    recordError(cli, 'model_capacity');

    const alert = events.find(event => event.type === 'alert_escalation');
    assert.ok(alert, 'capacity error threshold should emit alert');
    const message = String(alert.data['message'] ?? '');
    assert.match(message, /capacity|Auto\/Flash/);
    assert.doesNotMatch(message, /로그인 상태 확인 필요/);

    clearAllBroadcastListeners();
});

// ─── #219: employee transient / pre-SessionStart retry ───

test('#219 classifier flags pre-SessionStart exit as a transient startup', () => {
    const transient = classifyExitError('claude-e', 5, '[jaw:claude-e:error] Claude exited before SessionStart (exit 1)');
    assert.equal(transient.isTransientStartup, true);
    assert.equal(transient.isStall, false);
    assert.equal(transient.isAuth, false);

    const generic = classifyExitError('claude-e', 1, 'some unrelated failure');
    assert.equal(generic.isTransientStartup, false);
});

test('#219 persisted employee pre-SessionStart clears stale session and retries fresh once', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    let retryOpts: Record<string, any> | null = null;
    let resolved: any = null;
    clearErrors('claude-e');
    clearAllBroadcastListeners();
    clearEmployeeSession.run('Frontend');
    upsertEmployeeSession.run('Frontend', 'emp-sess-1', 'claude-e', 'claude-opus-4-6', 123);
    addBroadcastListener((type, data) => events.push({ type, data }));
    setSpawnAgent((_prompt: string, opts: Record<string, any> = {}) => {
        retryOpts = opts;
        return { promise: Promise.resolve({ text: 'retry ok', code: 0, sessionId: 'fresh-session' }) };
    });
    const { params } = baseExitParams({
        ctx: { fullText: '', sessionId: null, toolLog: [], traceLog: [], stderrBuf: '[jaw:claude-e:error] Claude exited before SessionStart (exit 1)' },
        code: 5,
        cli: 'claude-e',
        model: 'claude-opus-4-6',
        agentLabel: 'Frontend',
        mainManaged: false,
        empSid: 'emp-sess-1',
        isResume: true,
        opts: { agentId: 'Frontend', employeeSessionId: 'emp-sess-1' },
        resolve: (value: any) => { resolved = value; },
    });
    try {
        await handleAgentExit(params as any);
        await Promise.resolve();
        const retry = events.find(event => event.type === 'agent_retry');
        assert.ok(retry, 'stale employee resume should broadcast agent_retry');
        assert.equal(retry?.data["delay"], 0);
        assert.equal(retry?.data["isEmployee"], true);
        assert.equal(retry?.data["maxRetries"], 1);
        assert.equal(getEmployeeSession.get('Frontend'), undefined, 'stale employee session should be cleared');
        assert.ok(retryOpts, 'fresh retry should call spawnAgent');
        assert.equal(retryOpts?._skipResume, true);
        assert.equal(retryOpts?._skipInsert, true);
        assert.equal(retryOpts?._employeeFreshSessionRetry, true);
        assert.equal(retryOpts?.employeeSessionId, 'emp-sess-1', 'spawn.ts owns ignoring stale employeeSessionId when _skipResume is true');
        assert.equal(resolved?.text, 'retry ok');
    } finally {
        clearEmployeeSession.run('Frontend');
        clearErrors('claude-e');
        clearAllBroadcastListeners();
    }
});

test('#219 non-resume employee pre-SessionStart exit triggers bounded retry with backoff (no fallback)', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    clearErrors('claude-e');
    clearAllBroadcastListeners();
    addBroadcastListener((type, data) => events.push({ type, data }));
    const { params } = baseExitParams({
        ctx: { fullText: '', sessionId: null, toolLog: [], traceLog: [], stderrBuf: '[jaw:claude-e:error] Claude exited before SessionStart (exit 1)' },
        code: 5,
        cli: 'claude-e',
        model: 'claude-opus-4-6',
        agentLabel: 'Frontend',
        mainManaged: false,
        empSid: null,
        isResume: false,
        opts: { agentId: 'Frontend' },
    });
    params.retryState.setTimer = (t: any) => { retryTimer = t; };
    try {
        await handleAgentExit(params as any);
        const retry = events.find(event => event.type === 'agent_retry');
        assert.ok(retry, 'employee transient exit should broadcast agent_retry');
        const empDelay = retry?.data["delay"] as number;
        assert.ok(empDelay >= 2 && empDelay <= 3, `employee backoff delay should be 2-3s on first attempt, got ${empDelay}`);
        assert.equal(retry?.data["isEmployee"], true);
        assert.equal(events.some(event => event.type === 'agent_fallback'), false, 'employee transient retry must not switch CLI');
    } finally {
        if (retryTimer) clearTimeout(retryTimer);
        clearErrors('claude-e');
        clearAllBroadcastListeners();
    }
});

test('#219 employee transient retry does not loop after fresh-session retry attempt', async () => {
    let resolved: any = null;
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    clearErrors('claude-e');
    clearAllBroadcastListeners();
    addBroadcastListener((type, data) => events.push({ type, data }));
    const { params } = baseExitParams({
        ctx: { fullText: '', sessionId: null, toolLog: [], traceLog: [], stderrBuf: '[jaw:claude-e:error] Claude exited before SessionStart (exit 1)' },
        code: 5,
        cli: 'claude-e',
        model: 'claude-opus-4-6',
        agentLabel: 'Frontend',
        mainManaged: false,
        empSid: 'emp-sess-1',
        isResume: true,
        opts: { agentId: 'Frontend', employeeSessionId: 'emp-sess-1', _employeeFreshSessionRetry: true },
        resolve: (value: any) => { resolved = value; },
    });
    try {
        await handleAgentExit(params as any);
        assert.equal(events.some(event => event.type === 'agent_retry'), false, 'must not retry when _retryAttempt exhausted');
        assert.ok(resolved, 'should resolve to a failure result');
        assert.equal(resolved.code, 5);
    } finally {
        clearErrors('claude-e');
        clearAllBroadcastListeners();
    }
});

test('#219 main pre-SessionStart exit is retried via effectiveIs429 (backoff)', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    clearErrors('claude');
    clearAllBroadcastListeners();
    addBroadcastListener((type, data) => events.push({ type, data }));
    const { params } = baseExitParams({
        ctx: { fullText: '', sessionId: null, toolLog: [], traceLog: [], stderrBuf: 'Claude exited before SessionStart (exit 1)' },
        code: 1,
        cli: 'claude',
        model: 'claude-sonnet',
        agentLabel: 'main',
        mainManaged: true,
        opts: {},
    });
    params.retryState.setTimer = (t: any) => { retryTimer = t; };
    try {
        await handleAgentExit(params as any);
        const retry = events.find(event => event.type === 'agent_retry');
        assert.ok(retry, 'main transient exit should trigger a retry');
        const mainDelay = retry?.data["delay"] as number;
        assert.ok(mainDelay >= 3 && mainDelay <= 5, `main backoff delay should be 3-5s on first attempt, got ${mainDelay}`);
    } finally {
        if (retryTimer) clearTimeout(retryTimer);
        clearErrors('claude');
        clearAllBroadcastListeners();
    }
});

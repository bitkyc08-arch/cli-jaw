#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

const JWC_BIN = '/Users/jun/.local/bin/jwc';
const TIMEOUT_MS = 180_000;
const PROMPT = 'Run the shell command `echo fixture-hello` and then reply with exactly: fixture done';
const fixturePath = resolve('tests/fixtures/dashboard2-code-acp.ndjson');
const metaPath = resolve('tests/fixtures/dashboard2-code-acp.meta.json');

function getJwcVersion() {
    const result = spawnSync(JWC_BIN, ['--version'], { encoding: 'utf8' });
    return (result.stdout || result.stderr || 'unknown').trim();
}

function hashUpdates(updates) {
    return createHash('sha256').update(JSON.stringify(updates)).digest('hex');
}

function rpcError(msg) {
    const details = typeof msg.error?.data?.details === 'string' ? `: ${msg.error.data.details}` : '';
    return new Error(`${msg.error?.message ?? 'JSON-RPC error'}${details}`);
}

function choosePermissionOption(options) {
    const allowish = /allow|approve|accept|yes/i;
    return options.find(option => allowish.test([
        option.kind,
        option.name,
        option.label,
        option.optionId,
        option.id,
    ].filter(Boolean).join(' '))) ?? options[0];
}

async function runAttempt(attempt) {
    const cwd = await mkdtemp(`${tmpdir()}/cli-jaw-code-acp-fixture-`);
    const wire = [];
    const stderr = [];
    const protocolNoise = [];
    const pending = new Map();
    const updates = { prompt: [], load1: [], load2: [] };
    let nextId = 1;
    let activeCapture = null;
    let buffer = '';
    let stage = 'spawn';
    let timedOut = false;
    let sessionId = null;

    const child = spawn(JWC_BIN, ['--mode', 'acp'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, JWC_BRAND_NAME: 'jwc' },
    });

    const rejectPending = error => {
        for (const { reject } of pending.values()) reject(error);
        pending.clear();
    };

    const send = msg => {
        wire.push({ dir: 'out', msg });
        child.stdin.write(`${JSON.stringify(msg)}\n`);
    };

    const onMessage = msg => {
        wire.push({ dir: 'in', msg });

        if (msg.method === 'session/update') {
            const update = msg.params?.update;
            if (activeCapture && update && msg.params?.sessionId) updates[activeCapture].push(update);
        }

        if (msg.method === 'session/request_permission' && msg.id !== undefined) {
            const option = choosePermissionOption(Array.isArray(msg.params?.options) ? msg.params.options : []);
            const optionId = option?.optionId ?? option?.id;
            const result = optionId === undefined
                ? { outcome: { outcome: 'cancelled' } }
                : { outcome: { outcome: 'selected', optionId } };
            send({ jsonrpc: '2.0', id: msg.id, result });
            return;
        }

        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const deferred = pending.get(msg.id);
            if (!deferred) return;
            pending.delete(msg.id);
            if (msg.error !== undefined) deferred.reject(rpcError(msg));
            else deferred.resolve(msg.result ?? {});
        }
    };

    const request = (method, params) => {
        const id = nextId++;
        return new Promise((resolveRequest, rejectRequest) => {
            pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
            send({ jsonrpc: '2.0', id, method, params });
        });
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
        buffer += chunk;
        for (;;) {
            const newline = buffer.indexOf('\n');
            if (newline < 0) break;
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            try {
                onMessage(JSON.parse(line));
            } catch {
                protocolNoise.push(line);
            }
        }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => rejectPending(error));
    child.on('exit', code => rejectPending(new Error(`jwc exited with code ${code}`)));

    const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
        rejectPending(new Error(`jwc ACP capture timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    try {
        stage = 'handshake';
        await request('initialize', {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        });
        try {
            await request('authenticate', { methodId: 'agent' });
        } catch {
            // Authentication is optional for engines that reuse an existing agent login.
        }

        stage = 'session/new';
        const newSession = await request('session/new', { cwd, mcpServers: [] });
        sessionId = String(newSession.sessionId ?? '');
        if (!sessionId) throw new Error('session/new returned no sessionId');

        stage = 'session/prompt';
        activeCapture = 'prompt';
        let promptResponse;
        try {
            promptResponse = await request('session/prompt', {
                sessionId,
                messageId: randomUUID(),
                prompt: [{ type: 'text', text: PROMPT }],
            });
        } finally {
            activeCapture = null;
        }

        stage = 'session/list';
        await request('session/list', { cwd });

        const load = async capture => {
            stage = `session/${capture}`;
            activeCapture = capture;
            try {
                await request('session/load', { sessionId, cwd, mcpServers: [] });
            } finally {
                activeCapture = null;
            }
        };
        await load('load1');
        await load('load2');

        const load1Hash = hashUpdates(updates.load1);
        const load2Hash = hashUpdates(updates.load2);
        return {
            ok: true,
            attempt,
            wire,
            stderr: stderr.join(''),
            protocolNoise,
            cwd,
            sessionId,
            promptResponse,
            updates,
            load1Hash,
            load2Hash,
            deterministic: load1Hash === load2Hash,
        };
    } catch (error) {
        error.captureStage = stage;
        return {
            ok: false,
            retryable: stage === 'spawn' || stage === 'handshake',
            attempt,
            wire,
            stderr: stderr.join(''),
            protocolNoise,
            cwd,
            sessionId,
            timedOut,
            updates,
            error,
        };
    } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) child.kill('SIGTERM');
        await rm(cwd, { recursive: true, force: true });
    }
}

async function main() {
    const jwcVersion = getJwcVersion();
    let result;
    const attemptStderr = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
        result = await runAttempt(attempt);
        attemptStderr.push({ attempt, stderr: result.stderr });
        if (result.ok || !result.retryable) break;
    }

    const updateKindCounts = {};
    for (const update of result.updates.prompt) {
        const kind = String(update.sessionUpdate ?? 'unknown');
        updateKindCounts[kind] = (updateKindCounts[kind] ?? 0) + 1;
    }

    const meta = {
        jwcVersion,
        capturedAt: new Date().toISOString(),
        promptStopReason: result.promptResponse?.stopReason ?? null,
        load1Hash: result.load1Hash ?? null,
        load2Hash: result.load2Hash ?? null,
        deterministic: result.deterministic ?? false,
        sessionId: result.sessionId ?? null,
        updateKindCounts,
    };
    if (!result.ok) {
        meta.failureMode = {
            stage: result.error.captureStage,
            message: result.error.message,
            timedOut: result.timedOut,
        };
    }
    if (attemptStderr.some(entry => entry.stderr)) meta.stderr = attemptStderr;
    if (result.protocolNoise.length) meta.protocolNoise = result.protocolNoise;

    await mkdir(dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, `${result.wire.map(line => JSON.stringify(line)).join('\n')}\n`);
    await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

    console.log(`jwcVersion: ${jwcVersion}`);
    console.log(`stopReason: ${meta.promptStopReason ?? 'none'}`);
    console.log(`updateKindCounts: ${JSON.stringify(updateKindCounts)}`);
    console.log(`load1Hash: ${meta.load1Hash ?? 'none'}`);
    console.log(`load2Hash: ${meta.load2Hash ?? 'none'}`);
    console.log(`deterministic: ${meta.deterministic}`);
    for (const entry of attemptStderr) {
        console.log(`stderr attempt ${entry.attempt}: ${entry.stderr || '<empty>'}`);
    }
    if (!result.ok) {
        console.error(`capture failed at ${meta.failureMode.stage}: ${meta.failureMode.message}`);
        process.exitCode = 1;
    }
}

await main();

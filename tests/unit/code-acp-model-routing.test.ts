import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { CodeTransportError } from '../../src/code-mode/types.ts';

const fixture = resolve(import.meta.dirname, '../fixtures/fake-jwc-acp-model.mjs');

function records(path: string): Array<{ method?: string; params?: Record<string, unknown> }> {
    try {
        return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch {
        return [];
    }
}

test('ACP host records exact create and live model routing and keeps authoritative state', { concurrency: false }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-code-model-acp-'));
    const transcript = join(dir, 'transcript.ndjson');
    const previous = {
        command: process.env['JWC_ACP_CMD'], transcript: process.env['JWC_FAKE_TRANSCRIPT'],
        timeout: process.env['JWC_ACP_RPC_TIMEOUT_MS'], hang: process.env['JWC_FAKE_HANG_CLOSE'],
    };
    process.env['JWC_ACP_CMD'] = `${process.execPath} ${fixture}`;
    process.env['JWC_FAKE_TRANSCRIPT'] = transcript;
    process.env['JWC_ACP_RPC_TIMEOUT_MS'] = '500';
    delete process.env['JWC_FAKE_HANG_CLOSE'];
    const { acpHost, getAcpHostDiagnosticSnapshot } = await import('../../src/code-mode/acp-host.ts');
    try {
        const created = await acpHost.newSession(dir, { model: 'openai-codex/gpt-5.6-sol' });
        assert.equal(created.modelId, 'openai-codex/gpt-5.6-sol');
        const switched = await acpHost.setSessionModel(created.sessionId, 'openai-codex/gpt-5.6-terra');
        assert.equal(switched.modelId, 'openai-codex/gpt-5.6-terra');
        assert.equal(acpHost.listSessions()[0]?.modelId, 'openai-codex/gpt-5.6-terra');
        await assert.rejects(
            acpHost.setSessionModel(created.sessionId, 'openai-codex/invalid-model'),
            (error: unknown) => error instanceof CodeTransportError && error.code === 'unsupported_model',
        );
        assert.equal(acpHost.listSessions()[0]?.modelId, 'openai-codex/gpt-5.6-terra');
        await acpHost.dispose();
        assert.deepEqual(getAcpHostDiagnosticSnapshot(), { childAlive: false, pendingRpcCount: 0, sessionCount: 0 });
        const calls = records(transcript).filter(record => record.method);
        assert.deepEqual(calls.slice(0, 5).map(record => record.method), [
            'initialize', 'authenticate', 'session/new', 'session/set_model', 'session/set_model',
        ]);
        assert.equal(calls[3]?.params?.['modelId'], 'openai-codex/gpt-5.6-sol');
        assert.equal(calls[4]?.params?.['modelId'], 'openai-codex/gpt-5.6-terra');
    } finally {
        await acpHost.dispose().catch(() => {});
        for (const [key, value] of Object.entries(previous)) {
            const envKey = key === 'command' ? 'JWC_ACP_CMD'
                : key === 'transcript' ? 'JWC_FAKE_TRANSCRIPT'
                    : key === 'timeout' ? 'JWC_ACP_RPC_TIMEOUT_MS' : 'JWC_FAKE_HANG_CLOSE';
            if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
        }
        rmSync(dir, { recursive: true, force: true });
    }
});

test('initial model rejection closes the remote session and close timeout terminates the child', { concurrency: false }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-code-model-rollback-'));
    const transcript = join(dir, 'transcript.ndjson');
    const previous = {
        command: process.env['JWC_ACP_CMD'], transcript: process.env['JWC_FAKE_TRANSCRIPT'],
        timeout: process.env['JWC_ACP_RPC_TIMEOUT_MS'], hang: process.env['JWC_FAKE_HANG_CLOSE'],
    };
    process.env['JWC_ACP_CMD'] = `${process.execPath} ${fixture}`;
    process.env['JWC_FAKE_TRANSCRIPT'] = transcript;
    process.env['JWC_ACP_RPC_TIMEOUT_MS'] = '50';
    process.env['JWC_FAKE_HANG_CLOSE'] = '1';
    const { acpHost, getAcpHostDiagnosticSnapshot } = await import('../../src/code-mode/acp-host.ts');
    try {
        await assert.rejects(
            acpHost.newSession(dir, { model: 'openai-codex/invalid-model' }),
            (error: unknown) => error instanceof CodeTransportError && error.code === 'unsupported_model',
        );
        assert.deepEqual(getAcpHostDiagnosticSnapshot(), { childAlive: false, pendingRpcCount: 0, sessionCount: 0 });
        const methods = records(transcript).map(record => record.method).filter(Boolean);
        assert.deepEqual(methods.slice(-3), ['session/new', 'session/set_model', 'session/close']);
    } finally {
        await acpHost.dispose().catch(() => {});
        for (const [key, value] of Object.entries(previous)) {
            const envKey = key === 'command' ? 'JWC_ACP_CMD'
                : key === 'transcript' ? 'JWC_FAKE_TRANSCRIPT'
                    : key === 'timeout' ? 'JWC_ACP_RPC_TIMEOUT_MS' : 'JWC_FAKE_HANG_CLOSE';
            if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
        }
        rmSync(dir, { recursive: true, force: true });
    }
});

test('session/new timeout terminates the child because remote creation outcome is unknown', { concurrency: false }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-code-model-new-timeout-'));
    const transcript = join(dir, 'transcript.ndjson');
    const previous = {
        command: process.env['JWC_ACP_CMD'], transcript: process.env['JWC_FAKE_TRANSCRIPT'],
        timeout: process.env['JWC_ACP_RPC_TIMEOUT_MS'], hangNew: process.env['JWC_FAKE_HANG_NEW'],
    };
    process.env['JWC_ACP_CMD'] = `${process.execPath} ${fixture}`;
    process.env['JWC_FAKE_TRANSCRIPT'] = transcript;
    process.env['JWC_ACP_RPC_TIMEOUT_MS'] = '50';
    process.env['JWC_FAKE_HANG_NEW'] = '1';
    const { acpHost, getAcpHostDiagnosticSnapshot } = await import('../../src/code-mode/acp-host.ts');
    try {
        await assert.rejects(
            acpHost.newSession(dir, { model: 'openai-codex/gpt-5.6-sol' }),
            (error: unknown) => error instanceof CodeTransportError && error.code === 'rpc_timeout',
        );
        assert.deepEqual(getAcpHostDiagnosticSnapshot(), { childAlive: false, pendingRpcCount: 0, sessionCount: 0 });
        assert.equal(records(transcript).some(record => record.method === 'session/new'), true);
    } finally {
        await acpHost.dispose().catch(() => {});
        if (previous.command === undefined) delete process.env['JWC_ACP_CMD']; else process.env['JWC_ACP_CMD'] = previous.command;
        if (previous.transcript === undefined) delete process.env['JWC_FAKE_TRANSCRIPT']; else process.env['JWC_FAKE_TRANSCRIPT'] = previous.transcript;
        if (previous.timeout === undefined) delete process.env['JWC_ACP_RPC_TIMEOUT_MS']; else process.env['JWC_ACP_RPC_TIMEOUT_MS'] = previous.timeout;
        if (previous.hangNew === undefined) delete process.env['JWC_FAKE_HANG_NEW']; else process.env['JWC_FAKE_HANG_NEW'] = previous.hangNew;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('child exit maps retained sessions to 503, hides them from the live list, and closes them locally', { concurrency: false }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-code-model-child-exit-'));
    const transcript = join(dir, 'transcript.ndjson');
    const previous = {
        command: process.env['JWC_ACP_CMD'], transcript: process.env['JWC_FAKE_TRANSCRIPT'],
        timeout: process.env['JWC_ACP_RPC_TIMEOUT_MS'], exitAfter: process.env['JWC_FAKE_EXIT_AFTER'],
    };
    process.env['JWC_ACP_CMD'] = `${process.execPath} ${fixture}`;
    process.env['JWC_FAKE_TRANSCRIPT'] = transcript;
    process.env['JWC_ACP_RPC_TIMEOUT_MS'] = '500';
    process.env['JWC_FAKE_EXIT_AFTER'] = 'session/new';
    const { acpHost, getAcpHostDiagnosticSnapshot } = await import('../../src/code-mode/acp-host.ts');
    try {
        const created = await acpHost.newSession(dir, { model: 'openai-codex/gpt-5.6-sol' });
        assert.equal(created.modelId, 'openai-codex/gpt-5.6-sol');
        // The fake child exits right after answering session/new; wait for the
        // host to observe the exit and mark the session closed.
        let snapshot = getAcpHostDiagnosticSnapshot();
        for (let attempt = 0; attempt < 100 && snapshot.childAlive; attempt += 1) {
            await new Promise(resolveWait => setTimeout(resolveWait, 20));
            snapshot = getAcpHostDiagnosticSnapshot();
        }
        assert.equal(snapshot.childAlive, false);
        assert.equal(snapshot.sessionCount, 1); // retained for the 503 mapping

        // Live-list contract: exit-closed sessions are not selectable live sessions.
        assert.deepEqual(acpHost.listSessions(), []);

        // Documented contract: exited child => 503 unavailable; unknown id => 404.
        await assert.rejects(
            acpHost.setSessionModel(created.sessionId, 'openai-codex/gpt-5.6-terra'),
            (error: unknown) => error instanceof CodeTransportError && error.code === 'unavailable',
        );
        await assert.rejects(
            acpHost.prompt(created.sessionId, 'hello'),
            (error: unknown) => error instanceof CodeTransportError && error.code === 'unavailable',
        );
        await assert.rejects(
            acpHost.setSessionModel('never-existed', 'openai-codex/gpt-5.6-terra'),
            (error: unknown) => error instanceof CodeTransportError && error.code === 'unknown_session',
        );
        await assert.rejects(
            acpHost.prompt('never-existed', 'hello'),
            (error: unknown) => error instanceof CodeTransportError && error.code === 'unknown_session',
        );

        // Closed-entry close is local-only: no RPC, no child respawn, no accumulation.
        await acpHost.closeSession(created.sessionId);
        snapshot = getAcpHostDiagnosticSnapshot();
        assert.equal(snapshot.sessionCount, 0);
        assert.equal(snapshot.childAlive, false);
        assert.equal(records(transcript).some(record => record.method === 'session/close'), false);
    } finally {
        await acpHost.dispose().catch(() => {});
        if (previous.command === undefined) delete process.env['JWC_ACP_CMD']; else process.env['JWC_ACP_CMD'] = previous.command;
        if (previous.transcript === undefined) delete process.env['JWC_FAKE_TRANSCRIPT']; else process.env['JWC_FAKE_TRANSCRIPT'] = previous.transcript;
        if (previous.timeout === undefined) delete process.env['JWC_ACP_RPC_TIMEOUT_MS']; else process.env['JWC_ACP_RPC_TIMEOUT_MS'] = previous.timeout;
        if (previous.exitAfter === undefined) delete process.env['JWC_FAKE_EXIT_AFTER']; else process.env['JWC_FAKE_EXIT_AFTER'] = previous.exitAfter;
        rmSync(dir, { recursive: true, force: true });
    }
});

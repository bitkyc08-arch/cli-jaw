import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test, { mock } from 'node:test';
import express, { type NextFunction, type Request, type Response } from 'express';
import { CodeTransportError, type CodeTransportErrorCode } from '../../src/code-mode/types.ts';

const modelOptions = {
    providers: [
        { id: 'anthropic', models: ['claude-sonnet-4.6'], efforts: [], modelSource: 'jwc-cache' as const },
        { id: 'openai-codex', models: ['gpt-5.6-sol'], efforts: ['high'], modelSource: 'static-fallback' as const },
    ],
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4.6',
};

const calls: {
    newSession: Array<{ cwd: string; opts?: { model?: string } }>;
    setSessionModel: Array<{ sessionId: string; modelId: string }>;
} = {
    newSession: [],
    setSessionModel: [],
};
let newSessionError: Error | null = null;
let setSessionModelError: Error | null = null;
let promptError: Error | null = null;

const acpHostPath = resolve(import.meta.dirname, '../../src/code-mode/acp-host.js');
mock.module(acpHostPath, {
    namedExports: {
        probeCodeCapabilities: async () => ({ available: true, reason: 'ok' }),
        acpHost: {
            listSessions: () => [],
            listPendingPermissions: () => [],
            listStoredSessions: async () => [],
            loadSession: async () => { throw new Error('not used'); },
            extMethod: async () => ({}),
            forkSession: async () => { throw new Error('not used'); },
            newSession: async (cwd: string, opts?: { model?: string }) => {
                if (newSessionError) throw newSessionError;
                calls.newSession.push({ cwd, ...(opts ? { opts } : {}) });
                return {
                    sessionId: `session-${calls.newSession.length}`,
                    cwd,
                    status: 'idle',
                    createdAt: 1,
                    lastUsedAt: 1,
                    modelId: opts?.model ?? null,
                };
            },
            setSessionModel: async (sessionId: string, modelId: string) => {
                if (setSessionModelError) throw setSessionModelError;
                calls.setSessionModel.push({ sessionId, modelId });
                return {
                    sessionId, cwd: '/tmp/workspace', status: 'idle', createdAt: 1,
                    lastUsedAt: 2, modelId,
                };
            },
            prompt: async () => {
                if (promptError) throw promptError;
                return { accepted: true, sessionId: 'unused' };
            },
            cancel: async () => {},
            setSessionConfig: async () => {},
            closeSession: async () => {},
            answerPermission: () => false,
        },
    },
});

const modelOptionsPath = resolve(import.meta.dirname, '../../src/code-mode/model-options.js');
mock.module(modelOptionsPath, {
    namedExports: {
        buildJwcModelRole: () => '',
        clearJwcModelAssignment: async () => {},
        isJwcModelAssignmentRole: () => false,
        readJwcModelProfilePresetInfo: async () => ({
            taskPresets: [], builtinProfiles: [], applyAvailable: false, applyReason: 'unavailable',
        }),
        resolveJwcModelAssignments: async () => ({ roles: [], activeModel: { scope: 'session', note: '' } }),
        resolveJwcModelOptions: async () => modelOptions,
        writeJwcDefaultModelRole: async () => {},
        writeJwcModelAssignment: async () => {},
    },
});

const { registerCodeRoutes } = await import('../../src/routes/code.ts');
const noAuth = (_req: Request, _res: Response, next: NextFunction) => next();

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
    const app = express();
    app.use(express.json());
    registerCodeRoutes(app, noAuth);
    const server = app.listen(0);
    try {
        const address = server.address();
        assert.ok(address && typeof address === 'object');
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>(done => server.close(() => done()));
    }
}

test('registered Code handlers expose models and forward provider-qualified session models', async () => {
    calls.newSession.length = 0;
    calls.setSessionModel.length = 0;
    await withServer(async baseUrl => {
        const inventory = await fetch(`${baseUrl}/api/code/models`);
        assert.equal(inventory.status, 200);
        assert.deepEqual(await inventory.json(), { ok: true, ...modelOptions });

        const created = await fetch(`${baseUrl}/api/code/sessions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cwd: '/tmp/workspace', model: 'anthropic/claude-sonnet-4.6' }),
        });
        assert.equal(created.status, 201);
        assert.deepEqual(calls.newSession, [{
            cwd: '/tmp/workspace',
            opts: { model: 'anthropic/claude-sonnet-4.6' },
        }]);

        const switched = await fetch(`${baseUrl}/api/code/sessions/session-1/model`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ modelId: 'openai-codex/gpt-5.6-sol' }),
        });
        assert.equal(switched.status, 200);
        assert.deepEqual(calls.setSessionModel, [{
            sessionId: 'session-1',
            modelId: 'openai-codex/gpt-5.6-sol',
        }]);
        const switchedBody = await switched.json() as { session: { modelId: string } };
        assert.equal(switchedBody.session.modelId, 'openai-codex/gpt-5.6-sol');
    });
});

test('registered Code session handler preserves omitted-model default behavior', async () => {
    calls.newSession.length = 0;
    await withServer(async baseUrl => {
        const created = await fetch(`${baseUrl}/api/code/sessions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cwd: '/tmp/default-workspace' }),
        });
        assert.equal(created.status, 201);
        assert.deepEqual(calls.newSession, [{ cwd: '/tmp/default-workspace' }]);
    });
});

test('registered Code model handlers expose typed validation and transport failures', async () => {
    newSessionError = null;
    setSessionModelError = null;
    await withServer(async baseUrl => {
        const relative = await fetch(`${baseUrl}/api/code/sessions`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cwd: 'relative', model: 'openai-codex/gpt-5.6-sol' }),
        });
        assert.equal(relative.status, 400);

        const missingModel = await fetch(`${baseUrl}/api/code/sessions/session-1/model`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        assert.equal(missingModel.status, 400);

        const cases: Array<[CodeTransportErrorCode | 'unexpected', number]> = [
            ['unknown_session', 404], ['unsupported_model', 422], ['unavailable', 503],
            ['rpc_timeout', 504], ['unexpected', 500],
        ];
        for (const [code, status] of cases) {
            setSessionModelError = code === 'unexpected'
                ? new Error('unexpected')
                : new CodeTransportError(code, code);
            const response = await fetch(`${baseUrl}/api/code/sessions/session-1/model`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ modelId: 'openai-codex/gpt-5.6-sol' }),
            });
            assert.equal(response.status, status, `switch ${code}`);
        }

        newSessionError = new CodeTransportError('unsupported_model', 'unsupported');
        const unsupportedCreate = await fetch(`${baseUrl}/api/code/sessions`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cwd: '/tmp/workspace', model: 'bad/model' }),
        });
        assert.equal(unsupportedCreate.status, 422);
        newSessionError = new CodeTransportError('rpc_timeout', 'timeout');
        const timeoutCreate = await fetch(`${baseUrl}/api/code/sessions`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cwd: '/tmp/workspace', model: 'openai-codex/gpt-5.6-sol' }),
        });
        assert.equal(timeoutCreate.status, 504);
        newSessionError = new CodeTransportError('unavailable', 'unavailable');
        const unavailableCreate = await fetch(`${baseUrl}/api/code/sessions`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cwd: '/tmp/workspace', model: 'openai-codex/gpt-5.6-sol' }),
        });
        assert.equal(unavailableCreate.status, 503);
        newSessionError = new Error('unexpected');
        const unexpectedCreate = await fetch(`${baseUrl}/api/code/sessions`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cwd: '/tmp/workspace', model: 'openai-codex/gpt-5.6-sol' }),
        });
        assert.equal(unexpectedCreate.status, 500);
    });
    newSessionError = null;
    setSessionModelError = null;
});

test('registered Code model handlers reject non-string model, modelId, and cwd payloads with 400', async () => {
    calls.newSession.length = 0;
    calls.setSessionModel.length = 0;
    newSessionError = null;
    setSessionModelError = null;
    await withServer(async baseUrl => {
        const post = (path: string, payload: unknown) => fetch(`${baseUrl}${path}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });

        // modelId must be a real string: numbers/objects must not coerce downstream.
        assert.equal((await post('/api/code/sessions/session-1/model', { modelId: 123 })).status, 400);
        assert.equal((await post('/api/code/sessions/session-1/model', { modelId: {} })).status, 400);
        assert.equal((await post('/api/code/sessions/session-1/model', { modelId: '   ' })).status, 400);

        // create model: present-but-non-string is malformed, omitted stays valid.
        assert.equal((await post('/api/code/sessions', { cwd: '/tmp/workspace', model: {} })).status, 400);
        assert.equal((await post('/api/code/sessions', { cwd: '/tmp/workspace', model: 123 })).status, 400);
        assert.equal((await post('/api/code/sessions', { cwd: '/tmp/workspace', model: '  ' })).status, 400);

        // cwd: String(["/tmp"]) coerces to an absolute path, so type-check first.
        assert.equal((await post('/api/code/sessions', { cwd: ['/tmp'] })).status, 400);
        assert.equal((await post('/api/code/sessions', { cwd: 123 })).status, 400);
        assert.equal((await post('/api/code/sessions/session-1/fork', { cwd: ['/tmp'] })).status, 400);
    });
    assert.deepEqual(calls.newSession, []);
    assert.deepEqual(calls.setSessionModel, []);
});

test('registered Code prompt handler maps transport failures to typed HTTP statuses', async () => {
    promptError = null;
    await withServer(async baseUrl => {
        const prompt = () => fetch(`${baseUrl}/api/code/sessions/session-1/prompt`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hello' }),
        });
        const cases: Array<[CodeTransportErrorCode | 'unexpected', number]> = [
            ['unknown_session', 404], ['unavailable', 503], ['rpc_timeout', 504], ['unexpected', 500],
        ];
        for (const [code, status] of cases) {
            promptError = code === 'unexpected'
                ? new Error('unexpected')
                : new CodeTransportError(code, code);
            const response = await prompt();
            assert.equal(response.status, status, `prompt ${code}`);
        }
        promptError = null;
        const accepted = await prompt();
        assert.equal(accepted.status, 202);
    });
    promptError = null;
});

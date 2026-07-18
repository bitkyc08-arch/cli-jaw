import assert from 'node:assert/strict';
import test from 'node:test';
import {
    CodeApiError,
    createCodeApiClient,
    type CodeModelOptions,
} from '../../public/dashboard2/src/code/code-api-client.ts';
import {
    createCodeSessionForGeneration,
    isCurrentCodeSessionGeneration,
} from '../../public/dashboard2/src/code/code-session-controller.ts';

function json(body: unknown, status = 200, contentType = 'application/json; charset=utf-8'): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': contentType },
    });
}

const options: CodeModelOptions = {
    providers: [
        { id: 'anthropic', models: ['claude-sonnet-4.6'], efforts: [], modelSource: 'jwc-cache' },
        { id: 'openai-codex', models: ['gpt-5.6-sol'], efforts: ['high'], modelSource: 'static-fallback' },
    ],
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4.6',
    usageOrder: ['openai-codex/gpt-5.6-sol'],
};

test('Code API client decodes models and emits exact create/switch request bodies', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
        const path = String(input);
        requests.push({ path, ...(init ? { init } : {}) });
        if (path.endsWith('/models')) return json({ ok: true, ...options });
        if (path.endsWith('/sessions')) return json({
            ok: true,
            session: {
                sessionId: 'session-1', cwd: '/repo', status: 'idle', createdAt: 1, lastUsedAt: 1,
                modelId: 'anthropic/claude-sonnet-4.6',
                secretField: 'must-not-cross-client-boundary',
            },
        }, 201);
        if (path.endsWith('/sessions/session-1/model')) return json({
            ok: true,
            session: {
                sessionId: 'session-1', cwd: '/repo', status: 'idle', createdAt: 1, lastUsedAt: 2,
                modelId: 'openai-codex/gpt-5.6-sol',
            },
        });
        throw new Error(`unexpected request ${path}`);
    };
    const client = createCodeApiClient(3457, { fetchImpl });

    assert.deepEqual(await client.listModelOptions(), options);
    const created = await client.newSession('/repo', 'anthropic/claude-sonnet-4.6');
    assert.equal('secretField' in created, false);
    await client.setSessionModel('session-1', 'openai-codex/gpt-5.6-sol');

    assert.equal(requests[0]?.path, '/i/3457/api/code/models');
    assert.equal(new Headers(requests[0]?.init?.headers).get('accept'), 'application/json');
    assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
        cwd: '/repo',
        model: 'anthropic/claude-sonnet-4.6',
    });
    assert.equal(new Headers(requests[1]?.init?.headers).get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(String(requests[2]?.init?.body)), {
        modelId: 'openai-codex/gpt-5.6-sol',
    });
});

test('Code API client rejects wrong content types and malformed model payloads with typed non-reflective errors', async () => {
    const secret = 'token-super-secret';
    const htmlClient = createCodeApiClient(3457, {
        fetchImpl: async () => new Response(`<html>${secret}</html>`, {
            status: 200,
            headers: { 'content-type': 'text/html' },
        }),
    });
    await assert.rejects(htmlClient.listModelOptions(), (error: unknown) => {
        assert.ok(error instanceof CodeApiError);
        assert.equal(error.code, 'invalid_content_type');
        assert.equal(error.message.includes(secret), false);
        return true;
    });

    const malformedClient = createCodeApiClient(3457, {
        fetchImpl: async () => json({
            ok: true,
            providers: [{ id: 'anthropic', models: [42], efforts: [] }],
            defaultProvider: 'anthropic',
            defaultModel: 'claude-sonnet-4.6',
        }),
    });
    await assert.rejects(malformedClient.listModelOptions(), (error: unknown) => {
        assert.ok(error instanceof CodeApiError);
        assert.equal(error.code, 'invalid_response');
        return true;
    });

    const failedClient = createCodeApiClient(3457, {
        fetchImpl: async () => json({ ok: false, error: secret }, 500),
    });
    await assert.rejects(failedClient.setSessionModel('session-1', 'anthropic/claude-sonnet-4.6'), (error: unknown) => {
        assert.ok(error instanceof CodeApiError);
        assert.equal(error.code, 'http_error');
        assert.equal(error.status, 500);
        assert.equal(error.message.includes(secret), false);
        return true;
    });
});

test('stale Code create closes the session through its originating port client', async () => {
    const controller = new AbortController();
    const closed: string[] = [];
    const client = {
        newSession: async () => {
            controller.abort();
            return {
                sessionId: 'old-port-session', cwd: '/repo', status: 'idle' as const,
                createdAt: 1, lastUsedAt: 1, modelId: 'openai-codex/gpt-5.6-sol',
            };
        },
        closeSession: async (sessionId: string) => {
            closed.push(sessionId);
            return { ok: true as const };
        },
    } as unknown as ReturnType<typeof createCodeApiClient>;
    const result = await createCodeSessionForGeneration(
        client, '/repo', 'openai-codex/gpt-5.6-sol',
        { signal: controller.signal, isCurrent: () => false },
    );
    assert.equal(result, null);
    assert.deepEqual(closed, ['old-port-session']);
});

test('same-port session generation rejects delayed authority from session A after opening B', () => {
    const loadA = 7;
    let current = loadA;
    current += 1; // user opens session B on the same worker port
    assert.equal(isCurrentCodeSessionGeneration(loadA, current), false);
    assert.equal(isCurrentCodeSessionGeneration(current, current), true);
});

test('stale Code create cleanup failure surfaces a console warning and still resolves null', async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
        const client = {
            newSession: async () => ({
                sessionId: 'orphan-session', cwd: '/repo', status: 'idle' as const,
                createdAt: 1, lastUsedAt: 1, modelId: 'openai-codex/gpt-5.6-sol',
            }),
            closeSession: async () => { throw new Error('DELETE 500'); },
        } as unknown as ReturnType<typeof createCodeApiClient>;
        const controller = new AbortController();
        const result = await createCodeSessionForGeneration(
            client, '/repo', 'openai-codex/gpt-5.6-sol',
            { signal: controller.signal, isCurrent: () => false },
        );
        assert.equal(result, null);
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0]?.[1], 'orphan-session');
        assert.ok(warnings[0]?.[2] instanceof Error);
    } finally {
        console.warn = originalWarn;
    }
});

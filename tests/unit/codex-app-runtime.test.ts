import test from 'node:test';
import assert from 'node:assert/strict';
import {
    loadCatalogEfforts,
    validateModelEffort,
    type CatalogEfforts,
} from '../../src/agent/codex-app-catalog.ts';
import {
    CodexAppClient,
    isRecoverableResumeError,
} from '../../src/agent/codex-app-client.ts';

type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

function injectRequest(client: CodexAppClient, handler: RequestHandler): void {
    Object.defineProperty(client, 'request', { value: handler });
}

test('validateModelEffort fails open without a catalog', () => {
    assert.deepEqual(
        validateModelEffort('gpt-5.5', 'high', new Map()),
        { ok: true, skipped: 'no-catalog' },
    );
});

test('validateModelEffort fails open when the model is not listed', () => {
    const efforts: CatalogEfforts = new Map([['gpt-5.5', new Set(['medium'])]]);
    assert.deepEqual(
        validateModelEffort('other-model', 'high', efforts),
        { ok: true, skipped: 'model-not-listed' },
    );
});

test('validateModelEffort accepts a supported effort', () => {
    const efforts: CatalogEfforts = new Map([['gpt-5.5', new Set(['medium', 'high'])]]);
    assert.deepEqual(validateModelEffort('gpt-5.5', 'high', efforts), { ok: true });
});

test('validateModelEffort rejects an unsupported effort with the supported list', () => {
    const efforts: CatalogEfforts = new Map([['gpt-5.5', new Set(['low', 'medium'])]]);
    assert.deepEqual(
        validateModelEffort('gpt-5.5', 'high', efforts),
        {
            ok: false,
            error: 'effort "high" is not supported by gpt-5.5 (supported: low, medium)',
        },
    );
});

test('validateModelEffort retries a bracket-suffix-stripped slug after exact lookup', () => {
    const fallbackEfforts: CatalogEfforts = new Map([['kimi/k3', new Set(['high'])]]);
    assert.deepEqual(validateModelEffort('kimi/k3[1m]', 'high', fallbackEfforts), { ok: true });

    const exactEfforts: CatalogEfforts = new Map([
        ['kimi/k3[1m]', new Set(['low'])],
        ['kimi/k3', new Set(['high'])],
    ]);
    assert.deepEqual(
        validateModelEffort('kimi/k3[1m]', 'high', exactEfforts),
        {
            ok: false,
            error: 'effort "high" is not supported by kimi/k3[1m] (supported: low)',
        },
    );
});

test('loadCatalogEfforts fails open when the catalog does not exist', () => {
    assert.equal(loadCatalogEfforts('/definitely/missing/codex-model-catalog.json').size, 0);
});

test('isRecoverableResumeError classifies missing-thread wire errors only', () => {
    const liveWireMessage = 'JSON-RPC error -32600: no rollout found for thread id 00000000-0000-0000-0000-000000000000';
    assert.equal(isRecoverableResumeError(liveWireMessage), true);
    assert.equal(isRecoverableResumeError('unknown thread abc'), true);
    assert.equal(isRecoverableResumeError('connect ECONNREFUSED 127.0.0.1:1234'), false);
    assert.equal(isRecoverableResumeError('Process exited'), false);
});

test('listModels follows nextCursor and forwards includeHidden on every page', async () => {
    const client = new CodexAppClient();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    injectRequest(client, async (method, params) => {
        requests.push({ method, params });
        if (requests.length === 1) return { data: ['first'], nextCursor: 'page-2' };
        return { data: ['second'], nextCursor: null };
    });

    assert.deepEqual(await client.listModels({ includeHidden: true }), ['first', 'second']);
    assert.deepEqual(requests, [
        { method: 'model/list', params: { includeHidden: true } },
        { method: 'model/list', params: { cursor: 'page-2', includeHidden: true } },
    ]);
});

test('interrupt latch sends cancel when turn/started arrives after initialization', async () => {
    const client = new CodexAppClient();
    client.threadId = 'thread-1';
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    injectRequest(client, async (method, params) => {
        requests.push({ method, params });
        return {};
    });

    await client.interruptTurn();
    client['handleLine'](JSON.stringify({
        method: 'turn/started',
        params: { turn: { id: 'turn-init' } },
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(requests, [{
        method: 'turn/interrupt',
        params: { threadId: 'thread-1', turnId: 'turn-init' },
    }]);
});

test('interrupt latch sends cancel when requested during turn/start', async () => {
    const client = new CodexAppClient();
    client.threadId = 'thread-2';
    let resolveStart!: (result: unknown) => void;
    const startResult = new Promise<unknown>((resolve) => { resolveStart = resolve; });
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    injectRequest(client, async (method, params) => {
        requests.push({ method, params });
        if (method === 'turn/start') return startResult;
        return {};
    });

    const starting = client.startTurn('hello');
    await client.interruptTurn();
    resolveStart({ turn: { id: 'turn-starting' } });
    await starting;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(requests, [
        {
            method: 'turn/start',
            params: {
                threadId: 'thread-2',
                input: [{ type: 'text', text: 'hello', text_elements: [] }],
                effort: 'medium',
                summary: 'detailed',
            },
        },
        {
            method: 'turn/interrupt',
            params: { threadId: 'thread-2', turnId: 'turn-starting' },
        },
    ]);
});

test('interrupt latch ignores terminal turn races', async () => {
    const client = new CodexAppClient();
    client.threadId = 'thread-3';
    let failures = 0;
    client.on('interrupt-failed', () => { failures += 1; });
    injectRequest(client, async () => {
        throw new Error('unknown turn turn-terminal');
    });

    await client.interruptTurn();
    client['handleLine'](JSON.stringify({
        method: 'turn/started',
        params: { turn: { id: 'turn-terminal' } },
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(failures, 0);
});

test('interrupt latch emits interrupt-failed for transport errors', async () => {
    const client = new CodexAppClient();
    client.threadId = 'thread-4';
    injectRequest(client, async () => {
        throw new Error('stdin not writable');
    });
    const failure = new Promise<Error>((resolve) => client.once('interrupt-failed', resolve));

    await client.interruptTurn();
    client['handleLine'](JSON.stringify({
        method: 'turn/started',
        params: { turn: { id: 'turn-transport' } },
    }));

    assert.match((await failure).message, /stdin not writable/);
});

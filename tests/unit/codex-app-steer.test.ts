// wp2 (devlog/_plan/260903_steer_default_context/020): codex-app native
// same-turn steer (turn/steer) — wire shape, error taxonomy, spawn routing.
// Must be the FIRST import: config.ts binds DB_PATH at module evaluation.
import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppClient, CodexSteerError } from '../../src/agent/codex-app-client.ts';
import { activeMainProcesses, canSteerAgent, steerAgent } from '../../src/agent/spawn.ts';
import { getRecentMessagesAll } from '../../src/core/db.ts';

type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;
const laneOptions = { model: 'gpt-5.5', effort: 'medium', cwd: '/tmp', fastMode: false };

function injectRequest(client: CodexAppClient, handler: RequestHandler): void {
    Object.defineProperty(client, 'request', { value: handler });
}

async function clientWithLiveTurn(scope: string, steerHandler?: RequestHandler): Promise<{
    client: CodexAppClient;
    requests: Array<{ method: string; params: Record<string, unknown> }>;
}> {
    const client = new CodexAppClient();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    injectRequest(client, async (method, params) => {
        requests.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') return { turn: { id: 'turn-1' } };
        if (method === 'turn/steer' && steerHandler) return steerHandler(method, params);
        if (method === 'turn/steer') return { turnId: 'turn-1' };
        return {};
    });
    await client.startThread(scope, laneOptions);
    await client.startTurn(scope, 'original task');
    requests.length = 0;
    return { client, requests };
}

// ─── CS-001: steerTurn wire shape (protocol: app-server-protocol v2/turn.rs) ───

test('CS-001: steerTurn sends turn/steer with threadId, expectedTurnId, text input, clientUserMessageId', async () => {
    const { client, requests } = await clientWithLiveTurn('scope-cs001');
    const result = await client.steerTurn('scope-cs001', 'focus on failing tests first', { clientUserMessageId: 'msg-1' });
    assert.equal(result.turnId, 'turn-1');
    assert.deepEqual(requests, [{
        method: 'turn/steer',
        params: {
            threadId: 'thread-1',
            expectedTurnId: 'turn-1',
            input: [{ type: 'text', text: 'focus on failing tests first', text_elements: [] }],
            clientUserMessageId: 'msg-1',
        },
    }]);
});

test('CS-002: steerTurn without an active turn throws CodexSteerError no-active-turn', async () => {
    const client = new CodexAppClient();
    injectRequest(client, async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        return {};
    });
    await client.startThread('scope-cs002', laneOptions);
    await assert.rejects(
        () => client.steerTurn('scope-cs002', 'too late'),
        (err: unknown) => err instanceof CodexSteerError && err.code === 'no-active-turn',
    );
});

test('CS-003: server not-steerable error maps to CodexSteerError not-steerable with turnKind', async () => {
    const { client } = await clientWithLiveTurn('scope-cs003', async () => {
        const err = new Error('JSON-RPC error -32600: cannot steer a review turn');
        (err as Error & { data?: unknown }).data = { codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'review' } } };
        throw err;
    });
    await assert.rejects(
        () => client.steerTurn('scope-cs003', 'redirect the review'),
        (err: unknown) => err instanceof CodexSteerError && err.code === 'not-steerable' && err.turnKind === 'review',
    );
});

test('CS-004: expectedTurnId race maps to CodexSteerError turn-mismatch', async () => {
    const { client } = await clientWithLiveTurn('scope-cs004', async () => {
        throw new Error('JSON-RPC error -32600: expectedTurnId does not match active turn turn-9');
    });
    await assert.rejects(
        () => client.steerTurn('scope-cs004', 'stale redirect'),
        (err: unknown) => err instanceof CodexSteerError && err.code === 'turn-mismatch',
    );
});

test('CS-005: unstructured rpc errors propagate unchanged (no CodexSteerError wrap)', async () => {
    const { client } = await clientWithLiveTurn('scope-cs005', async () => {
        throw new Error('stdin not writable');
    });
    await assert.rejects(
        () => client.steerTurn('scope-cs005', 'anything'),
        (err: unknown) => !(err instanceof CodexSteerError) && (err as Error).message === 'stdin not writable',
    );
});

test('CS-006: JSON-RPC error responses preserve error.data on the rejection', async () => {
    const client = new CodexAppClient();
    const seen = new Promise<Error>((resolve) => {
        // Seed a pending request the way request() does, then answer it with an
        // error carrying a structured payload (codexErrorInfo).
        (client as unknown as { pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }> })
            .pending.set(42, { resolve: () => {}, reject: resolve });
    });
    (client as unknown as { handleLine: (line: string) => void }).handleLine(JSON.stringify({
        id: 42,
        error: {
            code: -32600,
            message: 'cannot steer a compact turn',
            data: { codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'compact' } } },
        },
    }));
    const err = await seen;
    assert.match(err.message, /-32600.*compact/);
    assert.deepEqual(
        (err as Error & { data?: unknown }).data,
        { codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'compact' } } },
        'structured data must survive so steerTurn can map not-steerable',
    );
});

// ─── CS-007..010: spawn-side routing ───

type FakeRun = {
    process: null;
    starting: boolean;
    steering: boolean;
    ownerGeneration: number;
    meta: { origin: string; cli: string; chatSessionId?: string };
    steerTurnInBand?: (text: string) => Promise<'steered' | 'unavailable' | 'rejected'>;
};

function installFakeCodexAppRun(scope: string, outcome: 'steered' | 'unavailable' | 'rejected'): { calls: string[] } {
    const calls: string[] = [];
    const run: FakeRun = {
        process: null,
        starting: false,
        steering: false,
        ownerGeneration: 0,
        meta: { origin: 'web', cli: 'codex-app', chatSessionId: 'cs-spawn' },
        steerTurnInBand: async (text: string) => { calls.push(text); return outcome; },
    };
    activeMainProcesses.set(scope, run as never);
    return { calls };
}

test('CS-007: canSteerAgent is true while a codex-app steer hook is installed', () => {
    installFakeCodexAppRun('cs007', 'steered');
    try {
        assert.equal(canSteerAgent('cs007'), true);
    } finally {
        activeMainProcesses.delete('cs007');
    }
    assert.equal(canSteerAgent('cs007'), false);
});

test('CS-008: steerAgent routes in-band for codex-app and inserts the user row once accepted', async () => {
    const { calls } = installFakeCodexAppRun('cs008', 'steered');
    try {
        const outcome = await steerAgent('cs008', 'remember the context', 'test', { chatSessionId: 'cs-spawn' });
        assert.equal(outcome, 'steered');
        assert.deepEqual(calls, ['remember the context']);
        const rows = getRecentMessagesAll.all('cs-spawn', 5) as Array<{ role: string; content: string }>;
        assert.ok(rows.some(r => r.role === 'user' && r.content === 'remember the context'),
            'accepted steer writes the user row');
    } finally {
        activeMainProcesses.delete('cs008');
    }
});

test('CS-009: rejected steer (review/compact turn) falls back to queue WITHOUT inserting', async () => {
    installFakeCodexAppRun('cs009', 'rejected');
    try {
        const outcome = await steerAgent('cs009', 'queued instead', 'test', { chatSessionId: 'cs-spawn2' });
        assert.equal(outcome, 'fallback-queue');
        const rows = getRecentMessagesAll.all('cs-spawn2', 5) as Array<{ role: string; content: string }>;
        assert.ok(!rows.some(r => r.content === 'queued instead'),
            'unaccepted steer must not insert — the queue path owns the insert');
    } finally {
        activeMainProcesses.delete('cs009');
    }
});

test('CS-010: raced steer (turn ended) falls back to queue', async () => {
    installFakeCodexAppRun('cs010', 'unavailable');
    try {
        const outcome = await steerAgent('cs010', 'too late', 'test', { chatSessionId: 'cs-spawn3' });
        assert.equal(outcome, 'fallback-queue');
    } finally {
        activeMainProcesses.delete('cs010');
    }
});

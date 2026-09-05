import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshActivityIdentity } from '../../bin/commands/tui/api.js';

const makeContext = (): Parameters<typeof refreshActivityIdentity>[0] => ({
    apiUrl: 'http://127.0.0.1:3457', isRaw: false,
    activityIdentity: { sessionId: 'old', scope: 'local:old' }, activityIdentityGeneration: 0,
});
const response = (sessionId: string) => Response.json({ ok: true,
    data: { activityIdentity: { sessionId, scope: `local:${sessionId}` } } });

test('snapshot identity is invalid during refresh and late responses cannot change ownership', async () => {
    const ctx = makeContext();
    const pending: Array<(value: Response) => void> = [];
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Promise<Response>(resolve => pending.push(resolve));
    try {
        const first = refreshActivityIdentity(ctx);
        assert.equal(ctx.activityIdentity, null);
        const second = refreshActivityIdentity(ctx);
        pending[1]!(response('new'));
        await second;
        pending[0]!(response('stale'));
        await first;
        assert.deepEqual(ctx.activityIdentity, { sessionId: 'new', scope: 'local:new' });
    } finally { globalThis.fetch = original; }
});

test('missing malformed or failed snapshot never invents a default session', async () => {
    const original = globalThis.fetch;
    try {
        for (const body of [{}, { data: {} }, { data: { activityIdentity: { sessionId: 's' } } },
            { data: { activityIdentity: { sessionId: '', scope: 'default' } } }]) {
            const ctx = makeContext();
            globalThis.fetch = async () => Response.json(body);
            await refreshActivityIdentity(ctx);
            assert.equal(ctx.activityIdentity, null);
        }
        const ctx = makeContext();
        globalThis.fetch = async () => Response.json({ error: 'unavailable' }, { status: 503 });
        await refreshActivityIdentity(ctx);
        assert.equal(ctx.activityIdentity, null);
    } finally { globalThis.fetch = original; }
});

test('raw startup makes no additional snapshot request', async () => {
    const ctx = makeContext();
    ctx.isRaw = true;
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; return response('unexpected'); };
    try {
        await refreshActivityIdentity(ctx);
        assert.equal(calls, 0);
        assert.equal(ctx.activityIdentity, null);
    } finally { globalThis.fetch = original; }
});

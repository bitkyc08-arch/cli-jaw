import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
let loaded: Promise<unknown>;
mock.module('../../src/agent/runtime/claude-sdk-loader.js', { namedExports: { loadClaudeSdk: () => loaded } });
mock.module('../../src/trace/store.js', { namedExports: { appendTraceEvent: () => null } });
const { createClaudeSdkSession } = await import('../../src/agent/runtime/claude-sdk-session.ts');
function setup() {
    let release!: (sdk: unknown) => void, close!: () => void;
    loaded = new Promise(resolve => { release = resolve; });
    const closed = new Promise<void>(resolve => { close = resolve; });
    const calls: unknown[] = [];
    const sdk = { query: ({ options }: { options: unknown }) => {
        calls.push(options);
        return { close, async *[Symbol.asyncIterator]() { await closed; } };
    } };
    const controller = new AbortController();
    const options = { prepared: { cwd: process.cwd(), binary: process.execPath, env: { SNAPSHOT: 'initial' }, model: 'haiku',
        systemPrompt: 'initial instructions', permissions: 'safe' as 'safe' | 'auto', fastMode: false,
        effort: 'low' as 'low' | 'high', resumeSessionId: 'initial-sid' },
        signal: controller.signal, promptTimeoutMs: 1000, closeTimeoutMs: 100,
        getTurnContext: () => { throw new Error('No prompt in acquisition fixture'); } };
    return { options, controller, calls, release: () => release(sdk) };
}
test('prepared settings are captured before the asynchronous SDK load', async () => {
    const f = setup(); const acquiring = createClaudeSdkSession(f.options);
    f.options.prepared.permissions = 'auto'; f.options.prepared.model = 'changed';
    f.options.prepared.env.SNAPSHOT = 'changed'; f.options.prepared.fastMode = true;
    f.options.prepared.systemPrompt = 'changed'; f.options.prepared.effort = 'high'; f.options.prepared.resumeSessionId = 'changed';
    f.release(); const session = await acquiring;
    try {
        const options = f.calls[0] as Record<string, unknown>;
        assert.equal(options.permissionMode, 'default'); assert.equal(options.model, 'haiku');
        assert.deepEqual(options.env, { SNAPSHOT: 'initial' }); assert.equal(options.effort, 'low');
        assert.equal(options.resume, 'initial-sid'); assert.equal(options.settings, undefined);
        assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'initial instructions' });
    } finally { await session.close(); }
});
test('original acquisition signal remains authoritative even if the caller replaces the property', async () => {
    const f = setup(); const acquiring = createClaudeSdkSession(f.options);
    f.options.signal = new AbortController().signal; f.controller.abort(); f.release();
    let unexpected;
    try { await assert.rejects(acquiring.then(session => { unexpected = session; return session; }), /acquire_aborted/); }
    finally { await unexpected?.close(); }
    assert.equal(f.calls.length, 0);
});

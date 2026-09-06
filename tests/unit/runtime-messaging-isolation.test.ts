import '../setup/isolated-home.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../src/core/db.js';
import { createChatSession } from '../../src/core/chat-sessions.js';
import { addBroadcastListener, removeBroadcastListener, broadcast, type BroadcastListener } from '../../src/core/bus.js';
import { subscribe, type BusEvent } from '../../src/core/event-bus.js';
import { recordRuntimeEvent, type RuntimeEventContext } from '../../src/agent/runtime/events.js';
import { RuntimeProjection } from '../../src/agent/runtime/projection.js';
import { startTraceRun, finalizeTraceRun } from '../../src/trace/store.js';
import { readActivityPage } from '../../src/trace/activity-journal.js';
import type { RuntimeEventBody, RuntimeRequestView } from '../../src/shared/runtime-contract.js';
import { createSlackForwarder } from '../../src/slack/forwarder.js';
import { createDiscordForwarder } from '../../src/discord/forwarder.js';
import { createTelegramForwarder } from '../../src/telegram/forwarder.js';

const CANARY = 'ACTIVITY_SECRET_CANARY_wp21';
const secret = JSON.stringify({ password: CANARY });
const FINAL = 'FINAL CHANNEL ANSWER';
type Channel = 'slack' | 'discord' | 'telegram';
type EndStatus = 'done' | 'error' | 'stopped';

// Same supported request shape as runtime-event-emitter.test.ts. The real codec
// must sanitize it; a fabricated native option/callback is not decision authority.
const view: RuntimeRequestView = { title: secret, fields: [{ id: 'decision', label: 'Choose',
    options: [{ id: 'allow', label: 'Allow once' }], multiSelect: false, allowFreeform: false }] };

function bodies(status: EndStatus): RuntimeEventBody[] {
    // Compile-time exhaustiveness by kind; adding a RuntimeEvent variant requires
    // an explicit sink-isolation scenario rather than silently missing coverage.
    const cases: { [K in RuntimeEventBody['kind']]: Array<Extract<RuntimeEventBody, { kind: K }>> } = {
        'turn-start': [{ kind: 'turn-start', provider: 'fixture' }],
        message: (['unknown', 'commentary', 'final'] as const).flatMap(phase =>
            (['append', 'replace'] as const).map(operation => ({ kind: 'message' as const,
                itemId: 'message-' + phase, phase, text: secret, operation }))),
        reasoning: [{ kind: 'reasoning', itemId: 'thought', text: secret, operation: 'append' },
            { kind: 'reasoning', itemId: 'thought', text: secret, operation: 'replace' }],
        tool: (['running', 'done', 'error', 'stopped'] as const).map(toolStatus => ({
            kind: 'tool', itemId: 'tool-' + toolStatus, name: 'Read', status: toolStatus,
            input: secret, output: secret, detail: secret })),
        request: (['approval', 'question'] as const).map(requestType => ({
            kind: 'request', requestId: 'request-' + requestType, requestType, view })),
        'request-settled': ['approval', 'question'].map(kind => ({ kind: 'request-settled', requestId: 'request-' + kind })),
        usage: [{ kind: 'usage', inputTokens: 3, outputTokens: 2, cachedTokens: 1 }],
        'turn-end': [{ kind: 'turn-end', status, finalText: secret, ...(status === 'error' ? { error: secret } : {}) }],
    };
    return Object.values(cases).flat();
}

async function sinks(t: TestContext, exercise: (h: {
    sse: BusEvent[]; quiet(): Promise<void>; legacyFinal(replay?: () => void): Promise<void>;
}) => Promise<void>): Promise<void> {
    const sends: Array<{ channel: Channel; text: unknown }> = [];
    const fetches: string[] = [];
    const invocations: Channel[] = [];
    const legacy: string[] = [];
    const pending: Promise<unknown>[] = [];
    const sse: BusEvent[] = [];
    // No network fallback: every fetch is intercepted, including unexpected URLs.
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
        fetches.push(String(url));
        assert.equal(String(url), 'https://slack.com/api/chat.postMessage');
        assert.equal(init?.method, 'POST');
        const payload = JSON.parse(String(init?.body)) as { channel: string; text: string };
        assert.equal(payload.channel, 'C-fixture');
        sends.push({ channel: 'slack', text: payload.text });
        return new Response(JSON.stringify({ ok: true, ts: '1.1' }), { status: 200 });
    });
    // Narrow structural vendor fakes: production forwarders/chunkers remain real.
    const discord = { channels: { fetch: async (id: string) => {
        assert.equal(id, 'D-fixture');
        return { send: async (text: unknown) => { sends.push({ channel: 'discord', text }); } };
    } } } as unknown as Parameters<typeof createDiscordForwarder>[0]['client'];
    const telegram = { api: { sendMessage: async (id: string | number, text: string) => {
        assert.equal(id, 'T-fixture'); sends.push({ channel: 'telegram', text });
        return { message_id: 1 };
    } } } as unknown as Parameters<typeof createTelegramForwarder>[0]['bot'];
    const forwarders = {
        slack: createSlackForwarder({ getToken: () => 'fixture-token', getLastTarget: () => ({
            channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C-fixture' }) }),
        discord: createDiscordForwarder({ client: discord, getLastTarget: () => ({
            channel: 'discord', targetKind: 'channel', peerKind: 'channel', targetId: 'D-fixture' }) }),
        telegram: createTelegramForwarder({ bot: telegram, getLastChatId: () => 'T-fixture', prefix: '' }),
    };
    const observers: BroadcastListener[] = [(type) => { legacy.push(type); }];
    for (const channel of ['slack', 'discord', 'telegram'] as const) {
        observers.push((type, data) => {
            invocations.push(channel);
            pending.push(Promise.resolve(forwarders[channel](type, data)));
        });
    }
    observers.forEach(addBroadcastListener);
    const unsubscribe = subscribe(event => sse.push(event));
    const drain = async () => {
        await Promise.all(pending.splice(0));
        // Telegram exposes a void handler. Its fake transport resolves immediately;
        // one event-loop turn drains that bounded microtask chain, not a timed sleep.
        await new Promise<void>(resolve => setImmediate(resolve));
    };
    try {
        await exercise({ sse,
            quiet: async () => {
                await drain();
                assert.deepEqual(legacy, []); assert.deepEqual(invocations, []);
                assert.deepEqual(fetches, []); assert.deepEqual(sends, []);
            },
            legacyFinal: async replay => {
                broadcast('agent_done', { origin: 'web', text: FINAL });
                await drain();
                replay?.();
                await drain();
                assert.deepEqual(legacy, ['agent_done']);
                assert.deepEqual(invocations, ['slack', 'discord', 'telegram']);
                assert.deepEqual(fetches, ['https://slack.com/api/chat.postMessage']);
                assert.equal(sends.length, 3);
                for (const channel of ['slack', 'discord', 'telegram']) {
                    assert.deepEqual(sends.filter(send => send.channel === channel), [{ channel, text: FINAL }]);
                }
                assert.equal(JSON.stringify(sends).includes(CANARY), false);
            },
        });
    } finally {
        await drain(); observers.forEach(removeBroadcastListener); unsubscribe();
    }
}

function owner(audience: 'public' | 'internal'): RuntimeEventContext {
    const sessionId = createChatSession('runtime messaging isolation').id;
    const scope = 'runtime-sink:' + sessionId;
    const runId = startTraceRun({ cli: 'fixture', sessionId, scopeKey: scope, audience });
    return { runId, sessionId, scope, audience, turnId: runId };
}

for (const audience of ['public', 'internal'] as const) {
    for (const status of ['done', 'error', 'stopped'] as const) {
        test(`${audience}/${status}: all Activity kinds and replay bypass real channel forwarders`, { timeout: 10_000 }, async t => {
            const context = owner(audience); // Admission broadcasts precede sink instrumentation.
            await sinks(t, async h => {
                const events = bodies(status).map(body => {
                    const event = recordRuntimeEvent(context, body);
                    assert.ok(event, `real journal rejected ${body.kind}`); return event;
                });
                finalizeTraceRun(context.runId, status === 'stopped' ? 'interrupted' : status);
                assert.equal(JSON.stringify(events).includes(CANARY), false);
                assert.equal(h.sse.length, audience === 'public' ? events.length : 0);
                if (audience === 'public') assert.deepEqual(h.sse.map(event => event.data), events);
                await h.quiet();

                const page = readActivityPage({ runId: context.runId, sessionId: context.sessionId, after: 0, limit: 40 });
                if (audience === 'internal') assert.equal(page, null);
                else {
                    assert.ok(page);
                    assert.deepEqual(page.events, events); assert.equal(page.incomplete, false);
                    // Even an accidental replay through broadcast is presentation-only.
                    for (const event of page.events) broadcast('agent_runtime', { ...event });
                    assert.equal(JSON.stringify(page).includes(CANARY), false);
                }
                broadcast('agent_runtime_gap', { ...context, reason: 'projection_degraded', text: CANARY }, audience);
                broadcast('agent_runtime', { ...context, kind: 'future-unknown-kind', text: CANARY }, audience);
                await h.quiet();
                await h.legacyFinal(() => {
                    for (const event of page?.events ?? []) broadcast('agent_runtime', { ...event });
                    broadcast('agent_runtime_gap', { ...context, reason: 'projection_degraded' }, audience);
                });
            });
        });
    }
}

test('real journal insert failure emits one gap, never a channel send or synthetic final', { timeout: 10_000 }, async t => {
    const context = owner('public');
    await sinks(t, async h => {
        const projection = new RuntimeProjection(context);
        projection.start('fixture');
        db.exec(`CREATE TEMP TRIGGER messaging_activity_fail BEFORE INSERT ON trace_events
            WHEN new.source='runtime' BEGIN SELECT RAISE(ABORT, 'fixture journal failure'); END`);
        try {
            projection.tool('tool', { name: 'Read', status: 'running', output: secret });
            projection.tool('tool', { status: 'done', output: secret });
        } finally { db.exec('DROP TRIGGER messaging_activity_fail'); }
        assert.deepEqual(h.sse.map(event => event.event), ['agent_runtime', 'agent_runtime_gap']);
        assert.equal(JSON.stringify(h.sse).includes(CANARY), false);
        finalizeTraceRun(context.runId, 'done');
        const page = readActivityPage({ runId: context.runId, sessionId: context.sessionId, after: 0, limit: 40 });
        assert.ok(page);
        assert.equal(page.loss, 'storage_error'); assert.equal(page.incomplete, true);
        assert.deepEqual(page.events.map(event => event.kind), ['turn-start']);
        await h.quiet();
        await h.legacyFinal();
    });
});

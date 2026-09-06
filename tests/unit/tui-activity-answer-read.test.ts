import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createTuiStore } from '../../src/cli/tui/store.js';
import { createActivityItem } from '../../src/cli/tui/activity.js';
import { handleWsMessage } from '../../bin/commands/tui/ws-handler.js';
import { requestTuiActivityAnswer, cancelTuiActivityAnswers } from '../../bin/commands/tui/activity-answer-read.js';
import { releaseCommittedActivity, invalidateActivityContext, restoreActiveActivity } from '../../bin/commands/tui/activity-replay.js';
import type { TuiContext } from '../../bin/commands/tui/types.js';

const base = { version: 1 as const, sessionId: 'chat', scope: 'local:chat', runId: 'run', turnId: 'turn' };
function context(): TuiContext {
    return { apiUrl: 'http://127.0.0.1:1', isRaw: false, settingsSnapshot: {}, activityIdentity: { sessionId: 'chat', scope: 'local:chat' },
        activityIdentityGeneration: 0, store: createTuiStore(), displayMode: 'fullscreen', requestFrame() {},
        ws: { send() {}, close() {} }, info: { cli: 'cursor', model: 'test', workingDir: '/tmp' },
        label: 'cursor', accent: '', dir: '/tmp', runtimeLocale: 'en', tuiConfig: {},
        inputActive: true, streaming: false, streamState: 'idle', turnStartedAt: 0, footerTimer: null,
        ideEnabled: false, idePopEnabled: false, preFileSetQueue: [], bgtaskTasks: [], bgtaskCount: 0,
    } as unknown as TuiContext;
}
const wire = (ctx: TuiContext, body: Record<string, unknown>) => handleWsMessage(ctx, Buffer.from(JSON.stringify(body)));
const event = (ctx: TuiContext, body: Record<string, unknown>) => wire(ctx, { type: 'agent_runtime', ...base, ...body });
const done = (ctx: TuiContext, body: Record<string, unknown> = {}) => wire(ctx, { type: 'agent_done', traceRunId: 'run',
    sessionId: 'chat', scope: 'local:chat', runtimeFinality: 'present', runtimeStatus: 'done', text: 'compat', ...body });
const saved = (content: string | null, runId = 'run') => Response.json({ ok: true, data: { message: content === null ? null : {
    id: 1, role: 'assistant', content, trace_run_id: runId, session_id: 'chat',
} } });
const answers = (ctx: TuiContext) => ctx.store.transcript.items.filter(i => i.type === 'assistant' && i.activityKey);
async function idle(ctx: TuiContext) {
    for (let i = 0; i < 80 && (ctx.activityAnswers?.active || ctx.activityAnswers?.queue.length); i++) await setImmediate();
    assert.ok(!ctx.activityAnswers?.active && !ctx.activityAnswers?.queue.length, 'bounded answer queue drained');
}
function cleanup(ctx: TuiContext) { if (ctx.footerTimer) clearInterval(ctx.footerTimer); cancelTuiActivityAnswers(ctx); }

for (const text of ['EXACT '.repeat(7000), ' \r\n\t', '']) {
    test(`canonical redacted text never becomes public answer; saved ${text.length} bytes wins compatibility`, async () => {
        const ctx = context(); const original = globalThis.fetch;
        let finish!: (r: Response) => void;
        globalThis.fetch = async () => new Promise<Response>(resolve => { finish = resolve; });
        try {
            event(ctx, { seq: 1, kind: 'turn-start', provider: 'cursor' });
            event(ctx, { seq: 2, kind: 'turn-end', status: 'done', finalText: 'REDACTED_PREVIEW' });
            assert.equal(answers(ctx).length, 0);
            done(ctx, { text: text.trim() ? 'compat' : '' });
            finish(saved(text)); await idle(ctx);
            assert.equal(answers(ctx).length, 1);
            assert.equal(answers(ctx)[0]?.text, text);
            assert.equal(answers(ctx)[0]?.activitySource, 'saved');
            done(ctx, { text: 'late bad' });
            assert.equal(answers(ctx)[0]?.text, text);
        } finally { cleanup(ctx); globalThis.fetch = original; }
    });
}

test('saved-first terminal keeps exact answer and later compatibility cannot replace it', async () => {
    const ctx = context(); const original = globalThis.fetch;
    globalThis.fetch = async () => saved('exact');
    try {
        event(ctx, { seq: 1, kind: 'turn-start', provider: 'cursor' });
        event(ctx, { seq: 2, kind: 'turn-end', status: 'done', finalText: '[redacted]' });
        await idle(ctx); done(ctx, { text: 'not exact' });
        assert.equal(answers(ctx).length, 1); assert.equal(answers(ctx)[0]?.text, 'exact');
    } finally { cleanup(ctx); globalThis.fetch = original; }
});

for (const earlyCanonical of [false, true]) {
    test(`missing journal uses a real receipt without fake turn, canonical binds during lookup=${earlyCanonical}`, async () => {
        const ctx = context(); const original = globalThis.fetch; let calls = 0;
        let finish!: (r: Response) => void;
        globalThis.fetch = async () => { calls++; return new Promise<Response>(resolve => { finish = resolve; }); };
        try {
            done(ctx); const receipt = answers(ctx)[0]!;
            assert.equal(ctx.store.transcript.items.some(i => i.type === 'activity'), false);
            assert.equal(receipt.activityReadIdentity?.runId, 'run');
            if (earlyCanonical) event(ctx, { seq: 1, kind: 'turn-start', provider: 'cursor' });
            finish(saved('saved exact')); await idle(ctx);
            if (!earlyCanonical) event(ctx, { seq: 1, kind: 'turn-start', provider: 'cursor' });
            event(ctx, { seq: 2, kind: 'turn-end', status: 'done', finalText: 'redacted' });
            await idle(ctx);
            assert.equal(calls, 1); assert.equal(answers(ctx).length, 1);
            assert.equal(answers(ctx)[0], receipt); assert.equal(receipt.text, 'saved exact');
        } finally { cleanup(ctx); globalThis.fetch = original; }
    });
}

for (const status of [409, 413, 503, 200]) {
    test(`MESSAGE lookup ${status} never promotes journal or erases known compatibility`, async () => {
        const ctx = context(); const original = globalThis.fetch;
        globalThis.fetch = async () => status === 200 ? saved(null) : Response.json({ error: 'unavailable' }, { status });
        try {
            done(ctx); await idle(ctx);
            assert.equal(answers(ctx)[0]?.text, 'compat');
            assert.equal(answers(ctx)[0]?.answerReadState, status === 200 ? 'absent' : 'unavailable');
            assert.equal(answers(ctx)[0]?.activitySource, 'compatibility');
        } finally { cleanup(ctx); globalThis.fetch = original; }
    });
}

test('answer queue bounds pending refs, rejects late abort-ignoring replies and stale queued base before GET', async () => {
    const ctx = context(); const original = globalThis.fetch; let calls = 0;
    let finish!: (r: Response) => void;
    globalThis.fetch = async () => { calls++; return new Promise<Response>(resolve => { finish = resolve; }); };
    try {
        for (let i = 0; i < 18; i++) {
            const item = createActivityItem({ ...base, runId: `run${i}`, seq: 1, kind: 'turn-start', provider: 'cursor' });
            ctx.store.transcript.items.push(item); requestTuiActivityAnswer(ctx, item);
        }
        assert.equal(calls, 1); assert.equal(ctx.activityAnswers?.queue.length, 16);
        const last = ctx.store.transcript.items.at(-1)!;
        assert.equal(last.type === 'activity' && last.answerReadState, 'unavailable');
        ctx.apiUrl = 'http://127.0.0.1:2';
        finish(saved('stale', 'run0')); await idle(ctx);
        assert.equal(calls, 1); assert.equal(answers(ctx).length, 0);
    } finally { cleanup(ctx); globalThis.fetch = original; }
});

test('retirement cancels pending response, leaves new view and lifecycle alone', async () => {
    const ctx = context(); const original = globalThis.fetch; let finish!: (r: Response) => void;
    globalThis.fetch = async () => new Promise<Response>(resolve => { finish = resolve; });
    try {
        event(ctx, { seq: 1, kind: 'turn-start', provider: 'cursor' });
        event(ctx, { seq: 2, kind: 'turn-end', status: 'done', finalText: 'preview' });
        invalidateActivityContext(ctx);
        finish(saved('stale')); await setImmediate(); await setImmediate();
        assert.equal(answers(ctx).length, 0); assert.equal(ctx.activityAnswers, undefined);
        assert.equal(ctx.activityIdentity, null);
    } finally { cleanup(ctx); globalThis.fetch = original; }
});

test('unknown foreign compatibility cannot mutate local input, clocks, IDE or transcript', () => {
    const ctx = context();
    try {
        event(ctx, { seq: 1, kind: 'turn-start', provider: 'cursor' });
        ctx.inputActive = false;
        const originalItems = [...ctx.store.transcript.items]; const timer = ctx.footerTimer; const clock = ctx.turnStartedAt;
        for (const type of ['agent_chunk', 'agent_output', 'agent_tool', 'agent_status', 'agent_done', 'orchestrate_done']) {
            wire(ctx, { type, sessionId: 'foreign', scope: 'local:foreign', traceRunId: 'unknown',
                text: 'foreign text', status: 'done', runtimeFinality: 'present', runtimeStatus: 'done' });
        }
        assert.deepEqual(ctx.store.transcript.items, originalItems);
        assert.equal(ctx.inputActive, false); assert.equal(ctx.footerTimer, timer); assert.equal(ctx.turnStartedAt, clock);
    } finally { cleanup(ctx); }
});

test('same-chat missing-journal old terminal cannot finish an active newer canonical run', async () => {
    const ctx = context(); const original = globalThis.fetch;
    globalThis.fetch = async () => saved('old final');
    try {
        event(ctx, { runId: 'new', turnId: 'new', seq: 1, kind: 'turn-start', provider: 'cursor' });
        ctx.inputActive = false; const timer = ctx.footerTimer; const clock = ctx.turnStartedAt;
        done(ctx); await idle(ctx);
        assert.equal(ctx.inputActive, false); assert.equal(ctx.streaming, true);
        assert.equal(ctx.footerTimer, timer); assert.equal(ctx.turnStartedAt, clock);
    } finally { cleanup(ctx); globalThis.fetch = original; }
});

test('released equal saved result upgrades digest receipt without duplicating or repopulating text', async () => {
    const ctx = context(); const original = globalThis.fetch; let finish!: (r: Response) => void;
    globalThis.fetch = async () => new Promise<Response>(resolve => { finish = resolve; });
    try {
        done(ctx); releaseCommittedActivity(ctx, ctx.store.transcript.items.length);
        finish(saved('compat')); await idle(ctx);
        assert.equal(answers(ctx).length, 1); assert.equal(answers(ctx)[0]?.text, '');
        assert.equal(answers(ctx)[0]?.activitySource, 'saved');
    } finally { cleanup(ctx); globalThis.fetch = original; }
});

test('snapshot-owned newer B without a journal model retains preview and lifecycle after A terminal', async () => {
    const ctx = context(); const original = globalThis.fetch;
    globalThis.fetch = async () => saved('old final');
    try {
        ctx.activityActiveRunId = 'new';
        wire(ctx, { type: 'agent_output', ...ctx.activityIdentity, traceRunId: 'new', text: 'B provisional' });
        ctx.inputActive = false; const timer = ctx.footerTimer; const clock = ctx.turnStartedAt;
        done(ctx); await idle(ctx);
        assert.equal(ctx.inputActive, false); assert.equal(ctx.streaming, true);
        assert.equal(ctx.footerTimer, timer); assert.equal(ctx.turnStartedAt, clock);
        assert.ok(ctx.store.transcript.items.some(i => i.type === 'assistant' && i.text === 'B provisional' && i.streaming));
    } finally { cleanup(ctx); globalThis.fetch = original; }
});

for (const canonical of [true, false]) {
    test(`absent native error preserves bounded safe diagnostic without promoting final, journal=${canonical}`, async () => {
        const ctx = context(); const original = globalThis.fetch;
        globalThis.fetch = async () => saved(null);
        try {
            if (canonical) event(ctx, { seq: 1, kind: 'turn-start', provider: 'cursor' });
            done(ctx, { runtimeFinality: 'absent', runtimeStatus: 'error', text: '\x1b]52;c;SECRET\x07Provider startup failed' });
            await idle(ctx);
            done(ctx, { runtimeFinality: 'absent', runtimeStatus: 'error', text: 'duplicate' });
            const diagnostics = ctx.store.transcript.items.filter(i => i.type === 'command' && i.activityDiagnosticKey);
            assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0]?.text, 'Provider startup failed');
            assert.equal(answers(ctx)[0]?.activityFinality, 'absent'); assert.equal(answers(ctx)[0]?.text, '');
        } finally { cleanup(ctx); globalThis.fetch = original; }
    });
}

for (const released of [true, false]) {
    test(`reconnect adopts a compatibility-only receipt exactly once, released=${released}`, async () => {
        const ctx = context(); const original = globalThis.fetch;
        ctx.activityActiveRunId = 'run';
        let releasePage!: () => void; let savedCalls = 0;
        const records = [{ ...base, seq: 1, kind: 'turn-start', provider: 'cursor' },
            { ...base, seq: 2, kind: 'turn-end', status: 'done', finalText: 'redacted' }];
        globalThis.fetch = async input => {
            const url = new URL(String(input));
            if (url.pathname.endsWith('/snapshot')) return Response.json({ ok: true, data: {
                activityIdentity: ctx.activityIdentity ?? { sessionId: 'chat', scope: 'local:chat' }, activeRun: { traceRunId: 'run' } } });
            if (url.pathname.includes('/messages/by-trace/')) { savedCalls++; return saved('saved exact'); }
            if (url.searchParams.get('after') === '0') await new Promise<void>(resolve => { releasePage = resolve; });
            return Response.json({ ok: true, data: { runId: 'run', sessionId: 'chat', scope: 'local:chat',
                through: 2, nextAfter: 2, hasMore: false, incomplete: false, loss: null, status: 'done',
                events: url.searchParams.get('after') === '0' ? records : [] } });
        };
        try {
            const restoring = restoreActiveActivity(ctx);
            for (let i = 0; i < 20 && !releasePage; i++) await setImmediate();
            assert.ok(releasePage);
            done(ctx); await idle(ctx);
            if (released) releaseCommittedActivity(ctx, ctx.store.transcript.items.length);
            const receipt = answers(ctx)[0]!;
            releasePage(); await restoring; await idle(ctx);
            assert.equal(savedCalls, 1); assert.equal(answers(ctx).length, 1); assert.equal(answers(ctx)[0], receipt);
            assert.equal(receipt.text, released ? '' : 'saved exact');
            const model = ctx.store.transcript.items.find(i => i.type === 'activity');
            assert.equal(model?.type === 'activity' && model.answerKey, receipt.activityKey);
        } finally { cleanup(ctx); globalThis.fetch = original; }
    });
}

for (const status of ['error', 'stopped', 'done'] as const) {
    test(`missing journal and blank diagnostic show honest terminal status: ${status}`, async () => {
        for (const text of [undefined, '', ' \n']) {
            const ctx = context(); const original = globalThis.fetch;
            globalThis.fetch = async () => saved(null);
            try {
                done(ctx, { runtimeFinality: 'absent', runtimeStatus: status, text }); await idle(ctx);
                done(ctx, { runtimeFinality: 'absent', runtimeStatus: status, text });
                const diagnostics = ctx.store.transcript.items.filter(i => i.type === 'command' && i.activityDiagnosticKey);
                assert.equal(diagnostics.length, status === 'done' ? 0 : 1);
                if (status !== 'done') assert.match(diagnostics[0]!.text, status === 'error' ? /Run failed without a final answer/ : /Run stopped without a final answer/);
                assert.equal(answers(ctx)[0]?.activityFinality, 'absent'); assert.equal(answers(ctx)[0]?.text, '');
            } finally { cleanup(ctx); globalThis.fetch = original; }
        }
    });
}

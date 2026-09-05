import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTuiStore } from '../../src/cli/tui/store.js';
import type { TuiContext } from '../../bin/commands/tui/types.js';
import { loadTuiActivityHistory, closeTuiActivityHistory, routeActivityHistoryInput, handleActivityHistoryKey } from '../../bin/commands/tui/activity-history.js';
import { bindActivityContext, invalidateActivityContext, releaseCommittedActivity, restoreActiveActivity, getActivityReplay } from '../../bin/commands/tui/activity-replay.js';
import { handleKeyInput, flushPendingEscape } from '../../bin/commands/tui/input-handler.js';
import { handleWsMessage } from '../../bin/commands/tui/ws-handler.js';
import { apiJson } from '../../bin/commands/tui/api.js';
import { appendTextToComposer, getComposerDisplayText, consumePasteProtocol } from '../../src/cli/tui/composer.js';
import { splitKeyInput, classifyKeyAction } from '../../src/cli/tui/keymap.js';
import { createActivityItem, updateActivityItem } from '../../src/cli/tui/activity.js';
import { appendActivityAnswer } from '../../src/cli/tui/activity-answer.js';
import type { RuntimeEvent } from '../../src/shared/runtime-contract.js';

const runId = 'tr_0000000000000001';
const identity = { version: 1 as const, sessionId: 'chat', scope: 'local:chat', runId, turnId: 'turn' };
const event: RuntimeEvent = { ...identity, seq: 7, kind: 'tool', itemId: 'tool', name: 'Read', status: 'done', output: 'retained detail' };
function context(sent: string[] = []): TuiContext {
    const ctx: TuiContext = {
        ws: { transport: 'sse', on() {}, close() {}, send(value) { sent.push(value); } }, apiUrl: 'http://127.0.0.1:3457',
        info: { cli: 'codex-app', workingDir: '/tmp', model: 'test' }, accent: '', label: 'codex-app', dir: '/tmp', runtimeLocale: 'en',
        tuiConfig: { pasteCollapseLines: 2, pasteCollapseChars: 160 }, settingsSnapshot: {},
        activityIdentity: { sessionId: 'chat', scope: 'local:chat' }, activitySettlementIdentity: { sessionId: 'chat', scope: 'local:chat' },
        activityIdentityGeneration: 0, values: { port: '3457', raw: false, simple: false }, isRaw: false, store: createTuiStore(),
        overlayBoxHeight: 0, inputActive: true, streaming: false, streamState: 'idle', bgtaskCount: 0, bgtaskTasks: [],
        turnStartedAt: 0, streamSink: null, commandRunning: false, escPending: false, escTimer: null, footerTimer: null,
        editorChordPending: false, prevLineCount: 0, promptCursorRow: 0, resizeTimer: null, ideEnabled: false, idePopEnabled: false,
        preFileSetQueue: [], chatCwd: '/tmp', isGit: false, detectedIde: null, promptPrefix: '', footer: '',
        displayMode: 'fullscreen', requestFrame() {},
    };
    bindActivityContext(ctx);
    return ctx;
}
function cleanup(ctx: TuiContext): void {
    closeTuiActivityHistory(ctx);
    ctx.activityReplay?.reset();
    if (ctx.footerTimer) clearInterval(ctx.footerTimer);
    if (ctx.escTimer) clearTimeout(ctx.escTimer);
}
const page = (events: RuntimeEvent[] = [event], extras: Record<string, unknown> = {}) => Response.json({ ok: true, data: {
    runId, sessionId: 'chat', scope: 'local:chat', status: 'done', events, through: events.at(-1)?.seq ?? 7,
    nextAfter: events.at(-1)?.seq ?? 7, hasMore: false, incomplete: false, loss: null, ...extras,
} });
const discovery = () => Response.json({ ok: true, data: { runs: [{ id: runId, messageId: 1, status: 'done', startedAt: 1 }], pageSize: 40 } });

test('selected history loads one payload and descriptor discovery without moving selection', async () => {
    const ctx = context();
    const panel = ctx.store.overlay.activityHistory;
    Object.assign(panel, { open: true, runId, seq: 7, offset: 3, expanded: true });
    const paths: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async input => {
        paths.push(String(input));
        return String(input).includes('/activity-runs?') ? discovery() : page();
    };
    try {
        await loadTuiActivityHistory(ctx);
        assert.equal(panel.events[0]?.seq, 7);
        assert.equal(panel.seq, 7);
        assert.equal(panel.offset, 3);
        assert.equal(panel.loading, false);
        assert.equal(panel.message, '');
        assert.equal(paths.length, 2);
        assert.ok(paths.every(path => path.includes('session=chat')));
    } finally { globalThis.fetch = original; cleanup(ctx); }
});

test('next descriptor batch preserves the selected payload and does not refetch tool records', async () => {
    const ctx = context();
    const panel = ctx.store.overlay.activityHistory;
    Object.assign(panel, { open: true, runId, seq: 7, events: [event] });
    const events = panel.events;
    const after = 'tr_00000000000000ff';
    const paths: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async input => {
        const url = new URL(String(input)); paths.push(url.pathname);
        assert.equal(url.pathname, '/api/traces/activity-runs');
        assert.equal(url.searchParams.get('after'), after);
        return Response.json({ ok: true, data: { runs: [{ id: 'tr_0000000000000100', messageId: null, status: 'done', startedAt: 2 }], pageSize: 40 } });
    };
    try {
        await loadTuiActivityHistory(ctx, { after, records: false });
        assert.equal(panel.events, events);
        assert.equal(panel.runId, runId);
        assert.equal(panel.seq, 7);
        assert.equal(panel.runs[0]?.id, 'tr_0000000000000100');
        assert.equal(paths.length, 1);
    } finally { globalThis.fetch = original; cleanup(ctx); }
});

test('closing aborts the HTTP request and an uncooperative late read cannot change a new panel', async () => {
    const ctx = context();
    const panel = ctx.store.overlay.activityHistory;
    Object.assign(panel, { open: true, runId });
    let resolve!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
        signal = init?.signal as AbortSignal;
        return new Promise(done => { resolve = done; });
    };
    try {
        const loading = loadTuiActivityHistory(ctx);
        closeTuiActivityHistory(ctx);
        assert.equal(signal?.aborted, true);
        invalidateActivityContext(ctx);
        const next = ctx.store.overlay.activityHistory;
        next.open = true;
        next.message = 'new conversation';
        resolve(page());
        await loading;
        assert.equal(next.message, 'new conversation');
        assert.deepEqual(next.events, []);
    } finally { globalThis.fetch = original; cleanup(ctx); }
});

test('foreign-scope history is rejected without sending a prompt or replacing records', async () => {
    const sent: string[] = [];
    const ctx = context(sent);
    const panel = ctx.store.overlay.activityHistory;
    Object.assign(panel, { open: true, runId, events: [event] });
    const original = globalThis.fetch;
    globalThis.fetch = async () => page([{ ...event, scope: 'foreign' }], { scope: 'foreign' });
    try {
        await loadTuiActivityHistory(ctx);
        assert.deepEqual(panel.events, [event]);
        assert.match(panel.message, /History unavailable/);
        assert.deepEqual(sent, []);
    } finally { globalThis.fetch = original; cleanup(ctx); }
});

test('apiJson composes caller cancellation with its timeout', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
        received = init?.signal as AbortSignal;
        received.addEventListener('abort', () => reject(received!.reason), { once: true });
    });
    try {
        const reading = apiJson({ apiUrl: 'http://127.0.0.1' }, '/history', { signal: controller.signal });
        controller.abort(new Error('closed'));
        await assert.rejects(reading, /closed/);
        assert.equal(received?.aborted, true);
    } finally { globalThis.fetch = original; }
});

for (const reset of [false, true]) {
    test(`paste drain survives ${reset ? 'session reset' : 'asynchronous close'} without message or stop dispatch`, () => {
        const sent: string[] = [];
        const ctx = context(sent);
        ctx.store.overlay.activityHistory.open = true;
        appendTextToComposer(ctx.store.composer, 'draft');
        const route = (input: string) => routeActivityHistoryInput(ctx, input, key => handleKeyInput(ctx, key), { columns: 80, height: 18 });
        try {
            route('\x1b[20'); route('0~pasted\r');
            assert.equal(ctx.store.activityPasteDrain.active, true);
            if (reset) invalidateActivityContext(ctx); else closeTuiActivityHistory(ctx);
            route('\x03evil\r\x1b[201');
            route('~\r');
            assert.equal(ctx.store.activityPasteDrain.active, false);
            assert.equal(getComposerDisplayText(ctx.store.composer), 'draft');
            assert.deepEqual(sent, []);
            assert.equal(route('z'), false);
            handleKeyInput(ctx, 'z');
            assert.equal(getComposerDisplayText(ctx.store.composer), 'draftz');
        } finally { cleanup(ctx); }
    });
}

test('history request Enter is disclosure only and End/PageUp use a bounded detail cursor', () => {
    const sent: string[] = [];
    const ctx = context(sent);
    const panel = ctx.store.overlay.activityHistory;
    const request: RuntimeEvent = { ...identity, seq: 9, kind: 'request', requestId: 'approval', requestType: 'approval', view: { title: 'Read?', fields: [] } };
    Object.assign(panel, { open: true, runId, events: [request, { ...event, seq: 11, output: 'detail\n'.repeat(100) }], seq: 9 });
    try {
        handleActivityHistoryKey(ctx, 'enter', '\r', { columns: 40, height: 16 });
        assert.equal(panel.expanded, true);
        assert.deepEqual(sent, []);
        handleActivityHistoryKey(ctx, 'arrow-down', '\x1b[B', { columns: 40, height: 16 });
        handleActivityHistoryKey(ctx, 'end', '\x1b[F', { columns: 40, height: 16 });
        const end = panel.offset;
        assert.ok(end > 20 && end < 200);
        handleActivityHistoryKey(ctx, 'page-up', '\x1b[5~', { columns: 40, height: 16 });
        assert.ok(panel.offset < end);
    } finally { cleanup(ctx); }
});

test('F6 batched with composer paste start does not switch paste ownership or leak Ctrl+C', () => {
    const sent: string[] = [];
    const ctx = context(sent);
    ctx.streaming = true;
    const size = { columns: 80, height: 18 };
    const feed = (input: string) => {
        if (routeActivityHistoryInput(ctx, input, key => handleKeyInput(ctx, key), size)) return;
        const tokens = consumePasteProtocol(input, ctx.store.pasteCapture, ctx.store.composer, ctx.tuiConfig);
        for (const token of tokens.flatMap(splitKeyInput)) {
            if (!handleActivityHistoryKey(ctx, classifyKeyAction(token), token, size)) handleKeyInput(ctx, token);
        }
    };
    try {
        feed('\x1b[17~\x1b[200~first part');
        assert.equal(ctx.store.overlay.activityHistory.open, false);
        feed('\x03remaining\x1b[201~');
        assert.deepEqual(sent, []);
        assert.equal(ctx.store.pasteCapture.active, false);
    } finally { cleanup(ctx); }
});

test('retired run cannot publish an answer or restart its clock after the same identity returns', () => {
    const ctx = context();
    try {
        runtime(ctx, start);
        invalidateActivityContext(ctx);
        ctx.activityIdentity = { sessionId: 'chat', scope: 'local:chat' };
        ctx.activitySettlementIdentity = ctx.activityIdentity;
        runtime(ctx, event);
        runtime(ctx, { seq: 11, kind: 'turn-end', status: 'done', finalText: 'OLD_RUN_FINAL' });
        assert.equal(ctx.streaming, false);
        assert.equal(ctx.store.transcript.items.some(item => item.type === 'assistant'), false);
    } finally { cleanup(ctx); }
});

test('committed native answer releases text but keeps its duplicate receipt', () => {
    const ctx = context();
    const turn = createActivityItem(event);
    updateActivityItem(turn, event);
    updateActivityItem(turn, { ...identity, seq: 9, kind: 'turn-end', status: 'done', finalText: 'answer' });
    ctx.store.transcript.items.push(turn);
    appendActivityAnswer(ctx.store.transcript, turn.key, { status: 'done', finalText: 'answer' });
    try {
        releaseCommittedActivity(ctx, 0);
        assert.equal(turn.released, false);
        releaseCommittedActivity(ctx, 2);
        assert.equal(turn.released, true);
        assert.equal(ctx.store.transcript.items.length, 2);
        assert.equal(appendActivityAnswer(ctx.store.transcript, turn.key, { status: 'done', finalText: 'answer' }), false);
        assert.equal(ctx.store.transcript.items[1]?.type === 'assistant' && ctx.store.transcript.items[1].text, '');
    } finally { cleanup(ctx); }
});

function runtime(ctx: TuiContext, body: Record<string, unknown>): void {
    handleWsMessage(ctx, Buffer.from(JSON.stringify({ type: 'agent_runtime', ...identity, ...body })));
}
const snapshot = () => Response.json({ activityIdentity: { sessionId: 'chat', scope: 'local:chat' }, activeRun: { traceRunId: runId } });
const start: RuntimeEvent = { ...identity, seq: 1, kind: 'turn-start', provider: 'codex-app' };
const first: RuntimeEvent = { ...identity, seq: 3, kind: 'message', itemId: 'm', phase: 'commentary', operation: 'append', text: 'first/' };

test('cold running restore connects the display owner and Escape can stop it', async () => {
    const sent: string[] = [];
    const ctx = context(sent);
    const original = globalThis.fetch;
    globalThis.fetch = async input => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/snapshot')) return snapshot();
        return url.searchParams.get('after') === '0' ? page([start, first], { status: 'running' })
            : page([], { through: 3, nextAfter: 3, status: 'running' });
    };
    try {
        await restoreActiveActivity(ctx);
        assert.equal(ctx.streaming, true);
        assert.equal(ctx.streamState, 'responding');
        assert.ok(ctx.activeActivityKey);
        flushPendingEscape(ctx);
        assert.deepEqual(sent.map(value => JSON.parse(value)), [{ type: 'stop' }]);
    } finally { globalThis.fetch = original; cleanup(ctx); }
});

test('reconnect keeps catch-up inside the live buffer so seq10 cannot hide missed seq8', async () => {
    const ctx = context();
    runtime(ctx, start); runtime(ctx, first);
    let resolveSeed!: (response: Response) => void;
    let started!: () => void;
    const seedStarted = new Promise<void>(resolve => { started = resolve; });
    const original = globalThis.fetch;
    globalThis.fetch = async input => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/snapshot')) return snapshot();
        if (url.searchParams.get('after') === '0') return new Promise(resolve => { resolveSeed = resolve; started(); });
        return page([{ ...first, seq: 8, text: 'caught/' }], { status: 'running' });
    };
    try {
        const restore = restoreActiveActivity(ctx);
        await seedStarted;
        runtime(ctx, { ...first, seq: 10, text: 'live' });
        resolveSeed(page([start, first], { status: 'running' }));
        await restore;
        const turn = ctx.store.transcript.items.find(item => item.type === 'activity');
        if (turn?.type !== 'activity') assert.fail('missing Activity');
        const entry = turn.model.entries.get('m');
        assert.equal(entry?.kind === 'message' && entry.text, 'first/caught/live');
        assert.equal(turn.model.seq, 10);
        assert.equal(turn.degraded, false);
        runtime(ctx, { ...first, seq: 8, text: 'caught/' });
        assert.equal(turn.model.seq, 10);
    } finally { globalThis.fetch = original; cleanup(ctx); }
});

test('failed atomic restore cannot publish a seeded final answer', async () => {
    const ctx = context();
    runtime(ctx, start); runtime(ctx, first);
    const bad: RuntimeEvent[] = [start, first, { ...event, seq: 5, itemId: 'm' },
        { ...identity, seq: 9, kind: 'turn-end', status: 'done', finalText: 'MUST_NOT_PUBLISH' }];
    const original = globalThis.fetch;
    globalThis.fetch = async input => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/snapshot')) return snapshot();
        return url.searchParams.get('after') === '0' ? page(bad) : page([], { through: 9, nextAfter: 9 });
    };
    try {
        await restoreActiveActivity(ctx);
        assert.equal(ctx.store.transcript.items.some(item => item.type === 'assistant'), false);
        const turn = ctx.store.transcript.items.find(item => item.type === 'activity');
        assert.equal(turn?.type === 'activity' && turn.model.seq, 3);
        assert.ok(ctx.store.transcript.items.some(item => item.type === 'status' && /restore unavailable/.test(item.text)));
    } finally { globalThis.fetch = original; cleanup(ctx); }
});

test('closed replay restores one full final and settles the display without duplicating later compatibility', async () => {
    const ctx = context();
    runtime(ctx, start);
    const end: RuntimeEvent = { ...identity, seq: 9, kind: 'turn-end', status: 'done', finalText: 'RESTORED_FINAL' };
    const original = globalThis.fetch;
    globalThis.fetch = async input => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/snapshot')) return snapshot();
        return url.searchParams.get('after') === '0' ? page([start, end]) : page([], { through: 9, nextAfter: 9 });
    };
    try {
        await restoreActiveActivity(ctx);
        assert.equal(ctx.streaming, false);
        assert.equal(ctx.inputActive, true);
        handleWsMessage(ctx, Buffer.from(JSON.stringify({ type: 'agent_done', traceRunId: runId,
            runtimeFinality: 'present', runtimeStatus: 'done', text: 'RESTORED_FINAL' })));
        const answers = ctx.store.transcript.items.filter(item => item.type === 'assistant');
        assert.equal(answers.length, 1);
        assert.equal(answers[0]?.text, 'RESTORED_FINAL');
    } finally { globalThis.fetch = original; cleanup(ctx); }
});

test('classic closed metadata does not suppress a later canonical final without compatibility', async () => {
    const ctx = context();
    ctx.displayMode = 'line';
    const original = process.stdout.write;
    const originalFetch = globalThis.fetch;
    let output = '';
    process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
    globalThis.fetch = async input => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/snapshot')) return snapshot();
        return url.searchParams.get('after') === '0' ? page([start, first]) : page([], { through: 3, nextAfter: 3 });
    };
    try {
        runtime(ctx, start);
        await restoreActiveActivity(ctx);
        assert.equal(ctx.streaming, false);
        runtime(ctx, { seq: 9, kind: 'turn-end', status: 'done', finalText: 'METADATA_LATE_FINAL' });
        assert.match(output, /\n  Answer\n  METADATA_LATE_FINAL\n/);
        assert.equal(output.match(/METADATA_LATE_FINAL/g)?.length, 1);
        assert.equal(ctx.streaming, false);
    } finally { globalThis.fetch = originalFetch; process.stdout.write = original; cleanup(ctx); }
});

test('REST replay of a retired run cannot recreate its final answer after reset', async () => {
    const ctx = context();
    runtime(ctx, start);
    invalidateActivityContext(ctx);
    ctx.activityIdentity = { sessionId: 'chat', scope: 'local:chat' };
    ctx.activitySettlementIdentity = ctx.activityIdentity;
    const original = globalThis.fetch;
    let payloadReads = 0;
    globalThis.fetch = async input => {
        if (String(input).endsWith('/snapshot')) return snapshot();
        payloadReads++;
        return page([start, { ...identity, seq: 9, kind: 'turn-end', status: 'done', finalText: 'RETIRED_FINAL' }]);
    };
    try {
        await restoreActiveActivity(ctx);
        assert.equal(payloadReads, 0);
        assert.equal(ctx.store.transcript.items.some(item => item.type === 'assistant'), false);
        assert.equal(ctx.streaming, false);
    } finally { globalThis.fetch = original; cleanup(ctx); }
});

test('old canonical end during REST replay cannot reclaim a newer live owner', async () => {
    const ctx = context();
    runtime(ctx, start);
    let resolveSeed!: (response: Response) => void;
    let started!: () => void;
    const seedStarted = new Promise<void>(resolve => { started = resolve; });
    const original = globalThis.fetch;
    const end: RuntimeEvent = { ...identity, seq: 9, kind: 'turn-end', status: 'done', finalText: 'A final' };
    globalThis.fetch = async input => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/snapshot')) return snapshot();
        if (url.searchParams.get('after') === '0') return new Promise(resolve => { resolveSeed = resolve; started(); });
        return page([], { through: 9, nextAfter: 9 });
    };
    try {
        const restore = restoreActiveActivity(ctx);
        await seedStarted;
        runtime(ctx, { ...start, runId: 'tr_0000000000000002' });
        const owner = ctx.activeActivityKey;
        runtime(ctx, end);
        assert.equal(ctx.activeActivityKey, owner);
        resolveSeed(page([start, end]));
        await restore;
        assert.equal(ctx.activeActivityKey, owner);
        assert.equal(ctx.streaming, true);
        assert.notEqual(ctx.streamState, 'idle');
    } finally { globalThis.fetch = original; cleanup(ctx); }
});

test('classic authoritative final survives replay-buffer overflow and compatibility delivery', async () => {
    const ctx = context();
    ctx.displayMode = 'line';
    const original = process.stdout.write;
    const originalFetch = globalThis.fetch;
    let output = '';
    process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
    try {
        const restoring = getActivityReplay(ctx).restore(() => new Promise<RuntimeEvent[]>(() => {}));
        const journal: RuntimeEvent[] = [start];
        runtime(ctx, start);
        for (let seq = 2; seq <= 256; seq++) {
            const chunk = { ...first, seq, text: 'small valid chunk' };
            journal.push(chunk); runtime(ctx, chunk);
        }
        const end: RuntimeEvent = { ...identity, seq: 300, kind: 'turn-end', status: 'done', finalText: 'OVERFLOW_FINAL_SENTINEL' };
        journal.push(end); runtime(ctx, end);
        await assert.rejects(restoring, /activity_live_buffer_overflow/);
        handleWsMessage(ctx, Buffer.from(JSON.stringify({ type: 'agent_done', traceRunId: runId,
            runtimeFinality: 'present', runtimeStatus: 'done', text: 'OVERFLOW_FINAL_SENTINEL' })));
        assert.equal(output.match(/OVERFLOW_FINAL_SENTINEL/g)?.length ?? 0, 1);
        assert.equal(ctx.streaming, false);
        const turn = ctx.store.transcript.items.find(item => item.type === 'activity');
        assert.equal(turn?.type === 'activity' && turn.displayGap, true);
        globalThis.fetch = async input => {
            const url = new URL(String(input));
            if (url.pathname.endsWith('/snapshot')) return snapshot();
            const rest = journal.filter(event => event.seq > Number(url.searchParams.get('after') ?? 0));
            const chunk = rest.slice(0, 40);
            return page(chunk, { through: 300, nextAfter: chunk.at(-1)?.seq ?? 300, hasMore: rest.length > chunk.length });
        };
        await restoreActiveActivity(ctx);
        assert.equal(turn?.type === 'activity' && turn.displayGap, false);
        assert.equal(turn?.type === 'activity' && turn.recordingGap, false);
        assert.equal(output.match(/OVERFLOW_FINAL_SENTINEL/g)?.length ?? 0, 1);
    } finally { process.stdout.write = original; globalThis.fetch = originalFetch; cleanup(ctx); }
});

import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeFrame, computeStablePrefixIndex } from '../../bin/commands/tui/fullscreen-mode.js';
import { releaseCommittedActivity } from '../../bin/commands/tui/activity-replay.js';
import { closeTuiActivityHistory, handleActivityHistoryKey, loadTuiActivityHistory } from '../../bin/commands/tui/activity-history.js';
import type { TuiContext } from '../../bin/commands/tui/types.js';
import { createTuiStore } from '../../src/cli/tui/store.js';
import { createActivityItem, updateActivityItem } from '../../src/cli/tui/activity.js';
import { appendActivityAnswer } from '../../src/cli/tui/activity-answer.js';
import { openActivityHistory } from '../../src/cli/tui/activity-history.js';
import { Viewport } from '../../src/cli/tui/render/viewport.js';
import { Screen, VIEWPORT_FILL } from '../../src/cli/tui/render/frame.js';
import { solveLayout } from '../../src/cli/tui/render/layout.js';
import type { RuntimeEvent } from '../../src/shared/runtime-contract.js';
import { AnsiTerminalModel } from './helpers/ansi-terminal-model.ts';

const SENTINEL = 'COMMITTED_ANSWER_SENTINEL';
const identity = { version: 1 as const, runId: 'tr_0000000000000001', sessionId: 'chat', scope: 'old:chat', turnId: 'turn-a' };
const start: RuntimeEvent = { ...identity, seq: 1, kind: 'turn-start', provider: 'fixture' };
const record: RuntimeEvent = { ...identity, seq: 7, kind: 'tool', itemId: 'read', name: 'Read', status: 'done', output: 'OLD_SCOPE_DETAIL' };

function context(): TuiContext {
    return {
        ws: { transport: 'sse', on() {}, close() {}, send() { assert.fail('history must not send or stop'); } },
        apiUrl: 'http://127.0.0.1:3457', info: { cli: 'codex-app', workingDir: '/fixture', model: 'fixture' },
        accent: '', label: 'codex-app', dir: '/fixture', runtimeLocale: 'en',
        tuiConfig: { pasteCollapseLines: 2, pasteCollapseChars: 160 }, settingsSnapshot: { presentation: { mode: 'activity' } },
        activityIdentity: { sessionId: 'chat', scope: 'local:chat' }, activityIdentityGeneration: 0,
        values: { port: '3457', raw: false, simple: false }, isRaw: false, store: createTuiStore(),
        overlayBoxHeight: 0, inputActive: true, streaming: false, streamState: 'idle', bgtaskCount: 0, bgtaskTasks: [],
        turnStartedAt: 0, streamSink: null, commandRunning: false, escPending: false, escTimer: null, footerTimer: null,
        editorChordPending: false, prevLineCount: 1, promptCursorRow: 0, resizeTimer: null, ideEnabled: false, idePopEnabled: false,
        preFileSetQueue: [], chatCwd: '/fixture', isGit: false, detectedIde: null, promptPrefix: '  > ', footer: '',
        displayMode: 'fullscreen', requestFrame() {},
    };
}

function seed(ctx: TuiContext) {
    const old = createActivityItem(start);
    updateActivityItem(old, record);
    updateActivityItem(old, { ...start, seq: 9, kind: 'turn-end', status: 'done', finalText: 'JOURNAL_NOT_ANSWER' });
    ctx.store.transcript.items.push(old);
    appendActivityAnswer(ctx.store.transcript, old.key, { status: 'done', finalText: SENTINEL }, 'saved');
    const answer = ctx.store.transcript.items[1]!;
    assert.ok(answer.type === 'assistant');
    const liveStart: RuntimeEvent = { ...start, runId: 'tr_0000000000000002', turnId: 'turn-b', scope: 'local:chat' };
    const live = createActivityItem(liveStart, true);
    updateActivityItem(live, { ...liveStart, seq: 3, kind: 'tool', itemId: 'live', name: 'Working', status: 'running',
        output: Array.from({ length: 30 }, (_, i) => `LIVE_ROW_${i}`).join('\n') });
    ctx.store.transcript.items.push(live);
    return { old, answer, live, liveStart };
}

async function withHarness(lane: 'standard' | 'dumb' | 'zellij', run: (h: Harness) => void | Promise<void>): Promise<void> {
    const keys = ['TERM', 'TMUX', 'STY', 'ZELLIJ', 'ZELLIJ_SESSION_NAME', 'CMUX_WORKSPACE_ID', 'CMUX_SURFACE_ID', 'CMUX_SOCKET_PATH'];
    const env = keys.map(key => [key, process.env[key]] as const);
    const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    const write = process.stdout.write;
    for (const key of keys) delete process.env[key];
    process.env.TERM = lane === 'dumb' ? 'dumb' : 'xterm-256color';
    if (lane === 'zellij') process.env.ZELLIJ = 'fixture';
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const term = new AnsiTerminalModel(80, 24), screen = new Screen(), ctx = context(), viewport = new Viewport();
    let output = '', releases = 0;
    process.stdout.write = ((chunk: string | Uint8Array) => {
        // Node test-runner control frames are not terminal output.
        if (typeof chunk !== 'string') return write.call(process.stdout, chunk);
        output += chunk; term.write(chunk); return true;
    }) as typeof process.stdout.write;
    const h = {
        ctx, viewport, screen, term,
        count: () => [...term.scrollback, term.visibleText()].join('\n').split(SENTINEL).length - 1,
        releases: () => releases, output: () => output,
        paint: (frame: Parameters<Screen['render']>[0]) => {
            screen.render(frame);
            return screen.lastCommitFlushedCount(); // exactly once for this render
        },
        cycle: (beforeRender?: () => void) => {
            // composeFrame refreshes actual cells/mode before selecting a commit.
            composeFrame(ctx, viewport);
            const height = Math.max(1, solveLayout(process.stdout.columns!, process.stdout.rows!, 1).transcript.height - 5);
            const stable = computeStablePrefixIndex(ctx.store.transcript.items);
            const commit = ctx.store.overlay.activityHistory.open ? null : viewport.peekStableCommitRows(height, stable);
            const queued = commit ? screen.queueCommitLines(commit.rows) : false;
            beforeRender?.();
            const projection = queued && commit ? viewport.withPreviewFrontier(commit.frontier) : viewport;
            screen.render(composeFrame(ctx, projection));
            const flushed = screen.lastCommitFlushedCount(); // consuming receipt, never call again this frame
            if (flushed > 0 && commit) {
                assert.equal(flushed, commit.rows.length);
                viewport.markCommittedFrontier(commit.frontier);
                releaseCommittedActivity(ctx, commit.frontier.itemIndex);
                releases++;
            }
            return { stable, commit, queued, flushed };
        },
        resize: (width: number, height: number) => {
            Object.defineProperty(process.stdout, 'columns', { value: width, configurable: true });
            Object.defineProperty(process.stdout, 'rows', { value: height, configurable: true });
            term.resize(width, height, { nativePush: true });
            screen.forceResizeRedraw();
        },
    };
    try { screen.enter(); await run(h); }
    finally {
        closeTuiActivityHistory(ctx);
        screen.exit(); process.stdout.write = write;
        if (cols) Object.defineProperty(process.stdout, 'columns', cols); else delete process.stdout.columns;
        if (rows) Object.defineProperty(process.stdout, 'rows', rows); else delete process.stdout.rows;
        for (const [key, value] of env) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
}
type Harness = {
    ctx: TuiContext; viewport: Viewport; screen: Screen; term: AnsiTerminalModel;
    count(): number; releases(): number; output(): string;
    paint(frame: Parameters<Screen['render']>[0]): number;
    cycle(beforeRender?: () => void): { stable: number; commit: ReturnType<Viewport['peekStableCommitRows']>; queued: boolean; flushed: number };
    resize(width: number, height: number): void;
};

for (const lane of ['dumb', 'zellij'] as const) test(`${lane} refusal preserves Activity/answer payload and logical frontier`, async () => {
    await withHarness(lane, h => {
        const { old, answer } = seed(h.ctx);
        h.paint({ rows: [VIEWPORT_FILL, 'initial', '>'] });
        const before = h.viewport.currentFrontier();
        const result = h.cycle();
        assert.equal(result.stable, 2); assert.ok(result.commit?.rows.join('\n').includes(SENTINEL));
        assert.equal(result.queued, false); assert.equal(result.flushed, 0);
        assert.deepEqual(h.viewport.currentFrontier(), before); assert.equal(h.releases(), 0);
        assert.equal(old.released, false); assert.equal(old.model.entries.size, 1); assert.equal(answer.text, SENTINEL);
        h.viewport.scrollToTop(); h.cycle();
        assert.equal(h.term.countVisible(SENTINEL), 1, 'refused prefix remains inspectable in virtual viewport');
        assert.equal(h.term.scrollback.join('\n').includes(SENTINEL), false);
    });
});

test('accepted queue defers on real stale pixels, then actual flush releases once and preserves sentinel across F6/mode/resize', async () => {
    await withHarness('standard', h => {
        const { old, answer, live, liveStart } = seed(h.ctx);
        const before = h.viewport.currentFrontier();
        h.paint({ rows: ['STALE_WELCOME', 'STALE_SECOND', VIEWPORT_FILL, 'footer', '>'] });
        const deferred = h.cycle(() => {
            assert.equal(answer.text, SENTINEL); assert.equal(old.released, false);
            assert.deepEqual(h.viewport.currentFrontier(), before);
        });
        assert.ok(deferred.commit); assert.equal(deferred.queued, true); assert.equal(deferred.flushed, 0);
        assert.equal(h.screen.lastCommitDeferredByStaleRows(), true);
        assert.equal(h.releases(), 0); assert.equal(answer.text, SENTINEL); assert.equal(old.model.entries.size, 1);
        assert.deepEqual(h.viewport.currentFrontier(), before);
        const flushed = h.cycle();
        assert.ok(flushed.flushed > 0); assert.equal(h.viewport.currentFrontier().itemIndex, 2);
        assert.equal(h.releases(), 1); assert.equal(old.released, true); assert.equal(old.model.entries.size, 0);
        assert.equal(answer.text, ''); assert.equal(answer.activityReleased, true); assert.ok(answer.activityDigest);
        assert.equal(h.count(), 1);
        const frontier = h.viewport.currentFrontier(), revision = old.revision;
        assert.equal(appendActivityAnswer(h.ctx.store.transcript, old.key, { status: 'done', finalText: SENTINEL }, 'saved'), false);
        h.cycle(); assert.equal(h.count(), 1); assert.equal(h.releases(), 1); assert.equal(old.revision, revision);

        // A committed row can still occupy Screen's physical history lane.
        // A real repaint evacuates that lane through DECSTBM before F6 opens;
        // do not seed terminal.scrollback or assume queue flush already did so.
        h.screen.forceRedraw(); h.cycle();
        assert.equal(h.term.scrollback.join('\n').split(SENTINEL).length - 1, 1);

        const panel = h.ctx.store.overlay.activityHistory;
        openActivityHistory(panel, [old]);
        Object.assign(panel, { sessionId: 'chat', originalScope: 'old:chat', events: [record], seq: 7, expanded: true });
        const inspected = { runId: panel.runId, seq: panel.seq, scope: panel.originalScope };
        const overlay = h.cycle(); assert.equal(overlay.commit, null); assert.equal(h.count(), 1);
        assert.equal(h.term.scrollback.join('\n').split(SENTINEL).length - 1, 1);
        updateActivityItem(live, { ...liveStart, seq: 5, kind: 'message', itemId: 'new', phase: 'commentary', operation: 'replace', text: 'NEW_LIVE_PROGRESS' });
        h.cycle();
        assert.deepEqual({ runId: panel.runId, seq: panel.seq, scope: panel.originalScope }, inspected);
        closeTuiActivityHistory(h.ctx);
        const outputStart = h.output().length;
        for (const mode of ['legacy', 'activity']) {
            h.ctx.settingsSnapshot = { presentation: { mode } }; h.cycle();
            assert.equal(old.presentation, 'activity', 'committed projection cannot be rewritten');
            assert.equal(h.count(), 1); assert.deepEqual(h.viewport.currentFrontier(), frontier);
        }
        for (const [width, height] of [[60, 20], [80, 24]]) {
            h.resize(width!, height!); h.cycle(); h.cycle();
            assert.equal(h.count(), 1); assert.deepEqual(h.viewport.currentFrontier(), frontier);
        }
        assert.equal(h.output().slice(outputStart).includes('\x1b[3J'), false);
        assert.equal(h.releases(), 1); assert.equal(answer.text, '');
    });
});

for (const owner of ['activity', 'answer'] as const) test(`pending ${owner} saved read stops the actual stable prefix`, async () => {
    await withHarness('standard', h => {
        const { old, answer } = seed(h.ctx);
        const pending = owner === 'activity' ? old : answer;
        pending.answerReadState = 'pending';
        h.paint({ rows: [VIEWPORT_FILL, 'initial', '>'] });
        const result = h.cycle();
        assert.equal(result.stable, owner === 'activity' ? 0 : 1);
        assert.ok((result.commit?.frontier.itemIndex ?? 0) <= result.stable);
        assert.equal(answer.text, SENTINEL); assert.notEqual(answer.activityReleased, true);
        if (owner === 'activity') { assert.equal(result.commit, null); assert.equal(old.released, false); }
        pending.answerReadState = 'saved';
        const committed = h.cycle();
        assert.equal(committed.stable, 2); assert.ok(committed.flushed > 0);
        assert.equal(answer.activityReleased, true); assert.equal(h.count(), 1);
    });
});

test('authenticated old-scope F6 selection stays read-only while current live progress and commit state persist', async () => {
    await withHarness('standard', async h => {
        const { old, live, liveStart } = seed(h.ctx);
        h.paint({ rows: [VIEWPORT_FILL, 'initial', '>'] }); h.cycle();
        assert.equal(h.count(), 1);
        const frontier = h.viewport.currentFrontier(), originalFetch = globalThis.fetch;
        const paths: string[] = [];
        openActivityHistory(h.ctx.store.overlay.activityHistory, [old]);
        globalThis.fetch = async (input, init) => {
            const url = new URL(String(input)); paths.push(url.pathname);
            assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error');
            assert.equal(url.searchParams.get('session'), 'chat');
            if (url.pathname.startsWith('/api/messages/')) return Response.json({ ok: true, data: { message: {
                id: 1, role: 'assistant', content: 'INSPECTED_SAVED_ANSWER', trace_run_id: identity.runId, session_id: 'chat',
            } } });
            return Response.json({ ok: true, data: { runId: identity.runId, sessionId: 'chat', scope: 'old:chat',
                status: 'done', events: [record], through: 7, nextAfter: 7, hasMore: false, incomplete: false, loss: null } });
        };
        try {
            await loadTuiActivityHistory(h.ctx, { discover: false });
            const panel = h.ctx.store.overlay.activityHistory;
            assert.equal(panel.originalScope, 'old:chat'); assert.equal(panel.seq, 7);
            handleActivityHistoryKey(h.ctx, 'printable', 'a', { columns: 80, height: 18 }); h.cycle();
            assert.equal(h.term.countVisible('INSPECTED_SAVED_ANSWER'), 1);
            updateActivityItem(live, { ...liveStart, seq: 6, kind: 'message', itemId: 'new', phase: 'commentary', operation: 'replace', text: 'LATEST' });
            h.cycle();
            assert.equal(panel.answerView, true); assert.equal(panel.seq, 7); assert.equal(panel.originalScope, 'old:chat');
            assert.deepEqual(h.ctx.activityIdentity, { sessionId: 'chat', scope: 'local:chat' });
            assert.deepEqual(h.viewport.currentFrontier(), frontier); assert.equal(h.count(), 1);
            assert.deepEqual(paths, [`/api/traces/${identity.runId}/activity`, `/api/messages/by-trace/${identity.runId}`]);
        } finally { globalThis.fetch = originalFetch; }
    });
});

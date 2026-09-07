import '../setup/isolated-home.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { handleWsMessage } from '../../bin/commands/tui/ws-handler.ts';
import type { TuiContext } from '../../bin/commands/tui/types.ts';
import { createTuiStore } from '../../src/cli/tui/store.ts';
import { appendUserItem, replaceNativeAssistantFinal } from '../../src/cli/tui/transcript.ts';
import { renderStatusBar } from '../../src/cli/tui/presentation.ts';
import { stopSpinner } from '../../src/cli/tui/spinner.ts';
import { refreshInfo, refreshActivityIdentity } from '../../bin/commands/tui/api.js';
import { applySettingsSelection } from '../../bin/commands/tui/overlays.js';
import { buildAppearanceRows } from '../../src/cli/tui/settings-screen.js';
import { computeStablePrefixIndex } from '../../bin/commands/tui/fullscreen-mode.js';
import { retireActivityView } from '../../bin/commands/tui/activity-replay.js';
import { cancelTuiActivityAnswers } from '../../bin/commands/tui/activity-answer-read.js';
import { renderActivityItem } from '../../src/cli/tui/activity.js';
import xterm from '@xterm/xterm';
import printProducer from '../fixtures/tui-print-producer.json' with { type: 'json' };

function makeCtx(): TuiContext {
    return {
        ws: { send() { /* no-op */ }, close() { /* no-op */ } },
        apiUrl: '',
        info: { cli: 'codex', workingDir: '/tmp/project', model: 'test-model' },
        accent: '',
        label: 'codex',
        dir: '/tmp/project',
        runtimeLocale: 'en',
        tuiConfig: { theme: 'dark', fullscreen: true, pasteCollapseLines: 2, pasteCollapseChars: 160 },
        settingsSnapshot: {},
        values: { port: '3457', raw: false, simple: false },
        isRaw: false,
        store: createTuiStore(),
        overlayBoxHeight: 0,
        inputActive: true,
        streaming: false,
        streamState: 'idle',
        bgtaskCount: 0,
        bgtaskTasks: [],
        turnStartedAt: 0,
        streamSink: null,
        commandRunning: false,
        escPending: false,
        escTimer: null,
        footerTimer: null,
        editorChordPending: false,
        prevLineCount: 1,
        promptCursorRow: 0,
        resizeTimer: null,
        ideEnabled: false,
        idePopEnabled: false,
        preFileSetQueue: [],
        chatCwd: '/tmp/project',
        isGit: false,
        detectedIde: null,
        promptPrefix: '  > ',
        footer: renderStatusBar({
            model: 'test-model',
            engine: 'codex',
            engineAccent: '\x1b[36m',
            state: 'idle',
            cwd: '/tmp/project',
            port: 3457,
        }),
        displayMode: 'fullscreen',
        requestFrame: null,
    } as unknown as TuiContext;
}

function msg(value: Record<string, unknown>): Buffer {
    return Buffer.from(JSON.stringify(value));
}

function committedTools(ctx: TuiContext) {
    return ctx.store.transcript.items.filter(item => item.type === 'tool');
}


function cleanupCtx(ctx: TuiContext): void {
    stopSpinner();
    if (ctx.footerTimer) {
        clearInterval(ctx.footerTimer);
        ctx.footerTimer = null;
    }
}

function assistantTexts(ctx: TuiContext): string[] {
    return ctx.store.transcript.items
        .filter(item => item.type === 'assistant')
        .map(item => item.type === 'assistant' ? item.text : '');
}

// wp37/a356cecc donor IDs; P4/D10 is in history-io, P5 in scrollback.
const activityId = { version: 1, sessionId: 'activity-chat', scope: 'local:activity-chat',
    runId: 'tr_0000000000000037', turnId: 'activity-turn' };
function runtime(ctx: TuiContext, body: Record<string, unknown>): void {
    handleWsMessage(ctx, msg({ type: 'agent_runtime', ...activityId, ...body }));
}
function printDone(ctx: TuiContext, text: string, extra: Record<string, unknown> = {}): void {
    handleWsMessage(ctx, msg({ type: 'agent_done', traceRunId: activityId.runId, text, ...extra }));
}
function nativeDone(ctx: TuiContext, text: string, extra: Record<string, unknown> = {}): void {
    printDone(ctx, text, { runtimeFinality: 'present', runtimeStatus: 'done', ...extra });
}
function gap(ctx: TuiContext, runId = activityId.runId): void {
    handleWsMessage(ctx, msg({ type: 'agent_runtime_gap', ...activityId, runId, reason: 'projection_degraded' }));
}
function gapText(ctx: TuiContext, text: string, extra: Record<string, unknown> = {}): void {
    handleWsMessage(ctx, msg({ type: 'agent_output', sessionId: activityId.sessionId, scope: activityId.scope,
        traceRunId: activityId.runId, text, ...extra }));
}
function answerResponse(content: string | null, runId = activityId.runId, sessionId = activityId.sessionId): Response {
    return Response.json({ ok: true, data: { message: content === null ? null : {
        id: 37, role: 'assistant', content, trace_run_id: runId, session_id: sessionId,
    } } });
}
async function answerIdle(ctx: TuiContext): Promise<void> {
    for (let i = 0; i < 100 && (ctx.activityAnswers?.active || ctx.activityAnswers?.queue.length); i++) await setImmediate();
    assert.equal(ctx.activityAnswers?.active ?? null, null, 'answer GET drained');
    assert.equal(ctx.activityAnswers?.queue.length ?? 0, 0, 'answer queue drained');
}
interface ExpectedWsHttp {
    origin: string;
    method: 'GET' | 'PUT';
    path: string;
    query: Array<[string, string]>;
    redirect: RequestRedirect | undefined;
    body: string | undefined;
    status: number;
    message?: { runId: string; sessionId: string; scope: string; content: string | null };
    response: () => Response;
}
function messageRequest(runId = activityId.runId, content: string | null = null,
    owner = { sessionId: activityId.sessionId, scope: activityId.scope }, status = 200): ExpectedWsHttp {
    return {
        origin: 'http://127.0.0.1:1', method: 'GET', path: '/api/messages/by-trace/' + encodeURIComponent(runId),
        query: [['session', owner.sessionId]], redirect: 'error', body: undefined, status,
        message: { runId, ...owner, content },
        response: () => status === 200 ? answerResponse(content, runId, owner.sessionId)
            : Response.json({ error: 'declared MESSAGE unavailable' }, { status }),
    };
}
function controlRequest(path: string, method: 'GET' | 'PUT' = 'GET', body?: string, status = 200): ExpectedWsHttp {
    return {
        origin: 'http://127.0.0.1:1', method, path, query: [], body, status,
        redirect: path === '/api/orchestrate/snapshot' ? 'error' : undefined,
        response: () => path === '/api/auth/token' ? Response.json({ token: '' }) : Response.json({ data: {} }),
    };
}
function activityFixture(t: TestContext, expected: ExpectedWsHttp[] = []) {
    const ctx = makeCtx();
    ctx.apiUrl = 'http://127.0.0.1:1';
    ctx.activityIdentity = { sessionId: activityId.sessionId, scope: activityId.scope };
    ctx.activityIdentityGeneration = 0;
    const violations: string[] = [], calls: Array<{ url: URL; init?: RequestInit }> = [];
    let next = 0;
    const http: { reply?: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined } = {};
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        try {
            const url = new URL(String(input));
            const exchange = expected[next];
            assert.ok(exchange, 'undeclared HTTP request at index ' + next + ': ' + url.href);
            assert.equal(url.origin, exchange.origin); assert.equal(url.username, ''); assert.equal(url.password, '');
            assert.equal(url.hash, ''); assert.equal(url.pathname, exchange.path);
            assert.equal(init?.method ?? 'GET', exchange.method);
            assert.deepEqual([...url.searchParams.entries()], exchange.query, 'exact query/cardinality/order');
            assert.equal(init?.redirect, exchange.redirect); assert.equal(init?.body, exchange.body);
            if (exchange.message) {
                const declared = exchange.message;
                assert.ok([ctx.activityIdentity, ctx.activitySettlementIdentity].some(owner =>
                    owner?.sessionId === declared.sessionId && owner.scope === declared.scope), 'declared run owner is admitted');
            }
            // Validation precedes custom gates; custom sync/async assertions must
            // also reach the out-of-band ledger if the consumer catches fetch.
            calls.push({ url, init }); next++;
            const response = await (http.reply?.(url, init) ?? exchange.response());
            assert.equal(response.status, exchange.status, 'declared HTTP outcome');
            if (exchange.message && exchange.status === 200) {
                const declared = exchange.message;
                const payload = await response.clone().json();
                assert.deepEqual(payload, await answerResponse(declared.content, declared.runId, declared.sessionId).json(),
                    'response owner/content comes from the declared fixture, never the request');
            }
            return response;
        } catch (error) {
            violations.push(error instanceof Error ? error.message : String(error));
            throw error;
        }
    });
    t.after(async () => {
        cancelTuiActivityAnswers(ctx); cleanupCtx(ctx); ctx.activityReplay?.reset();
        await setImmediate();
        assert.deepEqual(violations, [], 'no swallowed HTTP validation/custom-handler assertion');
        assert.equal(next, expected.length, 'complete expected HTTP sequence consumed');
        assert.deepEqual(calls.map(({ url, init }) => ({
            origin: url.origin, method: init?.method ?? 'GET', path: url.pathname, query: [...url.searchParams.entries()],
        })), expected.map(({ origin, method, path, query }) => ({ origin, method, path, query })));
        assert.equal(ctx.activityAnswers, undefined); assert.equal(ctx.footerTimer, null);
    });
    return { ctx, calls, http };
}
function lineCapture(t: TestContext): () => string {
    const original = process.stdout.write; let output = '';
    t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array, ...args: unknown[]) => {
        if (typeof chunk !== 'string') return original.call(process.stdout, chunk);
        output += chunk;
        args.find((arg): arg is () => void => typeof arg === 'function')?.();
        return true;
    });
    return () => output;
}
function activityRow(ctx: TuiContext, runId = activityId.runId) {
    const row = ctx.store.transcript.items.find(item => item.type === 'activity' && item.model.identity.runId === runId);
    assert.ok(row?.type === 'activity'); return row;
}

test('D01 admitted gap tool mirrors and final tool backfill cannot execute provider terminal controls', async t => {
    const { ctx } = activityFixture(t, [messageRequest()]);
    runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' }); gap(ctx);
    handleWsMessage(ctx, msg({ type: 'agent_tool', traceRunId: activityId.runId, icon: '$',
        label: '\x1b[2JRead', detail: '\x1b]52;c;SECRET\x07safe result', status: 'running', stepRef: 't' }));
    assert.equal(ctx.store.transcript.liveTools[0]?.label, 'Read');
    assert.equal(ctx.store.transcript.liveTools[0]?.detail, 'safe result');
    printDone(ctx, 'final', { toolLog: [{ icon: '$', label: '\x1b[2JRead',
        detail: '\x1b]52;c;SECRET\x07safe final result', status: 'done', stepRef: 't' }] });
    await answerIdle(ctx);
    const tool = committedTools(ctx)[0]!;
    assert.ok(tool.type === 'tool'); assert.equal(tool.detail, 'safe final result');
    assert.doesNotMatch(tool.text, /\x1b|SECRET/);
});

for (const order of ['legacy-first', 'canonical-first'] as const) {
    for (const finalText of ['FULL_FINAL_BYTES\r\n', '']) {
test('D02 gap fallback ' + order + ' settles ' + (finalText ? 'full' : 'empty') + ' saved final without shifting previews', async t => {
            const { ctx, http } = activityFixture(t, [messageRequest(activityId.runId, finalText)]);
            const response = Promise.withResolvers<Response>();
            http.reply = url => url.pathname.startsWith('/api/messages/') ? response.promise : undefined;
            t.after(() => response.resolve(answerResponse(null)));
            runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' }); gap(ctx);
            gapText(ctx, 'PROVISIONAL_THOUGHT', { thinking: true }); gapText(ctx, 'PROVISIONAL_ANSWER');
            const items = ctx.store.transcript.items, previews = items.slice();
            const end = () => runtime(ctx, { seq: 7, kind: 'turn-end', status: 'done', finalText: 'JOURNAL_ONLY' });
            if (order === 'canonical-first') end();
            printDone(ctx, 'COMPATIBILITY_ONLY');
            if (order === 'legacy-first') end();
            assert.equal(computeStablePrefixIndex(items), 0, 'pending MESSAGE blocks actual commit');
            response.resolve(answerResponse(finalText)); await answerIdle(ctx);
            printDone(ctx, 'LATE_WRONG_COMPATIBILITY');
            assert.equal(ctx.store.transcript.items, items);
            for (const [i, row] of previews.entries()) assert.equal(items[i], row, 'stable row ' + i);
            assert.equal(items.length, previews.length + 1);
            assert.equal(items.at(-1)?.type, 'assistant'); assert.equal(items.at(-1)?.text, finalText);
            assert.deepEqual(assistantTexts(ctx).filter(Boolean), finalText ? [finalText] : []);
            assert.ok(!items.some(item => (item.type === 'assistant' || item.type === 'thinking') && item.streaming));
            assert.ok(!items.some(item => 'text' in item && /PROVISIONAL_|JOURNAL_ONLY/.test(item.text)));
            assert.equal(computeStablePrefixIndex(items), items.length);
        });
test('D03 line gap fallback ' + order + ' preserves provisional and exact ' + (finalText ? 'full' : 'empty') + ' receipt once', async t => {
            const { ctx } = activityFixture(t, [messageRequest()]); ctx.displayMode = 'line'; const output = lineCapture(t);
            runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' }); gap(ctx); gapText(ctx, 'PROVISIONAL_ANSWER\n\n');
            const beforeFinal = output().length;
            const end = () => runtime(ctx, { seq: 7, kind: 'turn-end', status: 'done', finalText: 'JOURNAL_ONLY' });
            if (order === 'canonical-first') end();
            printDone(ctx, finalText);
            if (order === 'legacy-first') end();
            printDone(ctx, finalText); await answerIdle(ctx);
            assert.match(output().slice(0, beforeFinal), /Provisional output/);
            assert.equal(output().match(/PROVISIONAL_ANSWER/g)?.length, 1); assert.doesNotMatch(output(), /JOURNAL_ONLY/);
            if (finalText) assert.equal(output().slice(beforeFinal).match(/FULL_FINAL_BYTES/g)?.length, 1);
            else assert.match(output().slice(beforeFinal), order === 'canonical-first'
                ? /checking the saved answer/ : /final answer is empty/);
            const receipt = ctx.store.transcript.items.find(i => i.type === 'assistant' && i.activityKey);
            assert.ok(receipt?.type === 'assistant');
            assert.equal(receipt.activityFinality, 'present'); assert.equal(receipt.text, finalText);
            assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), ctx.store.transcript.items.length);
        });
    }
test('D04 gap fallback A then B then ' + order + ' late A preserves B previews and lifecycle', async t => {
        const { ctx } = activityFixture(t, [messageRequest()]);
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' }); gap(ctx);
        gapText(ctx, 'A_THOUGHT', { thinking: true }); gapText(ctx, 'A_PREVIEW');
        appendUserItem(ctx.store.transcript, 'B user', 'B user');
        runtime(ctx, { seq: 1, runId: 'B', turnId: 'B-turn', kind: 'turn-start', provider: 'codex' }); gap(ctx, 'B');
        gapText(ctx, 'B_THOUGHT', { traceRunId: 'B', thinking: true }); gapText(ctx, 'B_PREVIEW', { traceRunId: 'B' });
        const bIndex = ctx.store.transcript.items.indexOf(activityRow(ctx, 'B'));
        const bRows = ctx.store.transcript.items.slice(bIndex), before = bRows.map(row => JSON.stringify(row));
        const owner = ctx.activeActivityKey, clock = ctx.turnStartedAt, timer = ctx.footerTimer;
        const sink = { push() {}, end() { assert.fail('A must not flush B'); } };
        ctx.streamSink = sink; ctx.inputActive = false;
        const end = () => runtime(ctx, { seq: 7, kind: 'turn-end', status: 'error', finalText: null });
        if (order === 'canonical-first') end();
        printDone(ctx, 'A_DIAGNOSTIC');
        if (order === 'legacy-first') end();
        await answerIdle(ctx);
        assert.deepEqual(bRows.map(row => JSON.stringify(row)), before);
        for (const [i, row] of bRows.entries()) assert.equal(ctx.store.transcript.items[bIndex + i], row);
        assert.equal(ctx.activeActivityKey, owner); assert.equal(ctx.turnStartedAt, clock);
        assert.equal(ctx.footerTimer, timer); assert.equal(ctx.streamSink, sink);
        assert.equal(ctx.streaming, true); assert.equal(ctx.inputActive, false);
        assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), bIndex);
        assert.ok(!ctx.store.transcript.items.some(item => 'text' in item && /A_THOUGHT|A_PREVIEW/.test(item.text)));
        assert.deepEqual(assistantTexts(ctx).filter(Boolean), ['B_PREVIEW', 'A_DIAGNOSTIC']);
    });
}

test('D05 line gap split controls stay hidden and print startup body survives canonical null once', async t => {
    const { ctx } = activityFixture(t, [messageRequest()]); ctx.displayMode = 'line'; const output = lineCapture(t);
    runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' }); gap(ctx);
    gapText(ctx, 'VISIBLE_PREVIEW\x1b]52;c;'); gapText(ctx, 'HIDDEN_PAYLOAD\x07VISIBLE_SUFFIX');
    runtime(ctx, { seq: 7, kind: 'turn-end', status: 'error', finalText: null });
    printDone(ctx, 'STARTUP_DIAGNOSTIC'); printDone(ctx, 'STARTUP_DIAGNOSTIC'); await answerIdle(ctx);
    assert.equal(output().match(/VISIBLE_PREVIEW/g)?.length, 1); assert.equal(output().match(/VISIBLE_SUFFIX/g)?.length, 1);
    assert.doesNotMatch(output(), /HIDDEN_PAYLOAD|Updated diagnostic/);
    assert.equal(output().match(/STARTUP_DIAGNOSTIC/g)?.length, 1);
    assert.deepEqual(assistantTexts(ctx).filter(Boolean), ['STARTUP_DIAGNOSTIC']);
    const receipt = ctx.store.transcript.items.find(i => i.type === 'assistant' && i.activityKey);
    assert.ok(receipt?.type === 'assistant'); assert.equal(receipt.activitySource, 'compatibility');
    assert.equal(receipt.activityDiagnostic, false); assert.equal(activityRow(ctx).terminalStatus, 'error');
    assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), ctx.store.transcript.items.length);
});

test('D06 gap fallback thinking snapshots keep indices while saved answer follows canonical close', async t => {
    const { ctx } = activityFixture(t, [messageRequest(activityId.runId, 'FINAL_ONLY')]);
    runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' }); gap(ctx); gapText(ctx, 'PROVISIONAL_ANSWER');
    const prior = ctx.store.transcript.items.slice();
    const tool = { type: 'agent_tool', traceRunId: activityId.runId, sessionId: activityId.sessionId, scope: activityId.scope,
        toolType: 'thinking', stepRef: 'thinking-1', icon: 'T', label: 'Thinking', status: 'running' };
    handleWsMessage(ctx, msg({ ...tool, detail: 'PROVISIONAL_THOUGHT' }));
    handleWsMessage(ctx, msg({ ...tool, detail: 'PROVISIONAL_THOUGHT_REPLACED', status: 'done' }));
    for (const [i, item] of prior.entries()) assert.equal(ctx.store.transcript.items[i], item);
    const rows = ctx.store.transcript.items.slice();
    assert.equal(rows.length, prior.length + 1); assert.equal(rows.at(-1)?.text, 'PROVISIONAL_THOUGHT_REPLACED');
    runtime(ctx, { seq: 7, kind: 'turn-end', status: 'done', finalText: 'JOURNAL_ONLY' });
    assert.deepEqual(assistantTexts(ctx).filter(Boolean), []); await answerIdle(ctx);
    for (const [i, item] of rows.entries()) assert.equal(ctx.store.transcript.items[i], item);
    assert.deepEqual(assistantTexts(ctx).filter(Boolean), ['FINAL_ONLY']);
    assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), ctx.store.transcript.items.length);
});

test('D07 gap fallback caps rows across agents and thinking steps without combining their previews', async t => {
    const { ctx } = activityFixture(t, [messageRequest()]); runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' }); gap(ctx);
    for (let i = 0; i < 64; i++) {
        gapText(ctx, 'agent-' + i, { agentId: 'agent-' + i });
        handleWsMessage(ctx, msg({ type: 'agent_tool', traceRunId: activityId.runId, sessionId: activityId.sessionId,
            scope: activityId.scope, icon: 'T', label: 'Thinking', toolType: 'thinking', status: 'running',
            agentId: 'agent-' + i, stepRef: 'step-' + i, detail: 'thought-' + i }));
    }
    const previews = ctx.store.transcript.items.filter(i => i.type === 'assistant' || i.type === 'thinking');
    assert.equal(previews.length, 16);
    assert.deepEqual(previews.slice(0, 3).map(i => i.text), ['agent-0', 'thought-0', 'agent-1']);
    assert.equal(activityRow(ctx).displayGap, true);
    printDone(ctx, 'FULL_AFTER_ROW_LIMIT'); await answerIdle(ctx);
    assert.deepEqual(assistantTexts(ctx).filter(Boolean), ['FULL_AFTER_ROW_LIMIT']);
    assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), ctx.store.transcript.items.length);
});

test('D08 gap fallback caps total run characters independently of the selected full final', async t => {
    const { ctx } = activityFixture(t, [messageRequest()]); runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' }); gap(ctx);
    for (let i = 0; i < 64; i++) gapText(ctx, 'x'.repeat(4000), { agentId: 'agent-' + i });
    assert.equal(assistantTexts(ctx).reduce((sum, text) => sum + text.length, 0), 32768);
    const full = 'f'.repeat(70000) + '\r\nFULL_FINAL_TAIL'; printDone(ctx, full); await answerIdle(ctx);
    assert.deepEqual(assistantTexts(ctx).filter(Boolean), [full]);
});

test('D09 line gap fallback freezes after truncation so a discarded control opener cannot leak its suffix', async t => {
    const { ctx } = activityFixture(t, [messageRequest()]); ctx.displayMode = 'line'; const output = lineCapture(t);
    runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' }); gap(ctx);
    gapText(ctx, 'x'.repeat(4090) + '\x1b]52;c;' + 'HIDDEN'.repeat(100));
    gapText(ctx, 'LEAK_SUFFIX\x07', { agentId: 'another-agent' }); gapText(ctx, 'LEAK_SUFFIX\x07');
    const previews = assistantTexts(ctx); assert.equal(previews.length, 1); assert.equal(previews[0]?.length, 4096);
    assert.doesNotMatch(output(), /HIDDEN|LEAK_SUFFIX/); assert.equal(output().match(/Provisional output limited/g)?.length, 1);
    printDone(ctx, 'FULL_AFTER_LIMIT'); await answerIdle(ctx);
    assert.equal(output().match(/FULL_AFTER_LIMIT/g)?.length, 1);
    assert.deepEqual(assistantTexts(ctx).filter(Boolean), ['FULL_AFTER_LIMIT']);
});

test('D11 retiring a gap fallback clears owned previews in place and late A cannot resurrect them', t => {
    const { ctx } = activityFixture(t, []); runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' }); gap(ctx);
    gapText(ctx, 'RETIRED_PREVIEW'); gapText(ctx, 'RETIRED_THOUGHT', { thinking: true });
    const rows = ctx.store.transcript.items.slice(), next = { sessionId: 'other', scope: 'local:other' };
    const assistant = rows.find(row => row.type === 'assistant');
    const thinking = rows.find(row => row.type === 'thinking');
    assert.ok(assistant?.type === 'assistant'); assert.ok(thinking?.type === 'thinking');
    assert.equal(assistant.text, 'RETIRED_PREVIEW'); assert.equal(thinking.text, 'RETIRED_THOUGHT');
    retireActivityView(ctx, next); ctx.activityIdentity = next;
    for (const row of [assistant, thinking]) {
        assert.equal(row.text, '', 'retirement clears both original preview kinds');
        assert.equal(row.streaming, false, 'retirement settles both original preview kinds');
    }
    runtime(ctx, { seq: 7, kind: 'turn-end', status: 'done', finalText: 'LATE_RETIRED_FINAL' }); printDone(ctx, 'LATE_RETIRED_FINAL');
    for (const row of [assistant, thinking]) {
        assert.equal(row.text, '', 'late input cannot resurrect either original row');
        assert.equal(row.streaming, false, 'late input cannot reopen either original row');
    }
    for (const [i, row] of rows.entries()) assert.equal(ctx.store.transcript.items[i], row);
    assert.equal(ctx.store.transcript.items.length, rows.length); assert.deepEqual(assistantTexts(ctx).filter(Boolean), []);
    assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), rows.length);
});

test('D12 old gap fallback status and tools cannot mutate B clock or live tools', async t => {
    const { ctx } = activityFixture(t, [messageRequest()]); runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' }); gap(ctx);
    runtime(ctx, { seq: 1, runId: 'B', turnId: 'B-turn', kind: 'turn-start', provider: 'codex' }); gap(ctx, 'B');
    const tool = { type: 'agent_tool', traceRunId: 'B', sessionId: activityId.sessionId, scope: activityId.scope,
        icon: 'T', label: 'B_TOOL', detail: 'B_DETAIL', stepRef: 'shared-step', status: 'running' };
    handleWsMessage(ctx, msg(tool));
    const live = ctx.store.transcript.liveTools[0]!, before = JSON.stringify(live);
    const owner = ctx.activeActivityKey, clock = ctx.turnStartedAt, timer = ctx.footerTimer, state = ctx.streamState;
    for (const wire of [
        { type: 'agent_status', status: 'running', traceRunId: activityId.runId },
        { ...tool, traceRunId: activityId.runId, label: 'A_TOOL', detail: 'A_DETAIL', status: 'done' },
        { ...tool, traceRunId: activityId.runId, label: 'A_TOOL', detail: 'A_DETAIL', status: 'running' },
    ]) {
        handleWsMessage(ctx, msg(wire));
        assert.equal(ctx.activeActivityKey, owner); assert.equal(ctx.turnStartedAt, clock); assert.equal(ctx.footerTimer, timer);
        assert.equal(ctx.streamState, state); assert.deepEqual(ctx.store.transcript.liveTools, [live]);
        assert.equal(ctx.store.transcript.liveTools[0], live); assert.equal(JSON.stringify(live), before);
        assert.equal(committedTools(ctx).length, 0);
    }
    handleWsMessage(ctx, msg({ ...tool, traceRunId: activityId.runId, toolType: 'thinking', detail: 'A_OWN_THOUGHT' }));
    assert.ok(ctx.store.transcript.items.some(i => i.type === 'thinking' && i.text === 'A_OWN_THOUGHT'));
    assert.equal(ctx.streamState, state); assert.equal(JSON.stringify(live), before);
    runtime(ctx, { seq: 7, kind: 'turn-end', status: 'done', finalText: 'JOURNAL_ONLY' }); printDone(ctx, 'A_FINAL');
    await answerIdle(ctx); assert.deepEqual(ctx.store.transcript.liveTools, [live]);
    assert.equal(ctx.streamState, state); assert.equal(JSON.stringify(live), before);
});

// Independently declared request/answer owners, not inferred from observed GETs
// or selected from agent_done to manufacture matching server responses.
const producerOwners: Record<string, { sessionId: string; scope: string; runs: string[]; answerRun: string | null }> = {
    normal: { sessionId: 'print-chat-1', scope: 'print-scope-1',
        runs: ['tr_9f1d274b54b746d596cc6f9e6af80e64'], answerRun: 'tr_9f1d274b54b746d596cc6f9e6af80e64' },
    empty: { sessionId: 'print-chat-2', scope: 'print-scope-2',
        runs: ['tr_b510b90fa58e4367a644bde620b21d50'], answerRun: 'tr_b510b90fa58e4367a644bde620b21d50' },
    'terminal-gap': { sessionId: 'print-chat-3', scope: 'print-scope-3',
        runs: ['tr_b764dcc556aa43c4b9a944fcceaf255d'], answerRun: 'tr_b764dcc556aa43c4b9a944fcceaf255d' },
    'acp-error': { sessionId: 'default', scope: 'default',
        runs: ['tr_8256180e964a44d390c4a6968590e7cb'], answerRun: null },
    'agy-retry': { sessionId: 'default', scope: 'default',
        runs: ['tr_dc9c2afc9f3e48ab9df27235df56792b', 'tr_b484df9b6ebb46c6b9bd924607008866'],
        answerRun: 'tr_b484df9b6ebb46c6b9bd924607008866' },
};
for (const capture of printProducer.captures) for (const lookup of (
    ['normal', 'empty', 'agy-retry'].includes(capture.scenario) ? ['saved', 'absent', 'unavailable'] : ['saved'])) {
    test('D13 historical ' + capture.scenario + ' recorded frames, MESSAGE ' + lookup + ', settle one owned TUI answer', async t => {
        const owner = producerOwners[capture.scenario]!;
        const expected = owner.runs.map(run => messageRequest(run,
            lookup === 'saved' && run === owner.answerRun ? capture.expected.answer : null, owner, lookup === 'unavailable' ? 503 : 200));
        const { ctx } = activityFixture(t, expected); ctx.activityIdentity = capture.identity;
        assert.deepEqual(capture.identity, { sessionId: owner.sessionId, scope: owner.scope });
        for (const frame of capture.frames) handleWsMessage(ctx, msg(frame));
        await answerIdle(ctx);
        assert.deepEqual(assistantTexts(ctx), [capture.expected.answer], 'exactly one body, including the authoritative empty receipt');
        assert.equal(committedTools(ctx).length, 0, 'no toolLog duplicate while canonical close is pending');
        assert.equal(ctx.streaming, false);
        const activities = ctx.store.transcript.items.filter(i => i.type === 'activity');
        assert.equal(activities.length, capture.expected.activityCount);
        assert.deepEqual(activities.map(i => ({
            runId: i.model.identity.runId, turnId: i.model.identity.turnId,
            sessionId: i.model.identity.sessionId, scope: i.model.identity.scope,
        })), owner.runs.map(run => ({ runId: run, turnId: run, sessionId: owner.sessionId, scope: owner.scope })));
        assert.ok(activities.every(i => i.degraded === capture.expected.degraded));
        const answer = ctx.store.transcript.items.find(i => i.type === 'assistant');
        assert.ok(answer?.type === 'assistant');
        if (owner.answerRun) {
            const current = activityRow(ctx, owner.answerRun);
            assert.equal(answer.activityKey, current.key);
            assert.equal(answer.activitySource, lookup === 'saved' ? 'saved' : 'compatibility');
            assert.equal(answer.activityFinality, 'present');
            assert.equal(current.answerReadState, lookup);
            // Repeat the original compatible terminal: no extra body, owner or GET.
            for (const frame of capture.frames) if (frame.type === 'agent_done' && 'traceRunId' in frame
                && frame.traceRunId === owner.answerRun) handleWsMessage(ctx, msg(frame));
            await answerIdle(ctx);
            assert.deepEqual(assistantTexts(ctx), [capture.expected.answer]);
            assert.equal(ctx.store.transcript.items.find(i => i.type === 'assistant'), answer);
        } else {
            assert.equal(answer.activitySource, undefined, 'no-ID ACP error remains a legacy body');
            assert.equal(answer.activityKey, undefined, 'no fake canonical answer receipt');
        }
        if (capture.scenario === 'terminal-gap') assert.equal(activities[0]!.model.end, null, 'no fabricated canonical terminal');
        if (capture.scenario === 'agy-retry') {
            const old = activities[0]!, fresh = activities[1]!;
            assert.equal(old.model.end?.status, 'stopped'); assert.equal(old.model.end?.finalText, null);
            assert.equal(fresh.model.end?.status, 'done'); assert.equal(ctx.activeActivityKey, fresh.key);
            assert.ok(!ctx.store.transcript.items.some(i => i.type === 'assistant' && i.activityKey === old.key));
        }
    });
}
for (const order of ['legacy-first', 'canonical-first'] as const) for (const text of ['selected full answer\n' + 'x'.repeat(33000), '']) {
test('D14 print ' + order + ' coalesces ' + (text ? 'full bytes' : 'authoritative empty') + ' without native markers', async t => {
        const { ctx } = activityFixture(t, [messageRequest(activityId.runId, text)]);
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
        runtime(ctx, { seq: 3, kind: 'message', itemId: 'preview', phase: 'unknown', operation: 'append', text: 'NOT_ANSWER' });
        const end = () => runtime(ctx, { seq: 7, kind: 'turn-end', status: 'done', finalText: 'JOURNAL_ONLY' });
        if (order === 'canonical-first') { end(); assert.deepEqual(assistantTexts(ctx), []); }
        printDone(ctx, text);
        if (order === 'legacy-first') {
            assert.equal(activityRow(ctx).terminalStatus, 'finished');
            assert.match(renderActivityItem(activityRow(ctx), 80).join('\n'), /Finished/); end();
        }
        printDone(ctx, text); await answerIdle(ctx);
        assert.deepEqual(assistantTexts(ctx), [text]);
        const answer = ctx.store.transcript.items.find(i => i.type === 'assistant');
        assert.ok(answer?.type === 'assistant');
        assert.equal(answer.activityFinality, 'present'); assert.equal(answer.activityStatus, 'done');
        assert.equal(answer.activitySource, 'saved'); assert.equal(activityRow(ctx).terminalStatus, 'done');
        assert.equal(ctx.streaming, false); assert.equal(ctx.footerTimer, null);
    });
}

test('D15 print completion keeps its body across error/null canonical close and durable journal gap', async t => {
    const { ctx } = activityFixture(t, [messageRequest()]);
    runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' }); gap(ctx);
    printDone(ctx, 'CLI failed to start: useful diagnostic');
    assert.equal(ctx.streaming, false);
    runtime(ctx, { seq: 7, kind: 'turn-end', status: 'error', finalText: null }); await answerIdle(ctx);
    assert.deepEqual(assistantTexts(ctx), ['CLI failed to start: useful diagnostic']);
    const row = activityRow(ctx);
    assert.equal(row.terminalStatus, 'error'); assert.equal(row.recordingGap, true); assert.equal(row.degraded, true);
});

test('D16 unmarked print completion A then start B then late canonical A cannot stop B', async t => {
    const { ctx } = activityFixture(t, [messageRequest()]);
    runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' }); printDone(ctx, 'A full selected answer'); await answerIdle(ctx);
    runtime(ctx, { seq: 1, runId: 'B', turnId: 'B-turn', kind: 'turn-start', provider: 'codex' });
    const owner = ctx.activeActivityKey, clock = ctx.turnStartedAt, timer = ctx.footerTimer; ctx.inputActive = false;
    runtime(ctx, { seq: 7, kind: 'turn-end', status: 'error', finalText: 'different canonical diagnostic' });
    printDone(ctx, 'A full selected answer'); await answerIdle(ctx);
    assert.equal(ctx.activeActivityKey, owner); assert.equal(ctx.turnStartedAt, clock); assert.equal(ctx.footerTimer, timer);
    assert.equal(ctx.streaming, true); assert.equal(ctx.inputActive, false); assert.ok(timer);
    assert.deepEqual(assistantTexts(ctx), ['A full selected answer']);
});

test('D18 print compatibility distinguishes foreign, stale active-owner, idle legacy and owned missing-journal receipts', async t => {
    const { ctx } = activityFixture(t, [messageRequest(), messageRequest('owned-no-journal')]); runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
    for (const extra of [{ sessionId: 'foreign' }, { scope: 'foreign' }]) {
        printDone(ctx, 'wrong owner', extra);
        assert.deepEqual(assistantTexts(ctx), []); assert.equal(ctx.streaming, true);
    }
    printDone(ctx, 'stale unadmitted legacy', { traceRunId: 'unadmitted' });
    assert.deepEqual(assistantTexts(ctx), []); assert.equal(ctx.streaming, true);
    printDone(ctx, 'current done'); await answerIdle(ctx);
    printDone(ctx, 'idle legacy', { traceRunId: 'old-server-idle' });
    assert.deepEqual(assistantTexts(ctx), ['current done', 'idle legacy']);
    assert.equal(ctx.store.transcript.items.filter(i => i.type === 'activity').length, 1);
    printDone(ctx, 'owned without journal', { traceRunId: 'owned-no-journal',
        sessionId: activityId.sessionId, scope: activityId.scope });
    await answerIdle(ctx);
    assert.equal(ctx.store.transcript.items.filter(i => i.type === 'activity').length, 1);
    const receipt = ctx.store.transcript.items.find(i => i.type === 'assistant' && i.activityReadIdentity?.runId === 'owned-no-journal');
    assert.ok(receipt?.type === 'assistant'); assert.equal(receipt.text, 'owned without journal');
});

test('D22 semantic tool/commentary mirrors stay provisional and saved full answer wins once', async t => {
    const full = 'a'.repeat(33000) + ' SENTINEL_FULL_FINAL';
    const { ctx } = activityFixture(t, [messageRequest(activityId.runId, full)]);
    runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex-app' });
    runtime(ctx, { seq: 7, kind: 'tool', itemId: 'tool', name: 'Read', status: 'running', output: 'tool output' });
    runtime(ctx, { seq: 9, kind: 'message', itemId: 'work', phase: 'commentary', operation: 'append', text: 'work preview' });
    handleWsMessage(ctx, msg({ type: 'agent_output', traceRunId: activityId.runId, text: 'work preview' }));
    runtime(ctx, { seq: 15, kind: 'turn-end', status: 'done', finalText: 'JOURNAL_ONLY' });
    assert.deepEqual(assistantTexts(ctx), []);
    nativeDone(ctx, 'COMPATIBILITY_ONLY'); nativeDone(ctx, 'COMPATIBILITY_ONLY'); await answerIdle(ctx);
    assert.deepEqual(assistantTexts(ctx), [full]);
    assert.equal(ctx.store.transcript.items.filter(i => i.type === 'activity').length, 1);
    assert.equal(ctx.streaming, false); assert.equal(ctx.footerTimer, null); assert.equal(ctx.inputActive, true);
});

test('D23 journal terminal loss keeps compatibility final and settles the commit barrier after MESSAGE drains', async t => {
    const { ctx } = activityFixture(t, [messageRequest()]); runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex-app' });
    runtime(ctx, { seq: 3, kind: 'message', itemId: 'work', phase: 'unknown', operation: 'append', text: 'partial work' });
    gap(ctx); nativeDone(ctx, 'full fallback answer');
    assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), 0);
    await answerIdle(ctx);
    const row = activityRow(ctx);
    assert.equal(row.terminalStatus, 'done'); assert.equal(row.degraded, true); assert.equal(row.model.end, null);
    assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), ctx.store.transcript.items.length);
    assert.deepEqual(assistantTexts(ctx), ['full fallback answer']);
    runtime(ctx, { seq: 1, runId: 'next', turnId: 'next-turn', kind: 'turn-start', provider: 'codex-app' });
    assert.equal(ctx.streaming, true); assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), 2);
});

test('D24 late completion from an older Activity cannot stop a newer run', async t => {
    const { ctx } = activityFixture(t, [messageRequest()]); runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex-app' });
    runtime(ctx, { seq: 5, kind: 'turn-end', status: 'done', finalText: 'JOURNAL_ONLY' }); await answerIdle(ctx);
    runtime(ctx, { seq: 1, runId: 'new-run', turnId: 'new-turn', kind: 'turn-start', provider: 'codex-app' });
    ctx.inputActive = false; nativeDone(ctx, 'old answer'); await answerIdle(ctx);
    assert.equal(ctx.streaming, true); assert.equal(ctx.inputActive, false); assert.ok(ctx.footerTimer);
    assert.deepEqual(assistantTexts(ctx), ['old answer']);
});
for (const actualGap of [false, true]) {
test('D25 compatibility before canonical end preserves one answer and ' + (actualGap ? 'keeps real gap' : 'clears provisional gap'), async t => {
        const { ctx } = activityFixture(t, [messageRequest()]); runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex-app' });
        if (actualGap) gap(ctx);
        nativeDone(ctx, 'compatible answer');
        runtime(ctx, { seq: 7, kind: 'message', itemId: 'late-work', phase: 'commentary', operation: 'append', text: 'queued work' });
        handleWsMessage(ctx, msg({ type: 'agent_output', traceRunId: activityId.runId, text: 'queued work' }));
        handleWsMessage(ctx, msg({ type: 'agent_tool', traceRunId: activityId.runId, icon: 'tool', label: 'Read', status: 'running' }));
        assert.equal(ctx.streaming, false);
        runtime(ctx, { seq: 9, kind: 'turn-end', status: 'done', finalText: 'JOURNAL_ONLY' }); await answerIdle(ctx);
        const row = activityRow(ctx);
        assert.equal(row.degraded, actualGap); assert.equal(row.model.end?.seq, 9); assert.equal(row.model.entries.size, 1);
        assert.deepEqual(assistantTexts(ctx), ['compatible answer']); assert.equal(ctx.footerTimer, null);
    });
}

test('D26 identity refresh still permits exact admitted-run terminal settlement', async t => {
    const { ctx, http } = activityFixture(t, [controlRequest('/api/orchestrate/snapshot'), messageRequest()]); const snapshot = Promise.withResolvers<Response>();
    http.reply = url => url.pathname === '/api/orchestrate/snapshot' ? snapshot.promise : undefined;
    t.after(() => snapshot.resolve(Response.json({})));
    runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex-app' });
    const pending = refreshActivityIdentity(ctx);
    assert.equal(ctx.activityIdentity, null);
    runtime(ctx, { seq: 7, kind: 'turn-end', status: 'done', finalText: 'JOURNAL_ONLY' });
    nativeDone(ctx, 'complete while refreshing'); await answerIdle(ctx);
    snapshot.resolve(Response.json({ data: { activityIdentity: { sessionId: activityId.sessionId, scope: activityId.scope } } }));
    await pending;
    assert.equal(ctx.streaming, false); assert.deepEqual(assistantTexts(ctx), ['complete while refreshing']);
    assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), ctx.store.transcript.items.length);
});

test('D27 older completion during refresh cannot fall into newer-run legacy cleanup', async t => {
    const { ctx, http } = activityFixture(t, [messageRequest(), controlRequest('/api/orchestrate/snapshot')]); const snapshot = Promise.withResolvers<Response>();
    http.reply = url => url.pathname === '/api/orchestrate/snapshot' ? snapshot.promise : undefined;
    t.after(() => snapshot.resolve(Response.json({})));
    runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex-app' });
    runtime(ctx, { seq: 5, kind: 'turn-end', status: 'done', finalText: 'JOURNAL_ONLY' }); await answerIdle(ctx);
    runtime(ctx, { seq: 1, runId: 'new-run', turnId: 'new-turn', kind: 'turn-start', provider: 'codex-app' });
    ctx.inputActive = false;
    const owner = ctx.activeActivityKey, clock = ctx.turnStartedAt, timer = ctx.footerTimer;
    const pending = refreshActivityIdentity(ctx); assert.equal(ctx.activityIdentity, null);
    nativeDone(ctx, 'old answer'); await answerIdle(ctx);
    assert.equal(ctx.streaming, true); assert.equal(ctx.inputActive, false);
    assert.equal(ctx.activeActivityKey, owner); assert.equal(ctx.turnStartedAt, clock); assert.equal(ctx.footerTimer, timer);
    assert.deepEqual(assistantTexts(ctx), ['old answer']);
    snapshot.resolve(Response.json({ data: { activityIdentity: { sessionId: activityId.sessionId, scope: activityId.scope } } }));
    await pending;
});

test('D28 new run missing its start takes lifecycle ownership after the previous run settled', async t => {
    const { ctx } = activityFixture(t, [messageRequest(), messageRequest('new')]); runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex-app' });
    nativeDone(ctx, 'old'); await answerIdle(ctx);
    const identity = ctx.activityIdentity; ctx.activityIdentity = null;
    runtime(ctx, { seq: 1, runId: 'new', turnId: 'new-turn', kind: 'turn-start', provider: 'codex-app' });
    assert.equal(ctx.store.transcript.items.filter(i => i.type === 'activity').length, 1);
    ctx.activityIdentity = identity;
    runtime(ctx, { seq: 7, runId: 'new', turnId: 'new-turn', kind: 'tool', itemId: 'read', name: 'Read', status: 'running' });
    assert.equal(ctx.streaming, true); assert.equal(ctx.activeActivityKey, activityRow(ctx, 'new').key);
    ctx.inputActive = false; nativeDone(ctx, 'new answer', { traceRunId: 'new' }); await answerIdle(ctx);
    assert.equal(ctx.streaming, false); assert.equal(ctx.inputActive, true);
});

test('D29 classic legacy display emits canonical commentary and tool details before final', t => {
    const { ctx } = activityFixture(t, []); ctx.displayMode = 'line'; ctx.settingsSnapshot = { presentation: { mode: 'legacy' } };
    const output = lineCapture(t);
    runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex-app' });
    runtime(ctx, { seq: 3, kind: 'message', itemId: 'm', phase: 'commentary', operation: 'append', text: 'VISIBLE_WORK' });
    const before = output().length;
    runtime(ctx, { seq: 4, kind: 'request', requestId: 'question', requestType: 'question', view: { title: 'Question', fields: [] } });
    assert.match(output().slice(before), /^\n\r\x1b\[2KWaiting for question/);
    runtime(ctx, { seq: 5, kind: 'message', itemId: 'm', phase: 'commentary', operation: 'replace', text: 'VISIBLE_WORK MESSAGE_SUFFIX_ONLY' });
    runtime(ctx, { seq: 7, kind: 'tool', itemId: 't', name: 'Read', status: 'running', output: 'VISIBLE_TOOL_OUTPUT' });
    runtime(ctx, { seq: 8, kind: 'tool', itemId: 't', name: 'Read', status: 'running', output: 'VISIBLE_TOOL_OUTPUT TOOL_SUFFIX_ONLY' });
    assert.equal(output().match(/VISIBLE_WORK/g)?.length, 1);
    assert.equal(output().match(/MESSAGE_SUFFIX_ONLY/g)?.length, 1);
    assert.equal(output().match(/TOOL_SUFFIX_ONLY/g)?.length, 1);
    assert.equal(output().match(/VISIBLE_TOOL_OUTPUT/g)?.length, 1); assert.equal(assistantTexts(ctx).length, 0);
});

test('D30 classic footer repaint preserves the cell cursor between streamed suffixes', async t => {
    const { ctx } = activityFixture(t, []); ctx.displayMode = 'line'; ctx.settingsSnapshot = { presentation: { mode: 'legacy' } };
    const output = lineCapture(t);
    runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex-app' });
    runtime(ctx, { seq: 3, kind: 'message', itemId: 'm', phase: 'commentary', operation: 'replace', text: 'Checking' });
    runtime(ctx, { seq: 5, kind: 'message', itemId: 'm', phase: 'commentary', operation: 'replace', text: 'Checking files' });
    cleanupCtx(ctx);
    const terminal = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    try {
        // Mocked pre-PTY stdout has not had the OS ONLCR conversion.
        await new Promise<void>(resolve => terminal.write(output().replace(/\r?\n/g, '\r\n'), resolve));
        const rows = Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? '');
        assert.ok(rows.some(row => row.includes('Checking files')), rows.join('\n'));
    } finally { terminal.dispose(); }
});

test('D31 Activity rejects foreign identities and retains at most16 preview models without native commits', async t => {
    const { ctx } = activityFixture(t, Array.from({ length: 17 }, (_, i) => messageRequest('run-' + i)));
    runtime(ctx, { seq: 1, sessionId: 'provider-session', kind: 'turn-start', provider: 'codex-app' });
    runtime(ctx, { seq: 1, scope: 'foreign', kind: 'turn-start', provider: 'codex-app' });
    assert.equal(ctx.store.transcript.items.length, 0);
    for (let i = 0; i < 17; i++) {
        const runId = 'run-' + i, turnId = 'turn-' + i;
        runtime(ctx, { seq: 1, runId, turnId, kind: 'turn-start', provider: 'codex-app' });
        runtime(ctx, { seq: 3, runId, turnId, kind: 'message', itemId: 'm', phase: 'commentary', operation: 'append', text: 'preview' });
        runtime(ctx, { seq: 5, runId, turnId, kind: 'turn-end', status: 'done', finalText: 'JOURNAL_ONLY' });
        nativeDone(ctx, 'final-' + i, { traceRunId: runId }); await answerIdle(ctx);
    }
    const turns = ctx.store.transcript.items.filter(i => i.type === 'activity');
    assert.equal(turns.filter(i => !i.released).length, 16); assert.equal(ctx.store.transcript.items.length, 34);
    assert.deepEqual(assistantTexts(ctx), Array.from({ length: 17 }, (_, i) => 'final-' + i));
    assert.equal(turns[0]?.model.entries.size, 0);
});

test('D32 interactive raw prints semantic frames once without mutating display state', t => {
    const { ctx, calls } = activityFixture(t, []); ctx.isRaw = true; const lines: string[] = [];
    t.mock.method(console, 'log', (...args: unknown[]) => { lines.push(args.join(' ')); });
    const frame = { type: 'agent_runtime', version: 1, runId: 'raw-run', sessionId: 'raw-session',
        scope: 'local:raw-session', turnId: 'raw-turn', seq: 1, kind: 'turn-start', provider: 'codex-app' };
    handleWsMessage(ctx, msg(frame));
    assert.equal(lines.length, 1); assert.ok(lines[0]?.includes(JSON.stringify(frame)));
    assert.deepEqual(ctx.store.transcript.items, []); assert.equal(ctx.streaming, false);
    assert.equal(ctx.footerTimer, null); assert.equal(calls.length, 0);
});

test('D33 overlapping settings refreshes retain the newest presentation response', async t => {
    const { ctx, http } = activityFixture(t, [controlRequest('/api/auth/token'), controlRequest('/api/settings'),
        controlRequest('/api/auth/token'), controlRequest('/api/settings'), controlRequest('/api/session'), controlRequest('/api/orchestrate/snapshot')]);
    const pending = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()];
    const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]; let settings = 0;
    http.reply = url => {
        if (url.pathname === '/api/settings') { const i = settings++; started[i]!.resolve(); return pending[i]!.promise; }
        if (url.pathname === '/api/session') return Response.json({ data: { model: 'new-model' } });
        if (url.pathname === '/api/orchestrate/snapshot') return Response.json({ data: { activityIdentity: ctx.activitySettlementIdentity } });
        return undefined;
    };
    t.after(() => pending.forEach(p => p.resolve(Response.json({}))));
    const first = refreshInfo(ctx); await started[0]!.promise;
    const second = refreshInfo(ctx); await started[1]!.promise;
    pending[1]!.resolve(Response.json({ data: { presentation: { mode: 'legacy' } } })); assert.equal(await second, true);
    pending[0]!.resolve(Response.json({ data: { presentation: { mode: 'activity' } } })); assert.equal(await first, false);
    assert.deepEqual(ctx.settingsSnapshot['presentation'], { mode: 'legacy' }); assert.equal(settings, 2);
});

test('D34 a newer settings refresh also invalidates the older in-flight snapshot', async t => {
    const { ctx, http } = activityFixture(t, [controlRequest('/api/auth/token'), controlRequest('/api/settings'), controlRequest('/api/session'), controlRequest('/api/orchestrate/snapshot'),
        controlRequest('/api/auth/token'), controlRequest('/api/settings'), controlRequest('/api/session'), controlRequest('/api/orchestrate/snapshot')]);
    const snapshot = Promise.withResolvers<Response>(), session = Promise.withResolvers<Response>();
    const snapshotStarted = Promise.withResolvers<void>(), sessionStarted = Promise.withResolvers<void>();
    let settings = 0, sessions = 0, snapshots = 0;
    http.reply = url => {
        if (url.pathname === '/api/settings') return Response.json({ data: { presentation: { mode: ++settings === 1 ? 'activity' : 'legacy' } } });
        if (url.pathname === '/api/session') {
            if (++sessions === 2) { sessionStarted.resolve(); return session.promise; }
            return Response.json({ data: {} });
        }
        if (url.pathname === '/api/orchestrate/snapshot') {
            if (++snapshots === 1) { snapshotStarted.resolve(); return snapshot.promise; }
            return Response.json({ data: { activityIdentity: { sessionId: 'new', scope: 'local:new' } } });
        }
        return undefined;
    };
    t.after(() => { snapshot.resolve(Response.json({})); session.resolve(Response.json({})); });
    const first = refreshInfo(ctx); await snapshotStarted.promise;
    const second = refreshInfo(ctx); await sessionStarted.promise;
    snapshot.resolve(Response.json({ data: { activityIdentity: { sessionId: 'stale', scope: 'local:stale' } } }));
    assert.equal(await first, false); assert.equal(ctx.activityIdentity, null);
    session.resolve(Response.json({ data: {} }));
    assert.equal(await second, true); assert.deepEqual(ctx.activityIdentity, { sessionId: 'new', scope: 'local:new' });
});

test('D35 failed presentation PUT keeps the current display preference', async t => {
    const { ctx, http, calls } = activityFixture(t, [controlRequest('/api/settings', 'PUT', JSON.stringify({ presentation: { mode: 'activity' } }), 503)]); ctx.settingsSnapshot = { presentation: { mode: 'legacy' } };
    ctx.store.overlay.settingsSelected = buildAppearanceRows({ settings: ctx.settingsSnapshot, tuiConfig: ctx.tuiConfig,
        footerPreview: '' }).findIndex(row => row.id === 'presentation');
    http.reply = (url, init) => url.pathname === '/api/settings' && init?.method === 'PUT'
        ? Response.json({ error: 'settings unavailable' }, { status: 503 }) : undefined;
    await applySettingsSelection(ctx);
    const puts = calls.filter(call => call.init?.method === 'PUT');
    assert.equal(puts.length, 1); assert.equal(puts[0]?.url.pathname, '/api/settings');
    assert.equal(puts[0]?.init?.body, JSON.stringify({ presentation: { mode: 'activity' } }));
    assert.deepEqual(ctx.settingsSnapshot['presentation'], { mode: 'legacy' });
    assert.match(ctx.store.overlay.settingsMessage, /Failed to save Presentation/);
});

test('native final helper replaces only streaming assistant rows after the latest user', () => {
    const ctx = makeCtx();
    const transcript = ctx.store.transcript;
    const prior = { type: 'assistant' as const, text: 'earlier turn', streaming: true, timestamp: 1 };
    transcript.items.push(prior);
    appendUserItem(transcript, 'current', 'current');
    const work = { type: 'assistant' as const, text: 'settled work note', streaming: false, timestamp: 2 };
    const tool = { type: 'tool' as const, text: 'read', timestamp: 3 };
    const thinking = { type: 'thinking' as const, text: 'reasoning', streaming: true, timestamp: 4 };
    transcript.items.push(work, tool, thinking, { type: 'assistant', text: 'draft', streaming: true, timestamp: 5 });
    replaceNativeAssistantFinal(transcript, 'exact final');
    assert.deepEqual(assistantTexts(ctx), ['earlier turn', 'settled work note', 'exact final']);
    assert.equal(transcript.items[0], prior);
    assert.equal(transcript.items[2], work);
    assert.equal(transcript.items[3], tool);
    assert.equal(transcript.items[4], thinking);
    assert.equal(thinking.streaming, true);
});

for (const finality of ['present', 'absent']) {
    for (const text of ['', null]) {
        test(`native ${finality} ${text === null ? 'null' : 'empty'} clears provisional content and settles controls`, () => {
            const ctx = makeCtx();
            let flushed = 0;
            try {
                appendUserItem(ctx.store.transcript, 'q', 'q');
                handleWsMessage(ctx, msg({ type: 'agent_output', text: 'provisional' }));
                ctx.inputActive = false;
                ctx.streamSink = { push() {}, end() { flushed++; } };
                handleWsMessage(ctx, msg({ type: 'agent_done', text, runtimeFinality: finality,
                    traceRunId: `native-${finality}-${text}`, toolLog: [{icon:'tool',label:'read',status:'done',stepRef:'read-1'}] }));
                assert.deepEqual(assistantTexts(ctx), []);
                assert.equal(committedTools(ctx).length, 1);
                assert.equal(flushed, 0);
                assert.equal(ctx.streamSink, null);
                assert.equal(ctx.streaming, false);
                assert.equal(ctx.streamState, 'idle');
                assert.equal(ctx.inputActive, true);
                assert.equal(ctx.footerTimer, null);
            } finally { cleanupCtx(ctx); }
        });
    }
}

test('native exact non-prefix final replaces provisional rows and both terminal sources settle once', () => {
    for (const first of ['agent_done', 'orchestrate_done']) {
        const ctx = makeCtx();
        let frames = 0;
        ctx.requestFrame = () => { frames++; };
        try {
            handleWsMessage(ctx, msg({ type: 'agent_output', text: 'draft' }));
            const terminal = {text:'rewritten answer',runtimeFinality:'present',traceRunId:'native-pair'};
            handleWsMessage(ctx, msg({ type: first, ...terminal }));
            const settledFrames = frames;
            handleWsMessage(ctx, msg({ type: first === 'agent_done' ? 'orchestrate_done' : 'agent_done', ...terminal }));
            assert.deepEqual(assistantTexts(ctx), ['rewritten answer']);
            assert.equal(frames, settledFrames);
            assert.equal(ctx.inputActive, true);
            assert.equal(ctx.footerTimer, null);
        } finally { cleanupCtx(ctx); }
    }
});

test('invalid finality keeps legacy reconciliation and sink flushing', () => {
    const ctx = makeCtx();
    let flushed = 0;
    try {
        handleWsMessage(ctx, msg({ type:'agent_output', text:'legacy preview' }));
        ctx.streamSink = {push() {}, end() { flushed++; }};
        handleWsMessage(ctx, msg({type:'agent_done',text:'',runtimeFinality:'invalid'}));
        assert.deepEqual(assistantTexts(ctx), ['legacy preview']);
        assert.equal(flushed, 1);
    } finally { cleanupCtx(ctx); }
});

test('classic native absent discards unflushed preview and labels existing stdout provisional', t => {
    const ctx = makeCtx();
    ctx.displayMode = 'line';
    let output = '';
    t.mock.method(process.stdout, 'write', (chunk: unknown) => { output += String(chunk); return true; });
    try {
        handleWsMessage(ctx, msg({type:'agent_output',text:'unflushed provisional token'}));
        output = '';
        handleWsMessage(ctx, msg({type:'agent_done',text:'',runtimeFinality:'absent'}));
        assert.doesNotMatch(output, /unflushed provisional token/);
        assert.match(output, /provisional/);
        assert.match(output, /no final answer/i);
        assert.equal(ctx.inputActive, true);
        assert.equal(ctx.footerTimer, null);
    } finally { cleanupCtx(ctx); }
});

test('native tool-only absence settles without creating an assistant row', () => {
    const ctx = makeCtx();
    try {
        handleWsMessage(ctx, msg({type:'agent_tool',icon:'tool',label:'read',stepRef:'native-read',status:'running'}));
        ctx.inputActive = false;
        handleWsMessage(ctx, msg({type:'agent_done',text:null,runtimeFinality:'absent',error:true}));
        assert.deepEqual(assistantTexts(ctx), []);
        assert.equal(ctx.store.transcript.liveTools.length, 0);
        assert.equal(ctx.streaming, false);
        assert.equal(ctx.inputActive, true);
        assert.equal(ctx.footerTimer, null);
        const tool = committedTools(ctx)[0];
        assert.equal(tool?.type === 'tool' ? tool.status : undefined, 'error');
    } finally { cleanupCtx(ctx); }
});

test('native terminal pair without run identity does not duplicate the current settled segment', () => {
    const ctx = makeCtx();
    try {
        handleWsMessage(ctx, msg({type:'agent_output',text:'draft'}));
        handleWsMessage(ctx, msg({type:'agent_done',text:'final',runtimeFinality:'present'}));
        handleWsMessage(ctx, msg({type:'orchestrate_done',text:'final',runtimeFinality:'present'}));
        assert.deepEqual(assistantTexts(ctx), ['final']);
        appendUserItem(ctx.store.transcript, 'next', 'next');
        handleWsMessage(ctx, msg({type:'agent_done',text:'next final',runtimeFinality:'present'}));
        assert.deepEqual(assistantTexts(ctx), ['final', 'next final']);
    } finally { cleanupCtx(ctx); }
});

test('raw interactive orchestrate terminal remains a raw event rather than native transcript finalization', t => {
    const ctx = makeCtx();
    ctx.isRaw = true;
    const lines: unknown[][] = [];
    t.mock.method(console, 'log', (...args: unknown[]) => { lines.push(args); });
    const payload = {type:'orchestrate_done',text:'exact raw',runtimeFinality:'present'};
    handleWsMessage(ctx, msg(payload));
    assert.equal(ctx.store.transcript.items.length, 0);
    assert.equal(lines.length, 1);
    assert.ok(String(lines[0]?.[0]).includes(JSON.stringify(payload)));
});

test('agent_done drains running live tools and keeps final answer after tool-only output', () => {
    const ctx = makeCtx();
    try {
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'date', status: 'running', stepRef: 's1' }));
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '🔧', label: 'Read', detail: 'src/a.ts', status: 'running', stepRef: 's2' }));

        handleWsMessage(ctx, msg({ type: 'agent_done', text: 'Final answer after tools.' }));

        assert.equal(ctx.store.transcript.liveTools.length, 0);
        assert.equal(committedTools(ctx).length, 2);
        assert.deepEqual(assistantTexts(ctx), ['Final answer after tools.']);
        assert.equal(ctx.inputActive, true);
        assert.equal(ctx.streamState, 'idle');
        assert.equal(ctx.footerTimer, null);
    } finally {
        cleanupCtx(ctx);
    }
});

test('agent_done toolLog updates duplicate stepRef detail without appending duplicate rows', () => {
    const ctx = makeCtx();
    try {
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'short', status: 'running', stepRef: 's1' }));
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'short', status: 'done', stepRef: 's1' }));

        handleWsMessage(ctx, msg({
            type: 'agent_done',
            text: 'Done.',
            toolLog: [{ icon: '🔧', label: 'Bash', detail: 'richer final output', status: 'done', stepRef: 's1' }],
        }));

        const tools = committedTools(ctx);
        assert.equal(tools.length, 1);
        const tool = tools[0]!;
        assert.equal(tool.type, 'tool');
        if (tool.type === 'tool') {
            assert.equal(tool.stepRef, 's1');
            assert.equal(tool.detail, 'richer final output');
            assert.equal(tool.status, 'done');
            assert.equal(tool.collapsed, true);
        }
        assert.equal(ctx.footerTimer, null);
    } finally {
        cleanupCtx(ctx);
    }
});

test('agent_done appends only final suffix after streamed text around tools', () => {
    const ctx = makeCtx();
    try {
        handleWsMessage(ctx, msg({ type: 'agent_output', text: 'Partial' }));
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'echo', status: 'running', stepRef: 's1' }));

        handleWsMessage(ctx, msg({ type: 'agent_done', text: 'Partial final.' }));

        assert.equal(ctx.store.transcript.liveTools.length, 0);
        assert.equal(committedTools(ctx).length, 1);
        assert.deepEqual(assistantTexts(ctx), ['Partial', ' final.']);
        assert.equal(ctx.store.transcript.items.some(item => item.type === 'assistant' && item.streaming), false);
        assert.equal(ctx.footerTimer, null);
    } finally {
        cleanupCtx(ctx);
    }
});

test('agent_done error drains remaining live tools as error rows', () => {
    const ctx = makeCtx();
    try {
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'npm test', status: 'running', stepRef: 's1' }));

        handleWsMessage(ctx, msg({ type: 'agent_done', text: 'Failed.', error: 'boom' }));

        const tool = committedTools(ctx)[0]!;
        assert.equal(tool.type, 'tool');
        if (tool.type === 'tool') {
            assert.equal(tool.status, 'error');
            assert.equal(tool.collapsed, true);
        }
        assert.deepEqual(assistantTexts(ctx), ['Failed.']);
        assert.equal(ctx.footerTimer, null);
    } finally {
        cleanupCtx(ctx);
    }
});


// ── 260703 CJ-WP3 regressions ──

test('agent_done toolLog replay does not duplicate a stepRef-less tool committed live', () => {
    const ctx = makeCtx();
    try {
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'short', status: 'running' }));
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'short', status: 'done' }));
        handleWsMessage(ctx, msg({
            type: 'agent_done',
            text: 'Done.',
            toolLog: [{ icon: '🔧', label: 'Bash', detail: 'richer final output', status: 'done' }],
        }));

        const tools = committedTools(ctx);
        assert.equal(tools.length, 1, `duplicated stepRef-less tool rows: ${tools.length}`);
        const tool = tools[0]!;
        if (tool.type === 'tool') {
            assert.equal(tool.detail, 'richer final output');
            assert.equal(tool.status, 'done');
        }
    } finally {
        cleanupCtx(ctx);
    }
});

test('stepRef-less fallback dedup is per turn — the same label commits fresh next turn', () => {
    const ctx = makeCtx();
    try {
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'turn1', status: 'done' }));
        appendUserItem(ctx.store.transcript, 'next question', 'next question');
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'turn2', status: 'done' }));

        const tools = committedTools(ctx);
        assert.equal(tools.length, 2, 'second-turn tool row was wrongly deduped');
    } finally {
        cleanupCtx(ctx);
    }
});

test('agent_done appends a reordered/renormalized final text instead of dropping it', () => {
    const ctx = makeCtx();
    try {
        handleWsMessage(ctx, msg({ type: 'agent_output', text: 'streamed draft' }));
        // Final is NOT a prefix-extension and NOT contained in the stream —
        // previously dropped silently, losing the canonical answer.
        handleWsMessage(ctx, msg({ type: 'agent_done', text: 'Rewritten canonical answer.' }));
        assert.deepEqual(assistantTexts(ctx), ['streamed draft\nRewritten canonical answer.']);

        // Contained final (renormalized superset stream) must NOT duplicate.
        appendUserItem(ctx.store.transcript, 'q2', 'q2');
        handleWsMessage(ctx, msg({ type: 'agent_output', text: 'full answer text\n' }));
        handleWsMessage(ctx, msg({ type: 'agent_done', text: 'full answer text' }));
        const texts = assistantTexts(ctx);
        assert.equal(texts.filter(t => t.includes('full answer text')).length, 1, `duplicated final: ${JSON.stringify(texts)}`);
    } finally {
        cleanupCtx(ctx);
    }
});

test('stepRef-less dedup resets at agent_done — a /retry-shaped run (no user item) commits fresh rows', () => {
    const ctx = makeCtx();
    try {
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'run1', status: 'done' }));
        handleWsMessage(ctx, msg({ type: 'agent_done', text: 'first.', toolLog: [] }));
        // /retry: a new run starts WITHOUT appendUserItem.
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'run2', status: 'done' }));

        const tools = committedTools(ctx);
        assert.equal(tools.length, 2, 'retried run tool row was wrongly deduped');
        const last = tools[tools.length - 1]!;
        if (last.type === 'tool') assert.equal(last.detail, 'run2');
    } finally {
        cleanupCtx(ctx);
    }
});

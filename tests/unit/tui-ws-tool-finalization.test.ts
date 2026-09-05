import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWsMessage } from '../../bin/commands/tui/ws-handler.ts';
import type { TuiContext } from '../../bin/commands/tui/types.ts';
import { createTuiStore } from '../../src/cli/tui/store.ts';
import { appendUserItem, replaceNativeAssistantFinal } from '../../src/cli/tui/transcript.ts';
import { renderStatusBar } from '../../src/cli/tui/jawcode-bridge.ts';
import { stopSpinner } from '../../src/cli/tui/spinner.ts';
import { refreshInfo, refreshActivityIdentity } from '../../bin/commands/tui/api.ts';
import { applySettingsSelection } from '../../bin/commands/tui/overlays.ts';
import { buildAppearanceRows } from '../../src/cli/tui/settings-screen.ts';
import { computeStablePrefixIndex } from '../../bin/commands/tui/fullscreen-mode.ts';
import xterm from '@xterm/xterm';
import { releaseCommittedActivity, restoreActiveActivity, retireActivityView } from '../../bin/commands/tui/activity-replay.js';
import { renderActivityItem } from '../../src/cli/tui/activity.js';
import printProducer from '../fixtures/tui-print-producer.json' with { type: 'json' };

function makeCtx(): TuiContext {
    return {
        ws: { send() { /* no-op */ }, close() { /* no-op */ } },
        apiUrl: '',
        info: { cli: 'jwc', workingDir: '/tmp/project', model: 'test-model' },
        accent: '',
        label: 'jwc',
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
            engine: 'jwc',
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

const runtimeIdentity = { version: 1, sessionId: 'activity-chat', scope: 'local:activity-chat', runId: 'activity-run', turnId: 'activity-turn' };
function activityContext(): TuiContext {
    const ctx = makeCtx();
    ctx.activityIdentity = { sessionId: runtimeIdentity.sessionId, scope: runtimeIdentity.scope };
    ctx.activityIdentityGeneration = 0;
    return ctx;
}
function runtime(ctx: TuiContext, body: Record<string, unknown>): void {
    handleWsMessage(ctx, msg({ type: 'agent_runtime', ...runtimeIdentity, ...body }));
}
function compatibility(ctx: TuiContext, text: string, extra: Record<string, unknown> = {}): void {
    handleWsMessage(ctx, msg({ type: 'agent_done', traceRunId: runtimeIdentity.runId,
        runtimeFinality: 'present', runtimeStatus: 'done', text, ...extra }));
}

function printCompatibility(ctx: TuiContext, text: string, extra: Record<string, unknown> = {}): void {
    handleWsMessage(ctx, msg({ type: 'agent_done', traceRunId: runtimeIdentity.runId, text, ...extra }));
}

function gapOutput(ctx: TuiContext, text: string, extra: Record<string, unknown> = {}): void {
    handleWsMessage(ctx, msg({ type: 'agent_output', traceRunId: runtimeIdentity.runId,
        sessionId: runtimeIdentity.sessionId, scope: runtimeIdentity.scope, text, ...extra }));
}

test('admitted gap tool mirrors and final tool backfill cannot execute provider terminal controls', () => {
    const ctx = activityContext();
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
        handleWsMessage(ctx, msg({ type: 'agent_runtime_gap', ...runtimeIdentity, reason: 'projection_degraded' }));
        handleWsMessage(ctx, msg({ type: 'agent_tool', traceRunId: runtimeIdentity.runId,
            icon: '$', label: '\x1b[2JRead', detail: '\x1b]52;c;SECRET\x07safe result', status: 'running', stepRef: 't' }));
        assert.equal(ctx.store.transcript.liveTools[0]?.label, 'Read');
        assert.equal(ctx.store.transcript.liveTools[0]?.detail, 'safe result');
        printCompatibility(ctx, 'final', { toolLog: [{ icon: '$', label: '\x1b[2JRead',
            detail: '\x1b]52;c;SECRET\x07safe final result', status: 'done', stepRef: 't' }] });
        const tool = committedTools(ctx)[0]!;
        assert.ok(tool.type === 'tool');
        assert.equal(tool.detail, 'safe final result');
        assert.doesNotMatch(tool.text, /\x1b|SECRET/);
    } finally { cleanupCtx(ctx); }
});

for (const order of ['legacy-first', 'canonical-first'] as const) {
    for (const finalText of ['FULL_FINAL_BYTES\r\n', '']) {
        test(`gap fallback ${order} settles ${finalText ? 'full' : 'empty'} final without shifting previews`, () => {
            const ctx = activityContext();
            try {
                runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
                handleWsMessage(ctx, msg({ type: 'agent_runtime_gap', ...runtimeIdentity, reason: 'projection_degraded' }));
                gapOutput(ctx, 'PROVISIONAL_THOUGHT', { thinking: true });
                gapOutput(ctx, 'PROVISIONAL_ANSWER');
                const items = ctx.store.transcript.items;
                const previews = items.slice();
                const end = () => runtime(ctx, { seq: 7, kind: 'turn-end', status: 'done', finalText });
                if (order === 'canonical-first') {
                    end();
                    assert.equal(computeStablePrefixIndex(items), items.length, 'canonical close settles previews before compatibility');
                }
                printCompatibility(ctx, finalText);
                assert.equal(computeStablePrefixIndex(items), items.length, 'compatibility close settles previews before canonical');
                if (order === 'legacy-first') end();
                printCompatibility(ctx, finalText);
                assert.equal(ctx.store.transcript.items, items);
                for (const [i, row] of previews.entries()) assert.equal(items[i], row, `stable row ${i}`);
                assert.equal(items.length, previews.length + 1);
                assert.deepEqual(assistantTexts(ctx).filter(Boolean), finalText ? [finalText] : []);
                assert.ok(!items.some(item => (item.type === 'assistant' || item.type === 'thinking') && item.streaming));
                assert.ok(!items.some(item => 'text' in item && /PROVISIONAL_/.test(item.text)));
                assert.equal(computeStablePrefixIndex(items), items.length);
            } finally { cleanupCtx(ctx); }
        });

        test(`line gap fallback ${order} labels provisional and ${finalText ? 'full' : 'empty'} final once`, () => {
            const ctx = activityContext();
            ctx.displayMode = 'line';
            const original = process.stdout.write;
            let output = '';
            process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
            try {
                runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
                handleWsMessage(ctx, msg({ type: 'agent_runtime_gap', ...runtimeIdentity, reason: 'projection_degraded' }));
                gapOutput(ctx, 'PROVISIONAL_ANSWER\n\n');
                const beforeFinal = output.length;
                const end = () => runtime(ctx, { seq: 7, kind: 'turn-end', status: 'done', finalText });
                if (order === 'canonical-first') end();
                printCompatibility(ctx, finalText);
                if (order === 'legacy-first') end();
                printCompatibility(ctx, finalText);
                assert.match(output.slice(0, beforeFinal), /Provisional output/);
                assert.equal(output.match(/PROVISIONAL_ANSWER/g)?.length, 1);
                assert.equal(output.slice(beforeFinal).match(finalText ? /FULL_FINAL_BYTES/g : /final answer is empty/gi)?.length, 1);
                assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), ctx.store.transcript.items.length);
            } finally { process.stdout.write = original; cleanupCtx(ctx); }
        });
    }

    test(`gap fallback A then B then ${order} late A preserves B previews and lifecycle`, () => {
        const ctx = activityContext();
        try {
            runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
            handleWsMessage(ctx, msg({ type: 'agent_runtime_gap', ...runtimeIdentity, reason: 'projection_degraded' }));
            gapOutput(ctx, 'A_THOUGHT', { thinking: true });
            gapOutput(ctx, 'A_PREVIEW');
            appendUserItem(ctx.store.transcript, 'B user', 'B user');
            runtime(ctx, { seq: 1, runId: 'B', kind: 'turn-start', provider: 'codex' });
            handleWsMessage(ctx, msg({ type: 'agent_runtime_gap', ...runtimeIdentity, runId: 'B', reason: 'projection_degraded' }));
            gapOutput(ctx, 'B_THOUGHT', { traceRunId: 'B', thinking: true });
            gapOutput(ctx, 'B_PREVIEW', { traceRunId: 'B' });
            const bIndex = ctx.store.transcript.items.findIndex(item => item.type === 'activity' && item.model.identity.runId === 'B');
            const bRows = ctx.store.transcript.items.slice(bIndex);
            const before = bRows.map(row => JSON.stringify(row));
            const owner = ctx.activeActivityKey;
            const clock = ctx.turnStartedAt;
            const timer = ctx.footerTimer;
            const sink = { push() {}, end() { assert.fail('A must not flush B'); } };
            ctx.streamSink = sink;
            ctx.inputActive = false;
            const end = () => runtime(ctx, { seq: 7, kind: 'turn-end', status: 'error', finalText: null });
            if (order === 'canonical-first') end();
            printCompatibility(ctx, 'A_DIAGNOSTIC');
            if (order === 'legacy-first') end();
            assert.deepEqual(bRows.map(row => JSON.stringify(row)), before);
            assert.equal(ctx.activeActivityKey, owner);
            assert.equal(ctx.turnStartedAt, clock);
            assert.equal(ctx.footerTimer, timer);
            assert.equal(ctx.streamSink, sink);
            assert.equal(ctx.streaming, true);
            assert.equal(ctx.inputActive, false);
            assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), bIndex);
            assert.ok(!ctx.store.transcript.items.some(item => 'text' in item && /A_THOUGHT|A_PREVIEW/.test(item.text)));
            assert.deepEqual(assistantTexts(ctx).filter(Boolean), ['B_PREVIEW', 'A_DIAGNOSTIC']);
        } finally { cleanupCtx(ctx); }
    });
}

test('line gap fallback sanitizes split controls and delivers a canonical-null diagnostic once', () => {
    const ctx = activityContext();
    ctx.displayMode = 'line';
    const original = process.stdout.write;
    let output = '';
    process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
        handleWsMessage(ctx, msg({ type: 'agent_runtime_gap', ...runtimeIdentity, reason: 'projection_degraded' }));
        gapOutput(ctx, 'VISIBLE_PREVIEW\x1b]52;c;');
        gapOutput(ctx, 'HIDDEN_PAYLOAD\x07VISIBLE_SUFFIX');
        runtime(ctx, { seq: 7, kind: 'turn-end', status: 'error', finalText: null });
        printCompatibility(ctx, 'STARTUP_DIAGNOSTIC');
        printCompatibility(ctx, 'STARTUP_DIAGNOSTIC');
        assert.equal(output.match(/VISIBLE_PREVIEW/g)?.length, 1);
        assert.equal(output.match(/VISIBLE_SUFFIX/g)?.length, 1);
        assert.doesNotMatch(output, /HIDDEN_PAYLOAD|Updated diagnostic/);
        assert.equal(output.match(/STARTUP_DIAGNOSTIC/g)?.length, 1);
        assert.match(output, /Diagnostic/);
        assert.deepEqual(assistantTexts(ctx).filter(Boolean), ['STARTUP_DIAGNOSTIC']);
        assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), ctx.store.transcript.items.length);
    } finally { process.stdout.write = original; cleanupCtx(ctx); }
});

test('gap fallback thinking tool snapshots keep their indices and retire on canonical close', () => {
    const ctx = activityContext();
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
        handleWsMessage(ctx, msg({ type: 'agent_runtime_gap', ...runtimeIdentity, reason: 'projection_degraded' }));
        gapOutput(ctx, 'PROVISIONAL_ANSWER');
        const prior = ctx.store.transcript.items.slice();
        const tool = { type: 'agent_tool', traceRunId: runtimeIdentity.runId, sessionId: runtimeIdentity.sessionId,
            scope: runtimeIdentity.scope, toolType: 'thinking', stepRef: 'thinking-1', icon: 'T', label: 'Thinking', status: 'running' };
        handleWsMessage(ctx, msg({ ...tool, detail: 'PROVISIONAL_THOUGHT' }));
        handleWsMessage(ctx, msg({ ...tool, detail: 'PROVISIONAL_THOUGHT_REPLACED', status: 'done' }));
        for (const [i, item] of prior.entries()) assert.equal(ctx.store.transcript.items[i], item);
        const rows = ctx.store.transcript.items.slice();
        assert.equal(rows.length, prior.length + 1, 'thinking snapshots update one owned row');
        runtime(ctx, { seq: 7, kind: 'turn-end', status: 'done', finalText: 'FINAL_ONLY' });
        for (const [i, item] of rows.entries()) assert.equal(ctx.store.transcript.items[i], item);
        assert.deepEqual(assistantTexts(ctx).filter(Boolean), ['FINAL_ONLY']);
        assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), ctx.store.transcript.items.length);
    } finally { cleanupCtx(ctx); }
});

test('gap fallback caps rows across agents and thinking steps without combining their previews', () => {
    const ctx = activityContext();
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
        handleWsMessage(ctx, msg({ type: 'agent_runtime_gap', ...runtimeIdentity, reason: 'projection_degraded' }));
        for (let i = 0; i < 64; i++) {
            gapOutput(ctx, `agent-${i}`, { agentId: `agent-${i}` });
            handleWsMessage(ctx, msg({ type: 'agent_tool', traceRunId: runtimeIdentity.runId,
                sessionId: runtimeIdentity.sessionId, scope: runtimeIdentity.scope,
                icon: 'T', label: 'Thinking', toolType: 'thinking', status: 'running',
                agentId: `agent-${i}`, stepRef: `step-${i}`, detail: `thought-${i}` }));
        }
        const previews = ctx.store.transcript.items.filter(item => item.type === 'assistant' || item.type === 'thinking');
        assert.equal(previews.length, 16);
        assert.equal(previews[0]?.text, 'agent-0');
        assert.equal(previews[1]?.text, 'thought-0');
        assert.equal(previews[2]?.text, 'agent-1');
        const activity = ctx.store.transcript.items[0]!;
        assert.ok(activity.type === 'activity');
        assert.equal(activity.displayGap, true);
        printCompatibility(ctx, 'FULL_AFTER_ROW_LIMIT');
        assert.deepEqual(assistantTexts(ctx).filter(Boolean), ['FULL_AFTER_ROW_LIMIT']);
        assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), ctx.store.transcript.items.length);
    } finally { cleanupCtx(ctx); }
});

test('gap fallback caps total run characters independently of the selected full final', () => {
    const ctx = activityContext();
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
        handleWsMessage(ctx, msg({ type: 'agent_runtime_gap', ...runtimeIdentity, reason: 'projection_degraded' }));
        for (let i = 0; i < 64; i++) gapOutput(ctx, 'x'.repeat(4000), { agentId: `agent-${i}` });
        const previews = ctx.store.transcript.items.filter(item => item.type === 'assistant');
        assert.equal(previews.reduce((sum, item) => sum + item.text.length, 0), 32 * 1024);
        const full = 'f'.repeat(70_000) + '\r\nFULL_FINAL_TAIL';
        printCompatibility(ctx, full);
        assert.deepEqual(assistantTexts(ctx).filter(Boolean), [full]);
    } finally { cleanupCtx(ctx); }
});

test('line gap fallback freezes after truncation so a discarded control opener cannot leak its suffix', () => {
    const ctx = activityContext();
    ctx.displayMode = 'line';
    const original = process.stdout.write;
    let output = '';
    process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
        handleWsMessage(ctx, msg({ type: 'agent_runtime_gap', ...runtimeIdentity, reason: 'projection_degraded' }));
        gapOutput(ctx, 'x'.repeat(4090) + '\x1b]52;c;' + 'HIDDEN'.repeat(100));
        gapOutput(ctx, 'LEAK_SUFFIX\x07', { agentId: 'another-agent' });
        gapOutput(ctx, 'LEAK_SUFFIX\x07');
        const previews = ctx.store.transcript.items.filter(item => item.type === 'assistant');
        assert.equal(previews.length, 1);
        assert.equal(previews[0]?.text.length, 4096);
        assert.doesNotMatch(output, /HIDDEN|LEAK_SUFFIX/);
        assert.equal(output.match(/Provisional output limited/g)?.length, 1);
        printCompatibility(ctx, 'FULL_AFTER_LIMIT');
        assert.equal(output.match(/FULL_AFTER_LIMIT/g)?.length, 1);
        assert.deepEqual(assistantTexts(ctx).filter(Boolean), ['FULL_AFTER_LIMIT']);
    } finally { process.stdout.write = original; cleanupCtx(ctx); }
});

for (const committed of [true, false]) {
    test(`gap fallback REST terminal clears previews only after committed restore=${committed}`, async () => {
        const ctx = activityContext();
        ctx.apiUrl = 'http://127.0.0.1:3457';
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
        handleWsMessage(ctx, msg({ type: 'agent_runtime_gap', ...runtimeIdentity, reason: 'projection_degraded' }));
        gapOutput(ctx, 'REST_PREVIEW');
        gapOutput(ctx, 'REST_THOUGHT', { thinking: true });
        const rows = ctx.store.transcript.items.slice();
        const original = globalThis.fetch;
        globalThis.fetch = async input => {
            const url = new URL(String(input));
            if (url.pathname.endsWith('/snapshot')) return Response.json({ activityIdentity: ctx.activitySettlementIdentity,
                activeRun: { traceRunId: runtimeIdentity.runId } });
            const seed = url.searchParams.get('after') === '0';
            if (!seed && !committed) throw new Error('tail read failed');
            return Response.json({ ok: true, data: { runId: runtimeIdentity.runId, sessionId: runtimeIdentity.sessionId,
                scope: runtimeIdentity.scope, status: 'done', through: 7, nextAfter: 7, hasMore: false, incomplete: false, loss: null,
                events: seed ? [{ ...runtimeIdentity, seq: 1, kind: 'turn-start', provider: 'codex' },
                    { ...runtimeIdentity, seq: 7, kind: 'turn-end', status: 'done', finalText: 'REST_FINAL' }] : [] } });
        };
        try {
            await restoreActiveActivity(ctx);
            for (const [i, item] of rows.entries()) assert.equal(ctx.store.transcript.items[i], item);
            if (committed) {
                assert.deepEqual(assistantTexts(ctx).filter(Boolean), ['REST_FINAL']);
                assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), ctx.store.transcript.items.length);
                printCompatibility(ctx, 'REST_FINAL');
                assert.deepEqual(assistantTexts(ctx).filter(Boolean), ['REST_FINAL']);
            } else {
                assert.deepEqual(assistantTexts(ctx).filter(Boolean), ['REST_PREVIEW']);
                assert.ok(rows.some(item => item.type === 'thinking' && item.streaming && item.text === 'REST_THOUGHT'));
            }
        } finally { globalThis.fetch = original; cleanupCtx(ctx); }
    });
}

test('retiring a gap fallback clears owned previews in place and late A cannot resurrect them', () => {
    const ctx = activityContext();
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
        handleWsMessage(ctx, msg({ type: 'agent_runtime_gap', ...runtimeIdentity, reason: 'projection_degraded' }));
        gapOutput(ctx, 'RETIRED_PREVIEW');
        gapOutput(ctx, 'RETIRED_THOUGHT', { thinking: true });
        const rows = ctx.store.transcript.items.slice();
        const next = { sessionId: 'other-session', scope: 'local:other-session' };
        retireActivityView(ctx, next);
        ctx.activityIdentity = next;
        runtime(ctx, { seq: 7, kind: 'turn-end', status: 'done', finalText: 'LATE_RETIRED_FINAL' });
        printCompatibility(ctx, 'LATE_RETIRED_FINAL');
        for (const [i, item] of rows.entries()) assert.equal(ctx.store.transcript.items[i], item);
        assert.equal(ctx.store.transcript.items.length, rows.length);
        assert.deepEqual(assistantTexts(ctx).filter(Boolean), []);
        assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), ctx.store.transcript.items.length);
    } finally { cleanupCtx(ctx); }
});

test('old gap fallback status and tools cannot mutate B clock or live tools', () => {
    const ctx = activityContext();
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
        handleWsMessage(ctx, msg({ type: 'agent_runtime_gap', ...runtimeIdentity, reason: 'projection_degraded' }));
        runtime(ctx, { seq: 1, runId: 'B', kind: 'turn-start', provider: 'codex' });
        handleWsMessage(ctx, msg({ type: 'agent_runtime_gap', ...runtimeIdentity, runId: 'B', reason: 'projection_degraded' }));
        const tool = { type: 'agent_tool', traceRunId: 'B', sessionId: runtimeIdentity.sessionId, scope: runtimeIdentity.scope,
            icon: 'T', label: 'B_TOOL', detail: 'B_DETAIL', stepRef: 'shared-step', status: 'running' };
        handleWsMessage(ctx, msg(tool));
        const live = ctx.store.transcript.liveTools[0]!;
        const before = JSON.stringify(live);
        const owner = ctx.activeActivityKey;
        const clock = ctx.turnStartedAt;
        const timer = ctx.footerTimer;
        const state = ctx.streamState;
        for (const wire of [
            { type: 'agent_status', status: 'running', traceRunId: runtimeIdentity.runId },
            { ...tool, traceRunId: runtimeIdentity.runId, label: 'A_TOOL', detail: 'A_DETAIL', status: 'done' },
            { ...tool, traceRunId: runtimeIdentity.runId, label: 'A_TOOL', detail: 'A_DETAIL', status: 'running' },
        ]) {
            handleWsMessage(ctx, msg(wire));
            assert.equal(ctx.activeActivityKey, owner);
            assert.equal(ctx.turnStartedAt, clock);
            assert.equal(ctx.footerTimer, timer);
            assert.equal(ctx.streamState, state);
            assert.deepEqual(ctx.store.transcript.liveTools, [live]);
            assert.equal(JSON.stringify(live), before);
            assert.equal(committedTools(ctx).length, 0);
        }
        handleWsMessage(ctx, msg({ ...tool, traceRunId: runtimeIdentity.runId, toolType: 'thinking', detail: 'A_OWN_THOUGHT' }));
        assert.ok(ctx.store.transcript.items.some(item => item.type === 'thinking' && item.text === 'A_OWN_THOUGHT'));
        assert.equal(ctx.streamState, state);
        assert.equal(JSON.stringify(live), before);
        runtime(ctx, { seq: 7, kind: 'turn-end', status: 'done', finalText: 'A_FINAL' });
        printCompatibility(ctx, 'A_FINAL');
        assert.deepEqual(ctx.store.transcript.liveTools, [live]);
        assert.equal(ctx.streamState, state);
        assert.equal(JSON.stringify(live), before);
    } finally { cleanupCtx(ctx); }
});

for (const capture of printProducer.captures) {
    test(`actual backend ${capture.scenario} frames settle one TUI answer`, () => {
        const ctx = activityContext();
        ctx.activityIdentity = capture.identity;
        try {
            for (const wire of capture.frames) handleWsMessage(ctx, msg(wire));
            const final = capture.frames.find(frame => frame.type === 'agent_done')!;
            assert.deepEqual(assistantTexts(ctx).filter(Boolean), final.text ? [final.text] : []);
            if (capture.scenario === 'empty') assert.deepEqual(assistantTexts(ctx), ['']);
            assert.equal(committedTools(ctx).length, 0, 'waiting for canonical close is not a missing-record fallback');
            assert.equal(ctx.streaming, false);
            const activity = ctx.store.transcript.items.find(item => item.type === 'activity');
            assert.ok(activity?.type === 'activity');
            assert.equal(activity.degraded, capture.scenario === 'terminal-gap');
        } finally { cleanupCtx(ctx); }
    });
}

for (const order of ['legacy-first', 'canonical-first'] as const) {
    for (const text of ['selected full answer\n' + 'x'.repeat(33_000), '']) {
        test(`print ${order} coalesces ${text ? 'full bytes' : 'authoritative empty'} without native markers`, () => {
            const ctx = activityContext();
            try {
                runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
                runtime(ctx, { seq: 3, kind: 'message', itemId: 'preview', phase: 'unknown', operation: 'append', text: 'not the answer' });
                const end = () => runtime(ctx, { seq: 7, kind: 'turn-end', status: 'done', finalText: text });
                if (order === 'canonical-first') end();
                printCompatibility(ctx, text);
                if (order === 'legacy-first') {
                    const item = ctx.store.transcript.items.find(item => item.type === 'activity');
                    assert.ok(item?.type === 'activity');
                    assert.equal(item.terminalStatus, 'finished');
                    assert.match(renderActivityItem(item, 80).join('\n'), /Finished/);
                    end();
                }
                printCompatibility(ctx, text);
                assert.deepEqual(assistantTexts(ctx), [text]);
                const answer = ctx.store.transcript.items.find(item => item.type === 'assistant');
                assert.ok(answer?.type === 'assistant');
                assert.equal(answer.activityFinality, 'present');
                assert.equal(answer.activityStatus, 'done');
                assert.equal(ctx.streaming, false);
                assert.equal(ctx.footerTimer, null);
            } finally { cleanupCtx(ctx); }
        });
    }
}

test('print completion keeps its diagnostic across error/null canonical close and durable journal gap', () => {
    const ctx = activityContext();
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
        handleWsMessage(ctx, msg({ type: 'agent_runtime_gap', ...runtimeIdentity, reason: 'projection_degraded' }));
        printCompatibility(ctx, 'CLI failed to start: useful diagnostic');
        assert.equal(ctx.streaming, false);
        runtime(ctx, { seq: 7, kind: 'turn-end', status: 'error', finalText: null });
        assert.deepEqual(assistantTexts(ctx), ['CLI failed to start: useful diagnostic']);
        const item = ctx.store.transcript.items.find(item => item.type === 'activity');
        assert.ok(item?.type === 'activity');
        assert.equal(item.terminalStatus, 'error');
        assert.equal(item.recordingGap, true);
        assert.equal(item.degraded, true);
    } finally { cleanupCtx(ctx); }
});

test('unmarked print completion A then start B then late canonical A cannot stop B', () => {
    const ctx = activityContext();
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
        printCompatibility(ctx, 'A full selected answer');
        runtime(ctx, { seq: 1, runId: 'B', kind: 'turn-start', provider: 'codex' });
        const owner = ctx.activeActivityKey;
        const clock = ctx.turnStartedAt;
        ctx.inputActive = false;
        runtime(ctx, { seq: 7, kind: 'turn-end', status: 'error', finalText: 'different canonical diagnostic' });
        printCompatibility(ctx, 'A full selected answer');
        assert.equal(ctx.activeActivityKey, owner);
        assert.equal(ctx.turnStartedAt, clock);
        assert.equal(ctx.streaming, true);
        assert.equal(ctx.inputActive, false);
        assert.ok(ctx.footerTimer);
        assert.deepEqual(assistantTexts(ctx), ['A full selected answer']);
    } finally { cleanupCtx(ctx); }
});

test('print canonical close after native scrollback release does not repopulate or print an answer', () => {
    const ctx = activityContext();
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
        printCompatibility(ctx, 'already committed');
        releaseCommittedActivity(ctx, ctx.store.transcript.items.length);
        runtime(ctx, { seq: 7, kind: 'turn-end', status: 'done', finalText: 'already committed' });
        assert.deepEqual(assistantTexts(ctx), ['']);
        const item = ctx.store.transcript.items.find(item => item.type === 'activity');
        assert.ok(item?.type === 'activity');
        assert.equal(item.released, true);
        assert.equal(item.terminalStatus, 'done');
        assert.equal(item.degraded, false);
        assert.equal(ctx.streaming, false);
    } finally { cleanupCtx(ctx); }
});

test('print fallback requires admitted trace and matching explicit session/scope', () => {
    const ctx = activityContext();
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
        for (const extra of [{ sessionId: 'foreign' }, { scope: 'foreign' }]) printCompatibility(ctx, 'wrong owner', extra);
        assert.deepEqual(assistantTexts(ctx), []);
        assert.equal(ctx.streaming, true);
        printCompatibility(ctx, 'older unadmitted legacy', { traceRunId: 'unadmitted' });
        assert.deepEqual(assistantTexts(ctx), ['older unadmitted legacy']);
        assert.equal(ctx.store.transcript.items.filter(item => item.type === 'activity').length, 1);
    } finally { cleanupCtx(ctx); }
});

for (const released of [false, true]) {
    test(`canonical-first null diagnostic is preserved by print completion, released=${released}`, () => {
        const ctx = activityContext();
        try {
            runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
            runtime(ctx, { seq: 7, kind: 'turn-end', status: 'error', finalText: null });
            if (released) releaseCommittedActivity(ctx, ctx.store.transcript.items.length);
            printCompatibility(ctx, 'original startup diagnostic');
            printCompatibility(ctx, 'original startup diagnostic');
            assert.deepEqual(assistantTexts(ctx).filter(Boolean), ['original startup diagnostic']);
            const answer = ctx.store.transcript.items.findLast(item => item.type === 'assistant');
            assert.ok(answer?.type === 'assistant');
            assert.equal(answer.activityStatus, 'error');
            assert.equal(answer.activityCorrection, false, 'an invisible null receipt did not deliver a body to correct');
            assert.equal(answer.activityDiagnostic, true);
        } finally { cleanupCtx(ctx); }
    });
}

test('equal print completion after canonical scrollback release does not repopulate the cleared receipt', () => {
    const ctx = activityContext();
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
        runtime(ctx, { seq: 7, kind: 'turn-end', status: 'done', finalText: 'same original' });
        releaseCommittedActivity(ctx, ctx.store.transcript.items.length);
        printCompatibility(ctx, 'same original');
        assert.deepEqual(assistantTexts(ctx), ['']);
    } finally { cleanupCtx(ctx); }
});

test('differing original print final after scrollback commit appends one labelled correction without touching B', () => {
    const ctx = activityContext();
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex' });
        runtime(ctx, { seq: 7, kind: 'turn-end', status: 'done', finalText: '[redacted canonical body]' });
        releaseCommittedActivity(ctx, ctx.store.transcript.items.length);
        runtime(ctx, { seq: 1, runId: 'B', kind: 'turn-start', provider: 'codex' });
        const owner = ctx.activeActivityKey;
        ctx.inputActive = false;
        printCompatibility(ctx, 'original full body');
        printCompatibility(ctx, 'original full body');
        assert.deepEqual(assistantTexts(ctx), ['', 'original full body']);
        const answer = ctx.store.transcript.items.at(-1)!;
        assert.ok(answer.type === 'assistant');
        assert.equal(answer.activityCorrection, true);
        assert.equal(ctx.activeActivityKey, owner);
        assert.equal(ctx.streaming, true);
        assert.equal(ctx.inputActive, false);
    } finally { cleanupCtx(ctx); }
});

test('semantic tool/commentary and mirrored compatibility produce one complete full answer', () => {
    const ctx = activityContext();
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex-app' });
        runtime(ctx, { seq: 7, kind: 'tool', itemId: 'tool', name: 'Read', status: 'running', output: 'tool output' });
        runtime(ctx, { seq: 9, kind: 'message', itemId: 'work', phase: 'commentary', operation: 'append', text: 'work preview' });
        handleWsMessage(ctx, msg({ type: 'agent_output', traceRunId: runtimeIdentity.runId, text: 'work preview' }));
        const full = 'a'.repeat(33_000) + ' SENTINEL_FULL_FINAL';
        runtime(ctx, { seq: 15, kind: 'turn-end', status: 'done', finalText: full });
        compatibility(ctx, full);
        compatibility(ctx, full);
        assert.deepEqual(assistantTexts(ctx), [full]);
        assert.equal(ctx.store.transcript.items.filter(item => item.type === 'activity').length, 1);
        assert.equal(ctx.streaming, false);
        assert.equal(ctx.footerTimer, null);
        assert.equal(ctx.inputActive, true);
    } finally { cleanupCtx(ctx); }
});

test('journal terminal loss keeps compatibility final and settles the commit barrier', () => {
    const ctx = activityContext();
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex-app' });
        runtime(ctx, { seq: 3, kind: 'message', itemId: 'work', phase: 'unknown', operation: 'append', text: 'partial work' });
        handleWsMessage(ctx, msg({ type: 'agent_runtime_gap', ...runtimeIdentity, reason: 'projection_degraded' }));
        compatibility(ctx, 'full fallback answer');
        const item = ctx.store.transcript.items.find(item => item.type === 'activity');
        assert.equal(item?.type, 'activity');
        if (item?.type === 'activity') {
            assert.equal(item.terminalStatus, 'done');
            assert.equal(item.degraded, true);
            assert.equal(item.model.end, null);
        }
        assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), ctx.store.transcript.items.length);
        assert.deepEqual(assistantTexts(ctx), ['full fallback answer']);
        runtime(ctx, { seq: 1, runId: 'next', kind: 'turn-start', provider: 'codex-app' });
        assert.equal(ctx.streaming, true);
        assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), 2);
    } finally { cleanupCtx(ctx); }
});

test('late completion from an older Activity cannot stop a newer run', () => {
    const ctx = activityContext();
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex-app' });
        runtime(ctx, { seq: 5, kind: 'turn-end', status: 'done', finalText: 'old answer' });
        runtime(ctx, { seq: 1, runId: 'new-run', kind: 'turn-start', provider: 'codex-app' });
        ctx.inputActive = false;
        compatibility(ctx, 'old answer');
        assert.equal(ctx.streaming, true);
        assert.equal(ctx.inputActive, false);
        assert.ok(ctx.footerTimer);
        assert.deepEqual(assistantTexts(ctx), ['old answer']);
    } finally { cleanupCtx(ctx); }
});

for (const actualGap of [false, true]) {
    test(`compatibility before canonical end preserves one answer and ${actualGap ? 'keeps real gap' : 'clears provisional gap'}`, () => {
        const ctx = activityContext();
        try {
            runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex-app' });
            if (actualGap) handleWsMessage(ctx, msg({ type: 'agent_runtime_gap', ...runtimeIdentity, reason: 'projection_degraded' }));
            compatibility(ctx, 'canonical answer');
            runtime(ctx, { seq: 7, kind: 'message', itemId: 'late-work', phase: 'commentary', operation: 'append', text: 'queued work' });
            handleWsMessage(ctx, msg({ type: 'agent_output', traceRunId: runtimeIdentity.runId, text: 'queued work' }));
            handleWsMessage(ctx, msg({ type: 'agent_tool', traceRunId: runtimeIdentity.runId, icon: 'tool', label: 'Read', status: 'running' }));
            assert.equal(ctx.streaming, false);
            runtime(ctx, { seq: 9, kind: 'turn-end', status: 'done', finalText: 'canonical answer' });
            const item = ctx.store.transcript.items.find(item => item.type === 'activity');
            if (item?.type !== 'activity') assert.fail('Activity absent');
            assert.equal(item.degraded, actualGap);
            assert.equal(item.model.end?.seq, 9);
            assert.equal(item.model.entries.size, 1);
            assert.deepEqual(assistantTexts(ctx), ['canonical answer']);
            assert.equal(ctx.footerTimer, null);
        } finally { cleanupCtx(ctx); }
    });
}

test('identity refresh still permits exact admitted-run terminal settlement', async () => {
    const ctx = activityContext();
    ctx.apiUrl = 'http://127.0.0.1:3457';
    let finish!: (response: Response) => void;
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Promise(resolve => { finish = resolve; });
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex-app' });
        const pending = refreshActivityIdentity(ctx);
        assert.equal(ctx.activityIdentity, null);
        runtime(ctx, { seq: 7, kind: 'turn-end', status: 'done', finalText: 'complete while refreshing' });
        compatibility(ctx, 'complete while refreshing');
        finish(Response.json({ activityIdentity: { sessionId: runtimeIdentity.sessionId, scope: runtimeIdentity.scope } }));
        await pending;
        assert.equal(ctx.streaming, false);
        assert.deepEqual(assistantTexts(ctx), ['complete while refreshing']);
        assert.equal(computeStablePrefixIndex(ctx.store.transcript.items), ctx.store.transcript.items.length);
    } finally { globalThis.fetch = original; cleanupCtx(ctx); }
});

test('older completion during refresh cannot fall into newer-run legacy cleanup', async () => {
    const ctx = activityContext();
    ctx.apiUrl = 'http://127.0.0.1:3457';
    let finish!: (response: Response) => void;
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Promise(resolve => { finish = resolve; });
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex-app' });
        runtime(ctx, { seq: 5, kind: 'turn-end', status: 'done', finalText: 'old answer' });
        runtime(ctx, { seq: 1, runId: 'new-run', kind: 'turn-start', provider: 'codex-app' });
        ctx.inputActive = false;
        const pending = refreshActivityIdentity(ctx);
        compatibility(ctx, 'old answer');
        assert.equal(ctx.streaming, true);
        assert.equal(ctx.inputActive, false);
        assert.deepEqual(assistantTexts(ctx), ['old answer']);
        finish(Response.json({ activityIdentity: { sessionId: runtimeIdentity.sessionId, scope: runtimeIdentity.scope } }));
        await pending;
    } finally { globalThis.fetch = original; cleanupCtx(ctx); }
});

test('new run missing its start takes lifecycle ownership after the previous run settled', () => {
    const ctx = activityContext();
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex-app' });
        compatibility(ctx, 'old');
        const identity = ctx.activityIdentity;
        ctx.activityIdentity = null;
        runtime(ctx, { seq: 1, runId: 'new', kind: 'turn-start', provider: 'codex-app' });
        ctx.activityIdentity = identity;
        runtime(ctx, { seq: 7, runId: 'new', kind: 'tool', itemId: 'read', name: 'Read', status: 'running' });
        assert.equal(ctx.streaming, true);
        ctx.inputActive = false;
        compatibility(ctx, 'new answer', { traceRunId: 'new' });
        assert.equal(ctx.streaming, false);
        assert.equal(ctx.inputActive, true);
    } finally { cleanupCtx(ctx); }
});

test('classic legacy display emits canonical commentary and tool details before final', () => {
    const ctx = activityContext();
    ctx.displayMode = 'line';
    ctx.settingsSnapshot = { presentation: { mode: 'legacy' } };
    const original = process.stdout.write;
    let output = '';
    process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
        output += String(chunk);
        const callback = args.find((arg): arg is () => void => typeof arg === 'function');
        callback?.(); return true;
    }) as typeof process.stdout.write;
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex-app' });
        runtime(ctx, { seq: 3, kind: 'message', itemId: 'm', phase: 'commentary', operation: 'append', text: 'VISIBLE_WORK' });
        const beforeNotice = output.length;
        runtime(ctx, { seq: 4, kind: 'request', requestId: 'question', requestType: 'question', view: { title: 'Question', fields: [] } });
        assert.match(output.slice(beforeNotice), /^\n\r\x1b\[2KWaiting for question/);
        runtime(ctx, { seq: 5, kind: 'message', itemId: 'm', phase: 'commentary', operation: 'replace', text: 'VISIBLE_WORK with suffix' });
        runtime(ctx, { seq: 7, kind: 'tool', itemId: 't', name: 'Read', status: 'running', output: 'VISIBLE_TOOL_OUTPUT' });
        runtime(ctx, { seq: 8, kind: 'tool', itemId: 't', name: 'Read', status: 'running', output: 'VISIBLE_TOOL_OUTPUT suffix' });
        assert.match(output, /VISIBLE_WORK/);
        assert.match(output, /VISIBLE_TOOL_OUTPUT/);
        assert.equal(output.match(/VISIBLE_WORK/g)?.length, 1);
        assert.equal(output.match(/VISIBLE_TOOL_OUTPUT/g)?.length, 1);
        assert.equal(assistantTexts(ctx).length, 0);
    } finally { process.stdout.write = original; cleanupCtx(ctx); }
});

test('classic footer repaint preserves the cell cursor between streamed suffixes', async () => {
    const ctx = activityContext();
    ctx.displayMode = 'line';
    ctx.settingsSnapshot = { presentation: { mode: 'legacy' } };
    const original = process.stdout.write;
    let output = '';
    process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
    try {
        runtime(ctx, { seq: 1, kind: 'turn-start', provider: 'codex-app' });
        runtime(ctx, { seq: 3, kind: 'message', itemId: 'm', phase: 'commentary', operation: 'replace', text: 'Checking' });
        runtime(ctx, { seq: 5, kind: 'message', itemId: 'm', phase: 'commentary', operation: 'replace', text: 'Checking files' });
    } finally { process.stdout.write = original; cleanupCtx(ctx); }
    const terminal = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    try {
        // A real PTY applies ONLCR to stdout; the mocked writer captures before it.
        await new Promise<void>(resolve => terminal.write(output.replace(/\r?\n/g, '\r\n'), resolve));
        const rows = Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? '');
        assert.ok(rows.some(row => row.includes('Checking files')), rows.join('\n'));
    } finally { terminal.dispose(); }
});

test('Activity rejects foreign identities and retains at most16 preview models without native commits', () => {
    const ctx = activityContext();
    try {
        runtime(ctx, { seq: 1, sessionId: 'provider-session', kind: 'turn-start', provider: 'codex-app' });
        runtime(ctx, { seq: 1, scope: 'foreign', kind: 'turn-start', provider: 'codex-app' });
        assert.equal(ctx.store.transcript.items.length, 0);
        for (let i = 0; i < 17; i++) {
            runtime(ctx, { seq: 1, runId: `run-${i}`, kind: 'turn-start', provider: 'codex-app' });
            runtime(ctx, { seq: 3, runId: `run-${i}`, kind: 'message', itemId: 'm', phase: 'commentary', operation: 'append', text: 'preview' });
            runtime(ctx, { seq: 5, runId: `run-${i}`, kind: 'turn-end', status: 'done', finalText: `final-${i}` });
            compatibility(ctx, `final-${i}`, { traceRunId: `run-${i}` });
        }
        const turns = ctx.store.transcript.items.filter(item => item.type === 'activity');
        assert.equal(turns.filter(item => !item.released).length, 16);
        assert.equal(ctx.store.transcript.items.length, 34);
        assert.deepEqual(assistantTexts(ctx), Array.from({ length: 17 }, (_, i) => `final-${i}`));
        assert.equal(turns[0]?.model.entries.size, 0);
    } finally { cleanupCtx(ctx); }
});

test('interactive raw prints semantic frames once without mutating display state', () => {
    const ctx = makeCtx();
    ctx.isRaw = true;
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args) => { lines.push(args.join(' ')); };
    try {
        const frame = { type: 'agent_runtime', version: 1, runId: 'raw-run', sessionId: 'raw-session',
            scope: 'local:raw-session', turnId: 'raw-turn', seq: 1, kind: 'turn-start', provider: 'codex-app' };
        handleWsMessage(ctx, msg(frame));
        assert.equal(lines.length, 1);
        assert.ok(lines[0]?.includes(JSON.stringify(frame)));
        assert.deepEqual(ctx.store.transcript.items, []);
        assert.equal(ctx.streaming, false);
        assert.equal(ctx.footerTimer, null);
    } finally { console.log = original; cleanupCtx(ctx); }
});

test('overlapping settings refreshes retain the newest presentation response', async () => {
    const ctx = makeCtx();
    ctx.apiUrl = 'http://127.0.0.1:3457';
    const pending: Array<(value: Response) => void> = [];
    const started: Array<() => void> = [];
    const firstStarted = new Promise<void>(resolve => started.push(resolve));
    const secondStarted = new Promise<void>(resolve => started.push(resolve));
    const original = globalThis.fetch;
    globalThis.fetch = async input => {
        if (String(input).endsWith('/api/settings')) return new Promise<Response>(resolve => {
            pending.push(resolve); started[pending.length - 1]?.();
        });
        return Response.json({});
    };
    try {
        const first = refreshInfo(ctx);
        await firstStarted;
        const second = refreshInfo(ctx);
        await secondStarted;
        pending[1]!(Response.json({ presentation: { mode: 'legacy' } }));
        assert.equal(await second, true);
        pending[0]!(Response.json({ presentation: { mode: 'activity' } }));
        assert.equal(await first, false);
        assert.deepEqual(ctx.settingsSnapshot['presentation'], { mode: 'legacy' });
    } finally { globalThis.fetch = original; cleanupCtx(ctx); }
});

test('a newer settings refresh also invalidates the older in-flight snapshot', async () => {
    const ctx = makeCtx();
    ctx.apiUrl = 'http://127.0.0.1:3457';
    let resolveSnapshot!: (response: Response) => void;
    let resolveSession!: (response: Response) => void;
    let snapshotStarted!: () => void;
    let sessionStarted!: () => void;
    const snapshotReady = new Promise<void>(resolve => { snapshotStarted = resolve; });
    const sessionReady = new Promise<void>(resolve => { sessionStarted = resolve; });
    let settings = 0;
    let sessions = 0;
    let snapshots = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async input => {
        const path = new URL(String(input)).pathname;
        if (path === '/api/settings') return Response.json({ presentation: { mode: ++settings === 1 ? 'activity' : 'legacy' } });
        if (path === '/api/session' && ++sessions === 2) return new Promise(resolve => {
            resolveSession = resolve; sessionStarted();
        });
        if (path === '/api/orchestrate/snapshot') {
            if (++snapshots === 1) return new Promise(resolve => { resolveSnapshot = resolve; snapshotStarted(); });
            return Response.json({ activityIdentity: { sessionId: 'new', scope: 'local:new' } });
        }
        return Response.json({});
    };
    try {
        const first = refreshInfo(ctx);
        await snapshotReady;
        const second = refreshInfo(ctx);
        await sessionReady;
        resolveSnapshot(Response.json({ activityIdentity: { sessionId: 'stale', scope: 'local:stale' } }));
        assert.equal(await first, false);
        assert.equal(ctx.activityIdentity, null);
        resolveSession(Response.json({}));
        assert.equal(await second, true);
        assert.deepEqual(ctx.activityIdentity, { sessionId: 'new', scope: 'local:new' });
    } finally { globalThis.fetch = original; cleanupCtx(ctx); }
});

test('failed presentation PUT keeps the current display preference', async () => {
    const ctx = makeCtx();
    ctx.apiUrl = 'http://127.0.0.1:3457';
    ctx.settingsSnapshot = { presentation: { mode: 'legacy' } };
    ctx.store.overlay.settingsSelected = buildAppearanceRows({ settings: ctx.settingsSnapshot,
        tuiConfig: ctx.tuiConfig, footerPreview: '' }).findIndex(row => row.id === 'presentation');
    const original = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ error: 'settings unavailable' }, { status: 503 });
    try {
        await applySettingsSelection(ctx);
        assert.deepEqual(ctx.settingsSnapshot['presentation'], { mode: 'legacy' });
        assert.match(ctx.store.overlay.settingsMessage, /Failed to save Presentation/);
    } finally { globalThis.fetch = original; cleanupCtx(ctx); }
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


// ── 260703 CJ-WP3 regressions (devlog _plan/260703_tui_scrollback_hardening/20) ──

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

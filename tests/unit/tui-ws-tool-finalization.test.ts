import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWsMessage } from '../../bin/commands/tui/ws-handler.ts';
import type { TuiContext } from '../../bin/commands/tui/types.ts';
import { createTuiStore } from '../../src/cli/tui/store.ts';
import { appendUserItem, replaceNativeAssistantFinal } from '../../src/cli/tui/transcript.ts';
import { renderStatusBar } from '../../src/cli/tui/jawcode-bridge.ts';
import { stopSpinner } from '../../src/cli/tui/spinner.ts';
import { refreshInfo } from '../../bin/commands/tui/api.ts';
import { applySettingsSelection } from '../../bin/commands/tui/overlays.ts';
import { buildAppearanceRows } from '../../src/cli/tui/settings-screen.ts';

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

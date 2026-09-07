import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWsMessage } from '../../bin/commands/tui/ws-handler.ts';
import type { TuiContext } from '../../bin/commands/tui/types.ts';
import { createTuiStore } from '../../src/cli/tui/store.ts';
import { renderStatusBar } from '../../src/cli/tui/presentation.ts';
import { stopSpinner } from '../../src/cli/tui/spinner.ts';

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

function cleanupCtx(ctx: TuiContext): void {
    stopSpinner();
    if (ctx.footerTimer) {
        clearInterval(ctx.footerTimer);
        ctx.footerTimer = null;
    }
}


test('fullscreen running tool updates live state without committing transcript rows', () => {
    const ctx = makeCtx();
    try {
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'npm test', status: 'running', stepRef: 's1' }));
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'npm test --watch', status: 'running', stepRef: 's1' }));

        assert.equal(ctx.store.transcript.items.length, 0);
        assert.equal(ctx.store.transcript.liveTools.length, 1);
        assert.equal(ctx.store.transcript.liveTools[0]?.detail, 'npm test --watch');
        assert.equal(ctx.streaming, true);
        assert.equal(ctx.streamState, 'tool');
        assert.ok(ctx.footerTimer);
    } finally {
        cleanupCtx(ctx);
    }
});

test('fullscreen terminal tool commits one folded transcript row and clears live state', () => {
    const ctx = makeCtx();
    try {
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'npm test', status: 'running', stepRef: 's1' }));
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: '', status: 'done', stepRef: 's1' }));
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'duplicate', status: 'done', stepRef: 's1' }));

        assert.equal(ctx.store.transcript.liveTools.length, 0);
        assert.equal(ctx.store.transcript.items.length, 1);
        const item = ctx.store.transcript.items[0]!;
        assert.equal(item.type, 'tool');
        if (item.type === 'tool') {
            assert.equal(item.detail, 'npm test');
            assert.equal(item.collapsed, true);
            assert.equal(item.status, 'done');
        }
    } finally {
        cleanupCtx(ctx);
    }
});

test('agent_done commits stale fullscreen live tools without deleting committed rows', () => {
    const ctx = makeCtx();
    try {
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'still running', status: 'running', stepRef: 's1' }));
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '🔧', label: 'Read', detail: 'done', status: 'done', stepRef: 's2' }));

        handleWsMessage(ctx, msg({ type: 'agent_done', text: 'Final answer.' }));

        assert.equal(ctx.store.transcript.liveTools.length, 0);
        const tools = ctx.store.transcript.items.filter(item => item.type === 'tool');
        assert.equal(tools.length, 2);
        assert.equal(tools.some(item => item.type === 'tool' && item.stepRef === 's1' && item.status === 'done'), true);
        assert.equal(tools.some(item => item.type === 'tool' && item.stepRef === 's2' && item.status === 'done'), true);
        assert.equal(ctx.store.transcript.items.some(item => item.type === 'assistant'), true);
        assert.equal(ctx.streamState, 'idle');
        assert.equal(ctx.footerTimer, null);
    } finally {
        cleanupCtx(ctx);
    }
});


test('fullscreen running status keeps thinking animation live with footer frame ticks', async () => {
    const ctx = makeCtx();
    let frames = 0;
    ctx.requestFrame = () => { frames += 1; };
    try {
        handleWsMessage(ctx, msg({ type: 'agent_status', status: 'running', agentId: 'main', agentName: 'main' }));

        assert.equal(ctx.streaming, true);
        assert.equal(ctx.streamState, 'responding');
        assert.ok(ctx.footerTimer);

        await new Promise(resolve => setTimeout(resolve, 160));
        assert.ok(frames > 0, 'fullscreen footer timer should request frames while thinking');
    } finally {
        ctx.streamState = 'idle';
        cleanupCtx(ctx);
    }
});

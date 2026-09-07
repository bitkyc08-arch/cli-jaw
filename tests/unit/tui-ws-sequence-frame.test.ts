import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWsMessage } from '../../bin/commands/tui/ws-handler.ts';
import { composeFrame } from '../../bin/commands/tui/fullscreen-mode.ts';
import type { TuiContext } from '../../bin/commands/tui/types.ts';
import { createTuiStore } from '../../src/cli/tui/store.ts';
import { Viewport } from '../../src/cli/tui/render/viewport.ts';
import { VIEWPORT_FILL } from '../../src/cli/tui/render/frame.ts';
import { renderStatusBar } from '../../src/cli/tui/presentation.ts';
import { visualWidth } from '../../src/cli/tui/renderers.ts';
import { appendUserItem, toggleToolExpansion } from '../../src/cli/tui/transcript.ts';
import { isSpinning, stopSpinner } from '../../src/cli/tui/spinner.ts';

function withTerminalSize<T>(cols: number, rows: number, fn: () => T): T {
    const columnsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
    try {
        return fn();
    } finally {
        if (columnsDesc) Object.defineProperty(process.stdout, 'columns', columnsDesc);
        if (rowsDesc) Object.defineProperty(process.stdout, 'rows', rowsDesc);
    }
}

function expandViewportFill(rows: string[], height: number): string[] {
    const idx = rows.indexOf(VIEWPORT_FILL);
    if (idx === -1) return rows;
    const expanded = [...rows];
    expanded.splice(idx, 1, ...new Array(Math.max(0, height - (rows.length - 1))).fill(''));
    return expanded;
}

function stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function makeCtx(): TuiContext {
    return {
        ws: { send() { /* no-op */ }, close() { /* no-op */ } },
        apiUrl: '',
        info: { cli: 'codex', workingDir: '/tmp/project', model: 'test-model' },
        accent: '',
        label: 'codex',
        dir: '/tmp/project',
        runtimeLocale: 'en',
        tuiConfig: { theme: 'dark', fullscreen: true, pasteCollapseLines: 2, pasteCollapseChars: 160, keymapPreset: 'default', diffStyle: 'summary' },
        settingsSnapshot: { showReasoning: false, tui: { theme: 'dark', fullscreen: true } },
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
        requestFrame: () => { /* no-op */ },
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

function renderText(ctx: TuiContext, viewport: Viewport, cols = 72, rows = 26): string {
    return withTerminalSize(cols, rows, () => {
        viewport.setWidth(cols);
        const frame = composeFrame(ctx, viewport);
        const expanded = expandViewportFill(frame.rows, rows);
        assert.equal(expanded.length, rows);
        assert.equal(expanded.some(row => row.includes('\n')), false);
        assert.ok(expanded.every(row => visualWidth(row) <= cols));
        return stripAnsi(expanded.join('\n'));
    });
}

test('handleWsMessage + composeFrame keeps final answer after live tools', () => {
    const ctx = makeCtx();
    const viewport = new Viewport();
    try {
        handleWsMessage(ctx, msg({ type: 'agent_status', status: 'running', agentName: 'main' }));
        handleWsMessage(ctx, msg({ type: 'agent_output', text: 'Running tools.', agentId: 'main' }));
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '$', label: 'Bash', detail: 'echo 1', status: 'running', stepRef: 's1' }));
        assert.match(renderText(ctx, viewport), /Running tools|Bash/);

        handleWsMessage(ctx, msg({ type: 'agent_done', text: 'Running tools. Final answer.', toolLog: [{ label: 'Bash', detail: 'done', status: 'done', stepRef: 's1' }] }));

        const frame = renderText(ctx, viewport);
        assert.match(frame, /Final answer/);
        assert.match(frame, /Bash/);
        assert.equal(ctx.store.transcript.liveTools.length, 0);
        assert.equal(ctx.streamState, 'idle');
        assert.equal(ctx.inputActive, true);
        assert.equal(ctx.footerTimer, null);
        assert.equal(isSpinning(), false);
    } finally {
        cleanupCtx(ctx);
    }
});

test('ctrl-o expanded frame remains width safe after agent_done toolLog backfill', () => {
    const ctx = makeCtx();
    const viewport = new Viewport();
    try {
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '$', label: 'Bash', detail: 'short', status: 'running', stepRef: 's1' }));
        handleWsMessage(ctx, msg({
            type: 'agent_done',
            text: 'Done.',
            toolLog: [{ label: 'Bash', detail: 'long final detail /Users/jun/Developer/new/700_projects/cli-jaw/src/cli/tui/ws-handler.ts', status: 'done', stepRef: 's1' }],
        }));
        assert.equal(toggleToolExpansion(ctx.store.transcript), true);

        const frame = renderText(ctx, viewport, 60, 24);
        assert.match(frame, /Bash/);
        assert.match(frame, /long final detail|ws-handler/);
    } finally {
        cleanupCtx(ctx);
    }
});

test('thinking streams in transcript, collapses when settled, and expands with ctrl-o', () => {
    const ctx = makeCtx();
    const viewport = new Viewport();
    try {
        handleWsMessage(ctx, msg({ type: 'agent_output', thinking: true, text: 'line one\nline two\nline three', agentId: 'main' }));

        const streamingFrame = renderText(ctx, viewport, 72, 26);
        assert.match(streamingFrame, /Thinking/);
        assert.match(streamingFrame, /line one|line two|line three/);
        assert.doesNotMatch(streamingFrame.split('\n').slice(-5).join('\n'), /line one/);

        handleWsMessage(ctx, msg({ type: 'agent_done', text: 'Final answer.' }));
        const collapsed = renderText(ctx, viewport, 72, 26);
        assert.match(collapsed, /Thinking .* \+3 lines|Thinking/);
        assert.doesNotMatch(collapsed, /line one\s+line two\s+line three/);

        assert.equal(toggleToolExpansion(ctx.store.transcript), true);
        const expanded = renderText(ctx, viewport, 72, 26);
        assert.match(expanded, /line one/);
        assert.match(expanded, /line two/);
        assert.match(expanded, /Final answer/);
    } finally {
        cleanupCtx(ctx);
    }
});

test('agent_output thinking rows remain ordered between tool rows and final assistant', () => {
    const ctx = makeCtx();
    const viewport = new Viewport();
    try {
        appendUserItem(ctx.store.transcript, 'run tools', 'run tools');
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '$', label: 'Bash', detail: 'echo 1', status: 'done', stepRef: 's1' }));
        handleWsMessage(ctx, msg({ type: 'agent_output', thinking: true, text: 'plan next tool\nconfirm ordering', agentId: 'main' }));
        handleWsMessage(ctx, msg({ type: 'agent_tool', icon: '$', label: 'Read File', detail: 'src/a.ts', status: 'done', stepRef: 's2' }));
        handleWsMessage(ctx, msg({ type: 'agent_done', text: 'Final answer.' }));

        assert.equal(ctx.store.transcript.items.map((item) => item.type).join(','), 'user,tool,thinking,tool,assistant');
        const collapsed = renderText(ctx, viewport, 72, 26);
        assert.match(collapsed, /Bash/);
        assert.match(collapsed, /Thinking .*\+2 lines|Thinking/);
        assert.match(collapsed, /Read File/);
        assert.match(collapsed, /Final answer/);
        assert.doesNotMatch(collapsed, /confirm ordering\s+Read File/);
    } finally {
        cleanupCtx(ctx);
    }
});

test('agent_done toolLog toolType thinking backfills collapsed row before final assistant', () => {
    const ctx = makeCtx();
    const viewport = new Viewport();
    try {
        appendUserItem(ctx.store.transcript, 'run tools', 'run tools');
        handleWsMessage(ctx, msg({
            type: 'agent_done',
            text: 'Final answer.',
            toolLog: [
                { label: 'Bash', detail: 'echo complete', status: 'done', stepRef: 's1' },
                { toolType: 'thinking', detail: 'late reasoning line one\nlate reasoning line two', status: 'done', stepRef: 'think-1' },
                { label: 'Read File', detail: 'src/a.ts', status: 'done', stepRef: 's2' },
            ],
        }));

        assert.equal(ctx.store.transcript.items.map((item) => item.type).join(','), 'user,tool,thinking,tool,assistant');
        const thinking = ctx.store.transcript.items[2]!;
        assert.equal(thinking.type, 'thinking');
        if (thinking.type === 'thinking') {
            assert.equal(thinking.streaming, false);
            assert.equal(thinking.collapsed, true);
            assert.equal(thinking.text, 'late reasoning line one\nlate reasoning line two');
        }

        const collapsed = renderText(ctx, viewport, 72, 26);
        assert.match(collapsed, /Thinking .*\+2 lines|Thinking/);
        assert.doesNotMatch(collapsed, /late reasoning line one\s+late reasoning line two/);
        assert.equal(toggleToolExpansion(ctx.store.transcript), true);
        const expanded = renderText(ctx, viewport, 72, 26);
        assert.match(expanded, /late reasoning line one/);
        assert.match(expanded, /late reasoning line two/);
        assert.match(expanded, /Final answer/);
    } finally {
        cleanupCtx(ctx);
    }
});

test('fullscreen agent_status running updates footer state without transcript thinking status row', () => {
    const ctx = makeCtx();
    try {
        handleWsMessage(ctx, msg({ type: 'agent_status', status: 'running', agentName: 'main' }));

        assert.equal(ctx.store.transcript.items.length, 0);
        assert.equal(ctx.streamState, 'responding');
        assert.equal(isSpinning(), false);
    } finally {
        cleanupCtx(ctx);
    }
});

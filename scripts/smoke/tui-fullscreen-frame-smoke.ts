import assert from 'node:assert/strict';
import { composeFrame } from '../../bin/commands/tui/fullscreen-mode.ts';
import type { TuiContext } from '../../bin/commands/tui/types.ts';
import { appendTextToComposer } from '../../src/cli/tui/composer.ts';
import { appendAssistantTurnText, appendToolItem, appendUserItem, finalizeStreamingAssistants, upsertLiveToolItem } from '../../src/cli/tui/transcript.ts';
import { createTuiStore } from '../../src/cli/tui/store.ts';
import { Viewport } from '../../src/cli/tui/render/viewport.ts';
import { VIEWPORT_FILL } from '../../src/cli/tui/render/frame.ts';
import { solveLayout } from '../../src/cli/tui/render/layout.ts';
import { visualWidth } from '../../src/cli/tui/renderers.ts';

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

function stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function makeCtx(): TuiContext {
    return {
        ws: { send() { /* no-op */ }, close() { /* no-op */ } },
        apiUrl: 'http://127.0.0.1:3457',
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
        footer: 'status /quit /clear',
        displayMode: 'fullscreen',
        requestFrame: null,
    } as unknown as TuiContext;
}

function expandViewportFill(rows: string[], height: number): string[] {
    const idx = rows.indexOf(VIEWPORT_FILL);
    if (idx === -1) return rows;
    const expanded = [...rows];
    expanded.splice(idx, 1, ...new Array(Math.max(0, height - (rows.length - 1))).fill(''));
    return expanded;
}

withTerminalSize(72, 24, () => {
    const ctx = makeCtx();
    ctx.welcomeLines = ['Welcome to jaw chat'];
    appendUserItem(ctx.store.transcript, 'hello', 'hello');
    appendToolItem(ctx.store.transcript, 'Bash', { status: 'done', detail: 'echo ok', stepRef: 's1' });
    upsertLiveToolItem(ctx.store.transcript, { icon: '🔧', label: 'Bash live', detail: 'npm test -- --runInBand', status: 'running', stepRef: 'live' });
    appendAssistantTurnText(ctx.store.transcript, 'Final answer remains visible.', 'main');
    finalizeStreamingAssistants(ctx.store.transcript);
    appendTextToComposer(ctx.store.composer, 'next 한글🙂');

    const frame = composeFrame(ctx, new Viewport());
    const expanded = expandViewportFill(frame.rows, 24);
    const regions = solveLayout(72, 24, 1);
    const transcript = stripAnsi(expanded.slice(regions.transcript.y - 1, regions.statusLine.y - 1).join('\n'));

    assert.equal(expanded.length, 24);
    assert.ok(frame.rows.every(row => !row.includes('\n')), 'frame rows must be physical rows');
    assert.ok(expanded.every(row => visualWidth(row) <= 72), 'frame rows must be width safe');
    assert.match(transcript, /Welcome to jaw chat/);
    assert.match(transcript, /Final answer remains visible/);
    assert.match(transcript, /Bash live/);
    assert.match(stripAnsi(expanded[regions.composer.y - 1] ?? ''), /next 한글🙂/);
    assert.equal(frame.cursorPos?.row, regions.composer.y);
});

console.log('tui-fullscreen-frame-smoke ok');

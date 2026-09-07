import assert from 'node:assert/strict';
import { composeFrame } from '../../bin/commands/tui/fullscreen-mode.ts';
import type { TuiContext } from '../../bin/commands/tui/types.ts';
import { createTuiStore } from '../../src/cli/tui/store.ts';
import {
    appendAssistantTurnText,
    appendToolItem,
    finalizeStreamingAssistants,
    toggleToolExpansion,
    upsertLiveToolItem,
} from '../../src/cli/tui/transcript.ts';
import { Viewport } from '../../src/cli/tui/render/viewport.ts';
import { VIEWPORT_FILL } from '../../src/cli/tui/render/frame.ts';
import { solveLayout } from '../../src/cli/tui/render/layout.ts';
import { renderStatusBar } from '../../src/cli/tui/presentation.ts';
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
        requestFrame: null,
    } as unknown as TuiContext;
}

function assertFrame(ctx: TuiContext, viewport: Viewport, cols: number, rows: number, expected: RegExp[]): void {
    withTerminalSize(cols, rows, () => {
        const frame = composeFrame(ctx, viewport);
        assert.equal(frame.rows.some(row => row.includes('\n')), false, `${cols}x${rows}: no embedded newlines`);
        const expanded = expandViewportFill(frame.rows, rows);
        const regions = solveLayout(cols, rows, 1);
        const transcript = stripAnsi(expanded.slice(regions.transcript.y - 1, regions.statusLine.y - 1).join('\n'));

        assert.equal(expanded.length, rows, `${cols}x${rows}: frame height`);
        assert.ok(expanded.every(row => visualWidth(row) <= cols), `${cols}x${rows}: rows fit width`);
        assert.match(stripAnsi(expanded[regions.statusLine.y - 1] ?? ''), /test-model|codex/, `${cols}x${rows}: status row pinned`);
        assert.match(expanded[regions.composer.y - 2] ?? '', /┌/, `${cols}x${rows}: composer top pinned`);
        assert.match(expanded[regions.help.y - 1] ?? '', /shortcuts/, `${cols}x${rows}: help row pinned`);
        for (const pattern of expected) {
            assert.match(transcript, pattern, `${cols}x${rows}: expected transcript ${pattern}`);
        }
    });
}

const ctx = makeCtx();
const viewport = new Viewport();
const sizes = [[64, 24], [72, 28], [96, 28], [120, 34], [70, 24]] as const;

appendAssistantTurnText(ctx.store.transcript, 'Starting resize stress.', 'main');
finalizeStreamingAssistants(ctx.store.transcript);
upsertLiveToolItem(ctx.store.transcript, {
    icon: '🔧',
    label: 'Bash',
    detail: 'npm test -- --filter tui-frame-resize-stress with a long running detail path /Users/jun/Developer/new/700_projects/cli-jaw',
    status: 'running',
    stepRef: 'live-bash',
});
assertFrame(ctx, viewport, sizes[0][0], sizes[0][1], [/Starting resize stress/, /Bash/]);

appendToolItem(ctx.store.transcript, 'Bash', {
    stepRef: 'bash-1',
    status: 'done',
    detail: 'first output line\nsecond output line\n/Users/jun/Developer/new/700_projects/cli-jaw/src/cli/tui/transcript.ts',
});
appendToolItem(ctx.store.transcript, 'Read File', {
    stepRef: 'read-1',
    status: 'done',
    detail: '/Users/jun/Developer/new/700_projects/cli-jaw/bin/commands/tui/fullscreen-mode.ts',
});
appendAssistantTurnText(ctx.store.transcript, 'Final answer survives after tools.', 'main');
finalizeStreamingAssistants(ctx.store.transcript);
assert.equal(toggleToolExpansion(ctx.store.transcript), true);

for (const [cols, rows] of sizes.slice(1)) {
    assertFrame(ctx, viewport, cols, rows, [/Bash/, /Read File/, /Final answer survives/]);
}

console.log(`TUI_FRAME_RESIZE_STRESS_OK cases=${sizes.length}`);

import assert from 'node:assert/strict';
import { handleWsMessage } from '../../bin/commands/tui/ws-handler.ts';
import { composeFrame } from '../../bin/commands/tui/fullscreen-mode.ts';
import type { TuiContext } from '../../bin/commands/tui/types.ts';
import { createTuiStore } from '../../src/cli/tui/store.ts';
import { Viewport } from '../../src/cli/tui/render/viewport.ts';
import { VIEWPORT_FILL } from '../../src/cli/tui/render/frame.ts';
import { solveLayout } from '../../src/cli/tui/render/layout.ts';
import { renderStatusBar } from '../../src/cli/tui/presentation.ts';
import { visualWidth } from '../../src/cli/tui/renderers.ts';
import { toggleToolExpansion } from '../../src/cli/tui/transcript.ts';
import { isSpinning, stopSpinner } from '../../src/cli/tui/spinner.ts';

type Size = readonly [cols: number, rows: number];

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
    let framesRequested = 0;
    const ctx = {
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
        requestFrame: () => { framesRequested += 1; },
        get framesRequested() { return framesRequested; },
    } as unknown as TuiContext & { readonly framesRequested: number };
    return ctx;
}

function ws(value: Record<string, unknown>): Buffer {
    return Buffer.from(JSON.stringify(value));
}

function assertFrame(ctx: TuiContext, viewport: Viewport, cols: number, rows: number, expected: RegExp[]): void {
    withTerminalSize(cols, rows, () => {
        viewport.setWidth(cols);
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

function toolEvents(): Record<string, unknown>[] {
    return Array.from({ length: 10 }, (_, i) => {
        const n = i + 1;
        const label = n % 3 === 0 ? 'Search' : n % 2 === 0 ? 'Read' : 'Bash';
        return {
            type: 'agent_tool',
            icon: label === 'Search' ? '⌕' : label === 'Read' ? '□' : '$',
            label,
            detail: `${label.toLowerCase()}-${n} /Users/jun/Developer/new/700_projects/cli-jaw/src/cli/tui/${n}.ts`,
            status: 'running',
            stepRef: `tool-${n}`,
        };
    });
}

const ctx = makeCtx() as TuiContext & { readonly framesRequested: number };
const viewport = new Viewport();
const sizes: Size[] = [[72, 28], [96, 30], [64, 24], [120, 34], [70, 24]];
let events = 0;
let frames = 0;

function send(event: Record<string, unknown>, expected: RegExp[]): void {
    handleWsMessage(ctx, ws(event));
    events += 1;
    const [cols, rows] = sizes[events % sizes.length]!;
    assertFrame(ctx, viewport, cols, rows, expected);
    frames += 1;
}

try {
    send({ type: 'agent_status', status: 'running', agentId: 'main', agentName: 'main' }, [/main thinking/]);
    send({ type: 'agent_output', text: 'Starting 10 tool calls.', agentId: 'main' }, [/Starting 10 tool calls/]);

    for (const event of toolEvents()) {
        send(event, [/Starting 10 tool calls/, /Bash|Read|Search/]);
    }

    send({ type: 'agent_tool', icon: '$', label: 'Bash', detail: 'echo "1"', status: 'done', stepRef: 'tool-1' }, [/Bash/]);
    send({ type: 'agent_tool', icon: '□', label: 'Read', detail: 'src/cli/tui/store.ts', status: 'done', stepRef: 'tool-2' }, [/Read|Bash/]);
    send({ type: 'agent_tool', icon: '⌕', label: 'Search', detail: '10 matches', status: 'error', stepRef: 'tool-3' }, [/Search|Read|Bash/]);
    send({ type: 'agent_output', text: ' Tools are returning.', agentId: 'main' }, [/Tools are returning|Bash|Read|Search/]);

    assert.equal(toggleToolExpansion(ctx.store.transcript), true);
    assertFrame(ctx, viewport, 66, 24, [/Bash|Read|Search/]);
    frames += 1;

    send({
        type: 'agent_done',
        text: 'Starting 10 tool calls. Tools are returning. Final answer survives after all tools.',
        toolLog: toolEvents().map((event, i) => ({
            icon: event['icon'],
            label: event['label'],
            detail: `final-output-${i + 1}`,
            status: i === 2 ? 'error' : 'done',
            stepRef: event['stepRef'],
        })),
    }, [/Final answer survives/, /Bash|Read|Search/]);

    const committedRefs = new Set(ctx.store.transcript.items
        .filter(item => item.type === 'tool')
        .map(item => item.type === 'tool' ? item.stepRef : undefined)
        .filter(Boolean));

    assert.equal(ctx.store.transcript.liveTools.length, 0);
    assert.equal(committedRefs.size, 10);
    assert.equal(ctx.store.transcript.items.some(item => item.type === 'assistant' && item.text.includes('Final answer survives')), true);
    assert.equal(ctx.inputActive, true);
    assert.equal(ctx.streamState, 'idle');
    assert.equal(ctx.footerTimer, null);
    assert.equal(isSpinning(), false);
    assert.ok(ctx.framesRequested > 0);

    console.log(`TUI_WS_SEQUENCE_STRESS_OK events=${events} frames=${frames}`);
} finally {
    stopSpinner();
    if (ctx.footerTimer) {
        clearInterval(ctx.footerTimer);
        ctx.footerTimer = null;
    }
}

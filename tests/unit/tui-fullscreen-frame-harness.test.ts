import test from 'node:test';
import assert from 'node:assert/strict';
import { composeFrame, renderTranscriptItem } from '../../bin/commands/tui/fullscreen-mode.ts';
import type { TuiContext } from '../../bin/commands/tui/types.ts';
import { createTuiStore } from '../../src/cli/tui/store.ts';
import { appendTextToComposer } from '../../src/cli/tui/composer.ts';
import { appendAssistantTurnText, appendCommandItem, appendThinkingTurnText, appendToolItem, appendUserItem, finalizeStreamingAssistants, toggleToolExpansion, upsertLiveToolItem } from '../../src/cli/tui/transcript.ts';
import { Viewport } from '../../src/cli/tui/render/viewport.ts';
import { VIEWPORT_FILL } from '../../src/cli/tui/render/frame.ts';
import { solveLayout } from '../../src/cli/tui/render/layout.ts';
import { renderStatusBar } from '../../src/cli/tui/jawcode-bridge.ts';
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

function makeCtx(): TuiContext {
    return {
        ws: { send() { /* no-op */ }, close() { /* no-op */ } },
        apiUrl: '',
        info: { cli: 'jwc', workingDir: '/tmp/project', model: 'test-model' },
        accent: '',
        label: 'jwc',
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

test('fullscreen composeFrame keeps frame rows newline-free and input pinned', () => {
    withTerminalSize(96, 28, () => {
        const ctx = makeCtx();
        appendUserItem(ctx.store.transcript, 'run\nwith two lines', 'run\nwith two lines');
        appendThinkingTurnText(ctx.store.transcript, 'thinking line 1\nthinking line 2', 'main');
        appendToolItem(ctx.store.transcript, '🔧 Bash npm test', {
            stepRef: 'bash-1',
            status: 'done',
            detail: 'line 1\nline 2\nline 3',
        });
        appendAssistantTurnText(ctx.store.transcript, 'Final answer after tools.', 'main');
        finalizeStreamingAssistants(ctx.store.transcript);

        const frame = composeFrame(ctx, new Viewport());
        assert.equal(frame.rows[0], VIEWPORT_FILL);
        assert.equal(frame.rows.some(row => row.includes('\n')), false);

        const expanded = expandViewportFill(frame.rows, 28);
        const regions = solveLayout(96, 28, 1);
        assert.equal(expanded.length, 28);
        assert.match(expanded[regions.statusLine.y - 1] ?? '', /\x1b\[(36|46)m/);
        assert.match(expanded[regions.statusLine.y - 1] ?? '', /test-model|jwc/);
        assert.match(expanded[regions.statusLine.y - 1] ?? '', /\/quit/);
        assert.match(expanded[regions.composer.y - 2] ?? '', /┌/);
        assert.match(expanded[regions.composer.y - 1] ?? '', /Type your message/);
        assert.match(expanded[regions.help.y - 1] ?? '', /shortcuts/);
        // composeFrame reports the cursor in pre-VIEWPORT_FILL-expansion coordinates;
        // Screen.render normalizes it to the interior composer row when painting.
        assert.deepEqual(frame.cursorPos, { row: 16, col: 4 });
    });
});

test('fullscreen launch welcome starts at the terminal frame origin', () => {
    withTerminalSize(80, 24, () => {
        const ctx = makeCtx();
        ctx.welcomeLines = ['╭─ welcome ─╮', '│ first row │', '╰───────────╯'];

        const frame = composeFrame(ctx, new Viewport());
        const expanded = expandViewportFill(frame.rows, 24);
        const regions = solveLayout(80, 24, 1);

        assert.notEqual(frame.rows[0], VIEWPORT_FILL, 'launch prelude should render before the fill lane');
        assert.equal(stripAnsi(expanded[0] ?? ''), '╭─ welcome ─╮');
        assert.equal(stripAnsi(expanded[1] ?? ''), '│ first row │');
        assert.equal(stripAnsi(expanded[2] ?? ''), '╰───────────╯');
        assert.match(stripAnsi(expanded[regions.statusLine.y - 1] ?? ''), /\/quit/);
        assert.match(expanded[regions.composer.y - 2] ?? '', /┌/);
        assert.match(expanded[regions.help.y - 1] ?? '', /shortcuts/);
    });
});

test('fullscreen first transcript row releases launch prelude anchor for scrollback commit', () => {
    withTerminalSize(80, 10, () => {
        const ctx = makeCtx();
        ctx.welcomeLines = ['welcome', '1', '2'];
        const viewport = new Viewport();

        const launchFrame = composeFrame(ctx, viewport);
        assert.notEqual(launchFrame.rows[0], VIEWPORT_FILL, 'pure launch frame should keep welcome at row 1');

        appendUserItem(ctx.store.transcript, '3\n4\n5', '3\n4\n5');
        const activeFrame = composeFrame(ctx, viewport);
        assert.equal(activeFrame.rows[0], VIEWPORT_FILL, 'first transcript frame must expose the top fill lane so welcome/1/2 can commit to scrollback');
        const pendingCommitRows = viewport.peekStableCommitRows(solveLayout(80, 10, 1).transcript.height, 1);
        assert.ok(
            pendingCommitRows !== null && pendingCommitRows.rows.length > 0,
            'first transcript render must leave rows ready for the scheduler post-render commit tick',
        );
        assert.match(stripAnsi(pendingCommitRows.rows.join('\n')), /welcome[\s\S]*1[\s\S]*2/);

        // The 5-row history-lane reservation keeps the user block body off the live
        // 1-row transcript region; after committing the prelude frontier and scrolling
        // to top, the body (3/4/5) is reachable in the virtual transcript region.
        viewport.markCommittedFrontier(pendingCommitRows.frontier);
        viewport.scrollToTop();
        const scrolledMain = stripAnsi(viewport
            .composeRegion(solveLayout(80, 10, 1).transcript)
            .join('\n'));
        assert.match(scrolledMain, /\b3\b/);
        assert.match(scrolledMain, /\b4\b/);
        assert.match(scrolledMain, /\b5\b/);
    });
});

test('fullscreen user and composer text use explicit readable foreground for dark themes', () => {
    withTerminalSize(96, 28, () => {
        const ctx = makeCtx();
        appendUserItem(ctx.store.transcript, 'visible user message', 'visible user message');
        appendTextToComposer(ctx.store.composer, 'visible composer text');

        const expanded = expandViewportFill(composeFrame(ctx, new Viewport()).rows, 28);
        const userRow = expanded.find(row => row.includes('visible user message')) ?? '';
        const composerRow = expanded.find(row => row.includes('visible composer text')) ?? '';

        assert.match(userRow, /\x1b\[97mvisible user message\x1b\[0m/);
        assert.match(composerRow, /\x1b\[97mvisible composer text\x1b\[0m/);
    });
});

test('fullscreen manual scroll can reach committed welcome session start', () => {
    withTerminalSize(80, 10, () => {
        const ctx = makeCtx();
        const viewport = new Viewport();
        ctx.welcomeLines = ['welcome', '1', '2'];
        appendUserItem(ctx.store.transcript, '3\n4\n5\n6\n7\n8', '3\n4\n5\n6\n7\n8');

        composeFrame(ctx, viewport);
        const transcriptHeight = solveLayout(80, 10, 1).transcript.height;
        const commitResult = viewport.peekStableCommitRows(transcriptHeight, 1);
        assert.ok(commitResult !== null && commitResult.rows.length > 0, 'test setup should create committed rows');
        viewport.markCommittedFrontier(commitResult.frontier);

        const following = stripAnsi(composeFrame(ctx, viewport).rows.join('\n'));
        assert.doesNotMatch(following, /welcome[\s\S]*1[\s\S]*2/, 'tail-follow should not duplicate committed welcome rows in the live viewport');

        viewport.pageUp(transcriptHeight);
        const expanded = expandViewportFill(composeFrame(ctx, viewport).rows, 10);
        const scrolled = stripAnsi(expanded.join('\n'));

        // After frontier commit, welcome is in native scrollback only — NOT in virtual scroll
        // Virtual PageUp should show transcript start, not committed welcome
        assert.match(scrolled, /\b5\b/, 'virtual scroll reaches transcript body after committed welcome');
    });
});

test('fullscreen tool rows strip legacy event emoji and preserve multi-word labels', () => {
    withTerminalSize(96, 28, () => {
        const ctx = makeCtx();
        appendToolItem(ctx.store.transcript, '🔧 Bash: npm test', {
            status: 'done',
            detail: 'npm test',
        });
        appendToolItem(ctx.store.transcript, 'Read File: src/a.ts', {
            status: 'done',
            detail: 'src/a.ts',
        });

        const expanded = expandViewportFill(composeFrame(ctx, new Viewport()).rows, 28);
        const regions = solveLayout(96, 28, 1);
        const main = stripAnsi(expanded.slice(regions.transcript.y - 1, regions.statusLine.y - 1).join('\n'));

        assert.match(main, /✔ Bash/);
        assert.match(main, /npm test/);
        assert.match(main, /✔ Read File/);
        assert.match(main, /src\/a\.ts/);
        assert.doesNotMatch(main, /🔧/);
        assert.doesNotMatch(main, /✔ File/);
        assert.doesNotMatch(main, /Bash\s+…/);
    });
});

test('fullscreen live tool rows do not render event emoji', () => {
    withTerminalSize(96, 28, () => {
        const ctx = makeCtx();
        upsertLiveToolItem(ctx.store.transcript, { icon: '🔧', label: 'Bash', detail: 'npm test', status: 'running', stepRef: 'live-1' });

        const expanded = expandViewportFill(composeFrame(ctx, new Viewport()).rows, 28);
        const regions = solveLayout(96, 28, 1);
        const main = stripAnsi(expanded.slice(regions.transcript.y - 1, regions.statusLine.y - 1).join('\n'));

        assert.match(main, /⏳ Bash/);
        assert.doesNotMatch(main, /🔧/);
    });
});

test('fullscreen command feedback renders without thinking spinner', () => {
    withTerminalSize(96, 28, () => {
        const ctx = makeCtx();
        appendCommandItem(ctx.store.transcript, 'State → P\nPlanning mode entered', { commandName: 'orchestrate', ok: true });

        const expanded = expandViewportFill(composeFrame(ctx, new Viewport()).rows, 28);
        const regions = solveLayout(96, 28, 1);
        const main = stripAnsi(expanded.slice(regions.transcript.y - 1, regions.statusLine.y - 1).join('\n'));

        assert.match(main, /✓ \/orchestrate: State → P/);
        assert.match(main, /Planning mode entered/);
        assert.doesNotMatch(main, /thinking/i);
        assert.doesNotMatch(main, /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/);
    });
});

test('fullscreen user block wraps multi-line input and keeps bottom cluster pinned', () => {
    withTerminalSize(44, 24, () => {
        const ctx = makeCtx();
        appendUserItem(
            ctx.store.transcript,
            'please inspect this very long user message that must wrap safely\nand keep the footer and composer pinned',
            'please inspect this very long user message that must wrap safely\nand keep the footer and composer pinned',
        );

        const frame = composeFrame(ctx, new Viewport());
        assert.equal(frame.rows.some(row => row.includes('\n')), false);
        const expanded = expandViewportFill(frame.rows, 24);
        const regions = solveLayout(44, 24, 1);
        const main = stripAnsi(expanded.slice(regions.transcript.y - 1, regions.statusLine.y - 1).join('\n'));

        assert.ok(expanded.every(row => visualWidth(row) <= 44), 'all user block frame rows must fit terminal width');
        assert.match(main, /╭─ You/);
        assert.match(main, /please inspect/);
        assert.match(main, /footer and composer/);
        assert.match(stripAnsi(expanded[regions.statusLine.y - 1] ?? ''), /\/quit/);
        assert.match(expanded[regions.composer.y - 2] ?? '', /┌/);
        assert.match(expanded[regions.help.y - 1] ?? '', /shortcuts/);
    });
});

test('fullscreen finished thinking collapses by default and ctrl-o expansion reveals body', () => {
    const collapsedRows = renderTranscriptItem({
        type: 'thinking',
        text: 'line one\nline two',
        streaming: false,
        collapsed: true,
        timestamp: 0,
    }, 52);
    const collapsed = stripAnsi(collapsedRows.join('\n'));
    assert.match(collapsed, /Thinking … \+2 lines/);
    assert.doesNotMatch(collapsed, /line one/);

    const expandedRows = renderTranscriptItem({
        type: 'thinking',
        text: 'single detail',
        streaming: false,
        collapsed: false,
        timestamp: 0,
    }, 52);
    const expanded = stripAnsi(expandedRows.join('\n'));
    assert.match(expanded, /Thinking … \+1 lines/);
    assert.match(expanded, /single detail/);
    assert.ok(expandedRows.every(row => visualWidth(row) <= 52));
});

test('fullscreen live tool rows stay width-safe during long mid-call updates', () => {
    withTerminalSize(72, 28, () => {
        const ctx = makeCtx();
        appendAssistantTurnText(ctx.store.transcript, 'Plan을 수정하고 re-audit하겠습니다.', 'main');
        finalizeStreamingAssistants(ctx.store.transcript);
        upsertLiveToolItem(ctx.store.transcript, {
            icon: '⏳',
            label: 'subagent: Verify estimateTokens callers',
            detail: 'prompt: In the repository /Users/jun/Developer/new/700_projects/cli-jaw check encoding joins 🦈 📁',
            status: 'running',
            stepRef: 'live-wide',
        });

        const frame = composeFrame(ctx, new Viewport());
        const expanded = expandViewportFill(frame.rows, 28);
        const regions = solveLayout(72, 28, 1);
        const main = stripAnsi(expanded.slice(regions.transcript.y - 1, regions.statusLine.y - 1).join('\n'));

        assert.equal(frame.rows.some(row => row.includes('\n')), false);
        assert.ok(expanded.every(row => visualWidth(row) <= 72), 'all frame rows must fit terminal width');
        assert.match(main, /subagent: Verify/);
        assert.doesNotMatch(main, /⏳\s+⏳/);
        assert.match(stripAnsi(expanded[regions.statusLine.y - 1] ?? ''), /\/quit/);
        assert.match(expanded[regions.composer.y - 2] ?? '', /┌/);
        assert.match(expanded[regions.help.y - 1] ?? '', /shortcuts/);
    });
});

test('fullscreen composeFrame stays bottom-pinned after composer text changes', () => {
    withTerminalSize(80, 24, () => {
        const ctx = makeCtx();
        appendAssistantTurnText(ctx.store.transcript, 'Ready.', 'main');
        finalizeStreamingAssistants(ctx.store.transcript);
        appendTextToComposer(ctx.store.composer, 'next message');

        const frame = composeFrame(ctx, new Viewport());
        assert.equal(frame.rows.some(row => row.includes('\n')), false);
        const expanded = expandViewportFill(frame.rows, 24);
        const regions = solveLayout(80, 24, 1);
        assert.match(expanded[regions.statusLine.y - 1] ?? '', /\/quit/);
        assert.match(expanded[regions.composer.y - 1] ?? '', /next message/);
        assert.match(expanded[regions.help.y - 1] ?? '', /shortcuts/);
        // Pre-expansion cursor row (Screen.render normalizes to the composer interior).
        assert.equal(frame.cursorPos?.row, 6);
        assert.ok((frame.cursorPos?.col ?? 0) > 4);
    });
});

test('fullscreen composeFrame keeps composer cluster fixed after first message', () => {
    withTerminalSize(80, 24, () => {
        const ctx = makeCtx();
        ctx.welcomeLines = ['Welcome to jaw chat'];

        const regions = solveLayout(80, 24, 1);
        const before = expandViewportFill(composeFrame(ctx, new Viewport()).rows, 24);
        appendUserItem(ctx.store.transcript, 'hello', 'hello');
        const after = expandViewportFill(composeFrame(ctx, new Viewport()).rows, 24);

        const beforeMain = stripAnsi(before.slice(regions.transcript.y - 1, regions.statusLine.y - 1).join('\n'));
        const afterMain = stripAnsi(after.slice(regions.transcript.y - 1, regions.statusLine.y - 1).join('\n'));

        assert.match(beforeMain, /Welcome to jaw chat/);
        assert.match(afterMain, /Welcome to jaw chat/);
        assert.match(afterMain, /hello/);
        assert.equal(before[regions.statusLine.y - 1], after[regions.statusLine.y - 1]);
        assert.equal(before[regions.composer.y - 2], after[regions.composer.y - 2]);
        assert.equal(before[regions.composer.y - 1], after[regions.composer.y - 1]);
        assert.equal(before[regions.help.y - 1], after[regions.help.y - 1]);
    });
});

test('fullscreen composeFrame renders slash surface without replacing transcript rows', () => {
    withTerminalSize(96, 28, () => {
        const ctx = makeCtx();
        appendAssistantTurnText(ctx.store.transcript, 'Transcript stays visible.', 'main');
        finalizeStreamingAssistants(ctx.store.transcript);
        ctx.store.autocomplete.open = true;
        ctx.store.autocomplete.stage = 'command';
        ctx.store.autocomplete.items = [
            { name: 'settings', desc: 'Open settings' },
            { name: 'model', desc: 'View/change model' },
        ];
        ctx.store.autocomplete.visibleRows = 2;
        ctx.store.autocomplete.selected = 0;

        const frame = composeFrame(ctx, new Viewport());
        const expanded = expandViewportFill(frame.rows, 28);
        const regions = solveLayout(96, 28, 1, { commandSurfaceLines: 2 });
        const joined = stripAnsi(expanded.join('\n'));

        const transcriptRegion = stripAnsi(expanded
            .slice(regions.transcript.y - 1, regions.statusLine.y - 1)
            .join('\n'));
        assert.match(transcriptRegion, /Transcript stays visible/);
        assert.match(stripAnsi(expanded[regions.statusLine.y - 1] ?? ''), /\/quit/);
        assert.match(stripAnsi(expanded[regions.commandSurface.y - 1] ?? ''), /\/settings/);
        assert.match(expanded[regions.commandSurface.y - 1] ?? '', /\x1b\[7m/);
        assert.match(expanded[regions.composer.y - 2] ?? '', /┌/);
        assert.match(expanded[regions.help.y - 1] ?? '', /shortcuts/);
        assert.doesNotMatch(joined, /Context/);
        assert.equal(frame.rows.some(row => row.includes('\n')), false);
    });
});

test('fullscreen composeFrame renders Appearance settings MVP in main content region', () => {
    withTerminalSize(96, 28, () => {
        const ctx = makeCtx();
        ctx.store.overlay.settingsOpen = true;

        const frame = composeFrame(ctx, new Viewport());
        const expanded = expandViewportFill(frame.rows, 28);
        const regions = solveLayout(96, 28, 1);
        const main = stripAnsi(expanded.slice(regions.transcript.y - 1, regions.statusLine.y - 1).join('\n'));

        assert.match(main, /Settings: cli-jaw/);
        assert.match(main, /Only supported local CLI\/TUI settings/);
        assert.match(main, /Local CLI \/ TUI/);
        assert.match(main, /Web AI Settings/);
        assert.match(main, /Runtime Frame Behavior/);
        assert.match(main, /Preview:/);
        assert.match(main, /Theme\s+dark/);
        assert.match(main, /Fullscreen Default\s+enabled/);
        assert.match(main, /Reasoning Visibility\s+off/);
        assert.match(main, /Compact Density\s+normal/);
        assert.match(main, /Markdown Renderer/);
        assert.match(main, /Tool Rows/);
        assert.match(main, /Composer Pin/);
        assert.match(main, /Enter\/Space to change/);
        assert.doesNotMatch(main, /Context/);
        assert.doesNotMatch(main, /Memory/);
        assert.match(stripAnsi(expanded[regions.statusLine.y - 1] ?? ''), /\/quit/);
        assert.match(expanded[regions.composer.y - 2] ?? '', /┌/);
        assert.match(expanded[regions.help.y - 1] ?? '', /shortcuts/);
        assert.equal(frame.cursorPos, undefined);
    });
});

test('fullscreen expanded tool detail wraps long output into physical frame rows', () => {
    withTerminalSize(64, 28, () => {
        const ctx = makeCtx();
        appendToolItem(ctx.store.transcript, '🔧 Bash long', {
            stepRef: 'long',
            status: 'done',
            detail: 'abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz',
        });
        const tool = ctx.store.transcript.items[0]!;
        assert.equal(tool.type, 'tool');
        if (tool.type === 'tool') tool.collapsed = false;

        const frame = composeFrame(ctx, new Viewport());
        assert.equal(frame.rows.some(row => row.includes('\n')), false);
        const expanded = expandViewportFill(frame.rows, 28);
        const regions = solveLayout(64, 28, 1);
        const main = stripAnsi(expanded.slice(regions.transcript.y - 1, regions.statusLine.y - 1).join('\n'));

        assert.match(main, /abcdef/);
        assert.match(main, /012345/);
        assert.match(main, /uvwxyz/);
        assert.match(expanded[regions.statusLine.y - 1] ?? '', /\/quit/);
        assert.match(expanded[regions.composer.y - 2] ?? '', /┌/);
        assert.match(expanded[regions.help.y - 1] ?? '', /shortcuts/);
    });
});

test('fullscreen expanded tool detail applies a physical row cap', () => {
    // renderToolBlock splits detail on newlines and clips each logical line to one row,
    // capping at 14 detail rows plus a "… +N lines" overflow summary row.
    const rows = renderTranscriptItem({
        type: 'tool',
        text: '🔧 Bash capped',
        timestamp: 0,
        status: 'done',
        collapsed: false,
        detail: Array.from({ length: 40 }, (_, i) => `detail line ${i}`).join('\n'),
    }, 50);
    const plain = stripAnsi(rows.join('\n'));
    const detailRows = plain.split('\n').filter(line => line.includes('│'));

    assert.equal(rows.some(row => row.includes('\n')), false);
    assert.equal(detailRows.length, 15);
    assert.match(plain, /… \+\d+ lines/);
});

test('fullscreen live tool rows render above the fixed bottom cluster', () => {
    withTerminalSize(80, 28, () => {
        const ctx = makeCtx();
        appendAssistantTurnText(ctx.store.transcript, 'Transcript remains visible.', 'main');
        finalizeStreamingAssistants(ctx.store.transcript);
        upsertLiveToolItem(ctx.store.transcript, { icon: '🔧', label: 'Bash', detail: 'npm test', status: 'running', stepRef: 's1' });

        const frame = composeFrame(ctx, new Viewport());
        assert.equal(frame.rows.some(row => row.includes('\n')), false);
        const expanded = expandViewportFill(frame.rows, 28);
        const regions = solveLayout(80, 28, 1);
        const main = stripAnsi(expanded.slice(regions.transcript.y - 1, regions.statusLine.y - 1).join('\n'));

        assert.match(main, /Transcript remains visible/);
        assert.match(main, /Bash/);
        assert.match(main, /npm test/);
        assert.match(stripAnsi(expanded[regions.statusLine.y - 1] ?? ''), /\/quit/);
        assert.match(expanded[regions.composer.y - 2] ?? '', /┌/);
        assert.match(expanded[regions.help.y - 1] ?? '', /shortcuts/);
    });
});

test('fullscreen live tool rows are capped with an overflow summary', () => {
    withTerminalSize(80, 28, () => {
        const ctx = makeCtx();
        for (let i = 0; i < 6; i += 1) {
            upsertLiveToolItem(ctx.store.transcript, { icon: '🔧', label: `Tool${i}`, detail: `detail ${i}`, status: 'running', stepRef: `s${i}` });
        }

        const expanded = expandViewportFill(composeFrame(ctx, new Viewport()).rows, 28);
        const regions = solveLayout(80, 28, 1);
        const main = stripAnsi(expanded.slice(regions.transcript.y - 1, regions.statusLine.y - 1).join('\n'));

        assert.match(main, /Tool0/);
        assert.match(main, /Tool1/);
        assert.match(main, /Tool2/);
        assert.match(main, /\+2 running tools/);
        assert.doesNotMatch(main, /Tool5/);
        assert.match(expanded[regions.composer.y - 2] ?? '', /┌/);
    });
});

test('fullscreen ctrl-o full sweep keeps final answer visible and rows width-safe', () => {
    for (const [cols, rows] of [[72, 28], [100, 30]] as const) {
        withTerminalSize(cols, rows, () => {
            const ctx = makeCtx();
            appendToolItem(ctx.store.transcript, 'Bash', {
                stepRef: 'bash-1',
                status: 'done',
                detail: 'first line from bash output\nsecond line from bash output\nthird line from bash output',
            });
            appendToolItem(ctx.store.transcript, 'Read File', {
                stepRef: 'read-1',
                status: 'done',
                detail: '/Users/jun/Developer/new/700_projects/cli-jaw/src/cli/tui/transcript.ts',
            });
            appendToolItem(ctx.store.transcript, 'Search', {
                stepRef: 'search-1',
                status: 'done',
                detail: 'matched agent_done toolLog final response live tool rows',
            });
            upsertLiveToolItem(ctx.store.transcript, {
                icon: '🔧',
                label: 'Bash live',
                detail: 'live one-line command output that should wrap when expanded',
                status: 'running',
                stepRef: 'live-1',
            });
            appendAssistantTurnText(ctx.store.transcript, 'Final answer remains after tool rows.', 'main');
            finalizeStreamingAssistants(ctx.store.transcript);
            assert.equal(toggleToolExpansion(ctx.store.transcript), true);
            assert.equal(ctx.store.transcript.liveToolsExpanded, true);

            const frame = composeFrame(ctx, new Viewport());
            assert.equal(frame.rows.some(row => row.includes('\n')), false);
            const expanded = expandViewportFill(frame.rows, rows);
            const regions = solveLayout(cols, rows, 1);
            const main = stripAnsi(expanded.slice(regions.transcript.y - 1, regions.statusLine.y - 1).join('\n'));

            assert.ok(expanded.every(row => visualWidth(row) <= cols), `all frame rows must fit width ${cols}`);
            assert.match(main, /Bash/);
            assert.match(main, /Read File/);
            assert.match(main, /Search/);
            assert.match(main, /Bash live|live tool output folded to fit/);
            assert.match(main, /Final answer remains/);
            assert.match(stripAnsi(expanded[regions.statusLine.y - 1] ?? ''), /\/quit/);
            assert.match(expanded[regions.composer.y - 2] ?? '', /┌/);
            assert.match(expanded[regions.help.y - 1] ?? '', /shortcuts/);
        });
    }
});

test('fullscreen reused viewport rerenders after terminal width shrinks', () => {
    const ctx = makeCtx();
    const viewport = new Viewport();
    appendToolItem(ctx.store.transcript, 'Read File', {
        stepRef: 'resize-read',
        status: 'done',
        detail: '/Users/jun/Developer/new/700_projects/cli-jaw/bin/commands/tui/fullscreen-mode.ts',
    });
    appendAssistantTurnText(ctx.store.transcript, 'Final answer remains visible after shrink.', 'main');
    finalizeStreamingAssistants(ctx.store.transcript);
    assert.equal(toggleToolExpansion(ctx.store.transcript), true);

    withTerminalSize(120, 30, () => {
        const expanded = expandViewportFill(composeFrame(ctx, viewport).rows, 30);
        assert.ok(expanded.every(row => visualWidth(row) <= 120));
    });

    withTerminalSize(64, 24, () => {
        const frame = composeFrame(ctx, viewport);
        const expanded = expandViewportFill(frame.rows, 24);
        const regions = solveLayout(64, 24, 1);
        const main = stripAnsi(expanded.slice(regions.transcript.y - 1, regions.statusLine.y - 1).join('\n'));

        assert.equal(frame.rows.some(row => row.includes('\n')), false);
        assert.ok(expanded.every(row => visualWidth(row) <= 64));
        assert.match(main, /Read File/);
        assert.match(main, /Final answer remains/);
        assert.match(expanded[regions.composer.y - 2] ?? '', /┌/);
        assert.match(expanded[regions.help.y - 1] ?? '', /shortcuts/);
    });
});

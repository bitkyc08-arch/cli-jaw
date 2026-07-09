// ─── jawcode-style bgtask rendering (devlog 260703 tui_steer_esc_rca doc 40) ──
// Overlay rows mirror jawcode's background footer panel: `{icon} {kind} {label}
// · {hint}` with the unicode glyph set (✔ ✘ ⏹ ⚠ ⟳), attention-first sort,
// formatDuration tiers, and a `!` attention suffix on the status-bar badge that
// clears when the Ctrl+O panel opens.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildBgtaskInnerLines, sortBgtaskItems, formatBgtaskDuration,
    paintCenteredBox,
    type BgtaskOverlayItem,
} from '../../src/cli/tui/overlay.ts';
import { formatFooter } from '../../bin/commands/tui/types.ts';
import { renderStatusBar } from '../../src/cli/tui/jawcode-bridge.ts';
import { handleWsMessage } from '../../bin/commands/tui/ws-handler.ts';
import type { TuiContext } from '../../bin/commands/tui/types.ts';
import { createTuiStore } from '../../src/cli/tui/store.ts';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function strip(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
}

test('formatBgtaskDuration follows jawcode formatDuration tiers', () => {
    assert.equal(formatBgtaskDuration(500), '500ms');
    assert.equal(formatBgtaskDuration(1500), '1.5s');
    assert.equal(formatBgtaskDuration(30 * 60_000 + 15_000), '30m15s');
    assert.equal(formatBgtaskDuration(2 * 3_600_000 + 30 * 60_000), '2h30m');
    assert.equal(formatBgtaskDuration(3 * 86_400_000 + 2 * 3_600_000), '3d2h');
    assert.equal(formatBgtaskDuration(60_000), '1m');
});

test('sortBgtaskItems ranks attention first, then running, recent first within rank', () => {
    const items: BgtaskOverlayItem[] = [
        { id: 'bg_old-complete', kind: 'shell', status: 'complete', elapsed: '', sortKey: 10 },
        { id: 'bg_new-running', kind: 'shell', status: 'running', elapsed: '5s', sortKey: 40 },
        { id: 'bg_failed', kind: 'shell', status: 'failed', elapsed: '', sortKey: 20 },
        { id: 'bg_old-running', kind: 'shell', status: 'running', elapsed: '9s', sortKey: 30 },
        { id: 'bg_cancelled', kind: 'shell', status: 'cancelled', elapsed: '', sortKey: 5 },
    ];
    const order = sortBgtaskItems(items).map(i => i.id);
    assert.deepEqual(order, ['bg_failed', 'bg_cancelled', 'bg_new-running', 'bg_old-running', 'bg_old-complete']);
});

test('overlay rows use the jawcode glyph set and dot-separated hints', () => {
    const items: BgtaskOverlayItem[] = [
        { id: 'bg_run12345', kind: 'shell', status: 'running', elapsed: '2m30s', sortKey: 4 },
        { id: 'bg_done1234', kind: 'web-ai', status: 'complete', elapsed: '', ago: '5m ago', sortKey: 3 },
        { id: 'bg_fail1234', kind: 'shell', status: 'failed', elapsed: '', ago: '1m ago', sortKey: 2 },
        { id: 'bg_stop1234', kind: 'shell', status: 'cancelled', elapsed: '', sortKey: 1 },
    ];
    const lines = buildBgtaskInnerLines(DIM, RESET, items).map(strip);
    // Attention rows sort first; kind column pads to 7 chars.
    assert.match(lines[0]!, /^ {2}✘ shell {3}fail1234 · failed · 1m ago$/);
    assert.match(lines[1]!, /^ {2}⏹ shell {3}stop1234 · cancelled$/);
    assert.match(lines[2]!, /^ {2}⟳ shell {3}run12345 · 2m30s$/);
    assert.match(lines[3]!, /^ {2}✔ web-ai {2}done1234 · complete · 5m ago$/);
});

test('overlay caps at 10 rows with an overflow line and keeps the close hint', () => {
    const items: BgtaskOverlayItem[] = Array.from({ length: 12 }, (_, i) => ({
        id: `bg_task${String(i).padStart(4, '0')}`, kind: 'shell', status: 'complete', elapsed: '', sortKey: i,
    }));
    const lines = buildBgtaskInnerLines(DIM, RESET, items).map(strip);
    assert.equal(lines.filter(l => l.includes('✔')).length, 10);
    assert.ok(lines.some(l => l.includes('+2 more')));
    assert.ok(lines.at(-1)!.includes('Press Escape or Ctrl+O to close'));
});

test('empty overlay keeps the no-tasks line', () => {
    const lines = buildBgtaskInnerLines(DIM, RESET, []).map(strip);
    assert.ok(lines[0]!.includes('No background tasks'));
});

test('status-bar badge grows the jawcode attention suffix', () => {
    const base = { model: 'm', engine: 'jwc', engineAccent: '\x1b[36m', state: 'idle', cwd: '/tmp', port: 1 };
    assert.ok(strip(renderStatusBar({ ...base, bgtask: 2 })).includes('⏳2'));
    assert.ok(strip(renderStatusBar({ ...base, bgtask: 2, bgtaskAttention: true })).includes('⏳2!'));
    assert.ok(strip(renderStatusBar({ ...base, bgtask: 0, bgtaskAttention: true })).includes('⏳!'));
    assert.ok(!strip(renderStatusBar({ ...base, bgtask: 0 })).includes('⏳'));
});

test('classic footer badge mirrors the attention suffix', () => {
    const ACCENT = '\x1b[31m';
    assert.ok(strip(formatFooter('x', ACCENT, 'idle', 0, 2, true)).includes('⏳2!'));
    assert.ok(strip(formatFooter('x', ACCENT, 'idle', 0, 0, true)).includes('⏳!'));
    assert.ok(!strip(formatFooter('x', ACCENT, 'idle', 0, 2)).includes('!'));
});

function makeCtx(): TuiContext {
    return {
        ws: { send() { /* no-op */ }, close() { /* no-op */ } },
        apiUrl: '',
        info: { cli: 'codex', workingDir: '/tmp', model: 'm' },
        accent: '', label: 'codex', dir: '/tmp', runtimeLocale: 'en',
        tuiConfig: { pasteCollapseLines: 2, pasteCollapseChars: 160 },
        settingsSnapshot: {}, values: { port: '3457', raw: false, simple: false }, isRaw: false,
        store: createTuiStore(),
        overlayBoxHeight: 0, inputActive: true, streaming: false, streamState: 'idle',
        bgtaskCount: 0, bgtaskTasks: [], turnStartedAt: 0, streamSink: null,
        commandRunning: false, escPending: false, escTimer: null, footerTimer: null,
        editorChordPending: false, prevLineCount: 1, promptCursorRow: 0, resizeTimer: null,
        ideEnabled: false, idePopEnabled: false, preFileSetQueue: [], chatCwd: '/tmp',
        isGit: false, detectedIde: null, promptPrefix: '  > ', footer: 'footer',
        displayMode: 'fullscreen', requestFrame: null,
    } as unknown as TuiContext;
}

test('bgtask_update latches attention on failure and renders the Ctrl+O hint', () => {
    const ctx = makeCtx();
    handleWsMessage(ctx, Buffer.from(JSON.stringify({
        type: 'bgtask_update', running: [],
        changed: { id: 'bg_x', kind: 'shell', status: 'failed' },
    })));
    assert.equal(ctx.bgtaskAttention, true);
    const last = ctx.store.transcript.items.filter(i => i.type === 'status').at(-1);
    assert.ok(last && 'text' in last && /bgtask shell failed · Ctrl\+O/.test(String(last.text)));
});

test('centered box pads/clips ANSI-colored rows by visual width without leaking escapes', () => {
    const items: BgtaskOverlayItem[] = [
        { id: 'bg_fail1234', kind: 'shell', status: 'failed', elapsed: '', ago: '12m30s ago', sortKey: 1 },
    ];
    const inner = buildBgtaskInnerLines(DIM, RESET, items);
    const frameRows = Array.from({ length: 20 }, () => '');
    paintCenteredBox(frameRows, 60, 20, '─ Background Tasks ', inner, 52);
    const row = frameRows.find(r => r.includes('✘'))!;
    assert.ok(row, 'failed row must be painted');
    // The colored row is visually shorter than innerW: it must be padded (not
    // sliced mid-escape) and keep BOTH box borders on the same line.
    assert.ok(strip(row).trimEnd().endsWith('│'), 'right border must survive ANSI content');
    assert.match(strip(row), /✘ shell {3}fail1234 · failed · 12m30s ago/);
    // No unclosed escape: every CSI sequence is followed eventually by a reset
    // before the right border (clipTextToCols appends one when clipping).
    const afterLastReset = row.slice(row.lastIndexOf('\x1b[0m'));
    assert.ok(!/\x1b\[(?!0m)[0-9;]+m/.test(afterLastReset), 'no dangling color after the last reset');
});

test('bgtask_update refreshes an open fullscreen panel from the API', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ tasks: [{ id: 'bg_done', kind: 'shell', status: 'complete', startedAt: null, completedAt: null }] }));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as { port: number };
    try {
        const ctx = makeCtx();
        ctx.apiUrl = `http://127.0.0.1:${port}`;
        ctx.store.overlay.bgtaskOpen = true;
        ctx.bgtaskAttention = true;
        handleWsMessage(ctx, Buffer.from(JSON.stringify({
            type: 'bgtask_update', running: [],
            changed: { id: 'bg_done', kind: 'shell', status: 'complete' },
        })));
        // openBgtaskOverlay refetch is fire-and-forget — wait for it to settle.
        for (let i = 0; i < 100 && !ctx.bgtaskOverlayItems; i += 1) {
            await new Promise(r => setTimeout(r, 5));
        }
        assert.equal(ctx.bgtaskOverlayItems?.[0]?.status, 'complete');
        // Panel is open → the user saw the state; attention latch stays cleared.
        assert.ok(!ctx.bgtaskAttention);
    } finally {
        server.close();
    }
});

test('bgtask_update completion does not latch attention', () => {
    const ctx = makeCtx();
    handleWsMessage(ctx, Buffer.from(JSON.stringify({
        type: 'bgtask_update', running: [],
        changed: { id: 'bg_x', kind: 'shell', status: 'complete' },
    })));
    assert.ok(!ctx.bgtaskAttention);
});

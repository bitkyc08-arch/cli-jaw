/**
 * 260704 RCA repro — resize/full-redraw flush pushes the blank rows parked
 * ABOVE the committed block into native scrollback (blank bands), instead of
 * deleting them in place like the steady-state shrink path (F4) does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Screen, VIEWPORT_FILL, type Frame } from '../../src/cli/tui/render/frame.ts';
import { AnsiTerminalModel } from './helpers/ansi-terminal-model.ts';

function withScreen(fn: (screen: Screen, term: AnsiTerminalModel, out: () => string) => void): void {
    let output = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    const origCols = process.stdout.columns;
    const origRows = process.stdout.rows;
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 8, configurable: true });
    const term = new AnsiTerminalModel(40, 8);
    process.stdout.write = ((chunk: string | Uint8Array) => {
        const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        output += s;
        term.write(s);
        return true;
    }) as typeof process.stdout.write;
    const MUX_KEYS = ['TMUX', 'STY', 'CMUX_WORKSPACE_ID', 'CMUX_SURFACE_ID', 'CMUX_SOCKET_PATH'] as const;
    const prevMux: Record<string, string | undefined> = {};
    for (const key of MUX_KEYS) { prevMux[key] = process.env[key]; delete process.env[key]; }
    const prevTerm = process.env.TERM; process.env.TERM = 'xterm-256color';
    try {
        const screen = new Screen();
        screen.enter();
        fn(screen, term, () => output);
        screen.exit();
    } finally {
        process.stdout.write = origWrite;
        Object.defineProperty(process.stdout, 'columns', { value: origCols, configurable: true });
        Object.defineProperty(process.stdout, 'rows', { value: origRows, configurable: true });
        for (const key of MUX_KEYS) {
            if (prevMux[key] !== undefined) process.env[key] = prevMux[key]; else delete process.env[key];
        }
        if (prevTerm !== undefined) process.env.TERM = prevTerm; else delete process.env.TERM;
    }
}

function nonEmptyScrollback(term: AnsiTerminalModel): string[] {
    return term.scrollback.map(row => row.replace(/\x1b\[[0-9;]*m/g, '').trimEnd());
}

test('H1 repro: width-resize flush must not stamp the blanks above a parked committed block', () => {
    withScreen((screen, term) => {
        const frame: Frame = { rows: [VIEWPORT_FILL, 'turn-tail', '> composer'] };
        screen.render(frame);
        // Park one committed row under a 6-row fill: rows 1..5 blank, row 6 = hist-1.
        assert.equal(screen.queueCommitLines(['hist-1']), true);
        screen.render(frame);

        // Simulate a width resize (visible-clear mode in a plain terminal).
        Object.defineProperty(process.stdout, 'columns', { value: 39, configurable: true });
        term.resize(39, 8);
        screen.forceResizeRedraw();
        screen.render({ rows: [VIEWPORT_FILL, 'turn-tail', '> composer'] });

        const sb = nonEmptyScrollback(term);
        const blankRows = sb.filter(row => row === '').length;
        assert.ok(sb.some(row => row.includes('hist-1')), `hist-1 must survive into scrollback, got: ${JSON.stringify(sb)}`);
        assert.equal(blankRows, 0, `resize flush stamped ${blankRows} blank rows into scrollback: ${JSON.stringify(sb)}`);
    });
});

test('adversarial-1: simultaneous width+height shrink adopts pushed rows and stamps no blanks', () => {
    withScreen((screen, term) => {
        const frame: Frame = { rows: [VIEWPORT_FILL, 'turn-tail', '> composer'] };
        screen.render(frame);
        assert.equal(screen.queueCommitLines(['hist-1', 'hist-2', 'hist-3']), true);
        screen.render(frame);

        // 40x8 → 39x6: the terminal pushes the top 2 rows natively AND rewraps.
        Object.defineProperty(process.stdout, 'columns', { value: 39, configurable: true });
        Object.defineProperty(process.stdout, 'rows', { value: 6, configurable: true });
        term.resize(39, 6, { nativePush: true });
        screen.forceResizeRedraw();
        screen.render({ rows: [VIEWPORT_FILL, 'turn-tail', '> composer'] });

        const sb = nonEmptyScrollback(term).filter(row => row !== '');
        for (const line of ['hist-1', 'hist-2', 'hist-3']) {
            const copies = sb.filter(row => row.includes(line)).length;
            assert.equal(copies, 1, `${line} must appear exactly once: ${JSON.stringify(sb)}`);
        }
        const blankRows = nonEmptyScrollback(term).filter(row => row === '').length;
        assert.equal(blankRows, 0, `no blank rows in scrollback: ${JSON.stringify(term.scrollback)}`);
    });
});

test('adversarial-3 (benign): fill<2 skips the flush transactionally — nothing reaches scrollback, no retry spin', () => {
    withScreen((screen, term) => {
        // Frame with fill = 1 (content fills all but one row of the 8-row term).
        const rows = [VIEWPORT_FILL, 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', '> composer'];
        screen.render({ rows });
        // The queue is accepted (the caller preview-hides only rows that are
        // beyond the visible window anyway), but the render must not flush,
        // must not report a stale-row deferral (no 16ms retry spin), and must
        // leave scrollback untouched — the unmarked frontier re-derives the
        // rows once capacity exists.
        assert.equal(screen.queueCommitLines(['hist-1']), true);
        screen.render({ rows });
        assert.equal(screen.lastCommitFlushedCount(), 0);
        assert.equal(screen.lastCommitDeferredByStaleRows(), false);
        assert.equal(term.scrollback.length, 0);
    });
});

test('adversarial-2: coalesced shrink→grow before the repaint keeps every row exactly once', () => {
    withScreen((screen, term) => {
        const frame: Frame = { rows: [VIEWPORT_FILL, 'turn-tail', '> composer'] };
        screen.render(frame);
        assert.equal(screen.queueCommitLines(['hist-1', 'hist-2', 'hist-3']), true);
        screen.render(frame);

        // Debounce window: shrink 8→6 (pushes hist-1, hist-2) then grow 6→7
        // (pulls hist-2 back) BEFORE the app repaints. Net delta = 1 pushed.
        term.resize(40, 6, { nativePush: true });
        term.resize(40, 7, { nativePush: true });
        Object.defineProperty(process.stdout, 'rows', { value: 7, configurable: true });
        screen.forceResizeRedraw();
        screen.render({ rows: [VIEWPORT_FILL, 'turn-tail', '> composer'] });

        const sb = nonEmptyScrollback(term).filter(row => row !== '');
        for (const line of ['hist-1', 'hist-2', 'hist-3']) {
            const copies = sb.filter(row => row.includes(line)).length;
            assert.equal(copies, 1, `${line} must appear exactly once: ${JSON.stringify(sb)}`);
        }
        assert.equal(nonEmptyScrollback(term).filter(row => row === '').length, 0,
            `no blank rows in scrollback: ${JSON.stringify(term.scrollback)}`);
    });
});

test('top-anchor: commits write below the block; only content crosses the seam when saturated', () => {
    withScreen((screen, term) => {
        const frame: Frame = { rows: [VIEWPORT_FILL, 'turn-tail', '> composer'] };
        screen.render(frame);
        // fill = 6 rows. First flush: 3 direct writes at rows 1..3, no scroll.
        assert.equal(screen.queueCommitLines(['hist-1', 'hist-2', 'hist-3']), true);
        screen.render(frame);
        assert.equal(term.scrollback.length, 0, `unsaturated flush must not scroll: ${JSON.stringify(term.scrollback)}`);
        const visible1 = term.visibleText();
        assert.ok(visible1.includes('hist-1') && visible1.includes('hist-3'), `block must sit on screen: ${visible1}`);

        // Second flush: rows 4..6 direct, then one saturated scroll — exactly
        // the OLDEST committed row crosses the seam, never a blank.
        assert.equal(screen.queueCommitLines(['hist-4', 'hist-5', 'hist-6', 'hist-7']), true);
        screen.render(frame);
        const sb = nonEmptyScrollback(term);
        assert.deepEqual(sb, ['hist-1'], `only hist-1 crosses the seam: ${JSON.stringify(sb)}`);
        const visible2 = term.visibleText();
        assert.ok(visible2.includes('hist-2') && visible2.includes('hist-7'), `block 2..7 stays on screen: ${visible2}`);
    });
});

test('top-anchor: fill shrink drains content-only through the seam', () => {
    withScreen((screen, term) => {
        screen.render({ rows: [VIEWPORT_FILL, 'turn-tail', '> composer'] });
        assert.equal(screen.queueCommitLines(['hist-1', 'hist-2', 'hist-3']), true);
        screen.render({ rows: [VIEWPORT_FILL, 'turn-tail', '> composer'] });
        // Live zone grows by 4 rows → fill 6→2 → block 3 must drain 1 row.
        screen.render({ rows: [VIEWPORT_FILL, 'l1', 'l2', 'l3', 'l4', 'turn-tail', '> composer'] });
        const sb = nonEmptyScrollback(term);
        assert.equal(sb.filter(row => row === '').length, 0, `no blank crosses the seam: ${JSON.stringify(sb)}`);
        assert.deepEqual(sb, ['hist-1'], `oldest row drains first: ${JSON.stringify(sb)}`);
        assert.ok(term.visibleText().includes('hist-2'), 'remaining block stays glued to the seam');
    });
});

test('H1b repro: height-shrink adopts terminal-pushed rows instead of re-emitting them', () => {
    withScreen((screen, term) => {
        const frame: Frame = { rows: [VIEWPORT_FILL, 'turn-tail', '> composer'] };
        screen.render(frame);
        assert.equal(screen.queueCommitLines(['hist-1', 'hist-2', 'hist-3']), true);
        screen.render(frame);

        // Terminal-native height shrink (8→6): the terminal keeps the cursor
        // visible and pushes the top 2 rows — hist-1, hist-2 — into its own
        // scrollback BEFORE the app reacts.
        Object.defineProperty(process.stdout, 'rows', { value: 6, configurable: true });
        term.resize(40, 6, { nativePush: true });
        screen.forceResizeRedraw();
        screen.render({ rows: [VIEWPORT_FILL, 'turn-tail', '> composer'] });

        const sb = nonEmptyScrollback(term).filter(row => row !== '');
        for (const line of ['hist-1', 'hist-2', 'hist-3']) {
            const copies = sb.filter(row => row.includes(line)).length;
            assert.equal(copies, 1, `${line} must appear exactly once in scrollback: ${JSON.stringify(sb)}`);
        }
        assert.deepEqual(sb, ['hist-1', 'hist-2', 'hist-3'], `ordered, blank-free scrollback: ${JSON.stringify(sb)}`);
    });
});

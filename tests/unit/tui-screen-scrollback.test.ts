import test from 'node:test';
import assert from 'node:assert/strict';
import { Screen, VIEWPORT_FILL, type Frame } from '../../src/cli/tui/render/frame.ts';
import { AnsiTerminalModel } from './helpers/ansi-terminal-model.ts';

function withScreen(fn: (screen: Screen, term: AnsiTerminalModel, out: () => string) => void, opts?: { tmux?: boolean; preScrollback?: string[] }): void {
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
    if (opts?.tmux) process.env.TMUX = '/tmp/tmux-test,1234,0';
    const prevTerm = process.env.TERM; process.env.TERM = 'xterm-256color';
    if (opts?.preScrollback) term.scrollback.push(...opts.preScrollback);
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

// 260703 scrollback hardening:
// red→green repros for the four Screen defects, driven through the hardened
// AnsiTerminalModel (real DECSTBM + 3J semantics).

test('F1: launch inside tmux keeps the pane scrollback (no 3J)', () => {
    withScreen((screen, term, out) => {
        screen.render({ rows: [VIEWPORT_FILL, 'hello', '> composer'] });
        assert.ok(!out().includes('\x1b[3J'), 'launch clear emitted 3J inside tmux');
        assert.deepEqual(term.scrollback, ['user-history-1', 'user-history-2']);
    }, { tmux: true, preScrollback: ['user-history-1', 'user-history-2'] });
});

test('F1: launch in a plain terminal keeps the fresh-terminal 3J behavior', () => {
    withScreen((screen, term, out) => {
        screen.render({ rows: [VIEWPORT_FILL, 'hello', '> composer'] });
        assert.ok(out().includes('\x1b[3J'));
        assert.equal(term.scrollback.length, 0);
    }, { preScrollback: ['stale'] });
});

test('F2: resize before the first native commit keeps tmux pane scrollback', () => {
    withScreen((screen, term, out) => {
        const frame = { rows: [VIEWPORT_FILL, 'hello', '> composer'] };
        screen.render(frame);
        const before = out().length;
        // Simulate a terminal resize (model + reported dimensions).
        Object.defineProperty(process.stdout, 'columns', { value: 50, configurable: true });
        term.resize(50, 8);
        screen.render(frame);
        assert.ok(!out().slice(before).includes('\x1b[3J'), 'pre-commit resize emitted 3J inside tmux');
    }, { tmux: true });
});

// F3: committed row must survive the fill shrinking through 1 to 0.
test('F3 repro: last committed row survives fill shrink 2→1→0', () => {
    withScreen((screen, term) => {
        // Frame: fill sentinel + 1 content row + composer → fill = 8-2 = 6.
        const frame = (contentRows: string[]): Frame => ({ rows: [VIEWPORT_FILL, ...contentRows, '> composer'] });
        screen.render(frame(['turn-1']));
        // Commit two lines through the fill region (fillRows=6 ≥ 2).
        assert.equal(screen.queueCommitLines(['committed-A', 'committed-B']), true);
        screen.render(frame(['turn-1']));
        assert.equal(screen.lastCommitFlushedCount(), 2);
        // Grow content so fill shrinks 6→2→1→0: each step scrolls committed rows up.
        screen.render(frame(['turn-1', 'l2', 'l3', 'l4', 'l5']));          // fill 2
        screen.render(frame(['turn-1', 'l2', 'l3', 'l4', 'l5', 'l6']));    // fill 1
        screen.render(frame(['turn-1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'])); // fill 0
        const everywhere = [...term.scrollback, ...term.visibleText().split('\n')].join('\n');
        assert.match(everywhere, /committed-A/, 'committed-A lost');
        assert.match(everywhere, /committed-B/, 'committed-B lost');
        const sb = term.scrollback.join('\n');
        assert.match(sb, /committed-A/, 'committed-A not in scrollback');
        assert.match(sb, /committed-B/, 'committed-B not in scrollback');
    });
});

// F4: fill regrowth between turns then shrink — no blank rows between
// committed content bands in scrollback.
test('F4 repro: no blank band stamped between committed turns', () => {
    withScreen((screen, term) => {
        const frame = (contentRows: string[]): Frame => ({ rows: [VIEWPORT_FILL, ...contentRows, '> composer'] });
        // Turn 1 renders 4 content rows (fill 8-5=3), commits them, then the
        // frontier hides them (frame shrinks to 0 content rows → fill 6).
        screen.render(frame(['t1-a', 't1-b', 't1-c', 't1-d']));
        assert.equal(screen.queueCommitLines(['t1-a', 't1-b', 't1-c', 't1-d']), true);
        screen.render(frame(['t1-a', 't1-b', 't1-c', 't1-d']));
        assert.equal(screen.lastCommitFlushedCount(), 4);
        // Frontier hides turn 1 → taller fill with the committed block inside it.
        screen.render(frame([]));
        // Turn 2 grows → fill shrinks → scroll-outs.
        screen.render(frame(['t2-a', 't2-b']));
        screen.render(frame(['t2-a', 't2-b', 't2-c', 't2-d']));
        assert.equal(screen.queueCommitLines(['t2-a', 't2-b', 't2-c', 't2-d']), true);
        screen.render(frame(['t2-a', 't2-b', 't2-c', 't2-d']));
        screen.render(frame([]));
        screen.render(frame(['t3-a', 't3-b', 't3-c', 't3-d', 't3-e', 't3-f']));
        const sb = term.scrollback.map(l => l.trimEnd());
        const first = sb.findIndex(l => l.startsWith('t1-'));
        const last = (() => { let k = -1; sb.forEach((l, i) => { if (/^t\d-/.test(l)) k = i; }); return k; })();
        const blanksBetween = first >= 0 && last > first ? sb.slice(first, last).filter(l => l === '').length : 0;
        assert.ok(blanksBetween <= 1, `blank band stamped into scrollback: ${blanksBetween} blanks between content`);
    });
});

// Audit trace: ONE committed row parked at the bottom of a 5-row fill (the
// unsaturated flush), then an overlay-style frame drops the fill to 0. The
// four blank rows above the block must be deleted in place, not stamped into
// scrollback ahead of the committed row.
test('F4 (unsaturated block): fill collapse pushes content only, never the blanks above it', () => {
    withScreen((screen, term) => {
        const frame = (contentRows: string[]): Frame => ({ rows: [VIEWPORT_FILL, ...contentRows, '> composer'] });
        screen.render(frame(['turn-1']));                    // fill = 8-2 = 6
        assert.equal(screen.queueCommitLines(['only-committed-row']), true);
        screen.render(frame(['turn-1']));
        assert.equal(screen.lastCommitFlushedCount(), 1);
        // Overlay-style full-height frame: no sentinel → fill 0.
        screen.render({ rows: ['ov1', 'ov2', 'ov3', 'ov4', 'ov5', 'ov6', 'ov7', 'ov8'] });
        const sb = term.scrollback.map(l => l.trimEnd());
        assert.ok(sb.includes('only-committed-row'), 'committed row lost');
        // Blank rows BETWEEN/AFTER content are the recurring blank-band bug and
        // must be zero. Blanks BEFORE the first committed row are the bounded
        // one-time lane-saturation push (≤ one per flushed line until the
        // history region saturates) — a session-start separator, not a band.
        const firstContent = sb.findIndex(l => l !== '');
        assert.equal(sb.slice(firstContent).filter(l => l === '').length, 0, `blanks after content: ${JSON.stringify(sb)}`);
        assert.ok(firstContent <= 1, `unbounded leading blanks: ${JSON.stringify(sb)}`);
    });
});

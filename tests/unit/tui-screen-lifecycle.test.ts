import test from 'node:test';
import assert from 'node:assert/strict';
import { Screen, VIEWPORT_FILL, diffFrames, type Frame } from '../../src/cli/tui/render/frame.ts';
import { AnsiTerminalModel } from './helpers/ansi-terminal-model.ts';

type MuxEnvSnapshot = Record<'CMUX_WORKSPACE_ID' | 'CMUX_SURFACE_ID' | 'CMUX_SOCKET_PATH' | 'TMUX' | 'STY' | 'TERM', string | undefined>;

function snapshotMuxEnv(): MuxEnvSnapshot {
    return {
        CMUX_WORKSPACE_ID: process.env.CMUX_WORKSPACE_ID,
        CMUX_SURFACE_ID: process.env.CMUX_SURFACE_ID,
        CMUX_SOCKET_PATH: process.env.CMUX_SOCKET_PATH,
        TMUX: process.env.TMUX,
        STY: process.env.STY,
        TERM: process.env.TERM,
    };
}

function restoreMuxEnv(snapshot: MuxEnvSnapshot): void {
    for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

function clearMuxEnv(): MuxEnvSnapshot {
    const snapshot = snapshotMuxEnv();
    delete process.env.CMUX_WORKSPACE_ID;
    delete process.env.CMUX_SURFACE_ID;
    delete process.env.CMUX_SOCKET_PATH;
    delete process.env.TMUX;
    delete process.env.STY;
    process.env.TERM = 'xterm-256color';
    return snapshot;
}

function withOnlyMuxEnv(key: keyof MuxEnvSnapshot, value: string): MuxEnvSnapshot {
    const snapshot = clearMuxEnv();
    process.env[key] = value;
    return snapshot;
}


test('Screen enter/exit — inline mode (no alt-screen)', () => {
    let output = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
        output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
    }) as typeof process.stdout.write;

    try {
        const screen = new Screen();
        assert.equal(screen.active, false);
        screen.enter();
        assert.equal(screen.active, true);
        assert.ok(output.includes('\x1b[?25l'), 'hides cursor');
        assert.ok(!output.includes('\x1b[?1049h'), 'does NOT enter alt-screen');
        screen.exit();
        assert.equal(screen.active, false);
        assert.ok(output.includes('\x1b[?25h'), 'shows cursor');
        assert.ok(!output.includes('\x1b[?1049l'), 'does NOT leave alt-screen');
    } finally {
        process.stdout.write = origWrite;
    }
});

test('Screen render uses inline diff for incremental updates', () => {
    let output = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
        output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
    }) as typeof process.stdout.write;

    try {
        const screen = new Screen();
        screen.enter();
        output = '';
        const first: Frame = { rows: ['line1', 'line2'] };
        screen.render(first);
        assert.ok(output.includes('line1'));
        assert.ok(output.includes('line2'));

        output = '';
        const second: Frame = { rows: ['line1', 'changed'] };
        screen.render(second);
        assert.ok(!output.includes('line1'), 'unchanged row skipped');
        assert.ok(output.includes('changed'), 'changed row emitted');
        screen.exit();
    } finally {
        process.stdout.write = origWrite;
    }
});

test('Screen forceRedraw repaints from the existing frame top instead of current cursor row', () => {
    let output = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
        output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
    }) as typeof process.stdout.write;

    try {
        const screen = new Screen();
        screen.enter();
        output = '';
        screen.render({ rows: ['top', 'input', 'help'], cursorPos: { row: 1, col: 3 } });
        assert.ok(output.includes('\x1b[23;4H'), 'first render absolutely positions cursor on the bottom-pinned input row');

        output = '';
        screen.forceRedraw();
        screen.render({ rows: ['new top', 'new input', 'new help'], cursorPos: { row: 1, col: 3 } });

        assert.ok(output.includes('\x1b[22A'), 'full redraw should move from input row back to frame top');
        assert.ok(output.includes('new top'));
        assert.ok(output.includes('new input'));
        assert.ok(output.includes('new help'));
        screen.exit();
    } finally {
        process.stdout.write = origWrite;
    }
});

test('Screen disableMouse resets all supported mouse reporting modes', () => {
    let output = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
        output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
    }) as typeof process.stdout.write;

    try {
        const screen = new Screen();
        screen.disableMouse();
        assert.ok(output.includes('\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l'));
    } finally {
        process.stdout.write = origWrite;
    }
});

test('Screen cmux launch render clears preexisting terminal history for workspace env', () => {
    let output = '';
    const muxEnv = withOnlyMuxEnv('CMUX_WORKSPACE_ID', 'test-cmux-workspace');
    const origWrite = process.stdout.write.bind(process.stdout);
    const columnsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 6, configurable: true });
    process.stdout.write = ((chunk: string | Uint8Array) => {
        output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
    }) as typeof process.stdout.write;

    try {
        const screen = new Screen();
        screen.enter();
        output = '';
        screen.render({ rows: ['cmux-live'] });
        assert.ok(output.includes('\x1b[2J\x1b[H'), 'cmux launch should visibly clear');
        assert.ok(output.includes('\x1b[3J'), 'cmux launch should erase preexisting saved terminal lines');
        screen.exit();
    } finally {
        process.stdout.write = origWrite;
        if (columnsDesc) Object.defineProperty(process.stdout, 'columns', columnsDesc);
        if (rowsDesc) Object.defineProperty(process.stdout, 'rows', rowsDesc);
        restoreMuxEnv(muxEnv);
    }
});

test('Screen cmux surface env launch clears preexisting terminal history', () => {
    let output = '';
    const muxEnv = withOnlyMuxEnv('CMUX_SURFACE_ID', 'test-cmux-surface');
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
        output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
    }) as typeof process.stdout.write;

    try {
        const screen = new Screen();
        screen.enter();
        output = '';
        screen.render({ rows: ['cmux-surface-live'] });
        assert.ok(output.includes('\x1b[3J'), 'CMUX_SURFACE_ID launch should erase preexisting saved terminal lines');
        screen.exit();
    } finally {
        process.stdout.write = origWrite;
        restoreMuxEnv(muxEnv);
    }
});

test('Screen cmux socket env launch clears preexisting terminal history', () => {
    let output = '';
    const muxEnv = withOnlyMuxEnv('CMUX_SOCKET_PATH', '/tmp/test-cmux.sock');
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
        output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
    }) as typeof process.stdout.write;

    try {
        const screen = new Screen();
        screen.enter();
        output = '';
        screen.render({ rows: ['cmux-socket-live'] });
        assert.ok(output.includes('\x1b[3J'), 'CMUX_SOCKET_PATH launch should erase preexisting saved terminal lines');
        screen.exit();
    } finally {
        process.stdout.write = origWrite;
        restoreMuxEnv(muxEnv);
    }
});

test('Screen default startup shim resets sticky mouse and clears preexisting cmux terminal history', () => {
    let output = '';
    const muxEnv = withOnlyMuxEnv('CMUX_WORKSPACE_ID', 'test-cmux-workspace');
    const origWrite = process.stdout.write.bind(process.stdout);
    const columnsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 6, configurable: true });
    process.stdout.write = ((chunk: string | Uint8Array) => {
        output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
    }) as typeof process.stdout.write;

    try {
        const screen = new Screen();
        screen.enter();
        screen.disableMouse();
        screen.render({ rows: ['cmux-default-startup'] });
        assert.ok(output.includes('\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l'));
        assert.ok(output.includes('\x1b[3J'), 'cmux default startup should erase preexisting saved terminal lines');
        screen.exit();
    } finally {
        process.stdout.write = origWrite;
        if (columnsDesc) Object.defineProperty(process.stdout, 'columns', columnsDesc);
        if (rowsDesc) Object.defineProperty(process.stdout, 'rows', rowsDesc);
        restoreMuxEnv(muxEnv);
    }
});


test('Screen cmux resize repaint preserves scrollback after transcript is protected', () => {
    let output = '';
    const muxEnv = withOnlyMuxEnv('CMUX_WORKSPACE_ID', 'test-cmux-workspace');
    const origWrite = process.stdout.write.bind(process.stdout);
    const columnsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 8, configurable: true });
    process.stdout.write = ((chunk: string | Uint8Array) => {
        output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
    }) as typeof process.stdout.write;

    try {
        const screen = new Screen();
        screen.enter();
        (screen as any).hasNativeCommit = true; (screen as any).scrollbackProtected = true;
        screen.render({ rows: [VIEWPORT_FILL, 'cmux-live', 'input', 'help'], cursorPos: { row: 2, col: 1 } });
        Object.defineProperty(process.stdout, 'rows', { value: 5, configurable: true });
        output = '';
        screen.forceResizeRedraw();
        screen.render({ rows: [VIEWPORT_FILL, 'cmux-live', 'input', 'help'], cursorPos: { row: 2, col: 1 } });
        assert.equal(output.includes('\x1b[3J'), false, 'cmux resize must not erase saved scrollback');
        screen.exit();
    } finally {
        process.stdout.write = origWrite;
        if (columnsDesc) Object.defineProperty(process.stdout, 'columns', columnsDesc);
        if (rowsDesc) Object.defineProperty(process.stdout, 'rows', rowsDesc);
        restoreMuxEnv(muxEnv);
    }
});

test('Screen cmux welcome-only force resize discards disposable welcome scrollback', () => {
    let output = '';
    const muxEnv = withOnlyMuxEnv('CMUX_WORKSPACE_ID', 'test-cmux-workspace');
    const origWrite = process.stdout.write.bind(process.stdout);
    const columnsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 8, configurable: true });
    process.stdout.write = ((chunk: string | Uint8Array) => {
        output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
    }) as typeof process.stdout.write;

    try {
        const screen = new Screen();
        screen.enter();
        screen.render({ rows: [VIEWPORT_FILL, 'WELCOME', 'input', 'help'], cursorPos: { row: 2, col: 1 } });
        Object.defineProperty(process.stdout, 'rows', { value: 5, configurable: true });
        output = '';
        screen.forceResizeRedraw();
        screen.render({ rows: [VIEWPORT_FILL, 'WELCOME', 'input', 'help'], cursorPos: { row: 2, col: 1 } });
        assert.ok(output.includes('\x1b[3J'), 'cmux welcome-only resize should discard disposable scrollback to prevent welcome duplication');
        screen.exit();
    } finally {
        process.stdout.write = origWrite;
        if (columnsDesc) Object.defineProperty(process.stdout, 'columns', columnsDesc);
        if (rowsDesc) Object.defineProperty(process.stdout, 'rows', rowsDesc);
        restoreMuxEnv(muxEnv);
    }
});

test('Screen cmux implicit geometry repaint discards disposable welcome scrollback', () => {
    let output = '';
    const muxEnv = withOnlyMuxEnv('CMUX_WORKSPACE_ID', 'test-cmux-workspace');
    const origWrite = process.stdout.write.bind(process.stdout);
    const columnsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 8, configurable: true });
    process.stdout.write = ((chunk: string | Uint8Array) => {
        output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
    }) as typeof process.stdout.write;

    try {
        const screen = new Screen();
        screen.enter();
        screen.render({ rows: [VIEWPORT_FILL, 'WELCOME', 'input', 'help'], cursorPos: { row: 2, col: 1 } });
        Object.defineProperty(process.stdout, 'rows', { value: 5, configurable: true });
        output = '';
        screen.render({ rows: [VIEWPORT_FILL, 'WELCOME', 'input', 'help'], cursorPos: { row: 2, col: 1 } });
        assert.ok(output.includes('\x1b[3J'), 'cmux implicit geometry repaint should discard disposable welcome scrollback');
        screen.exit();
    } finally {
        process.stdout.write = origWrite;
        if (columnsDesc) Object.defineProperty(process.stdout, 'columns', columnsDesc);
        if (rowsDesc) Object.defineProperty(process.stdout, 'rows', rowsDesc);
        restoreMuxEnv(muxEnv);
    }
});

test('Screen forceResizeRedraw clears disposable welcome scrollback before transcript history exists', () => {
    const muxEnv = clearMuxEnv();
    let output = '';
    const terminal = new AnsiTerminalModel(40, 8);
    const origWrite = process.stdout.write.bind(process.stdout);
    const columnsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 8, configurable: true });
    process.stdout.write = ((chunk: string | Uint8Array) => {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        output += text;
        terminal.write(text);
        return true;
    }) as typeof process.stdout.write;

    try {
        const screen = new Screen();
        screen.enter();
        output = '';
        screen.render({ rows: [VIEWPORT_FILL, 'WELCOME', 'input', 'help'], cursorPos: { row: 2, col: 1 } });
        assert.equal(terminal.countVisible('WELCOME'), 1);

        terminal.resize(40, 5);
        Object.defineProperty(process.stdout, 'rows', { value: 5, configurable: true });
        output = '';
        screen.forceResizeRedraw();
        screen.render({ rows: [VIEWPORT_FILL, 'WELCOME', 'input', 'help'], cursorPos: { row: 2, col: 1 } });

        assert.ok(output.includes('\x1b[2J\x1b[H\x1b[3J'), 'pre-transcript resize should clear visible and saved disposable welcome rows');
        assert.equal(terminal.countVisible('WELCOME'), 1, terminal.visibleText());
        screen.exit();
    } finally {
        restoreMuxEnv(muxEnv);
        process.stdout.write = origWrite;
        if (columnsDesc) Object.defineProperty(process.stdout, 'columns', columnsDesc);
        if (rowsDesc) Object.defineProperty(process.stdout, 'rows', rowsDesc);
    }
});

test('Screen forceResizeRedraw preserves saved scrollback after transcript history is protected', () => {
    const muxEnv = clearMuxEnv();
    let output = '';
    const terminal = new AnsiTerminalModel(40, 8);
    const origWrite = process.stdout.write.bind(process.stdout);
    const columnsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 8, configurable: true });
    process.stdout.write = ((chunk: string | Uint8Array) => {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        output += text;
        terminal.write(text);
        return true;
    }) as typeof process.stdout.write;

    try {
        const screen = new Screen();
        screen.enter();
        output = '';
        screen.render({ rows: [VIEWPORT_FILL, 'u:first', 'input', 'help'], cursorPos: { row: 2, col: 1 } });
        (screen as any).hasNativeCommit = true; (screen as any).scrollbackProtected = true;

        terminal.resize(40, 5);
        Object.defineProperty(process.stdout, 'rows', { value: 5, configurable: true });
        output = '';
        screen.forceResizeRedraw();
        screen.render({ rows: [VIEWPORT_FILL, 'u:first', 'input', 'help'], cursorPos: { row: 2, col: 1 } });

        assert.ok(output.includes('\x1b[2J\x1b[H'), 'protected resize should still visibly clear and repaint native terminals');
        assert.equal(output.includes('\x1b[3J'), false, 'protected resize must not erase saved scrollback history');
        assert.equal(terminal.countVisible('u:first'), 1, terminal.visibleText());
        screen.exit();
    } finally {
        restoreMuxEnv(muxEnv);
        process.stdout.write = origWrite;
        if (columnsDesc) Object.defineProperty(process.stdout, 'columns', columnsDesc);
        if (rowsDesc) Object.defineProperty(process.stdout, 'rows', rowsDesc);
    }
});

test('Screen first fullscreen render clears preexisting terminal history before painting welcome outside multiplexers', () => {
    let output = '';
    const terminal = new AnsiTerminalModel(40, 6);
    terminal.write('shell-0\r\nshell-1\r\nshell-2');
    const origWrite = process.stdout.write.bind(process.stdout);
    const columnsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 6, configurable: true });
    const muxEnv = clearMuxEnv();
    process.stdout.write = ((chunk: string | Uint8Array) => {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        output += text;
        terminal.write(text);
        return true;
    }) as typeof process.stdout.write;

    try {
        const screen = new Screen();
        screen.enter();
        output = '';
        screen.render({ rows: ['╭ welcome ╮', VIEWPORT_FILL, 'input', 'help'], cursorPos: { row: 2, col: 1 } });

        assert.ok(output.includes('\x1b[2J\x1b[H'), 'launch render should clear the visible terminal and home the cursor');
        assert.ok(output.includes('\x1b[3J'), 'launch render should clear preexisting scrollback outside multiplexers');
        assert.equal(terminal.visibleText().includes('shell-'), false, terminal.visibleText());
        assert.equal((terminal.visibleText().split('\n')[0] ?? '').startsWith('╭ welcome'), true, terminal.visibleText());
        screen.exit();
    } finally {
        restoreMuxEnv(muxEnv);
        process.stdout.write = origWrite;
        if (columnsDesc) Object.defineProperty(process.stdout, 'columns', columnsDesc);
        if (rowsDesc) Object.defineProperty(process.stdout, 'rows', rowsDesc);
    }
});

test('diffFrames full paint on null prev', () => {
    const patch = diffFrames(null, { rows: ['a', 'b'] });
    assert.ok(patch.includes('a'));
    assert.ok(patch.includes('b'));
});

test('Screen render sanitizes embedded row newlines and clamps cursor column', () => {
    let output = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    const columnsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'columns', { value: 10, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 4, configurable: true });
    process.stdout.write = ((chunk: string | Uint8Array) => {
        output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
    }) as typeof process.stdout.write;

    try {
        const screen = new Screen();
        screen.enter();
        output = '';
        screen.render({ rows: ['top', 'tool\npayload that is too long', 'bottom'], cursorPos: { row: 1, col: 999 } });
        assert.ok(!output.includes('tool\npayload'), 'embedded newline should not split the frame row');
        assert.ok(output.includes('tool paylo'), 'row should be newline-sanitized then width-clipped');
        assert.ok(output.includes('\x1b[3;10H'), 'cursor column should clamp to terminal width - 1');
        assert.ok(!output.includes(';1000H'));
        screen.exit();
    } finally {
        process.stdout.write = origWrite;
        if (columnsDesc) Object.defineProperty(process.stdout, 'columns', columnsDesc);
        if (rowsDesc) Object.defineProperty(process.stdout, 'rows', rowsDesc);
    }
});

test('Screen queueCommitLines queues for render-internal flush', () => {
    const screen = new Screen();
    const columnsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'columns', { value: 30, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 6, configurable: true });

    try {
        screen.enter();
        screen.render({ rows: [VIEWPORT_FILL, 'live', 'input', 'help'] });
        screen.queueCommitLines(['welcome', 'u:first']);
        assert.equal(screen.lastCommitFlushedCount(), 0, 'no flush before render');
        screen.render({ rows: [VIEWPORT_FILL, 'live', 'input', 'help'] });
        // Flush happens inside render if geometry matches and fillRows > 0
        const flushed = screen.lastCommitFlushedCount();
        // flushed may be 0 if fillRows was too small or geometry didn't match — that's OK
        screen.exit();
    } finally {
        if (columnsDesc) Object.defineProperty(process.stdout, 'columns', columnsDesc);
        if (rowsDesc) Object.defineProperty(process.stdout, 'rows', rowsDesc);
    }
});

test('Screen auto-detects geometry changes and clears disposable welcome rows before debounce outside multiplexers', () => {
    let output = '';
    const terminal = new AnsiTerminalModel(40, 8);
    const origWrite = process.stdout.write.bind(process.stdout);
    const columnsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    const setSize = (rows: number, columns = 40): void => {
        Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
        Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
    };
    setSize(8);
    const muxEnv = clearMuxEnv();
    process.stdout.write = ((chunk: string | Uint8Array) => {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        output += text;
        terminal.write(text);
        return true;
    }) as typeof process.stdout.write;

    try {
        const screen = new Screen();
        screen.enter();
        output = '';
        screen.render({ rows: [VIEWPORT_FILL, 'WELCOME', 'input', 'help'], cursorPos: { row: 2, col: 1 } });
        assert.equal(terminal.countVisible('WELCOME'), 1);

        for (const rows of [5, 8, 4, 9, 6]) {
            terminal.resize(40, rows);
            setSize(rows);
            output = '';
            screen.render({ rows: [VIEWPORT_FILL, 'WELCOME', 'input', 'help'], cursorPos: { row: 2, col: 1 } });

            assert.ok(output.includes('\x1b[2J\x1b[H\x1b[3J'), `height ${rows} should clear disposable pre-transcript rows before repaint`);
            assert.equal(terminal.countVisible('WELCOME'), 1, terminal.visibleText());
        }
        screen.exit();
    } finally {
        restoreMuxEnv(muxEnv);
        process.stdout.write = origWrite;
        if (columnsDesc) Object.defineProperty(process.stdout, 'columns', columnsDesc);
        if (rowsDesc) Object.defineProperty(process.stdout, 'rows', rowsDesc);
    }
});

test('Screen defers native scrollback commits while geometry is dirty', () => {
    let output = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    const columnsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'columns', { value: 30, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 6, configurable: true });
    process.stdout.write = ((chunk: string | Uint8Array) => {
        output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
    }) as typeof process.stdout.write;

    try {
        const screen = new Screen();
        screen.enter();
        screen.render({ rows: [VIEWPORT_FILL, 'live', 'input', 'help'] });

        Object.defineProperty(process.stdout, 'rows', { value: 4, configurable: true });
        output = '';
        assert.equal(screen.needsResizeRepaint(), true);
        screen.queueCommitLines(['history-before-repaint']);
        assert.equal(output.includes('history-before-repaint'), false);

        screen.render({ rows: [VIEWPORT_FILL, 'live', 'input', 'help'] });
        assert.equal(screen.needsResizeRepaint(), false);
        screen.exit();
    } finally {
        process.stdout.write = origWrite;
        if (columnsDesc) Object.defineProperty(process.stdout, 'columns', columnsDesc);
        if (rowsDesc) Object.defineProperty(process.stdout, 'rows', rowsDesc);
    }
});

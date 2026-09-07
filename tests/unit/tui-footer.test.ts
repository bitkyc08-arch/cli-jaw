import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { formatFooter } from '../../bin/commands/tui/types.ts';
import { renderStatusBar } from '../../src/cli/tui/presentation.ts';
import { visualWidth } from '../../src/cli/tui/renderers.ts';

const ACCENT = '\x1b[31m';

function withColumns<T>(cols: number, fn: () => T): T {
    const columnsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
    try {
        return fn();
    } finally {
        if (columnsDesc) Object.defineProperty(process.stdout, 'columns', columnsDesc);
    }
}

test('idle footer shows a dimmed idle state + hints + label', () => {
    const f = formatFooter('codex', ACCENT, 'idle');
    assert.ok(f.includes('codex'));
    assert.ok(f.includes('idle'));
    assert.ok(f.includes('/quit'));
    assert.ok(f.includes('/clear'));
});

test('responding footer uses the accent + state label', () => {
    const f = formatFooter('codex', ACCENT, 'responding');
    assert.ok(f.includes('responding…'));
    assert.ok(f.includes(ACCENT));
});

test('tool footer shows a working state', () => {
    assert.ok(formatFooter('x', ACCENT, 'tool').includes('working…'));
});

test('elapsed is rendered when provided and > 0', () => {
    assert.ok(formatFooter('x', ACCENT, 'responding', 4200).includes('4.2s'));
    assert.ok(!formatFooter('x', ACCENT, 'idle', 0).includes('s  |')); // no elapsed at 0
});

test('bgtask count renders magenta hourglass segment only when > 0', () => {
    const withTasks = formatFooter('x', ACCENT, 'idle', 0, 2);
    assert.ok(withTasks.includes('⏳2'));
    assert.ok(withTasks.includes('\x1b[35m'), 'magenta color for bgtask segment');
    assert.ok(!formatFooter('x', ACCENT, 'idle', 0, 0).includes('⏳'));
    assert.ok(!formatFooter('x', ACCENT, 'idle').includes('⏳'), 'omitted param stays clean');
});

test('renderStatusBar renders cyan segmented status row with local presentation', () => {
    const row = withColumns(96, () => renderStatusBar({
        model: 'test-model',
        engine: 'codex',
        engineAccent: ACCENT,
        state: 'working…',
        elapsed: '1.2s',
        bgtask: 2,
        gitBranch: 'dev',
        cwd: '~/project',
        port: 3457,
    }));
    assert.match(row, /\x1b\[(36|46)m/);
    assert.match(row, /test-model/);
    assert.match(row, /codex/);
    assert.match(row, /working/);
    assert.match(row, /\/quit/);
    assert.match(row, /\/clear/);
    assert.doesNotMatch(row, /Context/);
    assert.doesNotMatch(row, /token/i);
    assert.doesNotMatch(row, /\d+(?:\.\d+)?%/);
});

test('renderStatusBar clips optional details under narrow width', () => {
    const row = withColumns(36, () => renderStatusBar({
        model: 'very-long-model-name',
        engine: 'codex',
        engineAccent: ACCENT,
        state: 'responding…',
        elapsed: '123.4s',
        bgtask: 9,
        gitBranch: 'feature/some-long-branch',
        cwd: '~/Developer/new/700_projects/cli-jaw',
        port: 3457,
    }));
    assert.match(row, /\x1b\[(36|46)m/);
    assert.match(row, /\/quit/);
    assert.doesNotMatch(row, /Context/);
    assert.doesNotMatch(row, /token/i);
    assert.doesNotMatch(row, /\d+(?:\.\d+)?%/);
});

test('renderStatusBar keeps emoji-heavy working rows within terminal width', () => {
    const row = withColumns(72, () => renderStatusBar({
        model: 'claude-opus-4-6',
        engine: 'Claude E',
        engineAccent: ACCENT,
        state: 'working…',
        elapsed: '1.9s',
        bgtask: 3,
        gitBranch: 'feature/very-long-active-branch',
        cwd: '/Users/jun/Developer/new/700_projects/cli-jaw',
        port: 3457,
    }));

    assert.ok(visualWidth(row) <= 72, `status row width ${visualWidth(row)} exceeds terminal width`);
    assert.match(row, /\/quit/);
});

test('local status segments fit narrow columns without splitting styled graphemes', () => {
    for (const columns of [20, 24, 36, 72, 96]) {
        const row = withColumns(columns, () => renderStatusBar({
            model: '한글👩‍💻e\u0301🇰🇷', engine: 'codex', engineAccent: ACCENT,
            state: 'working…', elapsed: '3.1s', bgtask: 2, bgtaskAttention: true, port: 3457,
        }));
        const plain = stripVTControlCharacters(row);
        assert.ok(visualWidth(row) <= columns, `${columns} columns: ${visualWidth(row)}`);
        assert.ok(!plain.includes('\x1b'));
        if (plain.includes('👩')) assert.ok(plain.includes('👩‍💻'));
        if (plain.includes('🇰')) assert.ok(plain.includes('🇰🇷'));
        if (columns >= 72) {
            assert.ok(plain.includes('한글👩‍💻e\u0301🇰🇷'));
            assert.ok(plain.includes('3.1s'));
            assert.ok(plain.includes('⏳2!'));
        }
    }
});

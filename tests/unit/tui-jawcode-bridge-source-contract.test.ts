import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToolLine, renderWelcome } from '../../src/cli/tui/jawcode-bridge.ts';
import { visualWidth } from '../../src/cli/tui/renderers.ts';

const source = readFileSync(new URL('../../src/cli/tui/jawcode-bridge.ts', import.meta.url), 'utf8');

test('renderToolLine preserves one-line completed tool detail and folds multiline detail', () => {
    assert.match(source, /const detailLines = detail\.split\('\\n'\)/);
    assert.match(source, /const firstDetail = detailLines\[0\]/);
    assert.match(source, /\$\{firstDetail\} … \+\$\{detailLines\.length - 1\} lines/);

    const singleLine = renderToolLine('🔧', 'Bash', 'npm test', 'done');
    assert.match(singleLine, /npm test/);

    const multiLine = renderToolLine('🔧', 'Bash', 'npm test\nsecond line', 'done');
    assert.match(multiLine, /npm test/);
    assert.match(multiLine, /\+1 lines/);
    assert.doesNotMatch(multiLine, /second line/);
});

test('renderToolLine folds multiline detail in every state — headers never carry raw newlines (jawcode 036d1ab parity)', () => {
    for (const state of ['pending', 'error'] as const) {
        const multiLine = renderToolLine('🔧', 'Bash', 'first line\nsecond line\nthird line', state);
        assert.doesNotMatch(multiLine, /\n/, `${state} header must be a single row`);
        assert.match(multiLine, /first line/);
        assert.match(multiLine, /\+2 lines/);
        assert.doesNotMatch(multiLine, /second line/);

        const singleLine = renderToolLine('🔧', 'Bash', 'npm test', state);
        assert.match(singleLine, /: npm test/);
    }
});

test('renderToolLine does not duplicate event emoji before the tool label', () => {
    assert.match(source, /renderToolLine\(_icon: string, label: string/);
    assert.doesNotMatch(source, /\$\{icon\} \$\{label\}/);
    assert.match(source, /theme\.bold\(label\)/);

    const rendered = renderToolLine('🔧', 'Bash', 'npm test', 'done');
    assert.match(rendered, /✔/);
    assert.match(rendered, /Bash/);
    assert.doesNotMatch(rendered, /🔧/);
});

test('renderWelcome clips long project rows to the terminal width', () => {
    const columnsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
    try {
        const lines = renderWelcome({
            version: '2.1.3',
            engine: 'Codex',
            engineAccent: '',
            model: 'gpt-5.5',
            directory: '/tmp/project',
            serverPort: 3457,
            projectRoot: '/Users/jun/Developer/new/700_projects/jawcode/some/extremely/long/project/path',
            gitBranch: 'dev',
            port: 3457,
        });

        assert.ok(lines.length > 0);
        assert.equal(lines.every(line => visualWidth(line) <= 80), true, lines.map(visualWidth).join(','));
    } finally {
        if (columnsDesc) Object.defineProperty(process.stdout, 'columns', columnsDesc);
        if (rowsDesc) Object.defineProperty(process.stdout, 'rows', rowsDesc);
    }
});

test('status bar left segment stays readable on its cyan background', async () => {
    const { renderStatusBar } = await import('../../src/cli/tui/jawcode-bridge.ts');
    const row = renderStatusBar({
        model: 'claude-fable-5',
        engine: 'jwc',
        engineAccent: '\x1b[36m',
        state: 'idle',
        cwd: '/tmp/project',
        port: 3457,
    });
    const segStart = row.indexOf('\x1b[46m\x1b[30m');
    assert.ok(segStart >= 0, 'left segment must open with cyan background + black foreground');
    const segBody = row.slice(segStart, row.indexOf('claude-fable-5') + 'claude-fable-5'.length);
    assert.equal(segBody.includes('\x1b[0m'), false, 'no full reset before the model name — it would drop the segment background');
    assert.equal(segBody.includes('\x1b[36m'), false, 'no cyan foreground inside the cyan segment (unreadable in dark mode)');
    assert.equal(segBody.includes('\x1b[38;'), false, 'no theme foreground colors inside the segment');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { renderToolLine, renderToolBlock, renderThinkingCollapse, renderSubagentTree, renderWelcome } from '../../src/cli/tui/presentation.ts';
import { visualWidth } from '../../src/cli/tui/renderers.ts';


test('renderToolLine preserves one-line completed tool detail and folds multiline detail', () => {

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
            projectRoot: '/Users/jun/Developer/new/700_projects/cli-jaw/some/extremely/long/project/path',
            gitBranch: 'dev',
            port: 3457,
        });

        assert.ok(lines.length > 0);
        assert.equal(lines.every(line => visualWidth(line) <= 80), true, lines.map(visualWidth).join(','));
    } finally {
        if (columnsDesc) Object.defineProperty(process.stdout, 'columns', columnsDesc);
        else Reflect.deleteProperty(process.stdout, 'columns');
        if (rowsDesc) Object.defineProperty(process.stdout, 'rows', rowsDesc);
        else Reflect.deleteProperty(process.stdout, 'rows');
    }
});

test('status bar left segment stays readable on its cyan background', async () => {
    const { renderStatusBar } = await import('../../src/cli/tui/presentation.ts');
    const row = renderStatusBar({
        model: 'claude-fable-5',
        engine: 'codex',
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

test('local tool rows preserve tree depth, sibling endings and elapsed time in every state', () => {
    const cases = [
        ['pending', '⏳'], ['done', '✔'], ['error', '✖'],
    ] as const;
    for (const [state, icon] of cases) {
        assert.equal(stripVTControlCharacters(renderToolLine('', 'Read', '한글', state, {
            depth: 2, isLast: false, elapsed: '1.2s',
        })), `    ├─ ${icon} Read: 한글 1.2s`);
        assert.equal(stripVTControlCharacters(renderToolLine('', 'Read', '', state, {
            depth: 1, isLast: true, elapsed: '30m15s',
        })), `  └─ ${icon} Read 30m15s`);
        assert.equal(stripVTControlCharacters(renderToolLine('', 'Read', '', state)), `  ${icon} Read`);
    }
});

test('expanded tool blocks keep nesting/time and clip ANSI CJK detail at whole graphemes', () => {
    const rows = renderToolBlock('Read', '\x1b[31m한글👩‍💻끝\x1b[0m\nsecond', 'done', {
        depth: 1, isLast: true, elapsed: '1.2s', collapsed: false, width: 13,
    });
    const plain = rows.map(stripVTControlCharacters);
    assert.equal(plain[1], '    │ 한글👩‍💻…');
    assert.equal(plain[2], '    │ second');
    assert.ok(rows.every(row => visualWidth(row) <= 13 && !row.includes('\n')));
    assert.equal(stripVTControlCharacters(renderToolBlock('Read', 'detail', 'done', {
        depth: 1, isLast: true, elapsed: '1.2s', collapsed: false, width: 60,
    })[0]!), '  └─ ✔ Read 1.2s');
});

test('subagents render their status, descendants, model and elapsed time without initialization', () => {
    const rows = renderSubagentTree([
        { name: '분석', status: 'running', elapsed: '2.5s', model: 'native-model', description: '검토',
            children: [{ label: 'Read', detail: 'src/a.ts' }, { label: 'Search' }] },
        { name: '완료', status: 'completed', elapsed: '1m2s', children: [{ label: 'Result', detail: 'ready' }] },
        { name: '오류', status: 'failed' },
        { name: '대기', status: 'pending' },
    ], 80).map(stripVTControlCharacters);
    assert.deepEqual(rows, [
        '  ├─ ⏳ 분석 2.5s',
        '  │  Description: 검토',
        '  │  Agent: native-model',
        '  │  ├─ Read: src/a.ts',
        '  │  └─ Search',
        '  ├─ ✔ 완료 1m2s',
        '  │  └─ Result: ready',
        '  ├─ ✖ 오류',
        '  └─ ① 대기',
    ]);
    assert.deepEqual(renderSubagentTree([]), []);
});

test('subagent rows wrap CJK, combining marks and emoji without losing content', () => {
    const rows = renderSubagentTree([{
        name: '한글👩‍💻e\u0301🇰🇷', status: 'completed',
        description: '첫줄\n둘째줄', children: [{ label: '읽기', detail: '가나다라마바사' }],
    }], 12);
    assert.ok(rows.every(row => visualWidth(row) <= 12 && !row.includes('\n')));
    const plain = rows.map(stripVTControlCharacters).join('');
    assert.ok(plain.includes('한글👩‍💻e\u0301🇰🇷'));
    assert.ok(plain.includes('첫줄둘째줄'));
    assert.ok(plain.includes('가나다라마바사'));
});

test('local reasoning collapse preserves expanded text and the collapsed line count', () => {
    assert.equal(stripVTControlCharacters(renderThinkingCollapse('first\nsecond', 2, false)), '  Thinking … +2 lines');
    assert.equal(stripVTControlCharacters(renderThinkingCollapse('first\nsecond', 2, true)), '  first\nsecond');
});

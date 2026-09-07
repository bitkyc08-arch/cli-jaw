import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMarkdown } from '../../src/cli/tui/markdown.ts';
import { createStreamSink } from '../../src/cli/tui/stream.ts';
import { renderTranscriptItem } from '../../bin/commands/tui/fullscreen-mode.ts';
import { visualWidth } from '../../src/cli/tui/renderers.ts';
import { createTranscriptState } from '../../src/cli/tui/transcript.ts';
import { appendActivityAnswer } from '../../src/cli/tui/activity-answer.ts';

test('presentation starts in an empty home with retired module resolution forbidden', () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-jaw-tui-local-'));
    // Exercise module loading, not source spelling. Even an optional catch cannot
    // hide a retired-module attempt: the hook records it in a separate receipt.
    const loader = `
        import { appendFileSync } from 'node:fs';
        let receipt;
        export function initialize(data) { receipt = data.receipt; }
        export async function resolve(specifier, context, nextResolve) {
            const normalized = specifier.replaceAll('\\\\', '/');
            const filename = normalized.split('/').at(-1);
            if (normalized === 'jawcode' || normalized.startsWith('jawcode/')
                || normalized.startsWith('@jawcode') || normalized.startsWith('@gajae-code/')
                || normalized.includes('/node_modules/jawcode/') || normalized.includes('/lib/tui/')
                || normalized.startsWith('bun:') || filename.startsWith('bun-shim.')
                || filename.startsWith('jawcode-bridge.') || filename.startsWith('jawcode-render.')
                || filename.startsWith('jawcode-tui-bundle.') || filename.startsWith('jawcode-interactive-bundle.')
                || filename.startsWith('pi_natives.')) {
                appendFileSync(receipt, specifier + '\\n');
                throw new Error('Retired presentation dependency: ' + specifier);
            }
            return nextResolve(specifier, context);
        }
    `;
    const script = `
        import { register } from 'node:module';
        import assert from 'node:assert/strict';
        import { existsSync } from 'node:fs';
        import { stripVTControlCharacters } from 'node:util';
        const receipt = ${JSON.stringify(join(home, 'retired-imports'))};
        register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(loader)}), {
            parentURL: import.meta.url, data: { receipt },
        });
        const presentation = await import(${JSON.stringify(new URL('../../src/cli/tui/presentation.ts', import.meta.url).href)});
        const { createStreamSink } = await import(${JSON.stringify(new URL('../../src/cli/tui/stream.ts', import.meta.url).href)});
        const welcome = presentation.renderWelcome({ version: 'test', engine: 'Codex', engineAccent: '',
            model: 'model', directory: ${JSON.stringify(home)}, serverPort: 3457 });
        assert.ok(welcome.some(row => row.includes('Codex')));
        assert.ok(presentation.renderToolBlock('Read', 'local', 'done').length);
        assert.ok(presentation.renderSubagentTree([{ name: 'child', status: 'running' }]).length);
        let output = '';
        const sink = createStreamSink({ write: chunk => output += chunk, width: 40 });
        sink.push('**local answer**'); sink.end();
        assert.equal(stripVTControlCharacters(output).trim(), 'local answer');
        assert.equal(existsSync(receipt), false, 'no retired import was attempted');
        assert.equal(existsSync(${JSON.stringify(join(home, '.jwc'))}), false);
        console.log('local-presentation-ready');
    `;
    try {
        const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script], {
            cwd: home,
            env: { ...process.env, HOME: home, USERPROFILE: home, CLI_JAW_HOME: home, NO_COLOR: '1' },
            encoding: 'utf8', timeout: 20_000,
        });
        assert.equal(child.error, undefined);
        assert.equal(child.status, 0, child.stderr);
        assert.equal(child.stdout.trim(), 'local-presentation-ready');
    } finally { rmSync(home, { recursive: true, force: true }); }
});

// These are ordinary local renderer calls: no optional module initialization,
// native-addon skip, or fake theme. The same layer serves fullscreen and line mode.
test('local Markdown renders headings, lists, fenced code and CJK tables', () => {
    const out = stripVTControlCharacters(renderMarkdown(
        '## Title\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n\n| 이름 | 값 |\n|---|---|\n| 한글 | 2 |',
        { width: 60, gutter: '  ' },
    ));
    assert.ok(out.includes('## Title'));
    assert.ok(out.includes('• one'));
    assert.ok(out.includes('• two'));
    assert.ok(out.includes('const x = 1;'));
    assert.ok(out.includes('┌') && out.includes('└'));
    assert.ok(out.includes('이름  값'));
    assert.ok(out.includes('한글  2'));
    assert.ok(out.includes('────  ──'));
});

test('local final Markdown remains deterministic and needs no initialization', () => {
    const text = '**완료** 👩‍💻 e\u0301 🇰🇷';
    const first = renderTranscriptItem({ type: 'assistant', text, streaming: false, timestamp: 1 }, 60);
    const second = renderTranscriptItem({ type: 'assistant', text, streaming: false, timestamp: 1 }, 60);
    assert.deepEqual(second, first);
    const out = stripVTControlCharacters(first.join('\n'));
    assert.equal(out.trim(), '완료 👩‍💻 e\u0301 🇰🇷');
    assert.ok(first.join('').includes('\x1b[1m완료'));
    assert.ok(!out.includes('▍'));
    assert.ok(first.every(row => visualWidth(row) <= 60));
});

test('line sink buffers incomplete fences, honors its gutter, and flushes final Markdown once', () => {
    const chunks: string[] = [];
    const sink = createStreamSink({ write: text => chunks.push(text), width: 40, gutter: '> ' });
    sink.push('## Start\n\n');
    assert.equal(chunks.length, 1);
    assert.ok(stripVTControlCharacters(chunks[0]!).includes('> ## Start'));
    sink.push('```ts\nconst value = "한글";\n');
    assert.equal(chunks.length, 1, 'unfinished fenced block remains buffered');
    sink.push('```\n');
    assert.equal(chunks.length, 2, 'a closed fence is a commit boundary');
    sink.push('**마지막** 👩‍💻 e\u0301 🇰🇷');
    assert.equal(chunks.length, 2);
    sink.end();
    assert.equal(chunks.length, 3);
    const out = stripVTControlCharacters(chunks.join(''));
    assert.ok(out.includes('const value = "한글";'));
    assert.ok(out.includes('> 마지막 👩‍💻 e\u0301 🇰🇷'));
    assert.equal(out.split('마지막').length - 1, 1);
    assert.equal(out.split('┌').length - 1, 1);
    assert.equal(out.split('└').length - 1, 1);
    sink.end();
    assert.equal(chunks.length, 3, 'repeat terminal cleanup cannot duplicate the answer');
});

test('fullscreen final answer uses local Markdown after streaming ends', () => {
    const text = '## Result\n\n**한글** 👩‍💻 e\u0301\n\n| A | B |\n|---|---|\n| 1 | 2 |';
    const item = { type: 'assistant' as const, text, streaming: true, timestamp: 1 };
    assert.deepEqual(renderTranscriptItem(item, 60).map(stripVTControlCharacters), [
        '', '  ## Result', '  한글 👩‍💻 e\u0301', '  A  B', '  ─  ─', '  1  2 ▍', '',
    ], 'the cursor must remain visible without becoming an extra Markdown table cell');
    item.streaming = false;
    const rows = renderTranscriptItem(item, 60);
    assert.deepEqual(rows.map(stripVTControlCharacters), [
        '', '  ## Result', '  한글 👩‍💻 e\u0301', '  A  B', '  ─  ─', '  1  2', '',
    ]);
    assert.ok(rows.every(row => !row.includes('\n') && visualWidth(row) <= 60));
});

test('streaming cursor cannot turn a closed code fence into code content', () => {
    const item = { type: 'assistant' as const, text: '```ts\nconst x = 1;\n```', streaming: true, timestamp: 1 };
    const rows = renderTranscriptItem(item, 30);
    assert.deepEqual(rows.map(stripVTControlCharacters), [
        '  ┌─ ts ' + '─'.repeat(19) + '┐',
        '    const x = 1;',
        '  └' + '─'.repeat(24) + '┘ ▍',
        '',
    ]);
    assert.ok(rows.every(row => visualWidth(row) <= 30));
    item.streaming = false;
    assert.deepEqual(renderTranscriptItem(item, 30).map(stripVTControlCharacters), [
        '  ┌─ ts ' + '─'.repeat(19) + '┐',
        '    const x = 1;',
        '  └' + '─'.repeat(24) + '┘',
        '',
    ]);
});

test('plain streaming text keeps one cursor and settles without changing graphemes', () => {
    const item = { type: 'assistant' as const, text: '**완료** 👩‍💻 e\u0301', streaming: true, timestamp: 1 };
    assert.deepEqual(renderTranscriptItem(item, 30).map(stripVTControlCharacters), ['  완료 👩‍💻 e\u0301 ▍', '']);
    item.streaming = false;
    assert.deepEqual(renderTranscriptItem(item, 30).map(stripVTControlCharacters), ['  완료 👩‍💻 e\u0301', '']);
});

test('a full CJK row sends the cursor to the next physical row without clipping content', () => {
    const item = { type: 'assistant' as const, text: '가'.repeat(14), streaming: true, timestamp: 1 };
    const rows = renderTranscriptItem(item, 30);
    assert.deepEqual(rows.map(stripVTControlCharacters), ['  ' + '가'.repeat(14), '  ▍', '']);
    assert.deepEqual(rows.map(visualWidth), [30, 3, 0]);
    item.streaming = false;
    assert.deepEqual(renderTranscriptItem(item, 30).map(stripVTControlCharacters), ['  ' + '가'.repeat(14), '']);
});

test('an empty streaming answer renders a cursor even in a one-cell viewport', () => {
    const item = { type: 'assistant' as const, text: '', streaming: true, timestamp: 1 };
    assert.deepEqual(renderTranscriptItem(item, 30).map(stripVTControlCharacters), ['  ▍']);
    assert.deepEqual(renderTranscriptItem(item, 1).map(stripVTControlCharacters), ['▍']);
});

test('saved native Activity content stays literal and receives no streaming decoration', () => {
    const state = createTranscriptState();
    appendActivityAnswer(state, 'native-answer', { finalText: '**native** 👩‍💻', status: 'done' }, 'saved');
    const rows = renderTranscriptItem(state.items[0]!, 30);
    assert.deepEqual(rows.map(stripVTControlCharacters), ['  Answer', '  **native** 👩‍💻']);
});

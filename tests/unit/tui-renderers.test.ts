import test from 'node:test';
import assert from 'node:assert/strict';
import { clipTextToCols, visualWidth, wrapTextToCols } from '../../src/cli/tui/renderers.ts';

test('visualWidth ignores ANSI escape codes', () => {
    assert.equal(visualWidth('\x1b[31mabc\x1b[0m'), 3);
});

test('visualWidth counts Hangul as double-width', () => {
    assert.equal(visualWidth('가a'), 3);
});

test('visualWidth counts emoji as double-width and variation selectors as zero-width', () => {
    assert.equal(visualWidth('⏳'), 2);
    assert.equal(visualWidth('🦈'), 2);
    assert.equal(visualWidth('✔️'), 2);
    assert.equal(visualWidth('✔︎'), 1);
});

test('clipTextToCols respects visual width for mixed-width text', () => {
    assert.equal(clipTextToCols('가나다abc', 5), '가나');
    assert.equal(clipTextToCols('가나다abc', 6), '가나다');
    assert.equal(clipTextToCols('가나다abc', 7), '가나다a');
});

test('clipTextToCols keeps emoji-heavy rows inside visual width', () => {
    const clipped = clipTextToCols('⏳ subagent: Verify estimateTokens callers: prompt with long detail 🦈 📁', 32);
    assert.ok(visualWidth(clipped) <= 32);
});

test('clipTextToCols preserves complete ANSI sequences and resets after clipping', () => {
    const clipped = clipTextToCols('\x1b[36mabcdef\x1b[0m', 3);
    assert.equal(clipped, '\x1b[36mabc\x1b[0m');
    assert.equal(visualWidth(clipped), 3);
});

test('clipTextToCols drops incomplete ANSI control sequences', () => {
    assert.equal(clipTextToCols('abc\x1b[', 10), 'abc');
});

test('wrapTextToCols wraps long ASCII lines into newline-free rows', () => {
    const rows = wrapTextToCols('abcdefghijklmnop', 5);
    assert.deepEqual(rows, ['abcde', 'fghij', 'klmno', 'p']);
    assert.equal(rows.some(row => row.includes('\n')), false);
    assert.ok(rows.every(row => visualWidth(row) <= 5));
});

test('wrapTextToCols preserves explicit newlines as separate physical rows', () => {
    const rows = wrapTextToCols('abc\ndefgh', 3);
    assert.deepEqual(rows, ['abc', 'def', 'gh']);
    assert.equal(rows.some(row => row.includes('\n')), false);
});

test('wrapTextToCols respects CJK visual width', () => {
    const rows = wrapTextToCols('가나다abc', 5);
    assert.deepEqual(rows, ['가나', '다abc']);
    assert.ok(rows.every(row => visualWidth(row) <= 5));
});

test('wrapTextToCols carries ANSI SGR styling to continuation rows', () => {
    const rows = wrapTextToCols('\x1b[36mabcdef\x1b[0m', 3);
    assert.deepEqual(rows, ['\x1b[36mabc\x1b[0m', '\x1b[36mdef\x1b[0m']);
    assert.ok(rows.every(row => visualWidth(row) <= 3));
});

test('measurement clipping and wrapping preserve complete emoji and decomposed Hangul clusters', () => {
    for (const text of ['👩‍💻', '👨‍👩‍👧‍👦', '👍🏽', '🇰🇷', '1️⃣', '한']) {
        assert.equal(visualWidth(text), 2, text);
        assert.equal(clipTextToCols(`A${text}B`, 4), `A${text}B`);
        assert.equal(clipTextToCols(`A${text}B`, 2), 'A');
        assert.deepEqual(wrapTextToCols(`A${text}B`, 3), [`A${text}`, 'B']);
    }
    assert.equal(visualWidth('a\u1ab0'), 1);
    assert.equal(visualWidth('\u200b'), 0);
    assert.equal(visualWidth('क्ष'), 2);
});

test('CSI within a grapheme keeps its original order without splitting that grapheme', () => {
    const input = 'A\x1b[31m👩\x1b[1m‍💻\x1b[0mB';
    const clipped = clipTextToCols(input, 3);
    assert.equal(clipped.replace(/\x1b\[[0-9;]*m/g, ''), 'A👩‍💻');
    assert.ok(clipped.indexOf('\x1b[31m') < clipped.indexOf('\x1b[1m'));
    assert.ok(clipped.endsWith('\x1b[0m'));
    assert.equal(visualWidth(input), 4);
});

test('styled processing segments visible input linearly, even with dense CSI in one long cluster', t => {
    const original = Intl.Segmenter.prototype.segment;
    let volume = 0;
    const spy = t.mock.method(Intl.Segmenter.prototype, 'segment', function (this: Intl.Segmenter, input: string) {
        volume += input.length;
        return original.call(this, input);
    });
    try {
        for (const input of ['\x1b[31ma'.repeat(2000), 'e' + '\x1b[31m\u0301'.repeat(2000)]) {
            volume = 0;
            const plain = input.replace(/\x1b\[[0-9;]*m/g, '');
            const out = clipTextToCols(input, 4000);
            assert.equal(out.replace(/\x1b\[[0-9;]*m/g, ''), plain);
            const styles = input.match(/\x1b\[[0-9;]*m/g) ?? [];
            assert.deepEqual((out.match(/\x1b\[[0-9;]*m/g) ?? []).slice(0, styles.length), styles);
            assert.ok(volume <= plain.length * 2, `segmented ${volume} for ${plain.length}`);
        }
    } finally { spy.mock.restore(); }
});

test('oversized SGR is emitted once and does not multiply across wrapped rows', () => {
    const style = '\x1b[' + '1;'.repeat(100) + '31m';
    const input = style + 'x'.repeat(200);
    const rows = wrapTextToCols(input, 1);
    assert.equal(rows.length, 200);
    assert.equal(rows.join('').split(style).length - 1, 1);
    assert.ok(rows[0]?.endsWith('\x1b[0m'));
    assert.equal(rows.join('').replace(/\x1b\[[0-9;]*m/g, ''), 'x'.repeat(200));
    assert.ok(rows.join('').length < input.length + 200);
});

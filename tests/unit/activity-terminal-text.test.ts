import test from 'node:test';
import assert from 'node:assert/strict';
import {
    safeActivityTerminalText,
    wrapActivityTerminalText,
    activityTerminalWidth,
} from '../../src/cli/tui/activity-terminal-text.js';

test('unfinished VT sequences suppress their payload through the accumulated end', () => {
    for (const tail of ['\x1b', '\x1b[', '\x1b[38;2;255', '\x1b(',
        '\x1b]52;c;secret', '\x1bP1;2qsecret', '\x1b_secret', '\x1b^secret',
        '\x1bXsecret', '\x9b31;', '\x9d52;c;secret', '\x90secret',
        '\x9fsecret', '\x9esecret', '\x98secret']) {
        assert.equal(safeActivityTerminalText(`앞${tail}`), '앞', JSON.stringify(tail));
    }
});

test('complete OSC DCS APC PM SOS controls hide payloads with either ST encoding', () => {
    for (const opener of ['\x1b]', '\x1bP', '\x1b_', '\x1b^', '\x1bX',
        '\x9d', '\x90', '\x9f', '\x9e', '\x98']) {
        for (const end of ['\x1b\\', '\x9c']) {
            assert.equal(safeActivityTerminalText(`앞${opener}secret\n\r\t${end}뒤`), '앞뒤');
        }
    }
    assert.equal(safeActivityTerminalText('a\x1b]0;title\x07b\x9d52;c;secret\x07c'), 'abc');
    assert.equal(safeActivityTerminalText('a\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\b'), 'alinkb');
});

test('BEL and embedded escape do not prematurely expose non-OSC string payloads', () => {
    assert.equal(safeActivityTerminalText('a\x1bPsecret\x07hidden\x1b[2Jhidden\x1b\\b'), 'ab');
    assert.equal(safeActivityTerminalText('a\x1b_secret\x1b]52;c;still-hidden'), 'a');
});

test('every split position is safe when raw provider chunks are accumulated', () => {
    for (const control of ['\x1b]52;c;secret\x1b\\', '\x1bPsecret\x9c',
        '\x9fsecret\x1b\\', '\x1b[38;2;255;0;0m', '\x9b?25l']) {
        for (let split = 0; split <= control.length; split++) {
            const accumulated = `앞${control.slice(0, split)}`;
            assert.equal(safeActivityTerminalText(accumulated), '앞');
            assert.equal(safeActivityTerminalText(accumulated + control.slice(split) + '뒤'), '앞뒤');
        }
    }
    assert.equal(safeActivityTerminalText('independent'), 'independent');
});

test('CSI, escape intermediates, C0, DEL and standalone C1 cannot reach display', () => {
    assert.equal(safeActivityTerminalText('a\x1b[2J\x1b[?25l\x1b[31mb\x9b0m\x1b(B\x1b#8\x1b7c'), 'abc');
    assert.equal(safeActivityTerminalText('a\x1b[31;\x1b]52;c;secret\x07b'), 'ab');
    const controls = Array.from({ length: 160 }, (_, cp) => cp)
        .filter(cp => cp < 32 || cp >= 127)
        .filter(cp => ![9, 10, 13, 27, 144, 152, 155, 157, 158, 159].includes(cp))
        .map(cp => String.fromCharCode(cp)).join('');
    assert.equal(safeActivityTerminalText(`앞${controls}뒤`), '앞뒤');
});

test('CR and CRLF become one newline, tabs four spaces, bidi controls disappear', () => {
    assert.equal(safeActivityTerminalText('경로\t파일\r\n끝\r다음\n'), '경로    파일\n끝\n다음\n');
    assert.equal(safeActivityTerminalText('a\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069한글'), 'a한글');
});

test('empty input, explicit blank lines and trailing newlines preserve rows', () => {
    assert.equal(safeActivityTerminalText(''), '');
    assert.equal(activityTerminalWidth(''), 0);
    assert.deepEqual(wrapActivityTerminalText('', 20), ['']);
    assert.deepEqual(wrapActivityTerminalText('\n가\n\n', 2), ['', '가', '', '']);
    assert.deepEqual(wrapActivityTerminalText('ab\n', 2), ['ab', '']);
});

test('width one replaces double-cell clusters, including flags and ZWJ families', () => {
    assert.deepEqual(wrapActivityTerminalText('가a👨‍👩‍👧‍👦🇰🇷e\u0301', 1), ['?', 'a', '?', '?', 'e\u0301']);
    for (const columns of [0, -1, NaN, Infinity, -Infinity, 0.5]) {
        assert.deepEqual(wrapActivityTerminalText('가a', columns), ['?', 'a']);
    }
    assert.deepEqual(wrapActivityTerminalText('가a', 2.9), ['가', 'a']);
});

test('combining marks and decomposed Hangul measure as clusters without changing source', () => {
    for (const [value, width] of [['e\u0301', 1], ['a\u1ab0', 1], ['\u0301', 0],
        ['\u200d\ufe0f', 0], ['한', 2], ['한', 2], ['ᅡᆫ', 0]] as const) {
        assert.equal(activityTerminalWidth(value), width, value);
    }
    assert.deepEqual(wrapActivityTerminalText('한e\u0301가', 2), ['한', 'e\u0301', '가']);
});

test('emoji presentation, skin tones, flags, keycaps and ZWJ sequences occupy two cells', () => {
    for (const emoji of ['😀', '👍🏽', '🇰🇷', '🇺🇸', '👨‍👩‍👧‍👦', '👩🏽‍💻', '❤️', '✔️', '1️⃣', '1⃣', '🏳️‍🌈']) {
        assert.equal(activityTerminalWidth(emoji), 2, emoji);
        assert.deepEqual(wrapActivityTerminalText(`${emoji}x`, 2), [emoji, 'x']);
    }
    assert.equal(activityTerminalWidth('❤︎'), 1);
    assert.equal(activityTerminalWidth('✔'), 1);
    assert.equal(activityTerminalWidth('123'), 3);
});

test('width measures the widest sanitized logical line; wrapping sanitizes before layout', () => {
    const raw = '\x1b[2J가\tA\r\nb\x1b]52;c;secret';
    assert.equal(activityTerminalWidth(raw), 7);
    assert.deepEqual(wrapActivityTerminalText(raw, 4), ['가  ', '  A', 'b']);
});

test('column matrix keeps clusters intact and gives exact hand-counted rows', () => {
    for (const columns of [2, 20, 40, 80, 120]) {
        const count = columns / 2;
        const row = '👩‍💻'.repeat(count);
        assert.deepEqual(wrapActivityTerminalText(`${row}가`, columns), [row, '가']);
        assert.equal(activityTerminalWidth(row), columns);
    }
});

test('input over 64 KiB is preserved and unterminated large payloads stay hidden', () => {
    const row = '한a'.repeat(40);
    const text = row.repeat(600);
    assert.ok(Buffer.byteLength(text) > 65536);
    assert.deepEqual(wrapActivityTerminalText(text, 120), Array(600).fill(row));
    assert.equal(safeActivityTerminalText(`앞\x1b]52;c;${text}`), '앞');
});

test('sanitization is idempotent and ordinary Korean markdown stays readable', () => {
    const text = '## 결과\n`file.ts` 한글 e\u0301 👩‍💻';
    assert.equal(safeActivityTerminalText(text), text);
    const safe = safeActivityTerminalText(`\x1b[31m${text}\r\t\u202e\x1b[0m`);
    assert.equal(safeActivityTerminalText(safe), safe);
});

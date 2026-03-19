import test from 'node:test';
import assert from 'node:assert/strict';
import { clipTextToCols, visualWidth } from '../../src/cli/tui/renderers.js';

test('visualWidth ignores ANSI escape codes', () => {
    assert.equal(visualWidth('\x1b[31mabc\x1b[0m'), 3);
});

test('visualWidth counts Hangul as double-width', () => {
    assert.equal(visualWidth('가a'), 3);
});

test('clipTextToCols respects visual width for mixed-width text', () => {
    assert.equal(clipTextToCols('가나다abc', 5), '가나');
    assert.equal(clipTextToCols('가나다abc', 6), '가나다');
    assert.equal(clipTextToCols('가나다abc', 7), '가나다a');
});

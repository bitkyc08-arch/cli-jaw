import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveNumericReference } from '../../src/orchestrator/parser.ts';

test('numeric reference resolves Korean index against latest assistant numbered list', () => {
    const result = resolveNumericReference('1번부터 하자', [
        { role: 'user', content: '1번부터 하자' },
        { role: 'assistant', content: '1. Heartbeat prompt leak fix\n2. Context anchor fix' },
    ]);

    assert.equal(result?.resolved, 'Heartbeat prompt leak fix');
    assert.equal(result?.needsConfirmation, false);
    assert.equal(result?.matchedIndex, 1);
    assert.deepEqual(result?.selection, {
        raw: '1번부터 하자',
        index: 1,
        text: 'Heartbeat prompt leak fix',
        source: 'latest_assistant_numbered_list',
    });
});

test('numeric reference supports parenthesis and colon list formats', () => {
    assert.equal(resolveNumericReference('2번 ㄱㄱ', [
        { role: 'assistant', content: '1) First task\n2) Second task' },
    ])?.resolved, 'Second task');

    assert.equal(resolveNumericReference('3.', [
        { role: 'assistant', content: '1: One\n2: Two\n3: Three' },
    ])?.resolved, 'Three');
});

test('numeric reference asks confirmation when latest assistant list does not contain the item', () => {
    const result = resolveNumericReference('4번', [
        { role: 'assistant', content: '1. One\n2. Two' },
    ]);

    assert.equal(result?.resolved, null);
    assert.equal(result?.needsConfirmation, true);
    assert.equal(result?.matchedIndex, 4);
});

test('non-numeric prompt is not treated as a numeric reference', () => {
    assert.equal(resolveNumericReference('heartbeat 이슈 조사', [
        { role: 'assistant', content: '1. One' },
    ]), null);
});

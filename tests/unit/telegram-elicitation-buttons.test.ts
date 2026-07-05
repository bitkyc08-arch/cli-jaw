import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildElicitationKeyboards,
    discardPendingElicitation,
    handleElicitationCallback,
    hasPendingElicitation,
    isButtonRenderableSpec,
    startPendingElicitation,
} from '../../src/telegram/elicitation-buttons.ts';
import { parseElicitationSpec } from '../../src/shared/elicitation-spec.ts';

const twoQuestionSpec = JSON.stringify({
    questions: [
        {
            id: 'q1', type: 'single_select', question: '어떤 색이 좋나요?',
            options: [{ id: 'red', label: '빨강' }, { id: 'blue', label: '파랑' }],
        },
        {
            id: 'q2', type: 'single_select', question: '크기는요?',
            options: [{ id: 's', label: '소' }, { id: 'l', label: '대' }],
        },
    ],
});

test.afterEach(() => {
    discardPendingElicitation('chat1');
});

test('single_select spec builds one keyboard message per question with index callback data', () => {
    const keyboards = startPendingElicitation('chat1', twoQuestionSpec);
    assert.ok(keyboards);
    assert.equal(keyboards!.length, 2);
    assert.equal(keyboards![0].text, 'Q1. 어떤 색이 좋나요?');
    assert.equal(keyboards![0].reply_markup.inline_keyboard[0][0].text, '빨강');
    assert.equal((keyboards![0].reply_markup.inline_keyboard[0][0] as { callback_data: string }).callback_data, 'elic:0:0');
    assert.equal((keyboards![1].reply_markup.inline_keyboard[1][0] as { callback_data: string }).callback_data, 'elic:1:1');
});

test('multi_select in the spec disables button rendering', () => {
    const mixed = JSON.stringify({
        questions: [
            { id: 'q1', type: 'single_select', question: 'a', options: [{ id: 'x', label: 'X' }] },
            { id: 'q2', type: 'multi_select', question: 'b', options: [{ id: 'y', label: 'Y' }] },
        ],
    });
    assert.equal(startPendingElicitation('chat1', mixed), null);
    assert.equal(hasPendingElicitation('chat1'), false);
});

test('more than 8 options disables button rendering', () => {
    const spec = parseElicitationSpec(JSON.stringify({
        questions: [{
            id: 'q1', type: 'single_select', question: 'many',
            options: Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: `옵션${i}` })),
        }],
    }));
    assert.ok(spec);
    assert.equal(isButtonRenderableSpec(spec!), false);
});

test('sequential callbacks progress then complete with a combined answer', () => {
    startPendingElicitation('chat1', twoQuestionSpec);

    const first = handleElicitationCallback('chat1', 'elic:0:1');
    assert.equal(first.kind, 'progress');
    assert.match((first as { ack: string }).ack, /파랑/);

    const second = handleElicitationCallback('chat1', 'elic:1:0');
    assert.equal(second.kind, 'complete');
    const combined = (second as { combinedAnswer: string }).combinedAnswer;
    assert.equal(combined, '어떤 색이 좋나요?: 파랑\n크기는요?: 소');
    // Completed session is gone.
    assert.equal(handleElicitationCallback('chat1', 'elic:0:0').kind, 'stale');
});

test('re-tapping the same question overwrites the previous choice', () => {
    startPendingElicitation('chat1', twoQuestionSpec);
    handleElicitationCallback('chat1', 'elic:0:0');
    handleElicitationCallback('chat1', 'elic:0:1');
    const done = handleElicitationCallback('chat1', 'elic:1:1');
    assert.equal(done.kind, 'complete');
    assert.match((done as { combinedAnswer: string }).combinedAnswer, /파랑/);
});

test('callbacks for unknown chats or malformed data are stale', () => {
    assert.equal(handleElicitationCallback('nobody', 'elic:0:0').kind, 'stale');
    startPendingElicitation('chat1', twoQuestionSpec);
    assert.equal(handleElicitationCallback('chat1', 'elic:zz').kind, 'stale');
    assert.equal(handleElicitationCallback('chat1', 'elic:9:9').kind, 'stale');
});

test('discardPendingElicitation invalidates the session', () => {
    startPendingElicitation('chat1', twoQuestionSpec);
    assert.equal(hasPendingElicitation('chat1'), true);
    discardPendingElicitation('chat1');
    assert.equal(handleElicitationCallback('chat1', 'elic:0:0').kind, 'stale');
});

test('buildElicitationKeyboards omits the Q prefix for a single question', () => {
    const spec = parseElicitationSpec(JSON.stringify({
        questions: [{ id: 'q1', type: 'single_select', question: '진행할까요?', options: [{ id: 'y', label: '네' }] }],
    }));
    const keyboards = buildElicitationKeyboards(spec!);
    assert.equal(keyboards[0].text, '진행할까요?');
});

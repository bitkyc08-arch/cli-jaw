import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assistantChunkMergeAction,
    codeChunkEventKey,
    isDuplicateAssistantFinalChunk,
    rememberCodeChunkEvents,
    shouldDropDuplicateCodeChunk,
    textFromCodeChunk,
} from '../../public/manager/src/code/code-event-dedupe.ts';

test('code event dedupe records replay chunks and drops the same late live chunk', () => {
    const seen = new Set<string>();
    const text = '**20개 도구 호출**을 완료했습니다.\n\n다음으로 특정 서브시스템을 더 깊게 조사할까요?';

    rememberCodeChunkEvents(seen, [{
        event: 'code_agent_message_chunk',
        sessionId: 's1',
        update: { messageId: 'm-final', content: { type: 'text', text } },
    }]);

    assert.equal(seen.size, 1);
    assert.equal(shouldDropDuplicateCodeChunk(seen, {
        topic: 'jwc',
        event: 'code_agent_message_chunk',
        sessionId: 's1',
        update: { messageId: 'm-final', content: { type: 'text', text } },
    }, text), true);
});

test('code event dedupe keeps different chunks for the same message id', () => {
    const seen = new Set<string>();
    const first = '첫 번째 delta';
    const second = '두 번째 delta';

    assert.equal(shouldDropDuplicateCodeChunk(seen, {
        topic: 'jwc',
        event: 'code_agent_message_chunk',
        sessionId: 's1',
        update: { messageId: 'm-stream', content: { type: 'text', text: first } },
    }, first), false);
    assert.equal(shouldDropDuplicateCodeChunk(seen, {
        topic: 'jwc',
        event: 'code_agent_message_chunk',
        sessionId: 's1',
        update: { messageId: 'm-stream', content: { type: 'text', text: second } },
    }, second), false);
});

test('code event dedupe can key exact SSE replays without a message id', () => {
    const event = {
        topic: 'jwc',
        event: 'code_agent_message_chunk',
        sessionId: 's1',
        sseEventId: '42',
        update: { content: { type: 'text', text: 'final answer' } },
    };
    const text = textFromCodeChunk(event.update);
    assert.equal(codeChunkEventKey(event, text), 's1:code_agent_message_chunk:sse:42:final answer');
});

test('code event dedupe treats an adjacent long identical assistant final as duplicate', () => {
    const text = [
        '**20개 도구 호출**을 완료했습니다. 결과 요약입니다.',
        '다음으로 특정 서브시스템(code-mode, folder-panel, tui 등) 20개 더 깊게 조사할까요?',
    ].join('\n\n');

    assert.equal(isDuplicateAssistantFinalChunk(text, text), true);
    assert.equal(isDuplicateAssistantFinalChunk('짧은 답변', '짧은 답변'), false);
});

test('assistant chunk merge replaces an incomplete prefix with a cumulative final snapshot', () => {
    const prefix = '요청하신 대로 10개 도구를 사용해 워크스페이스를 탐색했습니다.';
    const final = [
        prefix,
        '',
        '# 도구 결과',
        '1 Glob integration tests 10개',
        '2 Grep code unit tests 매치 없음',
    ].join('\n');

    assert.equal(assistantChunkMergeAction(prefix, final), 'replace');
});

test('assistant chunk merge drops an older prefix after the complete text already rendered', () => {
    const prefix = '요청하신 대로 10개 도구를 사용해 워크스페이스를 탐색했습니다.';
    const final = `${prefix}\n\n# 도구 결과\n1 Glob integration tests 10개`;

    assert.equal(assistantChunkMergeAction(final, prefix), 'drop');
});

test('assistant chunk merge still appends true delta chunks', () => {
    assert.equal(assistantChunkMergeAction('첫 번째 문장입니다.\n', '두 번째 문장입니다.'), 'append');
});

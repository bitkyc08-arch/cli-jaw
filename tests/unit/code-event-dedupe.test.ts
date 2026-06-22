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

test('assistant chunk merge replaces a leading-truncated duplicate snapshot', () => {
    const truncated = [
        '개 도구를 한 번에 병렬 호출해 봤습니다. 결과 요약입니다.',
        '',
        '#',
        '도구',
        '결과',
        '1',
        'Glob',
        'README 33개 발견 (README.md, README.ko.md 등)',
        '2',
        'Grep',
        '*.ts에서 export 검색 — 매치 없음',
        '3',
        'Shell',
        'cwd: /Users/jun/Developer/new/700_projects/cli-jaw, 프로젝트 루트 확인',
        '4',
        'find (MCP)',
        'package.json, package-lock.json 등 JSON 5개',
        '워크스페이스 스냅샷',
        '',
        '프로젝트: cli-jaw (AI agent orchestration platform)',
        '주요 디렉터리: src/, bin/, electron/, officecli/, skills_ref/',
        '다른 도구 조합이나 특정 파일/기능 검색도 원하시면 말씀 주세요.',
    ].join('\n');
    const complete = [
        '10개 도구를 한 번에 병렬 호출해 봤습니다. 결과 요약입니다.',
        '',
        '#',
        '도구',
        '결과',
        '1',
        'Glob',
        'README 33개 발견 (README.md, README.ko.md 등)',
        '2',
        'Grep',
        '*.ts에서 export 검색 — 매치 없음',
        '3',
        'Shell',
        'cwd: /Users/jun/Developer/new/700_projects/cli-jaw, 프로젝트 루트 확인',
        '4',
        'find (MCP)',
        'package.json, package-lock.json 등 JSON 5개',
        '워크스페이스 스냅샷',
        '',
        '프로젝트: cli-jaw (AI agent orchestration platform)',
        '주요 디렉터리: src/, bin/, electron/, officecli/, skills_ref/',
        '다른 도구 조합이나 특정 파일/기능 검색도 원하시면 말씀해 주세요.',
    ].join('\n');

    assert.equal(assistantChunkMergeAction(truncated, complete), 'replace');
    assert.equal(assistantChunkMergeAction(complete, truncated), 'drop');
});

test('assistant chunk merge drops an older prefix after the complete text already rendered', () => {
    const prefix = '요청하신 대로 10개 도구를 사용해 워크스페이스를 탐색했습니다.';
    const final = `${prefix}\n\n# 도구 결과\n1 Glob integration tests 10개`;

    assert.equal(assistantChunkMergeAction(final, prefix), 'drop');
});

test('assistant chunk merge still appends true delta chunks', () => {
    assert.equal(assistantChunkMergeAction('첫 번째 문장입니다.\n', '두 번째 문장입니다.'), 'append');
});

test('assistant chunk merge does not collapse long distinct chunks with a short shared phrase', () => {
    const first = [
        '10개 도구를 한 번에 병렬 호출해 봤습니다.',
        '첫 번째 조사 결과는 README와 package.json 중심입니다.',
        '워크스페이스 스냅샷은 src와 tests 구조만 요약합니다.',
        '다음으로 특정 서브시스템을 더 깊게 조사할까요?',
    ].join('\n');
    const second = [
        '20개 도구를 한 번 더 병렬 호출해 봤습니다.',
        '두 번째 조사 결과는 electron과 manager 중심입니다.',
        '릴리즈 스크립트와 Code mode 경로를 별도로 요약합니다.',
        '다음으로 특정 서브시스템을 더 깊게 조사할까요?',
    ].join('\n');

    assert.equal(assistantChunkMergeAction(first, second), 'append');
});

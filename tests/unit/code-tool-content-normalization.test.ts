import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToolContentFromUpdate } from '../../public/manager/src/code/code-types.ts';
import { replayEventsToTranscriptEntries } from '../../public/manager/src/code/code-transcript-replay.ts';

test('code tool rawOutput extracts JWC text content instead of rendering raw JSON payload', () => {
    const content = normalizeToolContentFromUpdate({
        rawOutput: {
            content: [
                { type: 'text', text: '.\n - codex-shim.ts 6.7KB\n - server.ts 29.8KB' },
            ],
        },
    });

    assert.equal(content.length, 1);
    assert.equal(content[0]?.type, 'output');
    assert.equal(content[0]?.label, 'Output');
    assert.equal(content[0]?.text, '.\n - codex-shim.ts 6.7KB\n - server.ts 29.8KB');
    assert.equal(content[0]?.text?.includes('"content"'), false);
});

test('code replay keeps rawOutput in normalized toolContent only, avoiding duplicate toolOutput rendering', () => {
    const entries = replayEventsToTranscriptEntries([
        {
            event: 'code_tool_call',
            sessionId: 's1',
            update: { toolCallId: 'tool-1', title: 'read: src/server.ts', status: 'running' },
        },
        {
            event: 'code_tool_call_update',
            sessionId: 's1',
            update: {
                toolCallId: 'tool-1',
                status: 'completed',
                rawOutput: {
                    content: [
                        { type: 'text', text: 'read result text' },
                    ],
                },
            },
        },
    ]);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.role, 'tool');
    assert.equal(entries[0]?.toolOutput, undefined);
    assert.equal(entries[0]?.toolContent?.length, 1);
    assert.equal(entries[0]?.toolContent?.[0]?.type, 'output');
    assert.equal(entries[0]?.toolContent?.[0]?.text, 'read result text');
});

test('code replay preserves final assistant message after tool calls', () => {
    const entries = replayEventsToTranscriptEntries([
        {
            event: 'code_user_message_chunk',
            sessionId: 's1',
            update: { content: { type: 'text', text: 'tool use 10개해봐' } },
        },
        {
            event: 'code_agent_message_chunk',
            sessionId: 's1',
            update: { content: { type: 'text', text: '10개의 도구를 사용해 워크스페이스를 탐색합니다.\n' } },
        },
        {
            event: 'code_tool_call',
            sessionId: 's1',
            update: { toolCallId: 'tool-1', title: 'find', status: 'running' },
        },
        {
            event: 'code_tool_call_update',
            sessionId: 's1',
            update: { toolCallId: 'tool-1', status: 'completed', rawOutput: { content: [{ type: 'text', text: 'README.md' }] } },
        },
        {
            event: 'code_agent_message_chunk',
            sessionId: 's1',
            update: { content: { type: 'text', text: '요청하신 대로 **10개 도구**를 사용해 워크스페이스를 탐색했습니다.' } },
        },
    ]);

    assert.equal(entries.length, 4);
    assert.equal(entries[0]?.role, 'user');
    assert.equal(entries[1]?.role, 'assistant');
    assert.equal(entries[2]?.role, 'tool');
    assert.equal(entries[3]?.role, 'assistant');
    assert.match(entries[3]?.text ?? '', /10개 도구/);
});

test('code replay replaces incomplete assistant prefix with cumulative final snapshot', () => {
    const prefix = '요청하신 대로 10개 도구를 사용해 워크스페이스를 탐색했습니다.';
    const final = [
        prefix,
        '',
        '# 도구 결과',
        '1 Glob integration tests 10개',
        '2 Grep code unit tests 매치 없음',
    ].join('\n');
    const entries = replayEventsToTranscriptEntries([
        {
            event: 'code_user_message_chunk',
            sessionId: 's1',
            update: { content: { type: 'text', text: 'tool use 10개해봐' } },
        },
        {
            event: 'code_agent_message_chunk',
            sessionId: 's1',
            update: { content: { type: 'text', text: prefix } },
        },
        {
            event: 'code_agent_message_chunk',
            sessionId: 's1',
            update: { content: { type: 'text', text: final } },
        },
    ]);

    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.role, 'assistant');
    assert.equal(entries[1]?.text, final);
    assert.equal((entries[1]?.text ?? '').indexOf(prefix), 0);
    assert.equal((entries[1]?.text ?? '').lastIndexOf(prefix), 0);
});

test('code replay replaces a leading-truncated assistant snapshot with the complete snapshot', () => {
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
        '워크스페이스 스냅샷',
        '',
        '프로젝트: cli-jaw (AI agent orchestration platform)',
        '주요 디렉터리: src/, bin/, electron/, officecli/, skills_ref/',
        '다른 도구 조합이나 특정 파일/기능 검색도 원하시면 말씀해 주세요.',
    ].join('\n');
    const entries = replayEventsToTranscriptEntries([
        {
            event: 'code_user_message_chunk',
            sessionId: 's1',
            update: { content: { type: 'text', text: 'tool use 10개해봐' } },
        },
        {
            event: 'code_agent_message_chunk',
            sessionId: 's1',
            update: { content: { type: 'text', text: truncated } },
        },
        {
            event: 'code_agent_message_chunk',
            sessionId: 's1',
            update: { content: { type: 'text', text: complete } },
        },
    ]);

    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.role, 'assistant');
    assert.equal(entries[1]?.text, complete);
    assert.equal((entries[1]?.text ?? '').includes(truncated), false);
});

test('code replay never overlap-merges different assistant message ids', () => {
    const first = [
        '10개 도구를 한 번에 병렬 호출해 봤습니다.',
        'README 33개 발견',
        'package.json 확인',
        '프로젝트 스냅샷 완료',
    ].join('\n');
    const second = [
        '추가 검토입니다.',
        '10개 도구를 한 번에 병렬 호출해 봤습니다.',
        'README 33개 발견',
        'package.json 확인',
        '프로젝트 스냅샷 완료',
    ].join('\n');
    const entries = replayEventsToTranscriptEntries([
        {
            event: 'code_agent_message_chunk',
            sessionId: 's1',
            update: { messageId: 'assistant-1', content: { type: 'text', text: first } },
        },
        {
            event: 'code_agent_message_chunk',
            sessionId: 's1',
            update: { messageId: 'assistant-2', content: { type: 'text', text: second } },
        },
    ]);

    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.messageId, 'assistant-1');
    assert.equal(entries[1]?.messageId, 'assistant-2');
    assert.equal(entries[0]?.text, first);
    assert.equal(entries[1]?.text, second);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildTargetMismatchResult,
    renderMultiTurnTranscript,
    resolveChatGptComposerToolRequests,
    resolveImplicitSessionSelection,
    sessionPollRecoveryCommand,
} from '../../src/browser/web-ai/index.js';
import type { WebAiSessionRecord } from '../../src/browser/web-ai/index.js';

test('BWAI-TOOLS-001: ChatGPT composer tool resolver handles explicit and inferred tools', () => {
    const explicit = resolveChatGptComposerToolRequests({
        tools: ['이미지 만들기', 'research'],
        plugins: 'github,Google Drive',
    });
    assert.deepEqual(explicit.tools.sort(), ['deep-research', 'image']);
    assert.deepEqual(explicit.plugins.sort(), ['github', 'google-drive']);

    const inferred = resolveChatGptComposerToolRequests({
        autoTools: true,
        prompt: '최신 뉴스를 웹에서 검색해줘',
    });
    assert.deepEqual(inferred.tools, ['web-search']);
    assert.ok(inferred.reasons.includes('auto:web-search-intent'));

    const deep = resolveChatGptComposerToolRequests({
        autoTools: true,
        prompt: '최신 정책을 종합 보고서로 깊이 분석해줘',
    });
    assert.deepEqual(deep.tools, ['deep-research']);
    assert.ok(deep.reasons.includes('auto:deep-research-intent'));
});

test('BWAI-TOOLS-002: implicit session selection stays explicit unless poll/stop needs binding', () => {
    assert.deepEqual(resolveImplicitSessionSelection({
        command: 'send',
        vendor: 'chatgpt',
        session: null,
    }), { action: 'explicit', sessionId: null, candidates: [] });

    assert.deepEqual(resolveImplicitSessionSelection({
        command: 'poll',
        vendor: 'chatgpt',
        session: 'webai_123',
    }), { action: 'explicit', sessionId: 'webai_123', candidates: [] });
});

test('BWAI-TOOLS-003: target mismatch result includes safe recovery command', () => {
    const session = {
        sessionId: 'webai_abc',
        vendor: 'chatgpt',
        targetId: 'target-old',
        conversationUrl: 'https://chatgpt.com/c/abc',
    } as WebAiSessionRecord;

    const result = buildTargetMismatchResult({
        vendor: 'chatgpt',
        session,
        actualTargetId: 'target-new',
        port: 9333,
        baseline: { assistantCount: 2 },
    });

    assert.equal(result.status, 'target-mismatch');
    assert.equal(result.expectedTargetId, 'target-old');
    assert.equal(result.actualTargetId, 'target-new');
    assert.equal(result.recovery, 'cli-jaw browser web-ai poll --vendor chatgpt --session webai_abc --navigate --json');
    assert.deepEqual(result.warnings, ['poll target changed: target-old -> target-new']);
    assert.equal(sessionPollRecoveryCommand('unknown', 'sid'), 'cli-jaw browser web-ai poll --vendor chatgpt --session sid --navigate --json');
});

test('BWAI-TOOLS-004: multi-turn transcript renderer is deterministic markdown', () => {
    const transcript = renderMultiTurnTranscript([
        {
            index: 0,
            prompt: 'First',
            answer: 'One',
            status: 'complete',
            warnings: [],
            sentAt: '2026-06-21T00:00:00.000Z',
            completedAt: '2026-06-21T00:00:01.000Z',
        },
        {
            index: 1,
            prompt: 'Second',
            answer: null,
            status: 'failed',
            warnings: ['timeout'],
            sentAt: '2026-06-21T00:00:02.000Z',
            completedAt: null,
        },
    ]);

    assert.match(transcript, /## Turn 0/);
    assert.match(transcript, /\*\*User:\*\* First/);
    assert.match(transcript, /\*\*Assistant:\*\* One/);
    assert.match(transcript, /## Turn 1/);
    assert.match(transcript, /\(no response\)/);
});

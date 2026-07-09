import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildRemoteChannelElicitationGuard,
    normalizeRemoteChannelElicitationOutput,
    orchestrate,
} from '../../src/orchestrator/pipeline.ts';
import {
    resetState,
    setState,
    type OrcContext,
} from '../../src/orchestrator/state-machine.ts';

const ctx: OrcContext = {
    originalPrompt: 'Clarify the remote channel behavior.',
    workingDir: null,
    plan: 'Remote channels must not emit Web-only elicitation fences.',
    workerResults: [],
    origin: 'telegram',
};

test.afterEach(() => {
    resetState('default');
});

test('remote channel elicitation guard is absent for web and heartbeat origins', () => {
    assert.equal(buildRemoteChannelElicitationGuard('web'), '');
    assert.equal(buildRemoteChannelElicitationGuard('heartbeat'), '');
});

test('remote channel elicitation guard forbids structured fences for Discord', () => {
    const guard = buildRemoteChannelElicitationGuard('discord');

    assert.match(guard, /Current origin is discord/);
    assert.match(guard, /Do not output standalone ```elicitation/);
    assert.match(guard, /```choice-buttons/);
    assert.match(guard, /```search-results/);
    assert.match(guard, /numbered options/);
    assert.match(guard, /search results/);
});

test('telegram guard allows a single single_select elicitation fence for inline keyboards', () => {
    const guard = buildRemoteChannelElicitationGuard('telegram');

    assert.match(guard, /Current origin is telegram/);
    assert.match(guard, /inline keyboard buttons/);
    assert.match(guard, /MAY output at most one ```elicitation fence/);
    assert.match(guard, /single_select questions only/);
    assert.match(guard, /Do not output ```choice-buttons or ```search-results/);
    assert.match(guard, /flattened to plain numbered text/);
});

test('orchestrate appends the remote guard after PABCD prompt assembly only for remote origins', async () => {
    let telegramPrompt = '';
    let webPrompt = '';
    setState('B', ctx, 'default');

    await orchestrate('continue', {
        origin: 'telegram',
        _skipClear: true,
        _skipInsert: true,
        _spawnAgent: (prompt: string) => {
            telegramPrompt = prompt;
            return { child: null, promise: Promise.resolve({ text: 'ok', code: 0 }) };
        },
    } as any);

    resetState('default');
    setState('B', { ...ctx, origin: 'web' }, 'default');

    await orchestrate('continue', {
        origin: 'web',
        _skipClear: true,
        _skipInsert: true,
        _spawnAgent: (prompt: string) => {
            webPrompt = prompt;
            return { child: null, promise: Promise.resolve({ text: 'ok', code: 0 }) };
        },
    } as any);

    assert.match(telegramPrompt, /## Approved Plan \(authoritative\)/);
    assert.match(telegramPrompt, /## Remote Channel Capability Override/);
    assert.ok(
        telegramPrompt.indexOf('## Remote Channel Capability Override') > telegramPrompt.indexOf('## Approved Plan (authoritative)'),
        'remote guard should be appended after approved-plan and state prompt assembly',
    );
    assert.doesNotMatch(webPrompt, /Remote Channel Capability Override/);
});

test('remote channel output normalization converts elicitation fences to plain numbered text', () => {
    const spec = JSON.stringify({
        questions: [{
            id: 'scope',
            question: '무엇을 진행할까요?',
            options: [
                { label: 'Web만 유지', value: 'web_only' },
                { label: 'Remote도 native 구현', value: 'remote_native' },
            ],
        }],
    });
    const output = normalizeRemoteChannelElicitationOutput(`설명\n\n\`\`\`elicitation\n${spec}\n\`\`\``, 'telegram');

    assert.doesNotMatch(output, /```elicitation/);
    assert.doesNotMatch(output, /"questions"/);
    assert.match(output, /번호나 텍스트로 답해주세요/);
    assert.match(output, /무엇을 진행할까요\?/);
    assert.match(output, /1\. Web만 유지/);
    assert.match(output, /2\. Remote도 native 구현/);
});

test('remote channel output normalization supports choice-buttons alias', () => {
    const spec = JSON.stringify({
        question: '진행 방식은?',
        options: ['plain text', 'native buttons'],
    });
    const output = normalizeRemoteChannelElicitationOutput(`\`\`\`choice-buttons\n${spec}\n\`\`\``, 'discord');

    assert.doesNotMatch(output, /```choice-buttons/);
    assert.match(output, /진행 방식은\?/);
    assert.match(output, /1\. plain text/);
    assert.match(output, /2\. native buttons/);
});

test('remote channel output normalization preserves option descriptions and multi-question labels', () => {
    const spec = JSON.stringify({
        questions: [
            {
                question: 'Phase 40은?',
                options: [{ label: 'runtime polish', description: 'cursor/composer/spacing' }],
            },
            {
                question: 'Phase 41은?',
                options: [{ label: 'structured parser', description: 'elicitation fallback' }],
            },
        ],
    });
    const output = normalizeRemoteChannelElicitationOutput(`\`\`\`elicitation\n${spec}\n\`\`\``, 'telegram');

    assert.doesNotMatch(output, /```elicitation/);
    assert.doesNotMatch(output, /"questions"/);
    assert.match(output, /Q1\. Phase 40은\?/);
    assert.match(output, /1\. runtime polish — cursor\/composer\/spacing/);
    assert.match(output, /Q2\. Phase 41은\?/);
    assert.match(output, /1\. structured parser — elicitation fallback/);
});


test('web output normalization preserves structured fences', () => {
    const raw = '```elicitation\n{"questions":[{"question":"선택?","options":["A"]}]}\n```';

    assert.equal(normalizeRemoteChannelElicitationOutput(raw, 'web'), raw);
});

test('remote channel output normalization converts search-results fence to plain text', () => {
    const spec = JSON.stringify({
        schemaVersion: 'search-results-v1',
        query: 'cli-jaw',
        results: [
            { title: 'cli-jaw repo', url: 'https://example.com/cli-jaw' },
            { title: 'docs', url: 'https://example.com/docs' },
        ],
    });
    const output = normalizeRemoteChannelElicitationOutput(`검색\n\n\`\`\`search-results\n${spec}\n\`\`\``, 'telegram');

    assert.doesNotMatch(output, /```search-results/);
    assert.doesNotMatch(output, /"schemaVersion"/);
    assert.match(output, /일반 텍스트로 표시합니다/);
    assert.match(output, /검색어: cli-jaw/);
    assert.match(output, /1\. cli-jaw repo/);
    assert.match(output, /2\. docs/);
});

test('remote channel output normalization strips incomplete search-results fences', () => {
    const raw = [
        '검색 결과입니다.',
        '',
        '```search-results',
        '{"schemaVersion":"search-results-v1","query":"secret","results":[{"title":"raw","url":"https://example.com"}]}',
    ].join('\n');
    const output = normalizeRemoteChannelElicitationOutput(raw, 'telegram');

    assert.doesNotMatch(output, /```search-results/);
    assert.doesNotMatch(output, /"schemaVersion"/);
    assert.doesNotMatch(output, /"results"/);
    assert.match(output, /검색 결과 카드는 Telegram\/Discord에서 Web UI로 표시되지 않습니다/);
});

test('remote channel output normalization strips incomplete elicitation fences', () => {
    const raw = [
        '선택해주세요.',
        '',
        '```elicitation',
        '{"questions":[{"question":"비밀 선택?","options":["A","B"]}]}',
    ].join('\n');
    const output = normalizeRemoteChannelElicitationOutput(raw, 'discord');

    assert.doesNotMatch(output, /```elicitation/);
    assert.doesNotMatch(output, /"questions"/);
    assert.match(output, /구조화 질문은 Telegram\/Discord에서 버튼 UI로 표시되지 않습니다/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    appendCursorAcceptedInstruction, buildCursorReplacementPrompt, buildPromptForArgs,
    PROMPT_HISTORY_MAX_ROWS, PROMPT_HISTORY_MAX_CHARS, withHistoryPrompt, withSteerContext,
    type CursorAcceptedContext,
} from '../../src/agent/prompt-context.ts';

// Independent fixed wire expectations from packet 122, not delimiter-count oracles.
const HEADER = '[Cursor redirect context - read-only]\n';
const ORIGINAL = '[Previous request - read-only context]\n';
const ACCEPTED = '[Accepted redirect - read-only context]\n';
const OMITTED = '[Some previous request context was omitted to fit the history limit.]';
const BOUNDARY = '[History Boundary]\nRecent Context is read-only background. The Current Message below is the only task to execute now.\nDo not continue prior plans, audits, commands, questions, or goals unless the Current Message explicitly asks to resume or continue them.';
const EMPTY: CursorAcceptedContext = Object.freeze({ messages: Object.freeze([]), omitted: false });
const fullLimit = 8_388_608;

function history(current: string, context: string): string {
    return `${context}\n\n${BOUNDARY}\n\n---\n[Current Message]\n${current}`;
}

function operational(prompt: string, sys = 'RULES'): string {
    return `[Operational Context — cli-jaw Integration]\nThe following operational guidelines apply to this session. Follow these task rules and use the tools/commands described:\n\n${sys}\n\n---\n\n${prompt}`;
}

function partial(prompt: string, text: string, truncated = false): string {
    return [
        '[Interrupted Turn Context — cli-jaw steer]',
        'The previous turn was interrupted by a new instruction from the user (steer).',
        'Its partial output before the interruption is below and is INCOMPLETE.',
        'Remember what it was doing, do not repeat completed work, and continue with the current message.',
        '[이전 턴이 사용자의 새 지시(steer)로 중단되었습니다. 아래는 중단 시점까지의 미완성 부분 출력입니다.',
        '완료된 작업을 반복하지 말고, 맥락을 기억한 채 현재 메시지를 이어서 수행하세요.]',
        '', '<partial_output>', `${truncated ? '... [truncated]\n' : ''}${text}`,
        '</partial_output>', '', '---', prompt,
    ].join('\n');
}

function replacement(originalRequest: string, accepted: CursorAcceptedContext = EMPTY, instruction = 'NOW'): string {
    return buildCursorReplacementPrompt({ instruction, originalRequest, accepted, partialText: '', sysPrompt: '' });
}

test('exports existing history defaults and composes short A → B → C without mutating accepted state', () => {
    assert.equal(PROMPT_HISTORY_MAX_ROWS, 10);
    assert.equal(PROMPT_HISTORY_MAX_CHARS, 8000);
    assert.equal(replacement('A', EMPTY, 'B'), history('B', HEADER + ORIGINAL + 'A'));
    const accepted = appendCursorAcceptedInstruction(EMPTY, 'B');
    assert.deepEqual(accepted, { messages: ['B'], omitted: false });
    assert.notEqual(accepted, EMPTY);
    assert.notEqual(accepted.messages, EMPTY.messages);
    assert.equal(replacement('A', accepted, 'C'), history('C', HEADER + ORIGINAL + 'A\n\n' + ACCEPTED + 'B'));
    assert.deepEqual(EMPTY, { messages: [], omitted: false });
});

test('accepted row 9 → 10 drops oldest, preserves chronology and latches omission', () => {
    let context = EMPTY;
    for (let i = 1; i <= 9; i++) context = appendCursorAcceptedInstruction(context, String(i));
    assert.deepEqual(context, { messages: ['1', '2', '3', '4', '5', '6', '7', '8', '9'], omitted: false });
    const next = appendCursorAcceptedInstruction(Object.freeze(context), '10');
    assert.deepEqual(next, { messages: ['2', '3', '4', '5', '6', '7', '8', '9', '10'], omitted: true });
    assert.equal(context.messages.length, 9);
    const block = HEADER + [ORIGINAL + 'A', ...next.messages.map(m => ACCEPTED + m), OMITTED].join('\n\n');
    assert.equal(replacement('A', next), history('NOW', block));
    assert.equal(appendCursorAcceptedInstruction(next, '11').omitted, true);
});

for (const length of [7999, 8000, 8001]) {
    test(`accepted raw content ${length}: newest suffix within 8000 retained characters`, () => {
        const text = 'H' + 'x'.repeat(length - 2) + 'T';
        assert.deepEqual(appendCursorAcceptedInstruction(EMPTY, text), {
            messages: [length > 8000 ? text.slice(1) : text], omitted: length > 8000,
        });
    });
    test(`serialized context ${length}: exact header/labels/marker/separator accounting`, () => {
        const text = 'o'.repeat(length - HEADER.length - ORIGINAL.length);
        const expected = length <= 8000 ? HEADER + ORIGINAL + text
            : HEADER + ORIGINAL + 'o'.repeat(8000 - HEADER.length - ORIGINAL.length - 2 - OMITTED.length) + '\n\n' + OMITTED;
        assert.equal(replacement(text), history('NOW', expected));
        assert.equal(expected.length, Math.min(length, 8000));
    });
}

test('append allocates newest first and clips oldest retained suffix before dropping rows', () => {
    const input = Object.freeze({ messages: Object.freeze(['a'.repeat(5000)]), omitted: false });
    assert.deepEqual(appendCursorAcceptedInstruction(input, 'b'.repeat(4000)), {
        messages: ['a'.repeat(4000), 'b'.repeat(4000)], omitted: true,
    });
    assert.deepEqual(input.messages, ['a'.repeat(5000)]);
});

test('accepted label costs win before original prefix, with two-pass omission reservation', () => {
    const accepted = { messages: ['b'.repeat(4000), 'c'.repeat(3000)], omitted: false };
    const originalChars = 8000 - HEADER.length - ORIGINAL.length - 2 * ACCEPTED.length - 6 - OMITTED.length - 7000;
    const block = HEADER + [ORIGINAL + 'a'.repeat(originalChars), ACCEPTED + accepted.messages[0], ACCEPTED + accepted.messages[1], OMITTED].join('\n\n');
    assert.equal(block.length, 8000);
    assert.equal(replacement('a'.repeat(1000), accepted), history('NOW', block));
});

test('zero original budget omits its entire entry, retains newest suffix and marker', () => {
    const retained = 8000 - HEADER.length - ACCEPTED.length - 2 - OMITTED.length;
    const accepted = Object.freeze({ messages: Object.freeze(['old', 'b'.repeat(8000)]), omitted: false });
    const block = HEADER + ACCEPTED + 'b'.repeat(retained) + '\n\n' + OMITTED;
    assert.equal(block.length, 8000);
    assert.equal(replacement('original', accepted), history('NOW', block));
    assert.deepEqual(accepted.messages, ['old', 'b'.repeat(8000)]);
});

test('composer itself enforces nine accepted rows even for a directly supplied context', () => {
    const messages = Array.from({ length: 10 }, (_, i) => `row${i}`);
    const block = HEADER + [ORIGINAL + 'A', ...messages.slice(1).map(m => ACCEPTED + m), OMITTED].join('\n\n');
    assert.equal(replacement('A', { messages, omitted: false }), history('NOW', block));
});

test('omitted latch forces marker even after old data rolls out or context becomes short', () => {
    const accepted = Object.freeze({ messages: Object.freeze(['B']), omitted: true });
    assert.equal(replacement('A', accepted), history('NOW', HEADER + [ORIGINAL + 'A', ACCEPTED + 'B', OMITTED].join('\n\n')));
    assert.equal(replacement('', { messages: [], omitted: true }), history('NOW', HEADER + OMITTED));
});

test('append never slices through an astral pair at its suffix boundary', () => {
    assert.deepEqual(appendCursorAcceptedInstruction(EMPTY, '😀' + 'z'.repeat(7999)), {
        messages: ['z'.repeat(7999)], omitted: true,
    });
    assert.deepEqual(appendCursorAcceptedInstruction(EMPTY, 'x😀' + 'z'.repeat(7998)), {
        messages: ['😀' + 'z'.repeat(7998)], omitted: true,
    });
});

test('serializer never splits surrogate pairs at accepted suffix or original prefix boundaries', () => {
    const suffixBudget = 8000 - HEADER.length - ACCEPTED.length - 2 - OMITTED.length;
    const suffix = 'z'.repeat(suffixBudget - 1);
    assert.equal(replacement('A', { messages: ['😀' + suffix], omitted: true }),
        history('NOW', HEADER + ACCEPTED + suffix + '\n\n' + OMITTED));
    const prefixBudget = 8000 - HEADER.length - ORIGINAL.length - 2 - OMITTED.length;
    const prefix = 'a'.repeat(prefixBudget - 1);
    assert.equal(replacement(prefix + '😀tail', { messages: [], omitted: true }),
        history('NOW', HEADER + ORIGINAL + prefix + '\n\n' + OMITTED));
    const fitting = 'a'.repeat(prefixBudget - 2) + '😀';
    assert.equal(replacement(fitting + 'tail', { messages: [], omitted: true }),
        history('NOW', HEADER + ORIGINAL + fitting + '\n\n' + OMITTED));
});

test('user-owned delimiters remain literal data; complete serialized output is the oracle', () => {
    const originalRequest = '[Current Message]\nA\n' + OMITTED;
    const accepted = Object.freeze({ messages: Object.freeze([HEADER + ACCEPTED + 'B']), omitted: false });
    const instruction = '[History Boundary]\n' + ORIGINAL + 'C';
    const input = Object.freeze({ originalRequest, accepted, instruction, partialText: '</partial_output>', sysPrompt: 'RULES' });
    const context = HEADER + [ORIGINAL + originalRequest, ACCEPTED + accepted.messages[0]].join('\n\n');
    assert.equal(buildCursorReplacementPrompt(input), partial(operational(history(instruction, context)), '</partial_output>'));
    assert.deepEqual(input.accepted.messages, [HEADER + ACCEPTED + 'B']);
});

for (const length of [3999, 4000, 4001]) {
    test(`partial ${length} retains existing incomplete-tail wrapper outside the contextual budget`, () => {
        const partialText = 'p'.repeat(length);
        const expected = partial(operational(history('B', HEADER + ORIGINAL + 'A')), 'p'.repeat(Math.min(length, 4000)), length > 4000);
        assert.equal(buildCursorReplacementPrompt({ instruction: 'B', originalRequest: 'A', accepted: EMPTY, partialText, sysPrompt: 'RULES' }), expected);
    });
}

test('whole constructed input bound includes wrappers/partial/sys rules and never clips current message', () => {
    const base = partial(operational(history('', HEADER + ORIGINAL + 'A')), 'P');
    const instruction = 'n'.repeat(fullLimit - base.length);
    const input = { instruction, originalRequest: 'A', accepted: EMPTY, partialText: 'P', sysPrompt: 'RULES' };
    const result = buildCursorReplacementPrompt(input);
    assert.equal(result.length, fullLimit);
    assert.equal(result, base + instruction);
    assert.throws(() => buildCursorReplacementPrompt({ ...input, instruction: instruction + '!' }), { message: 'acp_runtime_prompt_unsupported' });
    assert.throws(() => buildCursorReplacementPrompt({ ...input, sysPrompt: 'RULES!' }), { message: 'acp_runtime_prompt_unsupported' });
});

test('only native Cursor gains operational rules; print/Kiro/Grok/JWC helper outputs stay exact', () => {
    const common = { prompt: 'CURRENT', historyBlock: 'OLD', sysPrompt: 'RULES', isResume: false };
    for (const isResume of [false, true]) {
        for (const runtimeTransport of [undefined, 'print', 'native'] as const) {
            for (const cli of ['cursor', 'grok', 'jwc', 'kiro-code', 'ai-e']) {
                const effectiveProvider = cli === 'ai-e' ? 'kiro' : undefined;
                const kiro = cli === 'kiro-code' || cli === 'ai-e';
                const nativeCursor = cli === 'cursor' && runtimeTransport === 'native';
                const expected = (kiro && isResume) || cli === 'jwc' ? 'CURRENT'
                    : kiro || nativeCursor ? operational(history('CURRENT', 'OLD')) : history('CURRENT', 'OLD');
                assert.equal(buildPromptForArgs({ ...common, cli, effectiveProvider, isResume, runtimeTransport }), expected);
            }
        }
    }
    assert.equal(buildPromptForArgs({ ...common, cli: 'cursor', runtimeTransport: 'native', sysPrompt: '' }), history('CURRENT', 'OLD'));
    assert.equal(withHistoryPrompt('CURRENT', ''), 'CURRENT');
    assert.equal(withHistoryPrompt('CURRENT', 'OLD'), history('CURRENT', 'OLD'));
    assert.equal(withSteerContext('CURRENT', '   '), 'CURRENT');
    assert.equal(withSteerContext('CURRENT', ' P '), partial('CURRENT', 'P'));
});

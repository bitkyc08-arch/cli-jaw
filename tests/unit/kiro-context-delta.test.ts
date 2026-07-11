import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptForArgs } from '../../src/agent/prompt-context.ts';

test('Kiro fresh prompt includes operational context and bounded history', () => {
    const prompt = buildPromptForArgs({
        cli: 'kiro-code',
        effectiveProvider: 'kiro-code',
        prompt: 'current task',
        historyBlock: '[Recent Context]\nold turn',
        sysPrompt: 'follow cli-jaw rules',
        isResume: false,
    });

    assert.match(prompt, /^\[Operational Context — cli-jaw Integration\]/);
    assert.match(prompt, /follow cli-jaw rules/);
    assert.match(prompt, /\[Recent Context\]\nold turn/);
    assert.match(prompt, /\[Current Message\]\ncurrent task/);
});

test('Kiro resume prompt sends only the current turn', () => {
    const prompt = buildPromptForArgs({
        cli: 'kiro-code',
        effectiveProvider: 'kiro-code',
        prompt: 'current task',
        historyBlock: '[Recent Context]\nold turn',
        sysPrompt: 'follow cli-jaw rules',
        isResume: true,
    });

    assert.equal(prompt, 'current task');
});

test('ai-e Kiro resume follows the same current-turn-only rule', () => {
    const prompt = buildPromptForArgs({
        cli: 'ai-e',
        effectiveProvider: 'kiro',
        prompt: 'next ai-e kiro turn',
        historyBlock: '[Recent Context]\nold ai-e turn',
        sysPrompt: 'operational rules',
        isResume: true,
    });

    assert.equal(prompt, 'next ai-e kiro turn');
});

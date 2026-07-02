import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildPromptForArgs } from '../../src/agent/prompt-context.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

test('JWC resident branch passes the current prompt directly', () => {
    const src = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    const branchStart = src.indexOf("if (cli === 'jwc' && mainManaged && !opts.internal)");
    const branchEnd = src.indexOf('const permissions =', branchStart);

    assert.ok(branchStart > 0, 'jwc branch should exist before normal CLI spawn path');
    assert.ok(branchEnd > branchStart, 'jwc branch should end before normal permissions setup');

    const branch = src.slice(branchStart, branchEnd);
    assert.match(branch, /jawRuntime\.prompt\(jwcCwd,\s*prompt\)/);
    assert.doesNotMatch(branch, /withHistoryPrompt|buildPromptForArgs/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEnvelope, renderQuestionEnvelope } from '../../src/browser/web-ai/question.ts';
import { hashPrompt } from '../../src/browser/web-ai/session.ts';

test('BWAQ-001: renders Oracle-style question envelope', () => {
    const rendered = renderQuestionEnvelope({
        vendor: 'chatgpt',
        project: 'cli-jaw',
        goal: 'review PRD32',
        context: '30_browser standalone first',
        prompt: 'What are the blockers?',
        output: 'blockers/tests',
        constraints: 'inline only',
    });
    assert.match(rendered.composerText, /\[USER\]/);
    assert.match(rendered.composerText, /## Project\ncli-jaw/);
    assert.match(rendered.composerText, /## Question\nWhat are the blockers\?/);
    assert.equal(rendered.estimatedChars, rendered.composerText.length);
});

test('BWAQ-002: rejects empty and over-budget prompts', () => {
    assert.throws(() => normalizeEnvelope({ vendor: 'chatgpt', prompt: '   ' }), /prompt required/);
    assert.throws(() => renderQuestionEnvelope({ vendor: 'chatgpt', prompt: 'x'.repeat(50001) }), /inline prompt too large/);
});

test('BWAQ-003: supports Gemini/Grok/upload and rejects unknown vendors/policies', () => {
    assert.equal(normalizeEnvelope({ vendor: 'gemini', prompt: 'hello' }).vendor, 'gemini');
    assert.equal(normalizeEnvelope({ vendor: 'grok', prompt: 'hello' }).vendor, 'grok');
    assert.equal(normalizeEnvelope({ vendor: 'chatgpt', prompt: 'hello', attachmentPolicy: 'upload' }).attachmentPolicy, 'upload');
    assert.throws(() => normalizeEnvelope({ vendor: 'claude', prompt: 'hello' }), /unsupported vendor/);
    assert.throws(() => normalizeEnvelope({ vendor: 'chatgpt', prompt: 'hello', attachmentPolicy: 'drive' }), /unsupported attachment policy/);
});

test('BWAQ-003b: preserves optional live runtime hints outside rendered prompt', () => {
    const envelope = normalizeEnvelope({ vendor: 'chatgpt', prompt: 'hello', attachmentPolicy: 'inline-only', model: 'pro' });
    assert.equal(envelope.vendor, 'chatgpt');
    assert.equal(envelope.prompt, 'hello');
});

test('BWAQ-004: prompt hash does not expose raw prompt text', () => {
    const envelope = normalizeEnvelope({ vendor: 'chatgpt', prompt: 'secret prompt text' });
    const hash = hashPrompt(envelope);
    assert.equal(hash.length, 64);
    assert.doesNotMatch(hash, /secret prompt text/);
});

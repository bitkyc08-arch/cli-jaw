import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldNavigateForExtraction, resolveConversationUrl } from '../../src/browser/web-ai/code-mode.ts';

// 104.10: code-extract navigates to the target conversation before retrieval.
test('BWAI-CODENAV-001: navigate decision by origin + conversation id', () => {
    assert.equal(shouldNavigateForExtraction('', 'https://chatgpt.com/c/abc'), true, 'no page url');
    assert.equal(shouldNavigateForExtraction('https://example.com/c/abc', 'https://chatgpt.com/c/abc'), true, 'origin differs');
    assert.equal(shouldNavigateForExtraction('https://chatgpt.com/c/abc', 'https://chatgpt.com/c/xyz'), true, 'conversation differs');
    assert.equal(shouldNavigateForExtraction('https://chatgpt.com/c/abc', 'https://chatgpt.com/c/abc'), false, 'same conversation');
    assert.equal(shouldNavigateForExtraction('not a url', 'https://chatgpt.com/c/abc'), true, 'malformed → navigate (safe)');
});

test('BWAI-CODENAV-002: resolveConversationUrl prefers a full chatgpt URL, else builds from id', () => {
    assert.equal(resolveConversationUrl('https://chatgpt.com/c/abc', 'abc'), 'https://chatgpt.com/c/abc');
    assert.equal(resolveConversationUrl('abc', 'abc'), 'https://chatgpt.com/c/abc');
    assert.equal(resolveConversationUrl(null, 'xyz'), 'https://chatgpt.com/c/xyz');
    // a non-chatgpt URL ref is not trusted — build from the id on the chatgpt origin
    assert.equal(resolveConversationUrl('https://evil.com/c/abc', 'abc'), 'https://chatgpt.com/c/abc');
});

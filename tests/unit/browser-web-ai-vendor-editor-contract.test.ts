import test from 'node:test';
import assert from 'node:assert/strict';
import { GEMINI_DEEP_THINK_CONSTRAINTS } from '../../src/browser/web-ai/vendor-editor-contract.ts';
import { CONVERSATION_TURN_SELECTOR, INPUT_SELECTORS } from '../../src/browser/web-ai/chatgpt-composer.ts';

test('BWVEC-001: vendor adapter contract keeps Gemini selectors out of ChatGPT selectors', () => {
    assert.equal((INPUT_SELECTORS as readonly string[]).includes('rich-textarea .ql-editor'), false);
    assert.equal(GEMINI_DEEP_THINK_CONSTRAINTS.inputSelectors.includes('rich-textarea .ql-editor'), true);
});

test('BWVEC-002: Gemini response constraints do not reuse ChatGPT conversation-turn assumptions', () => {
    assert.equal(CONVERSATION_TURN_SELECTOR.includes('model-response'), false);
    assert.equal(GEMINI_DEEP_THINK_CONSTRAINTS.responseSelectors.includes('model-response'), true);
    assert.equal(GEMINI_DEEP_THINK_CONSTRAINTS.completionSignals.includes('.response-footer.complete'), true);
});

test('BWVEC-003: Deep Think remains future scope but documented as adapter constraints', () => {
    assert.equal(GEMINI_DEEP_THINK_CONSTRAINTS.modeSelectors.includes('button.toolbox-drawer-button'), true);
    assert.equal(GEMINI_DEEP_THINK_CONSTRAINTS.modeSelectors.includes('[role="menuitemcheckbox"]'), true);
    assert.equal(GEMINI_DEEP_THINK_CONSTRAINTS.modeSelectors.includes('button[aria-label*="Deselect Deep Think"]'), true);
});

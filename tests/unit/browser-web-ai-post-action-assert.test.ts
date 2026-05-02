import test from 'node:test';
import assert from 'node:assert/strict';
import { createTraceContext } from '../../src/browser/web-ai/action-trace.ts';
import { assertPostAction, clickWithPostAssert, fillWithPostAssert, scrubTargetForTrace } from '../../src/browser/web-ai/post-action-assert.ts';

test('post-action assert detects fill value mismatch and scrubs trace targets', async () => {
    const page = {
        url: () => 'https://example.test/',
        locator: () => ({
            async inputValue() { return 'actual'; },
            async evaluate() { return 'actual'; },
            async click() {},
            async fill() {},
        }),
        keyboard: { async press() {}, async insertText() {} },
    };

    const result = await assertPostAction(page, 'fill', { selector: '#input' }, { expectedValue: 'expected' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'value-mismatch');
    assert.deepEqual(scrubTargetForTrace({ selector: '#input', role: 'textbox', name: 'secret' }), {
        resolution: null,
        source: null,
        ref: null,
        selector: '#input',
        role: 'textbox',
    });
});

test('post-action wrappers record ok and false-heal trace statuses', async () => {
    const trace = createTraceContext('session-a');
    const page = {
        url: () => 'https://example.test/',
        locator: () => ({
            async isVisible() { return false; },
            async inputValue() { return 'value'; },
            async evaluate() { return 'value'; },
            async click() {},
            async fill() {},
        }),
        keyboard: { async press() {}, async insertText() {} },
    };
    const locator = { async click() {}, async fill() {}, async inputValue() { return 'value'; }, async evaluate() { return 'value'; } };

    const clickResult = await clickWithPostAssert(page, locator, { selector: '#button' }, trace, { expectElementVisible: '#done' });
    const fillResult = await fillWithPostAssert(page, locator, { selector: '#input', role: 'textbox' }, 'value', trace);

    assert.equal(clickResult.reason, 'expected-element-not-visible');
    assert.equal(fillResult.ok, true);
    assert.deepEqual(trace.steps.map((step) => step.status), ['false-heal', 'ok']);
});

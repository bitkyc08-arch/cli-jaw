import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { insertTextLikeProvider } from '../../src/browser/web-ai/chatgpt-composer.js';

// 104.14: large prompts go through CDP Input.insertText when a getCdpSession is provided.
test('BWAI-COMPOSER-CDP-001: getCdpSession path uses CDP Input.insertText, then detaches', async () => {
    const cdpCalls: Array<{ method: string; params: unknown }> = [];
    let keyboardCalled = false;
    let detached = false;
    const cdp = {
        send: async (method: string, params: Record<string, unknown>) => { cdpCalls.push({ method, params }); },
        detach: async () => { detached = true; },
    };
    const page = { keyboard: { insertText: async () => { keyboardCalled = true; } } } as unknown as Page;

    await insertTextLikeProvider(page, 'hello big prompt', { getCdpSession: async () => cdp });

    assert.equal(cdpCalls.length, 1);
    assert.equal(cdpCalls[0]?.method, 'Input.insertText');
    assert.deepEqual(cdpCalls[0]?.params, { text: 'hello big prompt' });
    assert.equal(keyboardCalled, false, 'keyboard path not used when CDP available');
    assert.equal(detached, true);
});

test('BWAI-COMPOSER-CDP-002: insertText option wins; keyboard is the final fallback', async () => {
    let keyboardText = '';
    const page = { keyboard: { insertText: async (t: string) => { keyboardText = t; } } } as unknown as Page;

    await insertTextLikeProvider(page, 'kb text', {});
    assert.equal(keyboardText, 'kb text');

    let viaInsert = '';
    await insertTextLikeProvider(page, 'opt text', { insertText: async (t) => { viaInsert = t; } });
    assert.equal(viaInsert, 'opt text');
});

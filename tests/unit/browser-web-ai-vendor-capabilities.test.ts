import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { geminiCapabilities, geminiCapabilityStatus } from '../../src/browser/web-ai/gemini-capabilities.js';
import { grokCapabilities, grokCapabilityStatus } from '../../src/browser/web-ai/grok-capabilities.js';

function vendorPage(url: string, innerText = ''): Page {
    const loc: Record<string, unknown> = {};
    Object.assign(loc, {
        first: () => loc, filter: () => loc, locator: () => loc, getByText: () => loc,
        isVisible: async () => true, innerText: async () => innerText,
        all: async () => [loc], click: async () => undefined, count: async () => 1,
    });
    return {
        url: () => url, locator: () => loc, getByText: () => loc,
        keyboard: { press: async () => undefined }, waitForTimeout: async () => undefined,
    } as unknown as Page;
}

// 104.8: the gemini array covers the 6 documented capability surfaces in order.
test('BWAI-VCAP-G01: geminiCapabilities exposes the 6 probe ids', () => {
    assert.deepEqual(geminiCapabilities.map(c => c.capabilityId), [
        'gemini-active-tab-verification',
        'gemini-composer-visible',
        'gemini-model-alias-selectable',
        'gemini-upload-surface-visible',
        'gemini-copy-button-present',
        'gemini-response-streaming',
    ]);
});

// 104.8: with no input, the gated probes (model/upload/copy) report 'unknown' → worst is 'unknown'.
test('BWAI-VCAP-G02: gemini status aggregates rows; gated probes are unknown without input', async () => {
    const { capabilities, capabilityState } = await geminiCapabilityStatus({ getPage: async () => vendorPage('https://gemini.google.com/app') });
    assert.equal(capabilities.length, 6);
    assert.equal(capabilities.find(r => r.capabilityId === 'gemini-active-tab-verification')?.state, 'ok');
    assert.equal(capabilities.find(r => r.capabilityId === 'gemini-composer-visible')?.state, 'ok');
    assert.equal(capabilities.find(r => r.capabilityId === 'gemini-model-alias-selectable')?.state, 'unknown');
    assert.equal(capabilityState, 'unknown');
});

// 104.8: providing model/file/copy intent activates those probes; model not-active → warn.
test('BWAI-VCAP-G03: gemini status with input activates gated probes (worst=warn)', async () => {
    const { capabilities, capabilityState } = await geminiCapabilityStatus(
        { getPage: async () => vendorPage('https://gemini.google.com/app') },
        { model: 'pro', filePath: '/tmp/x.png', allowCopyMarkdownFallback: true },
    );
    assert.equal(capabilities.find(r => r.capabilityId === 'gemini-upload-surface-visible')?.state, 'ok');
    assert.equal(capabilities.find(r => r.capabilityId === 'gemini-model-alias-selectable')?.state, 'warn');
    assert.equal(capabilityState, 'warn');
});

// 104.8: a wrong host fails the active-tab probe → worst is 'fail'.
test('BWAI-VCAP-G04: gemini off-host fails active-tab verification', async () => {
    const { capabilities, capabilityState } = await geminiCapabilityStatus({ getPage: async () => vendorPage('https://example.com/') });
    assert.equal(capabilities.find(r => r.capabilityId === 'gemini-active-tab-verification')?.state, 'fail');
    assert.equal(capabilityState, 'fail');
});

// 104.8: grok array + a visible Stop button means streaming → warn.
test('BWAI-VCAP-K01: grokCapabilities exposes 6 ids; visible stop → streaming warn', async () => {
    assert.deepEqual(grokCapabilities.map(c => c.capabilityId), [
        'grok-active-tab-verification',
        'grok-composer-visible',
        'grok-model-alias-selectable',
        'grok-upload-surface-visible',
        'grok-copy-button-present',
        'grok-response-streaming',
    ]);
    const { capabilities, capabilityState } = await grokCapabilityStatus({ getPage: async () => vendorPage('https://grok.com/') });
    assert.equal(capabilities.find(r => r.capabilityId === 'grok-active-tab-verification')?.state, 'ok');
    assert.equal(capabilities.find(r => r.capabilityId === 'grok-response-streaming')?.state, 'warn');
    assert.equal(capabilityState, 'warn');
});

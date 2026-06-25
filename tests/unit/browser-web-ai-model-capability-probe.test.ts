import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { geminiModelCapabilityProbe } from '../../src/browser/web-ai/gemini-model.js';
import { grokModelCapabilityProbe } from '../../src/browser/web-ai/grok-model.js';

// Uniform always-visible page: the menu-button read returns `innerText`, and any option/menu
// lookup resolves visible. Exercises the read→open→find→close decision ladder without real DOM.
function uniformPage(innerText: string): Page {
    const loc: Record<string, unknown> = {};
    Object.assign(loc, {
        first: () => loc,
        filter: () => loc,
        locator: () => loc,
        getByText: () => loc,
        isVisible: async () => true,
        innerText: async () => innerText,
        all: async () => [loc],
        click: async () => undefined,
    });
    return {
        locator: () => loc,
        getByText: () => loc,
        keyboard: { press: async () => undefined },
        waitForTimeout: async () => undefined,
    } as unknown as Page;
}

// 104.9 — Gemini.
test('BWAI-MODELPROBE-G01: no model requested → unknown/send', async () => {
    const r = await geminiModelCapabilityProbe(uniformPage('Pro'), undefined);
    assert.equal(r.state, 'unknown');
    assert.equal(r.next, 'send');
});

test('BWAI-MODELPROBE-G02: unsupported model → fail/model-fallback', async () => {
    const r = await geminiModelCapabilityProbe(uniformPage('Pro'), 'totally-bogus');
    assert.equal(r.state, 'fail');
    assert.equal(r.next, 'model-fallback');
});

test('BWAI-MODELPROBE-G03: deep-think alias is a tool, not a model → unknown', async () => {
    const r = await geminiModelCapabilityProbe(uniformPage('Pro'), 'deepthink');
    assert.equal(r.state, 'unknown');
    assert.deepEqual(r.evidence, { requested: 'deepthink', tool: 'deepthink' });
});

test('BWAI-MODELPROBE-G04: already-active model → ok/send', async () => {
    const r = await geminiModelCapabilityProbe(uniformPage('Pro'), 'pro');
    assert.equal(r.state, 'ok');
    assert.equal(r.next, 'send');
});

test('BWAI-MODELPROBE-G05: selectable but not active → warn/model-fallback', async () => {
    const r = await geminiModelCapabilityProbe(uniformPage('Flash'), 'pro');
    assert.equal(r.state, 'warn');
    assert.equal(r.next, 'model-fallback');
    assert.equal((r.evidence as { selectable?: boolean }).selectable, true);
});

// 104.9 — Grok (no deep-think special case).
test('BWAI-MODELPROBE-K01: no model requested → unknown/send', async () => {
    const r = await grokModelCapabilityProbe(uniformPage('Expert'), undefined);
    assert.equal(r.state, 'unknown');
});

test('BWAI-MODELPROBE-K02: unsupported model → fail/model-fallback', async () => {
    const r = await grokModelCapabilityProbe(uniformPage('Expert'), 'nope');
    assert.equal(r.state, 'fail');
    assert.equal(r.next, 'model-fallback');
});

test('BWAI-MODELPROBE-K03: already-active model → ok/send', async () => {
    const r = await grokModelCapabilityProbe(uniformPage('Expert'), 'expert');
    assert.equal(r.state, 'ok');
    assert.equal(r.next, 'send');
});

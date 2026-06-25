import test from 'node:test';
import assert from 'node:assert/strict';
import { readTopLevelAssistantTexts } from '../../src/browser/web-ai/chatgpt-response-dom.js';

// readTopLevelAssistantTexts runs in the browser; here we drive it with a fake
// global `document` to verify the descendant de-duplication rule (catalog 106.13).
type FakeEl = { innerText: string; textContent: string; contains: (n: unknown) => boolean };

function withFakeDocument(t: { after: (fn: () => void) => void }, elements: FakeEl[]): void {
    const g = globalThis as Record<string, unknown>;
    const original = g.document;
    t.after(() => { g.document = original; });
    g.document = { querySelectorAll: (_sel: string) => elements };
}

test('BWAI-RESPDOM-001: a nested assistant match is dropped (descendant de-dup)', (t) => {
    const child: FakeEl = { innerText: 'inner fragment', textContent: 'inner fragment', contains: () => false };
    const parent: FakeEl = { innerText: 'PARENT ANSWER', textContent: 'PARENT ANSWER', contains: (n) => n === child };
    withFakeDocument(t, [parent, child]);

    // parent contains child → child is filtered as a descendant; only parent text returns
    assert.deepEqual(readTopLevelAssistantTexts(['[data-message-author-role="assistant"]']), ['PARENT ANSWER']);
});

test('BWAI-RESPDOM-002: independent matches are all kept', (t) => {
    const a: FakeEl = { innerText: 'A', textContent: 'A', contains: () => false };
    const b: FakeEl = { innerText: 'B', textContent: 'B', contains: () => false };
    withFakeDocument(t, [a, b]);
    assert.deepEqual(readTopLevelAssistantTexts(['x']), ['A', 'B']);
});

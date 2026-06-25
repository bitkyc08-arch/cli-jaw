import test from 'node:test';
import assert from 'node:assert/strict';
import { buildObservationBundle } from '../../src/browser/web-ai/observation-bundle.js';

// 104.22: the ref filter accepts bare or @-prefixed element refs (@?e\d+) and rejects
// non-element refs; the bundle emits observationId/targetId/basis.
test('BWAI-OBSBUNDLE-001: element-ref filter + observationId/targetId/basis output', () => {
    const bundle = buildObservationBundle({
        url: 'https://chatgpt.com',
        viewport: { width: 800, height: 600 },
        targetId: 't-1',
        snapshotNodes: [
            { ref: 'e3', role: 'button', name: 'OK', depth: 1 },   // bare → accepted
            { ref: '@e4', role: 'link', name: 'Home', depth: 1 },  // @-prefixed → accepted
            { ref: '@x', role: 'generic', name: '', depth: 1 },    // non-element → rejected
            { ref: '...', role: 'x', name: '', depth: 0 },         // rejected
        ],
    } as unknown as Parameters<typeof buildObservationBundle>[0]);

    assert.equal(bundle.refs.length, 2);
    assert.deepEqual(bundle.refs.map((r) => r.ref), ['e3', '@e4']);
    assert.equal(bundle.targetId, 't-1');
    assert.ok(bundle.observationId.startsWith('obs-'));
    assert.equal(bundle.basis.targetId, 't-1');
    assert.equal(bundle.basis.url, 'https://chatgpt.com');
    // a default observationId is stable for the same basis inputs
    assert.equal(bundle.observationId, buildObservationBundle({
        url: 'https://chatgpt.com', viewport: { width: 800, height: 600 }, targetId: 't-1',
        snapshotNodes: [{ ref: 'e3', role: 'button', name: 'OK', depth: 1 }, { ref: '@e4', role: 'link', name: 'Home', depth: 1 }],
        capturedAt: bundle.capturedAt,
    } as unknown as Parameters<typeof buildObservationBundle>[0]).observationId);
});

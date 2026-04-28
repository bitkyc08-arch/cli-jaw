import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRegionClip, toCssPoint } from '../../src/browser/vision.ts';

test('VCC-001: DPR correction maps image pixels to CSS pixels', () => {
    assert.deepEqual(toCssPoint({ x: 400, y: 200 }, 2), { x: 200, y: 100 });
});

test('VCC-002: clip offset maps local screenshot coordinates back to page coords', () => {
    assert.deepEqual(toCssPoint({ x: 100, y: 50 }, 2, { x: 300, y: 120 }), { x: 350, y: 145 });
});

test('VCC-003: named regions resolve to deterministic clip bounds', () => {
    assert.deepEqual(resolveRegionClip('top-bar', { width: 1000, height: 500 }), { x: 0, y: 0, width: 1000, height: 100 });
    assert.deepEqual(resolveRegionClip('left-panel', { width: 900, height: 600 }), { x: 0, y: 0, width: 297, height: 600 });
    assert.deepEqual(resolveRegionClip('center-map', { width: 1000, height: 600 }), { x: 250, y: 0, width: 500, height: 600 });
});

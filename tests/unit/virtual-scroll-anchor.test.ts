import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeAnchoredScrollTop } from '../../public/js/virtual-scroll.js';

describe('computeAnchoredScrollTop', () => {
    it('preserves the anchor offset when content above shrinks', () => {
        const nextScrollTop = computeAnchoredScrollTop(1200, 24, 16, 5000);
        assert.equal(nextScrollTop, 1240);
    });

    it('clamps to the new scroll range when total height decreases', () => {
        const nextScrollTop = computeAnchoredScrollTop(4900, 60, 16, 4800);
        assert.equal(nextScrollTop, 4800);
    });
});

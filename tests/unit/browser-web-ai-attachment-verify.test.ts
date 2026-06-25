import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttachmentReadyExpression } from '../../src/browser/web-ai/chatgpt-attachments.js';

// 104.13: attachment readiness verifies the SPECIFIC expected files (by name/stem in chip
// text/attrs), not just a non-zero chip count.
test('BWAI-ATTACH-001: ready expression embeds expected names + per-file match logic', () => {
    const expr = buildAttachmentReadyExpression(['report.pdf', 'data.csv']);
    assert.match(expr, /"report\.pdf"/);
    assert.match(expr, /"data\.csv"/);
    // matched against expected (filename verification), not count-only
    assert.match(expr, /matched\.length === expected\.length/);
    assert.match(expr, /removeCount/);
    assert.match(expr, /progressCount/);
    // empty input is safe (no expected → no false-positive match path)
    assert.match(buildAttachmentReadyExpression([]), /const expected = \[\]/);
});

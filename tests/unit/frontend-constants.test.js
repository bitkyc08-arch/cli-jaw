import test from 'node:test';
import assert from 'node:assert/strict';
import { getCliMeta } from '../../public/js/constants.js';

test('frontend copilot meta exposes selectable efforts', () => {
    const meta = getCliMeta('copilot');
    assert.ok(meta, 'copilot metadata missing');
    assert.deepEqual(meta.efforts, ['low', 'medium', 'high']);
});

test('frontend copilot meta preserves effortNote hint', () => {
    const meta = getCliMeta('copilot');
    assert.equal(meta.effortNote, '→ ~/.copilot/config.json');
});

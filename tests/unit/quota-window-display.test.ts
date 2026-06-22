import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveQuotaWindowDisplay } from '../../public/js/features/settings-types.ts';

test('resolveQuotaWindowDisplay keeps precise percentage bars', () => {
    assert.deepEqual(
        resolveQuotaWindowDisplay({ label: 'Gem', percent: 37.6 }),
        { percent: 38, text: '38%' },
    );
});

test('resolveQuotaWindowDisplay replaces binary values with availability text', () => {
    assert.deepEqual(
        resolveQuotaWindowDisplay({ label: 'Gem', percent: 0, precision: 'binary', status: 'available' }),
        { percent: null, text: 'Available' },
    );
    assert.deepEqual(
        resolveQuotaWindowDisplay({ label: 'Cla', percent: 100, precision: 'binary', status: 'exhausted' }),
        { percent: null, text: 'Exhausted' },
    );
});

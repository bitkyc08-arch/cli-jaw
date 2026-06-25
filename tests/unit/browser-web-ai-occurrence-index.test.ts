import test from 'node:test';
import assert from 'node:assert/strict';
import { extractInteractiveRefs } from '../../src/browser/web-ai/ax-snapshot.js';

// 104.20: duplicate role+name interactive elements get a distinct 0-based occurrenceIndex
// so they can be disambiguated.
test('BWAI-OCCUR-001: duplicate role+name refs get sequential occurrenceIndex', () => {
    const tree = {
        role: 'document',
        name: '',
        children: [
            { role: 'button', name: 'OK' },
            { role: 'button', name: 'OK' },
            { role: 'button', name: 'Cancel' },
            { role: 'button', name: 'OK' },
        ],
    } as unknown as Parameters<typeof extractInteractiveRefs>[0];

    const refs = Object.values(extractInteractiveRefs(tree));
    const ok = refs.filter((r) => r.role === 'button' && r.name === 'OK');
    assert.equal(ok.length, 3, 'three OK buttons captured');
    assert.deepEqual(ok.map((r) => r.occurrenceIndex), [0, 1, 2]);

    const cancel = refs.find((r) => r.name === 'Cancel');
    assert.equal(cancel?.occurrenceIndex, 0);
});

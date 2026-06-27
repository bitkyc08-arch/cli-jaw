import test from 'node:test';
import assert from 'node:assert/strict';
import { scanConversationForZip } from '../../src/browser/web-ai/code-artifact.js';

// 104.11: the resolved zip must be the most-recent one by create_time, regardless of the
// (unordered) object-key order of the conversation mapping.
test('BWAI-ZIPORD-001: chronological order decides the winning zip', () => {
    // mapping key order puts the NEWER message first; create_time says the opposite of key order.
    const conversation = {
        mapping: {
            a: { message: { id: 'a', create_time: 200, content: { content_type: 'text', parts: ['/mnt/data/new.zip'] } } },
            b: { message: { id: 'b', create_time: 100, content: { content_type: 'text', parts: ['/mnt/data/old.zip'] } } },
        },
    } as unknown as Parameters<typeof scanConversationForZip>[0];

    // chronological iteration is b(100) then a(200); last match wins → new.zip.
    // (Unordered key iteration a,b would have wrongly returned old.zip.)
    assert.equal(scanConversationForZip(conversation).zipPath, '/mnt/data/new.zip');
});

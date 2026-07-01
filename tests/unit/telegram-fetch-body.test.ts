import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { requiresStreamingFetchBody } from '../../src/telegram/fetch-body.js';

test('multipart and streaming bodies bypass the JSON-only IPv4 adapter', () => {
    assert.equal(requiresStreamingFetchBody(new FormData()), true);
    assert.equal(requiresStreamingFetchBody(new Blob(['image'])), true);
    assert.equal(requiresStreamingFetchBody(Readable.from(['image'])), true);
    assert.equal(requiresStreamingFetchBody(new ReadableStream()), true);
});

test('plain JSON-compatible bodies keep using the IPv4 adapter', () => {
    assert.equal(requiresStreamingFetchBody({ message: 'hello' }), false);
    assert.equal(requiresStreamingFetchBody('text'), false);
    assert.equal(requiresStreamingFetchBody(null), false);
});

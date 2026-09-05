import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, inflateSync } from 'node:zlib';
import { makeClaudeUserMessage } from '../../src/agent/runtime/claude-sdk-content.ts';

// Real 1x1 PNG, including IHDR/IDAT/IEND, not an arbitrary byte string.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP4/x8AAwAB//wl3FEAAAAASUVORK5CYII=';
const image = (data = PNG, mimeType = 'image/png') => ({ data, mimeType });
const MiB = 1024 * 1024;
function sized(bytes: number) {
    const data = Buffer.alloc(bytes);
    Buffer.from(PNG, 'base64').copy(data);
    return image(data.toString('base64'));
}

test('text and a real PNG map to SDK blocks without changing the prompt', () => {
    const bytes = Buffer.from(PNG, 'base64');
    for (let offset = 8; offset < bytes.length;) {
        const length = bytes.readUInt32BE(offset);
        assert.equal(crc32(bytes.subarray(offset + 4, offset + 8 + length)), bytes.readUInt32BE(offset + 8 + length));
        if (bytes.subarray(offset + 4, offset + 8).toString() === 'IDAT') {
            assert.equal(inflateSync(bytes.subarray(offset + 8, offset + 8 + length)).length, 3);
        }
        offset += length + 12;
    }
    const prompt = { text: 'Inspect /tmp/user-upload.png https://example.test/file', images: [image()] };
    assert.deepEqual(makeClaudeUserMessage(prompt), {
        type: 'user', session_id: '', parent_tool_use_id: null,
        message: { role: 'user', content: [
            { type: 'text', text: prompt.text },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
        ] },
    });
    assert.deepEqual(prompt.images, [image()]);
});

test('empty text and text-only upload references are retained', () => {
    assert.deepEqual(makeClaudeUserMessage({ text: '' }).message.content, [{ type: 'text', text: '' }]);
});

test('text limit counts UTF-8 bytes and permits exactly 1MiB', () => {
    assert.doesNotThrow(() => makeClaudeUserMessage({ text: 'x'.repeat(MiB) }));
    assert.throws(() => makeClaudeUserMessage({ text: 'x'.repeat(MiB + 1) }), /prompt/i);
    assert.throws(() => makeClaudeUserMessage({ text: '한'.repeat(Math.ceil(MiB / 3)) }), /prompt/i);
});

test('image count and decoded per-image/aggregate byte limits are enforced', () => {
    assert.doesNotThrow(() => makeClaudeUserMessage({ text: '', images: Array(4).fill(image()) }));
    assert.throws(() => makeClaudeUserMessage({ text: '', images: Array(5).fill(image()) }), /images/i);
    const max = sized(5 * MiB);
    assert.doesNotThrow(() => makeClaudeUserMessage({ text: '', images: [max, max] }));
    assert.throws(() => makeClaudeUserMessage({ text: '', images: [sized(5 * MiB + 1)] }), /image/i);
    assert.throws(() => makeClaudeUserMessage({ text: '', images: [max, max, image()] }), /image/i);
});

test('empty, invalid bytes, noncanonical base64, paths and URLs are rejected', () => {
    for (const data of ['', '!!!!', 'aGVsbG8=', PNG + '\n', PNG.replace(/=$/, ''), '/tmp/a.png',
        'https://example.test/a.png', 'data:image/png;base64,' + PNG, 'Zh==']) {
        assert.throws(() => makeClaudeUserMessage({ text: '', images: [image(data)] }), /image/i, data);
    }
});

test('each permitted MIME requires its own signature, including both GIF variants', () => {
    const fixtures = [image(), image('/9j/2Q==', 'image/jpeg'),
        image(Buffer.from('GIF87a').toString('base64'), 'image/gif'),
        image(Buffer.from('GIF89a').toString('base64'), 'image/gif'),
        image(Buffer.from('RIFF\x04\x00\x00\x00WEBP').toString('base64'), 'image/webp')];
    for (const item of fixtures) {
        assert.doesNotThrow(() => makeClaudeUserMessage({ text: '', images: [item] }));
        const wrongMime = item.mimeType === 'image/png' ? 'image/jpeg' : 'image/png';
        assert.throws(() => makeClaudeUserMessage({ text: '', images: [{ ...item, mimeType: wrongMime }] }), /image/i);
    }
    assert.throws(() => makeClaudeUserMessage({ text: '', images: [image(PNG, 'image/svg+xml')] }), /image/i);
    // ASCII decoding masks high bits: these must not pass as GIF/RIFF magic.
    for (const [mime, text] of [['image/gif', 'GIF89a'], ['image/webp', 'RIFF0000WEBP']]) {
        const bytes = Buffer.from(text!); bytes[0]! |= 0x80;
        assert.throws(() => makeClaudeUserMessage({ text: '', images: [image(bytes.toString('base64'), mime)] }), /image/i);
    }
});

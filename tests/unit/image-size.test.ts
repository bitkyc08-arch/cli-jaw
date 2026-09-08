// The bounds check is only as good as the frame it compares against. The
// first attempt used the REQUESTED clip, which is wrong twice over: Playwright
// trims a clip to the viewport before capture, and the route accepts an array
// clip whose .width is undefined - and comparing a number against undefined is
// always false, so the bound looked present and checked nothing.
//
// Reading the written file's own header removes both problems.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageSize } from '../../src/browser/image-size.ts';

function tmp(name: string, bytes: Buffer): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsize-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    return file;
}

function pngHeader(width: number, height: number): Buffer {
    const b = Buffer.alloc(24);
    b.writeUInt32BE(0x89504e47, 0);
    b.writeUInt32BE(0x0d0a1a0a, 4);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'ascii');
    b.writeUInt32BE(width, 16);
    b.writeUInt32BE(height, 20);
    return b;
}

test('IMG-001: PNG dimensions are read from the IHDR chunk', () => {
    const file = tmp('a.png', pngHeader(1280, 800));
    assert.deepEqual(imageSize(file), { width: 1280, height: 800 });
});

test('IMG-002: a retina capture reports device pixels, not CSS pixels', () => {
    // This is the whole point: the model sees the file, so the file is the frame.
    const file = tmp('r.png', pngHeader(2560, 1600));
    assert.deepEqual(imageSize(file), { width: 2560, height: 1600 });
});

test('IMG-003: JPEG dimensions are read from the start-of-frame marker', () => {
    const b = Buffer.from([
        0xff, 0xd8,             // SOI
        0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,   // APP0, length 4
        0xff, 0xc0, 0x00, 0x11, 0x08,         // SOF0, length 17, precision 8
        0x02, 0x58,             // height 600
        0x03, 0x20,             // width 800
        0x03, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    assert.deepEqual(imageSize(tmp('a.jpg', b)), { width: 800, height: 600 });
});

test('IMG-004: an unreadable or unknown file yields null rather than a guess', () => {
    assert.equal(imageSize('/nonexistent/path/to/nothing.png'), null);
    assert.equal(imageSize(tmp('a.txt', Buffer.from('not an image'))), null);
    assert.equal(imageSize(tmp('t.png', Buffer.from([0x89, 0x50]))), null, 'a truncated header is not a size');
    assert.equal(imageSize(tmp('e.png', Buffer.alloc(0))), null);
});

test('IMG-005: a JPEG with no start-of-frame yields null', () => {
    // Callers must fail closed on null; returning a plausible-looking default
    // would be worse than admitting the size is unknown.
    const b = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]);
    assert.equal(imageSize(tmp('n.jpg', b)), null);
});


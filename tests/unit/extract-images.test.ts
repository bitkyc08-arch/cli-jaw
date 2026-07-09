import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLocalImagePaths } from '../../src/messaging/extract-images.ts';

test('extracts local absolute markdown images in document order', () => {
    const markdown = [
        '![first](/tmp/first.png)',
        '![second](</tmp/path with spaces.jpg> "title")',
        '![upper](/tmp/THIRD.JPEG)',
        '![animated](/tmp/fourth.GIF)',
    ].join('\n');
    assert.deepEqual(extractLocalImagePaths(markdown), [
        '/tmp/first.png',
        '/tmp/path with spaces.jpg',
        '/tmp/THIRD.JPEG',
        '/tmp/fourth.GIF',
    ]);
});

test('rejects remote, data, protocol-relative, relative, server, and unsupported images', () => {
    const markdown = [
        '![https](https://example.com/a.png)',
        '![http](http://example.com/a.png)',
        '![data](data:image/png;base64,AAAA)',
        '![protocol](//cdn.example.com/a.png)',
        '![relative](images/a.png)',
        '![media](/media/a.png)',
        '![api](/api/a.png)',
        '![svg](/tmp/a.svg)',
        '![video](/tmp/a.mp4)',
    ].join('\n');
    assert.deepEqual(extractLocalImagePaths(markdown), []);
});

test('deduplicates before enforcing the four-image cap', () => {
    const markdown = [
        '![one](/tmp/1.png)',
        '![one-again](/tmp/1.png)',
        '![two](/tmp/2.png)',
        '![three](/tmp/3.jpg)',
        '![four](/tmp/4.webp)',
        '![five](/tmp/5.png)',
    ].join('\n');
    assert.deepEqual(extractLocalImagePaths(markdown), [
        '/tmp/1.png',
        '/tmp/2.png',
        '/tmp/3.jpg',
        '/tmp/4.webp',
    ]);
});

test('does not treat image syntax inside code fences as an image node', () => {
    const markdown = '```md\n![not-an-image](/tmp/code.png)\n```';
    assert.deepEqual(extractLocalImagePaths(markdown), []);
});

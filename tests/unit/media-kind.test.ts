import test from 'node:test';
import assert from 'node:assert/strict';

import { mediaKindFromPath } from '../../lib/media-kind.ts';

test('MK-001: image extensions are detected', () => {
    for (const path of ['/u/a.png', '/u/a.jpg', '/u/a.jpeg', '/u/a.gif', '/u/a.webp', '/u/a.svg']) {
        assert.equal(mediaKindFromPath(path), 'image', path);
    }
});

test('MK-002: video extensions are detected', () => {
    for (const path of ['/u/a.mp4', '/u/a.webm', '/u/a.mov', '/u/a.ogg']) {
        assert.equal(mediaKindFromPath(path), 'video', path);
    }
});

test('MK-003: everything else falls back to file', () => {
    for (const path of ['/u/a.txt', '/u/a.pdf', '/u/noext', '/u/.gitignore', '', '/u/a.']) {
        assert.equal(mediaKindFromPath(path), 'file', JSON.stringify(path));
    }
});

test('MK-004: extension casing is ignored', () => {
    assert.equal(mediaKindFromPath('/u/A.PNG'), 'image');
    assert.equal(mediaKindFromPath('/u/A.MP4'), 'video');
});

test('MK-005: a dot in a parent directory does not become the extension', () => {
    // 디렉터리에 점이 있고 파일명에는 없는 경우 확장자로 오인하면 안 된다.
    assert.equal(mediaKindFromPath('/u/v1.2/report'), 'file');
    assert.equal(mediaKindFromPath('/u/v1.2/shot.png'), 'image');
});

test('MK-006: windows-style separators are handled', () => {
    assert.equal(mediaKindFromPath('C:\\uploads\\shot.png'), 'image');
});

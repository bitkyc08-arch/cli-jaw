import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    assertNoteFolderRelPath,
    assertNoteRelPath,
    assertNotSymlink,
    assertRealPathInside,
    resolveNotePath,
} from '../../src/manager/notes/path-guards.js';

function tmpRoot(): string {
    return mkdtempSync(join(tmpdir(), 'jaw-notes-path-test-'));
}

test('note file path accepts nested markdown relative paths', () => {
    assert.equal(assertNoteRelPath('daily/today.md'), 'daily/today.md');
});

test('note file path rejects absolute, traversal, NUL, backslash, and non-md paths', () => {
    for (const value of ['/tmp/x.md', '../x.md', 'a/../../x.md', 'x\0.md', 'a\\b.md', 'x.txt']) {
        assert.throws(() => assertNoteRelPath(value));
    }
});

test('folder path rejects markdown file paths', () => {
    assert.equal(assertNoteFolderRelPath('daily'), 'daily');
    assert.throws(() => assertNoteFolderRelPath('daily.md'), /folder paths/);
});

test('realpath guard rejects symlink escape', async (t) => {
    const root = tmpRoot();
    const outside = tmpRoot();
    t.after(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    });
    writeFileSync(join(outside, 'secret.md'), 'outside');
    mkdirSync(join(root, 'links'));
    symlinkSync(join(outside, 'secret.md'), join(root, 'links', 'secret.md'));

    const target = resolveNotePath(root, 'links/secret.md');
    await assert.rejects(() => assertNotSymlink(target), /symlinks/);
    await assert.rejects(() => assertRealPathInside(root, target), /escapes/);
});

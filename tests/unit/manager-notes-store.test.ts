import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_NOTE_BYTES } from '../../src/manager/notes/path-guards.js';
import { NotesStore } from '../../src/manager/notes/store.js';

function tmpRoot(): string {
    return mkdtempSync(join(tmpdir(), 'jaw-notes-store-test-'));
}

test('store creates folders, creates markdown files, and lists tree', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new NotesStore({ root });

    await store.createFolder('daily');
    const created = await store.createFile('daily/today.md', '# Today');
    assert.equal(created.path, 'daily/today.md');
    assert.equal(created.name, 'today.md');
    assert.equal(created.content, '# Today');
    assert.match(created.revision, /^[0-9a-f]{64}$/);

    const tree = await store.listTree();
    assert.equal(tree[0]?.kind, 'folder');
    assert.equal(tree[0]?.children?.[0]?.path, 'daily/today.md');
});

test('store writes with baseRevision and rejects stale revision', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new NotesStore({ root });
    const created = await store.createFile('note.md', 'one');
    const updated = await store.writeFile({
        path: 'note.md',
        content: 'two',
        baseRevision: created.revision,
    });
    assert.equal(updated.content, 'two');
    await assert.rejects(
        () => store.writeFile({ path: 'note.md', content: 'three', baseRevision: created.revision }),
        /changed since/,
    );
});

test('store renames markdown files and rejects collisions', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new NotesStore({ root });
    await store.createFile('a.md', 'a');
    await store.createFile('b.md', 'b');
    await assert.rejects(() => store.rename('a.md', 'b.md'), /already exists/);
    assert.deepEqual(await store.rename('a.md', 'c.md'), { from: 'a.md', to: 'c.md' });
    assert.equal((await store.readFile('c.md')).content, 'a');
});

test('store rejects large content and large files', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new NotesStore({ root });
    const tooLarge = 'x'.repeat(MAX_NOTE_BYTES + 1);
    await assert.rejects(() => store.createFile('large.md', tooLarge), /maximum/);
    writeFileSync(join(root, 'manual.md'), tooLarge);
    await assert.rejects(() => store.readFile('manual.md'), /maximum/);
});

test('store rejects symlink parent escapes on create', async (t) => {
    const root = tmpRoot();
    const outside = tmpRoot();
    t.after(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    });
    mkdirSync(join(root, 'links'));
    symlinkSync(outside, join(root, 'links', 'outside'));
    const store = new NotesStore({ root });
    await assert.rejects(() => store.createFile('links/outside/x.md', 'x'), /symlinks/);
});

test('store renames folders and rejects cycles', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new NotesStore({ root });
    await store.createFolder('folder');
    await store.createFile('folder/note.md', 'nested');

    assert.deepEqual(await store.rename('folder', 'folder2'), { from: 'folder', to: 'folder2' });
    assert.equal((await store.readFile('folder2/note.md')).content, 'nested');
    await assert.rejects(() => store.rename('folder2', 'folder2/child'), /cannot be moved into itself/);
});

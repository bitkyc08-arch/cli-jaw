import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NotesStore } from '../../src/manager/notes/store.ts';
import { MAX_NOTE_BYTES } from '../../src/notes/path-guards.ts';

function makeTempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'notes-tmpl-test-'));
    mkdirSync(join(root, '_templates'));
    return root;
}

test('listTemplates returns empty when _templates dir missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notes-tmpl-test-'));
    const store = new NotesStore({ root });
    const result = await store.listTemplates();
    assert.deepEqual(result, []);
});

test('listTemplates returns canonical names sorted alphabetically', async () => {
    const root = makeTempRoot();
    writeFileSync(join(root, '_templates', 'daily.md'), '# {{title}}');
    writeFileSync(join(root, '_templates', 'meeting.md'), '## Meeting');
    writeFileSync(join(root, '_templates', 'alpha.md'), 'first');
    const store = new NotesStore({ root });
    const result = await store.listTemplates();
    assert.equal(result.length, 3);
    assert.equal(result[0].name, 'alpha');
    assert.equal(result[1].name, 'daily');
    assert.equal(result[2].name, 'meeting');
    assert.equal(result[1].path, '_templates/daily.md');
});

test('listTemplates skips non-.md files', async () => {
    const root = makeTempRoot();
    writeFileSync(join(root, '_templates', 'daily.md'), '# Daily');
    writeFileSync(join(root, '_templates', 'notes.txt'), 'ignored');
    writeFileSync(join(root, '_templates', '.hidden.md'), 'ignored');
    const store = new NotesStore({ root });
    const result = await store.listTemplates();
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'daily');
});

test('listTemplates skips symlinks', async () => {
    const root = makeTempRoot();
    writeFileSync(join(root, '_templates', 'real.md'), '# Real');
    symlinkSync(join(root, '_templates', 'real.md'), join(root, '_templates', 'link.md'));
    const store = new NotesStore({ root });
    const result = await store.listTemplates();
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'real');
});

test('readTemplate returns content for valid template', async () => {
    const root = makeTempRoot();
    writeFileSync(join(root, '_templates', 'daily.md'), '# {{title}}\n\nDate: {{date}}');
    const store = new NotesStore({ root });
    const result = await store.readTemplate('daily');
    assert.equal(result.name, 'daily');
    assert.equal(result.path, '_templates/daily.md');
    assert.equal(result.content, '# {{title}}\n\nDate: {{date}}');
});

test('readTemplate rejects names with path traversal', async () => {
    const root = makeTempRoot();
    const store = new NotesStore({ root });
    await assert.rejects(() => store.readTemplate('../etc/passwd'), (err: Error & { statusCode?: number }) => {
        assert.match(err.message, /invalid/i);
        return true;
    });
});

test('readTemplate rejects names ending in .md', async () => {
    const root = makeTempRoot();
    writeFileSync(join(root, '_templates', 'daily.md'), '# Daily');
    const store = new NotesStore({ root });
    await assert.rejects(() => store.readTemplate('daily.md'), (err: Error) => {
        assert.match(err.message, /invalid/i);
        return true;
    });
});

test('readTemplate 404 for missing template', async () => {
    const root = makeTempRoot();
    const store = new NotesStore({ root });
    await assert.rejects(() => store.readTemplate('nonexistent'), (err: Error & { statusCode?: number }) => {
        assert.match(err.message, /not found/i);
        return true;
    });
});

test('listTemplates and readTemplate are consistent', async () => {
    const root = makeTempRoot();
    writeFileSync(join(root, '_templates', 'daily.md'), '# Daily');
    writeFileSync(join(root, '_templates', 'weekly.md'), '# Weekly');
    const store = new NotesStore({ root });
    const list = await store.listTemplates();
    for (const item of list) {
        const detail = await store.readTemplate(item.name);
        assert.equal(detail.name, item.name);
        assert.ok(detail.content.length > 0);
    }
});

test('readTemplate rejects names containing .md in the stem (foo.mdbar)', async () => {
    const root = makeTempRoot();
    writeFileSync(join(root, '_templates', 'foo.mdbar.md'), '# Tricky');
    const store = new NotesStore({ root });
    await assert.rejects(() => store.readTemplate('foo.mdbar'), (err: Error) => {
        assert.match(err.message, /invalid/i);
        return true;
    });
});

test('listTemplates excludes names containing .md in the stem', async () => {
    const root = makeTempRoot();
    writeFileSync(join(root, '_templates', 'foo.mdbar.md'), '# Hidden');
    writeFileSync(join(root, '_templates', 'foo.md.md'), '# Also hidden');
    writeFileSync(join(root, '_templates', 'valid.md'), '# Good');
    const store = new NotesStore({ root });
    const result = await store.listTemplates();
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'valid');
});

test('listTemplates excludes oversized templates', async () => {
    const root = makeTempRoot();
    writeFileSync(join(root, '_templates', 'small.md'), '# OK');
    writeFileSync(join(root, '_templates', 'oversized.md'), 'x'.repeat(MAX_NOTE_BYTES + 1));
    const store = new NotesStore({ root });
    const result = await store.listTemplates();
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'small');
});

test('every listed template is readable (property consistency)', async () => {
    const root = makeTempRoot();
    writeFileSync(join(root, '_templates', 'daily.md'), '# Daily');
    writeFileSync(join(root, '_templates', 'weekly.md'), '# Weekly');
    writeFileSync(join(root, '_templates', 'foo.mdbar.md'), '# Filtered out');
    writeFileSync(join(root, '_templates', 'oversized.md'), 'x'.repeat(MAX_NOTE_BYTES + 1));
    symlinkSync(join(root, '_templates', 'daily.md'), join(root, '_templates', 'link.md'));
    const store = new NotesStore({ root });
    const list = await store.listTemplates();
    assert.ok(list.length > 0);
    for (const item of list) {
        const detail = await store.readTemplate(item.name);
        assert.equal(detail.name, item.name);
        assert.ok(detail.content.length > 0);
    }
});

test('_templates directory is excluded from listTree', async () => {
    const root = makeTempRoot();
    writeFileSync(join(root, '_templates', 'daily.md'), '# Daily');
    writeFileSync(join(root, 'hello.md'), '# Hello');
    const store = new NotesStore({ root });
    const tree = await store.listTree();
    const names = tree.map(e => e.name);
    assert.ok(!names.includes('_templates'), '_templates should not appear in tree');
    assert.ok(names.includes('hello.md'));
});

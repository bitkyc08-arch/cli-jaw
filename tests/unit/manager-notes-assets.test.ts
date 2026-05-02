import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotesAssetStore } from '../../src/manager/notes/assets.js';
import { NotesStore } from '../../src/manager/notes/store.js';

function tmpRoot(): string {
    return mkdtempSync(join(tmpdir(), 'jaw-notes-assets-test-'));
}

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function base64(bytes: number[] | string): string {
    return Buffer.from(bytes).toString('base64');
}

test('note assets save under a hidden note slug and resolve inside notes root', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new NotesAssetStore({
        notesRoot: root,
        clock: () => new Date('2026-05-02T18:25:00.000Z'),
        id: () => '550e8400-e29b-41d4-a716-446655440000',
    });

    const saved = await store.saveAsset({
        notePath: 'project/meeting.md',
        mime: 'image/png',
        dataBase64: PNG_BASE64,
    });

    assert.equal(saved.ok, true);
    assert.equal(saved.mime, 'image/png');
    assert.equal(saved.path, '.assets/project__meeting/20260502T182500-550e8400-e29b-41d4-a716-446655440000.png');
    assert.equal(saved.markdown, `![pasted image](./${saved.path})`);
    assert.equal(existsSync(join(root, saved.path)), true);
    const resolved = await store.resolveAsset(saved.path);
    assert.equal(resolved.mime, 'image/png');
    assert.equal((await readFile(resolved.absolutePath)).length, saved.size);
});

test('note assets accept the planned raster image MIME set', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let counter = 0;
    const store = new NotesAssetStore({
        notesRoot: root,
        clock: () => new Date('2026-05-02T18:25:00.000Z'),
        id: () => `asset-${counter += 1}`,
    });

    const cases = [
        { mime: 'image/jpeg', dataBase64: base64([0xff, 0xd8, 0xff, 0xd9]), ext: '.jpg' },
        { mime: 'image/gif', dataBase64: base64('GIF89a'), ext: '.gif' },
        { mime: 'image/webp', dataBase64: base64('RIFFxxxxWEBP'), ext: '.webp' },
    ];

    for (const item of cases) {
        const saved = await store.saveAsset({ notePath: 'note.md', mime: item.mime, dataBase64: item.dataBase64 });
        assert.equal(saved.mime, item.mime);
        assert.equal(saved.path.endsWith(item.ext), true);
    }
});

test('note assets reject malformed base64, unsupported types, spoofed MIME, and traversal', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new NotesAssetStore({ notesRoot: root });

    await assert.rejects(
        () => store.saveAsset({ notePath: 'note.md', mime: 'image/png', dataBase64: 'not base64' }),
        /canonical base64/,
    );
    await assert.rejects(
        () => store.saveAsset({ notePath: 'note.md', mime: 'image/svg+xml', dataBase64: base64('<svg></svg>') }),
        /Unsupported note asset type/,
    );
    await assert.rejects(
        () => store.saveAsset({ notePath: 'note.md', mime: 'image/jpeg', dataBase64: PNG_BASE64 }),
        /MIME does not match/,
    );
    await assert.rejects(
        () => store.saveAsset({ notePath: '../outside.md', mime: 'image/png', dataBase64: PNG_BASE64 }),
        /escape notes root|invalid/,
    );
    await assert.rejects(
        () => store.resolveAsset('../outside.png'),
        /must stay under \.assets|escape notes root/,
    );
});

test('note assets reject symlinked asset roots and stay hidden from notes tree', async (t) => {
    const root = tmpRoot();
    const outside = tmpRoot();
    t.after(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    });
    symlinkSync(outside, join(root, '.assets'));
    const assetStore = new NotesAssetStore({ notesRoot: root });
    await assert.rejects(
        () => assetStore.saveAsset({ notePath: 'note.md', mime: 'image/png', dataBase64: PNG_BASE64 }),
        /symlinks are not supported/,
    );

    rmSync(join(root, '.assets'), { force: true });
    const notesStore = new NotesStore({ root });
    await notesStore.createFile('visible.md', '# Visible');
    writeFileSync(join(root, '.assets-placeholder'), 'x');
    const tree = await notesStore.listTree();
    assert.deepEqual(tree.map(entry => entry.path), ['visible.md']);
});

test('note assets reject symlinked slug directories even when they stay inside notes root', async (t) => {
    const root = tmpRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, '.assets'), { recursive: true });
    mkdirSync(join(root, 'real-slug'), { recursive: true });
    writeFileSync(join(root, 'real-slug', 'file.png'), Buffer.from(PNG_BASE64, 'base64'));
    symlinkSync(join(root, 'real-slug'), join(root, '.assets', 'slug'));

    const store = new NotesAssetStore({ notesRoot: root });
    await assert.rejects(
        () => store.resolveAsset('.assets/slug/file.png'),
        /Asset symlinks are not supported/,
    );
});

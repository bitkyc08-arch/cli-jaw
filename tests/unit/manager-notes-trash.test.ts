import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotesTrash } from '../../src/manager/notes/trash.js';

function tmpRoot(): string {
    return mkdtempSync(join(tmpdir(), 'jaw-notes-trash-test-'));
}

function writeNote(root: string, path = 'note.md'): string {
    const target = join(root, path);
    writeFileSync(target, 'note');
    return target;
}

test('system trash success uses CLI_JAW_TEST_SYSTEM_TRASH_DIR', async (t) => {
    const root = tmpRoot();
    const dashboardHome = tmpRoot();
    const systemTrash = tmpRoot();
    const previousNodeEnv = process.env.NODE_ENV;
    const previousTrashDir = process.env.CLI_JAW_TEST_SYSTEM_TRASH_DIR;
    const previousTrashFail = process.env.CLI_JAW_TEST_SYSTEM_TRASH_FAIL;
    t.after(() => {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
        if (previousTrashDir === undefined) delete process.env.CLI_JAW_TEST_SYSTEM_TRASH_DIR;
        else process.env.CLI_JAW_TEST_SYSTEM_TRASH_DIR = previousTrashDir;
        if (previousTrashFail === undefined) delete process.env.CLI_JAW_TEST_SYSTEM_TRASH_FAIL;
        else process.env.CLI_JAW_TEST_SYSTEM_TRASH_FAIL = previousTrashFail;
        rmSync(root, { recursive: true, force: true });
        rmSync(dashboardHome, { recursive: true, force: true });
        rmSync(systemTrash, { recursive: true, force: true });
    });
    process.env.NODE_ENV = 'test';
    process.env.CLI_JAW_TEST_SYSTEM_TRASH_DIR = systemTrash;
    delete process.env.CLI_JAW_TEST_SYSTEM_TRASH_FAIL;
    writeNote(root);

    const result = await new NotesTrash({ dashboardHome }).trashFile(root, 'note.md');
    assert.equal(result.deletedTo, 'os-trash');
    assert.equal(existsSync(join(root, 'note.md')), false);
    assert.equal(readdirSync(systemTrash).length, 1);
});

test('system trash failure falls back to dashboard trash', async (t) => {
    const root = tmpRoot();
    const dashboardHome = tmpRoot();
    t.after(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(dashboardHome, { recursive: true, force: true });
    });
    writeNote(root);
    const result = await new NotesTrash({
        dashboardHome,
        adapter: { moveToOsTrash: async () => { throw new Error('no system trash'); } },
    }).trashFile(root, 'note.md');
    assert.equal(result.deletedTo, 'dashboard-trash');
    assert.equal(existsSync(join(root, 'note.md')), false);
    assert.equal(typeof result.restoreHint, 'string');
    assert.equal(existsSync(result.restoreHint!), true);
});

test('dashboard trash collision gets a unique target', async (t) => {
    const root = tmpRoot();
    const dashboardHome = tmpRoot();
    let now = 1000;
    const previousNow = Date.now;
    t.after(() => {
        Date.now = previousNow;
        rmSync(root, { recursive: true, force: true });
        rmSync(dashboardHome, { recursive: true, force: true });
    });
    Date.now = () => now;
    writeNote(root);
    const notesTrash = new NotesTrash({
        dashboardHome,
        adapter: { moveToOsTrash: async () => { throw new Error('no system trash'); } },
    });
    const first = await notesTrash.trashFile(root, 'note.md');
    writeNote(root);
    now = 1000;
    const second = await notesTrash.trashFile(root, 'note.md');
    assert.notEqual(first.restoreHint, second.restoreHint);
    assert.match(second.restoreHint || '', /\.1$/);
});

test('fallback failure preserves original file', async (t) => {
    const root = tmpRoot();
    const dashboardHome = tmpRoot();
    t.after(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(dashboardHome, { recursive: true, force: true });
    });
    writeNote(root);
    const notesTrash = new NotesTrash({
        dashboardHome,
        adapter: { moveToOsTrash: async () => { throw new Error('no system trash'); } },
        fsImpl: {
            existsSync,
            mkdir,
            rename: async () => { throw new Error('fallback failed'); },
        },
    });
    await assert.rejects(() => notesTrash.trashFile(root, 'note.md'), /fallback failed/);
    assert.equal(existsSync(join(root, 'note.md')), true);
});

test('trash rejects symlink files', async (t) => {
    const root = tmpRoot();
    const outside = tmpRoot();
    const dashboardHome = tmpRoot();
    t.after(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
        rmSync(dashboardHome, { recursive: true, force: true });
    });
    writeNote(outside, 'outside.md');
    await rename(join(outside, 'outside.md'), join(outside, 'note.md'));
    await import('node:fs').then(fs => fs.symlinkSync(join(outside, 'note.md'), join(root, 'link.md')));
    await assert.rejects(
        () => new NotesTrash({ dashboardHome }).trashFile(root, 'link.md'),
        /symlinks/,
    );
});

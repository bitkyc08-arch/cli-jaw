import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createDashboardNotesRouter,
    createNotesJsonErrorHandler,
} from '../../src/manager/notes/routes.js';
import { NotesStore } from '../../src/manager/notes/store.js';
import { NotesTrash } from '../../src/manager/notes/trash.js';

function tmpRoot(): string {
    return mkdtempSync(join(tmpdir(), 'jaw-notes-routes-test-'));
}

async function withNotesServer(
    t: TestContext,
    fn: (baseUrl: string, root: string) => Promise<void>,
): Promise<void> {
    const root = tmpRoot();
    const dashboardHome = tmpRoot();
    const app = express();
    const server = http.createServer(app);
    t.after(() => {
        server.close();
        rmSync(root, { recursive: true, force: true });
        rmSync(dashboardHome, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.equal(typeof address, 'object');
    assert.ok(address);
    const port = address.port;
    app.use(
        '/api/dashboard/notes',
        express.json({ limit: '1100kb' }),
        createNotesJsonErrorHandler(),
        createDashboardNotesRouter({
            managerPort: port,
            store: new NotesStore({ root }),
            trash: new NotesTrash({
                dashboardHome,
                adapter: { moveToOsTrash: async () => { throw new Error('no system trash'); } },
            }),
        }),
    );
    app.use(express.json({ limit: '64kb' }));
    await fn(`http://127.0.0.1:${port}`, root);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
    return await response.json() as Record<string, unknown>;
}

test('notes routes create, read, update, tree, rename, and trash markdown files', async (t) => {
    await withNotesServer(t, async (baseUrl) => {
        const folder = await fetch(`${baseUrl}/api/dashboard/notes/folder`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'daily' }),
        });
        assert.equal(folder.status, 201);

        const created = await fetch(`${baseUrl}/api/dashboard/notes/file`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'daily/today.md', content: '# Today' }),
        });
        assert.equal(created.status, 201);
        const createdBody = await readJson(created);
        assert.equal(createdBody.path, 'daily/today.md');

        const renamedFolder = await fetch(`${baseUrl}/api/dashboard/notes/rename`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ from: 'daily', to: 'archive' }),
        });
        assert.equal(renamedFolder.status, 200);
        const renamedFolderBody = await readJson(renamedFolder);
        assert.equal(renamedFolderBody.to, 'archive');

        const file = await fetch(`${baseUrl}/api/dashboard/notes/file?path=archive%2Ftoday.md`);
        assert.equal(file.status, 200);
        const fileBody = await readJson(file);
        assert.equal(fileBody.content, '# Today');

        const updated = await fetch(`${baseUrl}/api/dashboard/notes/file`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'archive/today.md', content: '# Updated', baseRevision: fileBody.revision }),
        });
        assert.equal(updated.status, 200);

        const tree = await fetch(`${baseUrl}/api/dashboard/notes/tree`);
        assert.equal(tree.status, 200);
        const treeBody = await tree.json() as Array<{ path: string }>;
        assert.equal(treeBody[0]?.path, 'archive');

        const renamed = await fetch(`${baseUrl}/api/dashboard/notes/rename`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ from: 'archive/today.md', to: 'archive/done.md' }),
        });
        assert.equal(renamed.status, 200);

        const trashed = await fetch(`${baseUrl}/api/dashboard/notes/trash`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'archive/done.md' }),
        });
        assert.equal(trashed.status, 200);
        const trashBody = await readJson(trashed);
        assert.equal(trashBody.kind, 'file');
        assert.equal(trashBody.deletedTo, 'dashboard-trash');
    });
});

test('notes routes trash folders with explicit kind', async (t) => {
    await withNotesServer(t, async (baseUrl) => {
        const folder = await fetch(`${baseUrl}/api/dashboard/notes/folder`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'daily' }),
        });
        assert.equal(folder.status, 201);

        const created = await fetch(`${baseUrl}/api/dashboard/notes/file`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'daily/today.md', content: '# Today' }),
        });
        assert.equal(created.status, 201);

        const trashed = await fetch(`${baseUrl}/api/dashboard/notes/trash`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'daily', kind: 'folder' }),
        });

        assert.equal(trashed.status, 200);
        const body = await readJson(trashed);
        assert.equal(body.kind, 'folder');
        assert.equal(body.deletedTo, 'dashboard-trash');
        assert.equal(typeof body.restoreHint, 'string');
    });
});

test('notes trash route rejects invalid trash kind', async (t) => {
    await withNotesServer(t, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/dashboard/notes/trash`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'note.md', kind: 'directory' }),
        });
        assert.equal(response.status, 400);
        const body = await readJson(response);
        assert.equal(body.code, 'invalid_note_trash_kind');
    });
});

test('notes trash route rejects invalid folder trash paths', async (t) => {
    await withNotesServer(t, async (baseUrl) => {
        const traversal = await fetch(`${baseUrl}/api/dashboard/notes/trash`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: '../outside', kind: 'folder' }),
        });
        assert.equal(traversal.status, 400);
        assert.equal((await readJson(traversal)).code, 'invalid_note_path');

        const fileShapedFolder = await fetch(`${baseUrl}/api/dashboard/notes/trash`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'note.md', kind: 'folder' }),
        });
        assert.equal(fileShapedFolder.status, 400);
        assert.equal((await readJson(fileShapedFolder)).code, 'invalid_note_folder_path');
    });
});

test('notes mutations reject foreign origin', async (t) => {
    await withNotesServer(t, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/dashboard/notes/file`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'http://evil.com' },
            body: JSON.stringify({ path: 'note.md', content: 'x' }),
        });
        assert.equal(response.status, 403);
        const body = await readJson(response);
        assert.equal(body.code, 'notes_origin_forbidden');
    });
});

test('notes routes reject traversal outside notes root', async (t) => {
    await withNotesServer(t, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/dashboard/notes/file?path=..%2Fmanager-instances.json`);
        assert.equal(response.status, 400);
        const body = await readJson(response);
        assert.equal(body.code, 'invalid_note_path');
    });
});

test('notes routes return a typed 404 for missing markdown files', async (t) => {
    await withNotesServer(t, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/dashboard/notes/file?path=missing.md`);
        assert.equal(response.status, 404);
        const body = await readJson(response);
        assert.equal(body.code, 'note_not_found');
    });
});

test('notes folder rename rejects moving a folder into itself', async (t) => {
    await withNotesServer(t, async (baseUrl) => {
        const folder = await fetch(`${baseUrl}/api/dashboard/notes/folder`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'daily' }),
        });
        assert.equal(folder.status, 201);

        const response = await fetch(`${baseUrl}/api/dashboard/notes/rename`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ from: 'daily', to: 'daily/archive' }),
        });
        assert.equal(response.status, 400);
        const body = await readJson(response);
        assert.equal(body.code, 'invalid_note_path');
    });
});

test('notes route parser allows body over global 64kb and below notes limit', async (t) => {
    await withNotesServer(t, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/dashboard/notes/file`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'large.md', content: 'x'.repeat(70 * 1024) }),
        });
        assert.equal(response.status, 201);
    });
});

test('notes route parser normalizes malformed JSON and oversized payloads', async (t) => {
    await withNotesServer(t, async (baseUrl) => {
        const malformed = await fetch(`${baseUrl}/api/dashboard/notes/file`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{not json',
        });
        assert.equal(malformed.status, 400);
        assert.equal((await readJson(malformed)).code, 'invalid_json');

        const oversized = await fetch(`${baseUrl}/api/dashboard/notes/file`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'too-large.md', content: 'x'.repeat(1_150_000) }),
        });
        assert.equal(oversized.status, 413);
        assert.equal((await readJson(oversized)).code, 'note_payload_too_large');
    });
});

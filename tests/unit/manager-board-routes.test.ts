import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDashboardBoardRouter } from '../../src/manager/board/routes.js';
import { BoardStore } from '../../src/manager/board/store.js';

async function withBoardServer(
    fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'cli-jaw-board-routes-'));
    const store = new BoardStore({ dbPath: join(dir, 'dashboard.db') });
    const app = express();
    const server = http.createServer(app);
    app.use(express.json());
    app.use('/api/dashboard/board', createDashboardBoardRouter({ store }));

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const address = server.address();
        assert.equal(typeof address, 'object');
        assert.ok(address);
        await fn(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
}

test('board routes persist and return title, summary, and detail edits', async () => {
    await withBoardServer(async (baseUrl) => {
        const created = await fetch(`${baseUrl}/api/dashboard/board/tasks`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                title: 'Initial',
                summary: 'One line',
                detail: 'Full detail',
                lane: 'inbox',
            }),
        });
        assert.equal(created.status, 201);
        const createdBody = await created.json() as {
            task: { id: string; title: string; summary: string; detail: string };
        };
        assert.equal(createdBody.task.summary, 'One line');
        assert.equal(createdBody.task.detail, 'Full detail');

        const patched = await fetch(`${baseUrl}/api/dashboard/board/tasks/${createdBody.task.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                title: 'Updated',
                summary: 'Updated line',
                detail: 'Updated detail',
            }),
        });
        assert.equal(patched.status, 200);
        const patchedBody = await patched.json() as {
            task: { title: string; summary: string; detail: string };
        };
        assert.equal(patchedBody.task.title, 'Updated');
        assert.equal(patchedBody.task.summary, 'Updated line');
        assert.equal(patchedBody.task.detail, 'Updated detail');

        const listed = await fetch(`${baseUrl}/api/dashboard/board/tasks`);
        assert.equal(listed.status, 200);
        const listedBody = await listed.json() as {
            tasks: Array<{ id: string; title: string; summary: string; detail: string }>;
        };
        assert.equal(listedBody.tasks[0]?.summary, 'Updated line');
        assert.equal(listedBody.tasks[0]?.detail, 'Updated detail');
    });
});

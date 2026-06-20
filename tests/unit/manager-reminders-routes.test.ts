import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDashboardRemindersRouter } from '../../src/manager/reminders/routes.js';
import { RemindersStore } from '../../src/manager/reminders/store.js';

async function withRemindersServer(
    fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'cli-jaw-reminders-routes-'));
    const store = new RemindersStore({ dbPath: join(dir, 'dashboard.db') });
    const app = express();
    const server = http.createServer(app);
    app.use(express.json());
    app.use('/api/dashboard/reminders', createDashboardRemindersRouter({ store }));

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

test('reminders routes create and list dashboard-native reminders', async () => {
    await withRemindersServer(async (baseUrl) => {
        const created = await fetch(`${baseUrl}/api/dashboard/reminders`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Route reminder', listId: 'today', priority: 'high', manualRank: 1200 }),
        });
        assert.equal(created.status, 201);
        const createdBody = await created.json() as { item: { id: string; title: string; source: string; manualRank: number | null } };
        assert.equal(createdBody.item.title, 'Route reminder');
        assert.equal(createdBody.item.source, 'dashboard');
        assert.equal(createdBody.item.manualRank, 1200);

        const patched = await fetch(`${baseUrl}/api/dashboard/reminders/${createdBody.item.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ manualRank: 600 }),
        });
        assert.equal(patched.status, 200);
        const patchedBody = await patched.json() as { item: { manualRank: number | null } };
        assert.equal(patchedBody.item.manualRank, 600);

        const listed = await fetch(`${baseUrl}/api/dashboard/reminders`);
        assert.equal(listed.status, 200);
        const listedBody = await listed.json() as {
            ok: boolean;
            items?: Array<{ id: string; title: string }>;
            sourceStatus?: unknown;
        };
        assert.equal(listedBody.ok, true);
        assert.equal(listedBody.items?.[0]?.id, createdBody.item.id);
        assert.equal('sourceStatus' in listedBody, false);
    });
});

test('reminders from-message route creates local linked reminders and allows local status updates', async () => {
    await withRemindersServer(async (baseUrl) => {
        const created = await fetch(`${baseUrl}/api/dashboard/reminders/from-message`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                title: 'Pin from chat',
                notes: 'chat text',
                priority: 'high',
                port: 24576,
                instanceId: 'port:24576',
                messageId: 'msg-42',
                turnIndex: 4,
                threadKey: 'thread-key',
            }),
        });
        assert.equal(created.status, 201);
        const createdBody = await created.json() as { item: { id: string; source: string; messageId: string; port: number } };
        assert.equal(createdBody.item.source, 'dashboard');
        assert.equal(createdBody.item.messageId, 'msg-42');
        assert.equal(createdBody.item.port, 24576);

        const patched = await fetch(`${baseUrl}/api/dashboard/reminders/${createdBody.item.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'done' }),
        });
        assert.equal(patched.status, 200);
        const patchedBody = await patched.json() as { item: { status: string } };
        assert.equal(patchedBody.item.status, 'done');

        const nextRemindAt = '2026-05-10T09:00:00.000Z';
        const snoozed = await fetch(`${baseUrl}/api/dashboard/reminders/${createdBody.item.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ remindAt: nextRemindAt }),
        });
        assert.equal(snoozed.status, 200);
        const snoozedBody = await snoozed.json() as { item: { title: string; status: string; priority: string; remindAt: string | null } };
        assert.equal(snoozedBody.item.title, 'Pin from chat');
        assert.equal(snoozedBody.item.status, 'done');
        assert.equal(snoozedBody.item.priority, 'high');
        assert.equal(snoozedBody.item.remindAt, nextRemindAt);
    });
});

test('reminders routes reject invalid enum and non-integer link payloads', async () => {
    await withRemindersServer(async (baseUrl) => {
        const invalidPriority = await fetch(`${baseUrl}/api/dashboard/reminders/from-message`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                title: 'Bad pin',
                priority: 'urgent',
                port: 24576,
                instanceId: 'port:24576',
                messageId: 'msg-42',
            }),
        });
        assert.equal(invalidPriority.status, 400);

        const invalidPort = await fetch(`${baseUrl}/api/dashboard/reminders/from-message`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                title: 'Bad pin',
                port: 24576.5,
                instanceId: 'port:24576',
                messageId: 'msg-42',
            }),
        });
        assert.equal(invalidPort.status, 400);

        for (const badValue of [true, [1], '']) {
            const invalidCoercedPort = await fetch(`${baseUrl}/api/dashboard/reminders/from-message`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    title: 'Bad pin',
                    port: badValue,
                    instanceId: 'port:24576',
                    messageId: 'msg-42',
                }),
            });
            assert.equal(invalidCoercedPort.status, 400);
        }

        for (const badValue of [true, [], '']) {
            const invalidCoercedTurn = await fetch(`${baseUrl}/api/dashboard/reminders/from-message`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    title: 'Bad pin',
                    port: 24576,
                    turnIndex: badValue,
                    instanceId: 'port:24576',
                    messageId: 'msg-42',
                }),
            });
            assert.equal(invalidCoercedTurn.status, 400);
        }

        const invalidManualRank = await fetch(`${baseUrl}/api/dashboard/reminders`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Bad rank', manualRank: '1' }),
        });
        assert.equal(invalidManualRank.status, 400);

        const created = await fetch(`${baseUrl}/api/dashboard/reminders/from-message`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Pin', port: 24576, instanceId: 'port:24576', messageId: 'msg-1' }),
        });
        assert.equal(created.status, 201);
        const body = await created.json() as { item: { id: string } };
        const invalidStatus = await fetch(`${baseUrl}/api/dashboard/reminders/${body.item.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'archived' }),
        });
        assert.equal(invalidStatus.status, 400);

        const invalidRankPatch = await fetch(`${baseUrl}/api/dashboard/reminders/${body.item.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ manualRank: 'bad' }),
        });
        assert.equal(invalidRankPatch.status, 400);
    });
});

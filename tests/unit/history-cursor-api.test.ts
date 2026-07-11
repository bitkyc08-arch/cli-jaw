import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { registerMessageRoutes } from '../../src/routes/messages.ts';
import { db } from '../../src/core/db.ts';
import { createChatSession, deleteChatSession, getActiveChatSession, setActiveChatSession } from '../../src/core/chat-sessions.ts';
import { subscribe } from '../../src/core/event-bus.ts';
import { appendAssistantRawText, emitAgentTool, finishTurnLifecycle } from '../../src/agent/events/helpers.ts';
import type { SpawnContext } from '../../src/types/agent.ts';
import type { TurnSegment } from '../../src/shared/chat-events.ts';

type MessagesResponse = {
    ok: boolean;
    data: Array<Record<string, unknown> & { turn_segments?: TurnSegment[] }>;
    pageInfo?: {
        oldestCursor: number | null;
        newestCursor: number | null;
        hasMoreBefore: boolean;
        limit: number;
    };
    snapshotEventSeq?: number;
    error?: string;
};

function fakeContext(): SpawnContext {
    return {
        fullText: '',
        traceLog: [],
        toolLog: [],
        seenToolKeys: new Set(),
        hasClaudeStreamEvents: true,
        sessionId: null,
        cost: null,
        turns: null,
        duration: null,
        tokens: null,
        stderrBuf: '',
        traceAudience: 'public',
    };
}

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
    const app = express();
    registerMessageRoutes(app);
    const server: Server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
        await fn(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

async function json(baseUrl: string, query: string): Promise<MessagesResponse> {
    const response = await fetch(`${baseUrl}/api/messages${query}`);
    assert.equal(response.status, 200);
    return await response.json() as MessagesResponse;
}

async function withIsolatedSession(fn: (sessionId: string) => Promise<void>): Promise<void> {
    const prior = getActiveChatSession();
    const session = createChatSession(`history-cursor-${process.pid}-${Date.now()}`);
    try {
        await fn(session.id);
    } finally {
        db.prepare('DELETE FROM turn_segments WHERE session_id = ?').run(session.id);
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(session.id);
        setActiveChatSession(prior);
        deleteChatSession(session.id);
    }
}

test('includeSegments replay order matches lifecycle SSE publish order', async () => {
    await withIsolatedSession(async sessionId => {
        const traceRunId = `tr_history_${process.pid}_${Date.now()}`;
        const ctx = fakeContext();
        const published: TurnSegment[] = [];
        const unsubscribe = subscribe(entry => {
            if (entry.topic === 'agent' && entry.event.startsWith('turn_')) {
                published.push(entry.data as unknown as TurnSegment);
            }
        });
        try {
            appendAssistantRawText(ctx, 'history replay');
            emitAgentTool(ctx, 'main', {
                icon: 'tool',
                label: 'Read',
                toolType: 'Read',
                status: 'done',
                traceRunId,
                traceSeq: 1,
            }, {});
            finishTurnLifecycle(ctx, 'done');
        } finally {
            unsubscribe();
        }
        db.prepare(`
            INSERT INTO messages (role, content, cli, trace_run_id, session_id, turn_id)
            VALUES ('assistant', 'history replay', 'claude', ?, ?, ?)
        `).run(traceRunId, sessionId, published[0]!.turnId);

        await withServer(async baseUrl => {
            const body = await json(baseUrl, '?includeSegments=1&limit=10');
            assert.equal(body.data.length, 1);
            assert.deepEqual(body.data[0]?.turn_segments, published);
            assert.deepEqual(body.data[0]?.turn_segments?.map(segment => segment.turnSeq), published.map(segment => segment.turnSeq));
            assert.ok(Number.isSafeInteger(body.snapshotEventSeq));
        });
    });
});

test('before cursor pages reconstruct the complete message window without loss or duplicates', async () => {
    await withIsolatedSession(async sessionId => {
        const insertedIds: number[] = [];
        for (let index = 0; index < 8; index += 1) {
            const result = db.prepare(`
                INSERT INTO messages (role, content, session_id) VALUES (?, ?, ?)
            `).run(index % 2 === 0 ? 'user' : 'assistant', `page-${index}`, sessionId);
            insertedIds.push(Number(result.lastInsertRowid));
        }

        await withServer(async baseUrl => {
            let body = await json(baseUrl, '?includeSegments=1&limit=3');
            const rebuilt: number[] = body.data.map(row => Number(row['id']));
            assert.equal(body.pageInfo?.limit, 3);

            while (body.pageInfo?.hasMoreBefore) {
                assert.ok(body.pageInfo.oldestCursor);
                body = await json(baseUrl, `?includeSegments=1&limit=3&before=${body.pageInfo.oldestCursor}`);
                rebuilt.unshift(...body.data.map(row => Number(row['id'])));
            }

            assert.deepEqual(rebuilt, insertedIds);
            assert.equal(new Set(rebuilt).size, rebuilt.length);
        });
    });
});

test('includeTrace legacy response remains unpaged and unchanged by segment opt-in', async () => {
    await withIsolatedSession(async sessionId => {
        const trace = JSON.stringify([{ type: 'legacy-trace', detail: 'kept' }]);
        const result = db.prepare(`
            INSERT INTO messages (role, content, trace, tool_log, session_id)
            VALUES ('assistant', 'legacy content', ?, ?, ?)
        `).run(trace, '[]', sessionId);
        const messageId = Number(result.lastInsertRowid);

        await withServer(async baseUrl => {
            const legacy = await json(baseUrl, '?includeTrace=1');
            assert.equal(legacy.pageInfo, undefined);
            assert.deepEqual(legacy.data, [{
                ...legacy.data[0],
                id: messageId,
                content: 'legacy content',
                trace,
                tool_log: null,
            }]);

            const segmented = await json(baseUrl, '?includeTrace=1&includeSegments=1&limit=10');
            const { turn_segments: _segments, turn_id: _turnId, ...segmentedLegacyFields } = segmented.data[0] ?? {};
            assert.deepEqual(segmentedLegacyFields, legacy.data[0]);
            assert.deepEqual(segmented.data[0]?.turn_segments, []);
        });
    });
});

test('cursor mode enforces the hard cap, validates integers, and tolerates deleted anchors', async () => {
    await withIsolatedSession(async sessionId => {
        const result = db.prepare(`
            INSERT INTO messages (role, content, session_id) VALUES ('assistant', 'anchor', ?)
        `).run(sessionId);
        const anchorId = Number(result.lastInsertRowid);

        await withServer(async baseUrl => {
            const capped = await json(baseUrl, '?includeSegments=1&limit=9999');
            assert.equal(capped.pageInfo?.limit, 200);
            assert.ok(capped.pageInfo?.oldestCursor);
            assert.equal((await json(baseUrl, '?includeSegments=1&limit=0')).pageInfo?.limit, 200);

            const invalid = await fetch(`${baseUrl}/api/messages?before=not-a-cursor&limit=10`);
            assert.equal(invalid.status, 400);
            assert.equal((await invalid.json() as MessagesResponse).error, 'invalid_message_cursor');

            db.prepare('DELETE FROM messages WHERE id = ?').run(anchorId);
            const afterDelete = await fetch(`${baseUrl}/api/messages?before=${capped.pageInfo!.oldestCursor}&limit=10`);
            assert.equal(afterDelete.status, 200);
            assert.deepEqual((await afterDelete.json() as MessagesResponse).data, []);
        });
    });
});

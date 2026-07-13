import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { CodeSessionInfo, StoredCodeSessionInfo } from '../../src/code-mode/types.ts';
import type { TurnSegment } from '../../src/shared/chat-events.ts';
import type { CodeApiClient } from '../../public/dashboard2/src/code/code-api-client.ts';
import { chunkText, type AcpSessionUpdate } from '../../public/dashboard2/src/code/code-event-types.ts';
import {
    fetchHistorySummaries,
    loadSessionHistory,
    toHistorySummaries,
} from '../../public/dashboard2/src/code/code-history-adapter.ts';
import { createCodeSourceAdapter } from '../../public/dashboard2/src/code/code-source-adapter.ts';
import type { TurnStreamAction } from '../../public/dashboard2/src/turn-stream/types.ts';

interface FixtureMeta {
    sessionId: string;
}

interface FixtureRecord {
    dir?: string;
    msg?: {
        id?: number;
        method?: string;
        params?: {
            sessionId?: string;
            update?: AcpSessionUpdate;
        };
    };
}

interface FixtureUpdate {
    event: `code_${string}`;
    sessionId: string;
    update: AcpSessionUpdate;
}

const meta = JSON.parse(readFileSync(
    new URL('../fixtures/dashboard2-code-acp.meta.json', import.meta.url),
    'utf8',
)) as FixtureMeta;

function readLoadDrains(): [FixtureUpdate[], FixtureUpdate[]] {
    const records = readFileSync(
        new URL('../fixtures/dashboard2-code-acp.ndjson', import.meta.url),
        'utf8',
    ).trim().split('\n').map(line => JSON.parse(line) as FixtureRecord);
    const drains: FixtureUpdate[][] = [];
    for (let index = 0; index < records.length; index += 1) {
        const marker = records[index];
        if (marker?.dir !== 'out' || marker.msg?.method !== 'session/load') continue;
        const requestId = marker.msg.id;
        const updates: FixtureUpdate[] = [];
        for (index += 1; index < records.length; index += 1) {
            const record = records[index];
            if (record?.dir === 'in' && record.msg?.id === requestId) break;
            const params = record?.dir === 'in' && record.msg?.method === 'session/update'
                ? record.msg.params
                : undefined;
            const update = params?.update;
            if (!update || params?.sessionId !== meta.sessionId || typeof update.sessionUpdate !== 'string') continue;
            updates.push({ event: `code_${update.sessionUpdate}`, sessionId: meta.sessionId, update });
        }
        drains.push(updates);
    }
    assert.equal(drains.length, 2, 'fixture must contain exactly two session/load drains');
    return [drains[0]!, drains[1]!];
}

const [load1, load2] = readLoadDrains();

function clock(): () => number {
    let current = 2_000_000;
    return () => current++;
}

function lifecycleRows(actions: readonly TurnStreamAction[]): TurnSegment[] {
    return actions.flatMap(action => action.kind === 'lifecycle' ? [action.payload] : []);
}

function livePayload(update: FixtureUpdate, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { topic: 'jwc', ...update, ...extra };
}

function historyMessages(actions: readonly TurnStreamAction[]) {
    return actions.flatMap(action => action.kind === 'history_page' ? action.messages : []);
}

function stubClient(overrides: Partial<CodeApiClient>): CodeApiClient {
    return overrides as CodeApiClient;
}

test('061 history summaries filter invalid entries, select titles, and preserve metadata', () => {
    const stored = [
        { sessionId: 'session-title', cwd: '/one', title: 'Named', updatedAt: 'now', lastModified: 12, messageCount: 3 },
        { sessionId: 'session-first', cwd: '/two', firstMessage: 'First prompt' },
        { sessionId: '1234567890', cwd: '/three' },
        { sessionId: '', cwd: '/missing-id' },
        { sessionId: 'missing-cwd', cwd: '' },
    ] satisfies StoredCodeSessionInfo[];
    assert.deepEqual(toHistorySummaries(stored), [
        { sessionId: 'session-title', cwd: '/one', title: 'Named', updatedAt: 'now', lastModified: 12, messageCount: 3 },
        { sessionId: 'session-first', cwd: '/two', title: 'First prompt' },
        { sessionId: '1234567890', cwd: '/three', title: '12345678' },
    ]);
});

test('061 history list reports ready, empty, and explicit error states', async () => {
    const item: StoredCodeSessionInfo = { sessionId: 'one', cwd: '/repo', title: 'One' };
    assert.deepEqual(await fetchHistorySummaries(stubClient({ listStoredSessions: async () => [item] })), {
        state: 'ready',
        summaries: [{ sessionId: 'one', cwd: '/repo', title: 'One' }],
    });
    assert.deepEqual(await fetchHistorySummaries(stubClient({ listStoredSessions: async () => [] })), { state: 'empty' });
    assert.deepEqual(await fetchHistorySummaries(stubClient({
        listStoredSessions: async () => { throw new Error('boom'); },
    })), { state: 'error', message: 'boom' });
});

test('061 session/load history reconstructs one interrupted turn from the captured drain', async () => {
    const session: CodeSessionInfo = {
        sessionId: meta.sessionId,
        cwd: '/fixture',
        status: 'idle',
        createdAt: 0,
        lastUsedAt: 0,
        replayEvents: load1,
    };
    const adapter = createCodeSourceAdapter(meta.sessionId, { now: clock() });
    const loaded = await loadSessionHistory(
        stubClient({ loadSession: async () => session }),
        { sessionId: meta.sessionId, cwd: '/fixture' },
        adapter,
    );
    const rows = lifecycleRows(loaded.actions);
    assert.equal(rows.filter(row => row.type === 'turn_start').length, 1);
    const ends = rows.filter(row => row.type === 'turn_end');
    assert.equal(ends.length, 1);
    assert.equal(ends[0]?.status, 'interrupted');
    const messages = historyMessages(loaded.actions);
    assert.ok(messages.some(message => message.role === 'user'));
    const expected = load1
        .filter(item => item.update.sessionUpdate === 'agent_message_chunk')
        .map(item => chunkText(item.update.content))
        .join('');
    assert.equal(messages.findLast(message => message.role === 'assistant')?.content, expected);
});

test('061 overlap fence consumes regenerated message IDs without visible actions', () => {
    const adapter = createCodeSourceAdapter(meta.sessionId, { now: clock() });
    adapter.ingestReplay(load1, { status: 'idle' });
    const overlap = load2.flatMap(update => adapter.ingestLive(livePayload(update, { sseReplay: true })));
    assert.deepEqual(overlap, []);
    assert.ok(adapter.telemetry().droppedDuplicates > 0);
    const firstIds = load1.map(item => item.update.messageId).filter(Boolean);
    const secondIds = load2.map(item => item.update.messageId).filter(Boolean);
    assert.notDeepEqual(firstIds, secondIds);
});

test('061 stale replay cannot append to or terminate a newly accepted local turn', () => {
    const adapter = createCodeSourceAdapter(meta.sessionId, { now: clock() });
    adapter.ingestReplay(load1, { status: 'idle' });
    const accepted = adapter.notePromptAccepted('new prompt');
    assert.equal(lifecycleRows(accepted).filter(row => row.type === 'turn_end').length, 0);
    const matchingReplay = adapter.ingestLive(livePayload(load2[0]!, { sseReplay: true }));
    assert.deepEqual(matchingReplay, []);
    assert.equal(matchingReplay.some(action => action.kind === 'body_chunk'), false);
    const staleTerminal = adapter.ingestLive({
        topic: 'jwc',
        event: 'code_turn_done',
        sessionId: meta.sessionId,
        stopReason: 'end_turn',
        sseReplay: true,
    });
    assert.deepEqual(staleTerminal, []);
    const terminal = adapter.ingestLive({
        topic: 'jwc',
        event: 'code_turn_done',
        sessionId: meta.sessionId,
        stopReason: 'end_turn',
    });
    const ends = lifecycleRows(terminal).filter(row => row.type === 'turn_end');
    assert.deepEqual(ends.map(row => row.status), ['done']);
    assert.ok(terminal.some(action => action.kind === 'history_page'));
});

test('061 first non-replay frame closes the overlap phase', () => {
    const adapter = createCodeSourceAdapter(meta.sessionId, { now: clock() });
    adapter.ingestReplay(load1, { status: 'idle' });
    const live = adapter.ingestLive({
        topic: 'jwc',
        event: 'code_agent_message_chunk',
        sessionId: meta.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'novel-live', content: { text: 'novel live' } },
    });
    assert.ok(live.length > 0);
    const oldFingerprintAfterClosure = adapter.ingestLive(livePayload(load2.at(-1)!, { sseReplay: true }));
    assert.ok(oldFingerprintAfterClosure.length > 0);
});

test('061 unseen sseReplay content applies while the overlap phase remains open', () => {
    const adapter = createCodeSourceAdapter(meta.sessionId, { now: clock() });
    adapter.ingestReplay(load1, { status: 'idle' });
    const novel = adapter.ingestLive({
        topic: 'jwc',
        event: 'code_agent_message_chunk',
        sessionId: meta.sessionId,
        sseReplay: true,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'novel-replay', content: { text: 'unseen replay text' } },
    });
    assert.ok(novel.length > 0);
    assert.equal(novel.some(action => action.kind === 'body_chunk'), true);
});

test('061 Code REST clients are instance-scoped and never query by sessionId', () => {
    for (const relative of ['code-api-client.ts', 'code-capability-client.ts']) {
        const source = readFileSync(new URL(`../../public/dashboard2/src/code/${relative}`, import.meta.url), 'utf8');
        assert.match(source, /`\/i\/\$\{port\}/, relative);
        assert.doesNotMatch(source, /fetch\(\s*['"`]\/(?!i\/\$\{port\})/, relative);
    }
    const root = new URL('../../public/dashboard2/src/', import.meta.url).pathname;
    const pending = [root];
    while (pending.length) {
        const directory = pending.pop()!;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) pending.push(path);
            else if (/\.tsx?$/.test(entry.name)) assert.doesNotMatch(readFileSync(path, 'utf8'), /\?sessionId=/, path);
        }
    }
});

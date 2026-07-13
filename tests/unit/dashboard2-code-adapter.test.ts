import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { TurnSegment } from '../../src/shared/chat-events.ts';
import { createCodeSourceAdapter } from '../../public/dashboard2/src/code/code-source-adapter.ts';
import { chunkText, type AcpSessionUpdate } from '../../public/dashboard2/src/code/code-event-types.ts';
import type { TurnStreamAction } from '../../public/dashboard2/src/turn-stream/types.ts';

interface FixtureMeta {
    sessionId: string;
}

interface FixtureNotification {
    dir?: unknown;
    msg?: {
        method?: unknown;
        params?: {
            sessionId?: unknown;
            update?: unknown;
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

function readFixtureUpdates(): FixtureUpdate[] {
    const lines = readFileSync(
        new URL('../fixtures/dashboard2-code-acp.ndjson', import.meta.url),
        'utf8',
    ).trim().split('\n');
    const updates: FixtureUpdate[] = [];
    for (const line of lines) {
        const record = JSON.parse(line) as FixtureNotification;
        // The capture script appends session/list + two session/load replay
        // drains after the live prompt. The LIVE wire capture ends at the
        // first outgoing history call; replay records are exercised through
        // ingestReplay, not as live payloads.
        if (record.dir === 'out'
            && (record.msg?.method === 'session/list' || record.msg?.method === 'session/load')) {
            break;
        }
        const params = record.dir === 'in' && record.msg?.method === 'session/update'
            ? record.msg.params
            : null;
        const update = params?.update;
        if (!update || typeof update !== 'object' || Array.isArray(update)) continue;
        const sessionUpdate = (update as Record<string, unknown>)['sessionUpdate'];
        if (params?.sessionId !== meta.sessionId || typeof sessionUpdate !== 'string') continue;
        updates.push({
            event: `code_${sessionUpdate}`,
            sessionId: meta.sessionId,
            update: update as AcpSessionUpdate,
        });
    }
    return updates;
}

const fixtureUpdates = readFixtureUpdates();

function clock(): () => number {
    let current = 1_000_000;
    return () => current++;
}

function lifecycleRows(actions: readonly TurnStreamAction[]): TurnSegment[] {
    return actions.flatMap(action => action.kind === 'lifecycle' ? [action.payload] : []);
}

function bodyText(actions: readonly TurnStreamAction[]): string {
    return actions.flatMap(action => action.kind === 'body_chunk' ? [action.text] : []).join('');
}

function expectedAssistantText(updates: readonly FixtureUpdate[]): string {
    return updates
        .filter(({ update }) => update.sessionUpdate === 'agent_message_chunk')
        .map(({ update }) => chunkText(update.content))
        .join('');
}

function livePayload(value: FixtureUpdate, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { topic: 'jwc', ...value, ...extra };
}

function fixtureDrive(): { actions: TurnStreamAction[]; rows: TurnSegment[]; expected: string } {
    const adapter = createCodeSourceAdapter(meta.sessionId, { now: clock() });
    // the live wire has no user_message_chunk echo (jwc/1.1.2: user echo
    // appears only in session/load replay) — CodeTab supplies the user lane
    // through notePromptAccepted after the REST prompt is accepted
    const actions = adapter.notePromptAccepted('Run the shell command `echo fixture-hello` and then reply with exactly: fixture done');
    actions.push(...fixtureUpdates.flatMap(update => adapter.ingestLive(livePayload(update))));
    actions.push(...adapter.ingestLive({
        topic: 'jwc',
        event: 'code_turn_done',
        sessionId: meta.sessionId,
        stopReason: 'end_turn',
    }));
    return { actions, rows: lifecycleRows(actions), expected: expectedAssistantText(fixtureUpdates) };
}

test('D5 real jwc/1.1.2 fixture maps to ordered lifecycle, body, and history actions', () => {
    const { actions, rows, expected } = fixtureDrive();
    const starts = rows.filter(row => row.type === 'turn_start');
    const ends = rows.filter(row => row.type === 'turn_end');
    assert.equal(starts.length, 1);
    assert.equal(ends.length, 1);
    assert.equal(ends[0]?.status, 'done');

    const thinking = rows.filter(row => row.type === 'thinking');
    const thinkingRunning = thinking.find(row => row.status === 'running');
    const thinkingDone = thinking.find(row => row.status === 'done'
        && row.segmentId === thinkingRunning?.segmentId);
    assert.ok(thinkingRunning);
    assert.equal(thinkingRunning.fidelity, 'full');
    assert.equal(thinkingRunning.thinkingMarker, 'streaming');
    assert.ok(thinkingDone);
    assert.ok(thinkingDone.turnSeq > thinkingRunning.turnSeq);

    const toolRows = rows.filter(row => row.type === 'tool');
    assert.equal(toolRows.length, 2);
    assert.deepEqual(toolRows.map(row => row.status), ['running', 'done']);
    assert.equal(toolRows[0]?.segmentId, toolRows[1]?.segmentId);
    assert.notEqual(toolRows[0]?.turnSeq, toolRows[1]?.turnSeq);
    assert.ok(rows.some(row => row.type === 'assistant_text' && row.status === 'running'));
    assert.equal(bodyText(actions), expected);

    const history = actions.flatMap(action => action.kind === 'history_page' ? action.messages : []);
    const assistant = history.at(-1);
    assert.equal(assistant?.role, 'assistant');
    assert.ok(assistant?.turn_id);
    assert.equal(assistant?.content, expected);
    const done = actions.find(action => action.kind === 'agent_done');
    assert.equal(done?.kind === 'agent_done' ? done.text : null, expected);
    assert.ok(history.some(message => message.role === 'user' && message.turn_id === null));

    assert.equal(rows.every(row => row.sessionId === meta.sessionId), true);
    assert.equal(rows.every(row => /^code:.+:\d{8}$/.test(row.turnId)), true);
    const byTurn = Map.groupBy(rows, row => row.turnId);
    for (const turnRows of byTurn.values()) {
        for (let index = 1; index < turnRows.length; index += 1) {
            assert.ok(turnRows[index]!.turnSeq > turnRows[index - 1]!.turnSeq);
        }
    }
});

test('D5 tool lifecycle appends distinct immutable running and terminal actions', () => {
    const { actions } = fixtureDrive();
    const toolActions = actions.filter(action => action.kind === 'lifecycle'
        && action.payload.type === 'tool');
    assert.equal(toolActions.length, 2);
    assert.notEqual(toolActions[0], toolActions[1]);
    const start = toolActions[0]!.payload;
    const terminal = toolActions[1]!.payload;
    assert.equal(start.segmentId, terminal.segmentId);
    assert.notEqual(start.turnSeq, terminal.turnSeq);
    assert.deepEqual([start.status, terminal.status], ['running', 'done']);
});

test('D5 replay overlap drops duplicate body and tool starts and reconstructs interruption history', () => {
    const adapter = createCodeSourceAdapter(meta.sessionId, { now: clock() });
    const replayRecords = fixtureUpdates.map(({ event, sessionId, update }) => ({ event, sessionId, update }));
    const replay = adapter.ingestReplay(replayRecords, { status: 'idle' });
    const replayRows = lifecycleRows(replay);
    assert.ok(replayRows.some(row => row.type === 'turn_end' && row.status === 'interrupted'));
    assert.ok(replay.some(action => action.kind === 'history_page'
        && action.messages.some(message => message.role === 'assistant' && message.content)));

    const overlap = fixtureUpdates.flatMap(update => adapter.ingestLive(livePayload(update, { sseReplay: true })));
    assert.equal(bodyText(overlap), '');
    assert.equal(lifecycleRows(overlap).filter(row => row.type === 'tool' && row.status === 'running').length, 0);
    assert.ok(adapter.telemetry().droppedDuplicates > 0);
});

test('D5 restarted SSE id rewind does not duplicate snapshot text without messageId', () => {
    const adapter = createCodeSourceAdapter(meta.sessionId, { now: clock() });
    const update = {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'same text' },
    };
    const first = adapter.ingestLive({
        topic: 'jwc', event: 'code_agent_message_chunk', sessionId: meta.sessionId,
        update, sseEventId: '42',
    });
    const second = adapter.ingestLive({
        topic: 'jwc', event: 'code_agent_message_chunk', sessionId: meta.sessionId,
        update, sseEventId: '1',
    });
    assert.equal(bodyText([...first, ...second]), 'same text');
});

test('D5 task tool calls project to one convergent collab lifecycle', () => {
    const adapter = createCodeSourceAdapter(meta.sessionId, { now: clock() });
    const start = adapter.ingestLive({
        topic: 'jwc', event: 'code_tool_call', sessionId: meta.sessionId,
        update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'task-1',
            title: 'Review',
            rawInput: { agent_type: 'task', description: 'x', name: 'reviewer', prompt: 'y' },
        },
    });
    const terminal = adapter.ingestLive({
        topic: 'jwc', event: 'code_tool_call_update', sessionId: meta.sessionId,
        update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'task-1',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
        },
    });
    const rows = lifecycleRows([...start, ...terminal]).filter(row => row.type === 'collab');
    assert.equal(rows.length, 2);
    assert.equal(rows.some(row => row.type === 'tool'), false);
    assert.ok(rows[0]!.segmentId.startsWith('collab:'));
    assert.match(decodeURIComponent(rows[0]!.segmentId), /task-1/);
    assert.equal(rows[1]!.segmentId, rows[0]!.segmentId);
    assert.equal(rows[1]!.status, 'done');
});

test('D5 permission requests stay on the permission side-channel', () => {
    const seen: Array<{ requestId: string | null }> = [];
    const adapter = createCodeSourceAdapter(meta.sessionId, {
        now: clock(),
        onPermission: event => seen.push({ requestId: event.requestId }),
    });
    const actions = adapter.ingestLive({
        topic: 'jwc', event: 'code_permission_request', sessionId: meta.sessionId,
        id: 'perm-1', options: [{ optionId: 'allow' }],
    });
    assert.deepEqual(seen, [{ requestId: 'perm-1' }]);
    assert.deepEqual(actions, []);
    assert.deepEqual(lifecycleRows(actions), []);
});

test('D5 unknown update kinds increment telemetry without poisoning later updates', () => {
    const adapter = createCodeSourceAdapter(meta.sessionId, { now: clock() });
    assert.deepEqual(adapter.ingestLive({
        topic: 'jwc', event: 'code_totally_new_kind', sessionId: meta.sessionId,
        update: { sessionUpdate: 'totally_new_kind' },
    }), []);
    assert.equal(adapter.telemetry().unknownUpdateKinds['totally_new_kind'], 1);
    const next = adapter.ingestLive({
        topic: 'jwc', event: 'code_agent_message_chunk', sessionId: meta.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still works' } },
    });
    assert.equal(bodyText(next), 'still works');
});

test('D5 duplicate terminal events converge without appended actions', () => {
    const adapter = createCodeSourceAdapter(meta.sessionId, { now: clock() });
    adapter.ingestLive({
        topic: 'jwc', event: 'code_agent_message_chunk', sessionId: meta.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
    });
    const terminal = { topic: 'jwc', event: 'code_turn_done', sessionId: meta.sessionId };
    assert.ok(adapter.ingestLive(terminal).length > 0);
    assert.deepEqual(adapter.ingestLive(terminal), []);
    assert.deepEqual(adapter.ingestLive({
        topic: 'jwc', event: 'code_session_cancelled', sessionId: meta.sessionId,
    }), []);
});

test('D5 a post-terminal user chunk opens ordinal two without changing turn-one rows', () => {
    const adapter = createCodeSourceAdapter(meta.sessionId, { now: clock() });
    const first = adapter.ingestLive({
        topic: 'jwc', event: 'code_agent_message_chunk', sessionId: meta.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'assistant-1', content: { text: 'one' } },
    });
    first.push(...adapter.ingestLive({
        topic: 'jwc', event: 'code_turn_done', sessionId: meta.sessionId,
    }));
    const firstRows = lifecycleRows(first);
    const snapshot = structuredClone(firstRows);
    const second = adapter.ingestLive({
        topic: 'jwc', event: 'code_user_message_chunk', sessionId: meta.sessionId,
        update: { sessionUpdate: 'user_message_chunk', messageId: 'user-2', content: { text: 'two' } },
    });
    const secondRows = lifecycleRows(second);
    assert.ok(secondRows.some(row => row.turnId.endsWith(':00000002')));
    assert.deepEqual(firstRows, snapshot);
});

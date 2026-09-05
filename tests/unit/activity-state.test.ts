import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ACTIVITY_MAX_ENTRIES, ACTIVITY_ENTRY_CHARS, ACTIVITY_TEXT_CHARS,
    ACTIVITY_MAX_REQUESTS, ACTIVITY_FINAL_CHARS,
    createActivityState, applyActivityEvent, activityKey, activityEntryLabel,
    activityEntryText, activityStatus, activityRetainedChars,
    type ActivityState, type ActivityEntry,
} from '../../src/shared/activity-state.js';
import { parseRuntimeEvent } from '../../src/shared/runtime-event-parse.js';
import type { RuntimeEvent, RuntimeEventBody, RuntimeEventIdentity } from '../../src/shared/runtime-contract.js';

const identity: RuntimeEventIdentity = {
    version: 1, sessionId: 'chat-a', scope: 'local:chat-a', runId: 'run-a', turnId: 'turn-a', seq: 1,
};
function event(seq: number, body: RuntimeEventBody): RuntimeEvent {
    const parsed = parseRuntimeEvent({ ...identity, seq, ...body });
    assert.ok(parsed, 'fixture must satisfy the existing parser');
    return Object.freeze(parsed);
}
function apply(state: ActivityState, seq: number, body: RuntimeEventBody): void {
    assert.equal(applyActivityEvent(state, event(seq, body)), true);
}
function tool(state: ActivityState, itemId = 't'): Extract<ActivityEntry, { kind: 'tool' }> {
    const entry = state.entries.get(itemId);
    assert.ok(entry?.kind === 'tool');
    return entry;
}
function chars(entry: ActivityEntry): number {
    return entry.kind === 'tool'
        ? entry.name.length + (entry.input?.length ?? 0) + (entry.output?.length ?? 0) + (entry.detail?.length ?? 0)
        : entry.text.length;
}

test('fresh state copies only four identity parts and owns independent collections', () => {
    const supplied = { ...identity, parentItemId: 'parent' };
    const s = createActivityState(supplied);
    supplied.runId = 'changed';
    assert.deepEqual(s.identity, { sessionId: 'chat-a', scope: 'local:chat-a', runId: 'run-a', turnId: 'turn-a' });
    assert.deepEqual([s.seq, s.revision, s.end, s.usage, s.latestAction], [0, 0, null, null, '']);
    assert.deepEqual(s.omitted, { entries: 0, textChars: 0, requests: 0, finalChars: 0, throughSeq: 0 });
    assert.equal(activityStatus(s), 'running');
    assert.equal(activityRetainedChars(s), 0);
    const other = createActivityState(identity);
    assert.notEqual(s.entries, other.entries);
    assert.notEqual(s.requests, other.requests);
    assert.notEqual(s.omitted, other.omitted);
    assert.equal(activityKey(s.identity), '["chat-a","local:chat-a","run-a","turn-a"]');
    assert.notEqual(activityKey({ ...identity, sessionId: 'a:b', scope: 'c' }),
        activityKey({ ...identity, sessionId: 'a', scope: 'b:c' }));
});

test('all four identity parts fence events before any mutation', () => {
    const s = createActivityState(identity);
    const first = event(10, { kind: 'message', itemId: 'm', phase: 'unknown', text: 'kept', operation: 'append' });
    assert.equal(applyActivityEvent(s, first), true);
    const before = structuredClone(s);
    for (const key of ['sessionId', 'scope', 'runId', 'turnId'] as const) {
        assert.equal(applyActivityEvent(s, { ...first, seq: 999, [key]: 'foreign' }), false, key);
        assert.deepEqual(s, before);
    }
});

test('sparse committed sequence is accepted, duplicates and older events are inert', () => {
    const s = createActivityState(identity);
    apply(s, 7, { kind: 'turn-start', provider: 'codex-app' });
    apply(s, 104, { kind: 'message', itemId: 'm', phase: 'unknown', text: 'first', operation: 'append' });
    const before = structuredClone(s);
    for (const seq of [7, 103, 104]) {
        assert.equal(applyActivityEvent(s, event(seq, { kind: 'turn-end', status: 'error', finalText: 'stale' })), false);
        assert.deepEqual(s, before);
    }
    assert.deepEqual(s.omitted, { entries: 0, textChars: 0, requests: 0, finalChars: 0, throughSeq: 0 });
    assert.equal(s.revision, 2);
    apply(s, Number.MAX_SAFE_INTEGER, { kind: 'usage', inputTokens: 1 });
    assert.equal(s.seq, Number.MAX_SAFE_INTEGER);
});

test('message and reasoning append/replace remain independent and never guess finality', () => {
    const s = createActivityState(identity);
    apply(s, 1, { kind: 'message', itemId: 'm', phase: 'unknown', text: 'FINAL ANSWER', operation: 'append' });
    apply(s, 2, { kind: 'reasoning', itemId: 'r', text: 'thinking', operation: 'append' });
    apply(s, 3, { kind: 'message', itemId: 'm', phase: 'commentary', text: ' more', operation: 'append' });
    apply(s, 4, { kind: 'reasoning', itemId: 'r', text: ' revised', operation: 'append' });
    assert.equal(activityEntryText(s.entries.get('m')!), 'FINAL ANSWER more');
    assert.equal(activityEntryText(s.entries.get('r')!), 'thinking revised');
    assert.equal(activityEntryLabel(s.entries.get('m')!), 'Commentary');
    assert.equal(activityEntryLabel(s.entries.get('r')!), 'Reasoning');
    apply(s, 5, { kind: 'message', itemId: 'm', phase: 'final', text: 'draft', operation: 'replace' });
    assert.equal(activityEntryText(s.entries.get('m')!), 'draft');
    assert.equal(activityEntryLabel(s.entries.get('m')!), 'Answer draft');
    assert.equal(s.end, null);
    apply(s, 6, { kind: 'reasoning', itemId: 'r', text: '', operation: 'replace' });
    apply(s, 7, { kind: 'message', itemId: 'm', phase: 'unknown', text: '', operation: 'replace' });
    assert.equal(activityEntryText(s.entries.get('r')!), '');
    assert.equal(activityEntryText(s.entries.get('m')!), '');
    assert.equal(activityEntryLabel(s.entries.get('m')!), 'Output (phase unknown)');
});

test('an item cannot change kind; failure leaves state unchanged', () => {
    const bodies: RuntimeEventBody[] = [
        { kind: 'message', itemId: 'same', phase: 'unknown', text: 'message', operation: 'append' },
        { kind: 'reasoning', itemId: 'same', text: 'reasoning', operation: 'append' },
        { kind: 'tool', itemId: 'same', name: 'read', status: 'running' },
    ];
    for (const first of bodies) for (const second of bodies) {
        if (first.kind === second.kind) continue;
        const s = createActivityState(identity);
        apply(s, 1, first);
        const before = structuredClone(s);
        assert.throws(() => applyActivityEvent(s, event(2, second)), /runtime_item_kind_changed/);
        assert.deepEqual(s, before);
    }
});

test('clipped append keeps a contiguous prefix; replacement resets the preview', () => {
    for (const kind of ['message', 'reasoning'] as const) {
        const s = createActivityState(identity);
        const body = { kind, itemId: 'm', phase: 'unknown' as const, operation: 'append' as const };
        apply(s, 1, { ...body, text: '한'.repeat(4095) });
        apply(s, 2, { ...body, text: 'ABCD' });
        apply(s, 3, { ...body, text: 'TAIL' });
        assert.equal(activityEntryText(s.entries.get('m')!), '한'.repeat(4095) + 'A');
        assert.equal(s.omitted.textChars, 7);
        apply(s, 4, { ...body, operation: 'replace', text: 'new' });
        apply(s, 5, { ...body, text: ' tail' });
        assert.equal(activityEntryText(s.entries.get('m')!), 'new tail');
        assert.equal(s.omitted.textChars, 7);
    }
});

test('tool snapshots preserve absent fields, replace supplied values, and clear explicit empties', () => {
    const s = createActivityState(identity);
    apply(s, 1, { kind: 'tool', itemId: 't', name: 'read', status: 'running', input: 'in', output: 'a', detail: 'why' });
    const old = tool(s);
    apply(s, 2, { kind: 'tool', itemId: 't', name: 'read', status: 'done', output: 'ab' });
    assert.deepEqual([tool(s).input, tool(s).output, tool(s).detail], ['in', 'ab', 'why']);
    assert.equal(activityEntryText(tool(s)), 'in\nab\nwhy');
    assert.equal(activityEntryLabel(tool(s)), 'read (done)');
    assert.equal(old.output, 'a');
    apply(s, 3, { kind: 'tool', itemId: 't', name: 'read', status: 'error', input: '', output: '', detail: '' });
    apply(s, 4, { kind: 'tool', itemId: 't', name: 'read', status: 'stopped' });
    assert.deepEqual([tool(s).input, tool(s).output, tool(s).detail], ['', '', '']);
    assert.equal(activityEntryText(tool(s)), '');
    assert.equal(s.entries.size, 1);
});

test('large tool input leaves fair output and detail previews within the shared 4096 budget', () => {
    const s = createActivityState(identity);
    apply(s, 1, { kind: 'tool', itemId: 't', name: 'read', status: 'running', input: 'i'.repeat(20000) });
    assert.equal(chars(tool(s)), 4096);
    const before = s.omitted.textChars;
    apply(s, 2, { kind: 'tool', itemId: 't', name: 'read', status: 'running',
        output: 'LIVE OUTPUT ' + 'o'.repeat(20000), detail: 'DETAIL ' + 'd'.repeat(20000) });
    const entry = tool(s);
    assert.ok(entry.input!.length >= 1000);
    assert.ok(entry.output!.length >= 1000);
    assert.ok(entry.detail!.length >= 1000);
    assert.match(entry.output!, /^LIVE OUTPUT /);
    assert.match(entry.detail!, /^DETAIL /);
    assert.ok(Math.max(entry.input!.length, entry.output!.length, entry.detail!.length)
        - Math.min(entry.input!.length, entry.output!.length, entry.detail!.length) <= 1);
    assert.equal(chars(entry), 4096);
    assert.equal(s.omitted.textChars - before, 4 + 4092 + 20012 + 20007 - 4096);
    apply(s, 3, { kind: 'tool', itemId: 't', name: 'read', status: 'done', input: '', output: 'complete', detail: '' });
    assert.equal(activityEntryText(tool(s)), 'complete');
});

test('short tool fields return spare budget to large fields without wasting preview space', () => {
    const s = createActivityState(identity);
    apply(s, 1, { kind: 'tool', itemId: 't', name: 'read', status: 'running',
        input: 'i'.repeat(20000), output: 'live', detail: 'ok' });
    assert.deepEqual([tool(s).input?.length, tool(s).output, tool(s).detail], [4086, 'live', 'ok']);
    assert.equal(activityRetainedChars(s), 4096);
    assert.equal(s.omitted.textChars, 15914);
});

test('latest action uses the current tool and status, not raw output or control characters', () => {
    const s = createActivityState(identity);
    apply(s, 1, { kind: 'tool', itemId: 'a', name: 'read_file', status: 'running', output: 'SECRET OUTPUT' });
    assert.equal(s.latestAction, 'read_file (running)');
    apply(s, 2, { kind: 'tool', itemId: 'b', name: 'npm\n\ttest\u001b\u0085', status: 'done' });
    assert.equal(s.latestAction, 'npm test (done)');
    apply(s, 3, { kind: 'message', itemId: 'm', phase: 'commentary', text: 'other', operation: 'append' });
    assert.equal(s.latestAction, 'npm test (done)');
    apply(s, 4, { kind: 'tool', itemId: 'c', name: 'x'.repeat(240), status: 'running' });
    assert.equal(s.latestAction.length, 240);
});

test('entry cap evicts oldest previews; reappearing append remains visibly incomplete', () => {
    const s = createActivityState(identity);
    for (let i = 1; i <= 129; i++) apply(s, i * 3, {
        kind: 'message', itemId: 'm' + i, phase: 'unknown', text: 'x', operation: 'append',
    });
    assert.equal(ACTIVITY_MAX_ENTRIES, 128);
    assert.equal(s.entries.size, 128);
    assert.equal(s.entries.has('m1'), false);
    assert.deepEqual([s.omitted.entries, s.omitted.throughSeq], [1, 3]);
    apply(s, 400, { kind: 'message', itemId: 'm1', phase: 'unknown', text: 'fragment', operation: 'append' });
    assert.equal(activityEntryText(s.entries.get('m1')!), 'fragment');
    assert.equal(s.omitted.entries, 2);
    assert.equal(s.omitted.throughSeq, 400);
});

test('aggregate UTF-16 text budget bounds long live runs independently of entry count', () => {
    const s = createActivityState(identity);
    assert.deepEqual([ACTIVITY_ENTRY_CHARS, ACTIVITY_TEXT_CHARS], [4096, 65536]);
    for (let i = 1; i <= 600; i++) {
        apply(s, i * 3, { kind: 'tool', itemId: 'tool-' + i, name: 'read_file ' + i,
            status: 'running', input: 'x'.repeat(20000), output: 'y'.repeat(20000) });
        assert.ok(s.entries.size <= 128);
        assert.ok([...s.entries.values()].every(entry => chars(entry) <= 4096));
        const retained = [...s.entries.values()].reduce((sum, entry) => sum + chars(entry), 0);
        assert.equal(activityRetainedChars(s), retained);
        assert.ok(retained <= 65536);
        assert.ok(tool(s, 'tool-' + i).output!.length > 0);
    }
    assert.equal(s.entries.size, 16);
    assert.equal(s.omitted.entries, 584);
    assert.equal(s.omitted.throughSeq, 1752);
    assert.ok(s.omitted.textChars > 0);
    assert.equal(s.latestAction, 'read_file 600 (running)');
});

test('request notices cap at 16, replace by ID, release capacity and never retain form controls', () => {
    const s = createActivityState(identity);
    const view = { title: 'T'.repeat(500), fields: [{ id: 'f', label: 'choose',
        options: [{ id: 'yes', label: 'Yes' }], multiSelect: false, allowFreeform: false }] };
    for (let i = 1; i <= 40; i++) apply(s, i, { kind: 'request', requestId: 'r' + i, requestType: 'approval', view });
    assert.equal(ACTIVITY_MAX_REQUESTS, 16);
    assert.equal(s.requests.size, 16);
    assert.equal(s.omitted.requests, 24);
    assert.deepEqual(s.requests.get('r1'), { requestId: 'r1', requestType: 'approval', title: 'T'.repeat(256) });
    assert.ok([...s.requests.values()].every(notice => !('view' in notice) && !('fields' in notice)));
    apply(s, 41, { kind: 'request', requestId: 'r1', requestType: 'question', view: { title: 'new', fields: [] } });
    assert.equal(s.requests.get('r1')?.title, 'new');
    assert.equal(s.requests.get('r1')?.requestType, 'question');
    assert.equal(s.omitted.requests, 24);
    apply(s, 42, { kind: 'request-settled', requestId: 'r1' });
    apply(s, 43, { kind: 'request-settled', requestId: 'r40' });
    assert.equal(s.requests.size, 15);
    apply(s, 44, { kind: 'request', requestId: 'fresh', requestType: 'approval', view });
    assert.equal(s.requests.size, 16);
    apply(s, 45, { kind: 'turn-end', status: 'done', finalText: '' });
    assert.equal(s.requests.size, 0);
    assert.equal(s.omitted.requests, 24);
});

test('usage is a partial snapshot: present counts replace, zero clears, absence preserves', () => {
    const s = createActivityState(identity);
    const first = event(1, { kind: 'usage', inputTokens: 100, outputTokens: 50, cachedTokens: 20 });
    assert.equal(applyActivityEvent(s, first), true);
    assert.notEqual(s.usage, first);
    apply(s, 2, { kind: 'usage', inputTokens: 3, outputTokens: 0 });
    assert.deepEqual(s.usage, { ...identity, seq: 2, kind: 'usage', inputTokens: 3, outputTokens: 0, cachedTokens: 20 });
    apply(s, 3, { kind: 'usage' });
    assert.equal(s.usage?.cachedTokens, 20);
    assert.equal(s.usage?.outputTokens, 0);
});

test('terminal null, empty, whitespace and partial text are distinct and latch all event kinds', () => {
    for (const status of ['done', 'error', 'stopped'] as const) for (const finalText of [null, '', ' \n ', 'partial']) {
        const s = createActivityState(identity);
        apply(s, 1, { kind: 'message', itemId: 'm', phase: 'final', text: 'never a fallback', operation: 'append' });
        apply(s, 2, { kind: 'tool', itemId: 't', name: 'unfinished', status: 'running' });
        apply(s, 3, { kind: 'turn-end', status, finalText });
        assert.equal(s.end?.finalText, finalText);
        assert.equal(activityStatus(s), status);
        assert.equal(tool(s).status, 'running');
        assert.equal(s.entries.size, 2);
        const before = structuredClone(s);
        const late: RuntimeEventBody[] = [
            { kind: 'turn-start', provider: 'pi' },
            { kind: 'message', itemId: 'm', phase: 'unknown', text: 'late', operation: 'replace' },
            { kind: 'reasoning', itemId: 'r', text: 'late', operation: 'append' },
            { kind: 'tool', itemId: 't', name: 'late', status: 'done' },
            { kind: 'request', requestId: 'r', requestType: 'approval', view: { title: 'late', fields: [] } },
            { kind: 'request-settled', requestId: 'r' },
            { kind: 'usage', outputTokens: 500 },
            { kind: 'turn-end', status: 'done', finalText: 'replacement' },
        ];
        for (const body of late) {
            assert.equal(applyActivityEvent(s, event(10, body)), false);
            assert.deepEqual(s, before);
        }
    }
});

test('bounded final and error previews leave the caller full final including its tail untouched', () => {
    const s = createActivityState(identity);
    const fullFinal = 'f'.repeat(32768) + 'TAIL SENTINEL';
    const terminal = event(1, { kind: 'turn-end', status: 'error', finalText: fullFinal, error: 'e'.repeat(1000) });
    const before = structuredClone(terminal);
    assert.equal(applyActivityEvent(s, terminal), true);
    assert.equal(ACTIVITY_FINAL_CHARS, 32768);
    assert.equal(s.end?.finalText, 'f'.repeat(32768));
    assert.equal(s.omitted.finalChars, 13);
    assert.equal(s.end?.error?.length, 500);
    assert.deepEqual(terminal, before);
    assert.notEqual(s.end, terminal);
    assert.ok(terminal.kind === 'turn-end' && terminal.finalText?.endsWith('TAIL SENTINEL'));
    assert.equal(activityRetainedChars(s), 0, 'final has its own budget');
});

test('caller events and nested request views are never mutated or retained by reference', () => {
    const s = createActivityState(identity);
    const message = event(1, { kind: 'message', itemId: 'm', phase: 'unknown', text: 'x'.repeat(20000), operation: 'append' });
    const t = event(2, { kind: 'tool', itemId: 't', name: 'read', status: 'running', output: 'x'.repeat(20000) });
    const request = event(3, { kind: 'request', requestId: 'r', requestType: 'question', view: { title: 'Original', fields: [] } });
    assert.ok(request.kind === 'request');
    Object.freeze(request.view.fields);
    Object.freeze(request.view);
    for (const value of [message, t, request]) {
        const before = structuredClone(value);
        assert.equal(applyActivityEvent(s, value), true);
        assert.deepEqual(value, before);
    }
    assert.notEqual(s.entries.get('m'), message);
    assert.notEqual(s.entries.get('t'), t);
    assert.deepEqual(s.requests.get('r'), { requestId: 'r', requestType: 'question', title: 'Original' });
});

test('omission counters saturate safely and throughSeq never decreases', () => {
    const s = createActivityState(identity);
    for (let i = 1; i <= 128; i++) apply(s, i, {
        kind: 'message', itemId: 'm' + i, phase: 'unknown', text: '', operation: 'append',
    });
    // Simulate a long-lived preview approaching its counter limit without trillions of events.
    s.omitted.entries = Number.MAX_SAFE_INTEGER - 1;
    s.omitted.textChars = Number.MAX_SAFE_INTEGER - 1;
    s.omitted.requests = Number.MAX_SAFE_INTEGER - 1;
    s.omitted.throughSeq = 100;
    apply(s, 129, { kind: 'message', itemId: 'large', phase: 'unknown', text: 'x'.repeat(20000), operation: 'replace' });
    apply(s, 130, { kind: 'message', itemId: 'extra', phase: 'unknown', text: '', operation: 'replace' });
    assert.equal(s.omitted.entries, Number.MAX_SAFE_INTEGER);
    assert.equal(s.omitted.textChars, Number.MAX_SAFE_INTEGER);
    assert.equal(s.omitted.throughSeq, 100);
    for (let i = 1; i <= 18; i++) apply(s, 130 + i, {
        kind: 'request', requestId: 'r' + i, requestType: 'approval', view: { title: 'notice', fields: [] },
    });
    assert.equal(s.omitted.requests, Number.MAX_SAFE_INTEGER);
    assert.ok(Object.values(s.omitted).every(Number.isSafeInteger));
});

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
// Recorders are injected here; module loading must not initialize shared SQLite.
mock.module('../../src/trace/store.js', { namedExports: { appendTraceEvent: () => null } });
const { ClaudeSdkEvents } = await import('../../src/agent/runtime/claude-sdk-events.ts');
const { RuntimeProjection } = await import('../../src/agent/runtime/projection.ts');
import type { RuntimeEvent, RuntimeEventBody } from '../../src/shared/runtime-contract.ts';
import type { RuntimeEventContext } from '../../src/agent/runtime/events.ts';
import type { ClaudeChildOwner } from '../../src/agent/runtime/claude-sdk-children.ts';

const tool = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'pwd' } });
const assistant = (parent: string, id: string, content: object[]) => ({ type: 'assistant', parent_tool_use_id: parent,
    message: { id, content } });
const task = (subtype: string, task_id: string, extra: object = {}) => ({ type: 'system', subtype, task_id, ...extra });
async function harness() {
    const { ClaudeSdkChildren } = await import('../../src/agent/runtime/claude-sdk-children.ts');
    const events: RuntimeEvent[] = [], notices: string[] = [], parents = new Map<string, ClaudeChildOwner>();
    let seq = 0, failure = false;
    const record = (context: RuntimeEventContext, body: RuntimeEventBody): RuntimeEvent | null => {
        if (failure) return null;
        const event: RuntimeEvent = { ...context, version: 1, seq: ++seq, ...body };
        events.push(event); return event;
    };
    function owner(turnId: string) {
        let active = true, current = true, terminalWindow = false;
        const context = { runId: 'run', sessionId: 'session', scope: 'scope', turnId, audience: 'internal' as const };
        const projection = new RuntimeProjection(context, record, reason => notices.push(reason));
        const binding: ClaudeChildOwner = { context, projection, record, isCurrent: () => current, isActive: () => active,
            canRecordTerminal: () => terminalWindow };
        return { binding, projection, context, inactive: () => { active = false; }, stale: () => { current = false; },
            terminalWindow: (value: boolean) => { terminalWindow = value; }, invoke: (id: string, publish = true) => {
                parents.set(id, binding);
                if (publish) projection.tool('claude:tool:' + id, { name: 'Agent', status: 'running' });
            } };
    }
    return { events, notices, parents, owner, fail: () => { failure = true; },
        children: new ClaudeSdkChildren({ resolveParent: id => parents.get(id) ?? null }) };
}

test('finishChild stops pending tools without final/end and leaves completed tools terminal', () => {
    for (const status of ['done', 'error', 'stopped'] as const) {
        const events: RuntimeEvent[] = [];
        const p = new RuntimeProjection({ runId: 'r', sessionId: 's', scope: 's', turnId: 't', audience: 'internal' },
            (context, body) => { const e: RuntimeEvent = { ...context, version: 1, seq: events.length + 1, ...body }; events.push(e); return e; });
        const m = new ClaudeSdkEvents(p);
        m.accept({ type: 'assistant', message: { id: 'm', content: [tool('pending'), tool('complete')] } });
        m.accept({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'complete', content: 'ok' }] } });
        m.finishChild(status);
        const end = events.filter(e => e.kind === 'tool').slice(-1)[0];
        assert.equal(end?.status, status === 'error' ? 'error' : 'stopped');
        const count = events.length;
        m.finishChild('error'); m.accept({ type: 'assistant', message: { id: 'late', content: [tool('late')] } });
        assert.equal(events.length, count);
        assert.ok(!events.some(e => e.kind === 'turn-end' || e.kind === 'message' && e.phase === 'final'));
        p.tool('independent', { status: 'running' }); // finishChild must not close the projector.
        assert.equal(events.length, count + 1);
    }
});

test('parent plus two children have distinct IDs, published parents and no self references', async () => {
    const h = await harness(), parent = h.owner('turn'); parent.invoke('p1'); parent.invoke('p2');
    for (const id of ['p1', 'p2']) {
        assert.equal(h.children.accept(assistant(id, 'same-message', [tool('tool-' + id), { type: 'text', text: id }])), true);
    }
    const items = h.events.filter(e => 'itemId' in e);
    assert.equal(new Set(items.map(e => e.itemId)).size, 6);
    const roots = new Set(items.filter(e => !e.parentItemId).map(e => e.itemId));
    for (const e of items.filter(e => e.parentItemId)) {
        assert.ok(roots.has(e.parentItemId)); assert.notEqual(e.itemId, e.parentItemId);
        assert.match(e.itemId, /^claude-child-\d+-item-/);
    }
    assert.ok(!h.events.some(e => e.kind === 'turn-start' || e.kind === 'turn-end'));
});

test('failed parent recorder never fabricates linkage; child approvals survive journal failure', async () => {
    const h = await harness(), p = h.owner('old'); h.fail(); p.invoke('p');
    h.children.accept(assistant('p', 'm', [tool('t')]));
    assert.deepEqual(h.events, []); assert.equal(h.children.resolveTool('t'), null);
    const h2 = await harness(), p2 = h2.owner('turn'); p2.invoke('p'); h2.fail();
    h2.children.accept(assistant('p', 'm', [tool('t')]));
    assert.equal(h2.events.length, 1);
    const permission = h2.children.resolveTool('t'); assert.ok(permission);
    assert.equal(permission.context.parentItemId, 'item-1'); assert.ok(permission.isCurrent());
    p2.inactive(); assert.equal(permission.isCurrent(), false);
});

test('captured child approval context is immutable and never borrowed by the next send', async () => {
    const h = await harness(), old = h.owner('old'); old.invoke('p');
    h.children.accept(assistant('p', 'm', [tool('t')]));
    const permission = h.children.resolveTool('t'); assert.ok(permission);
    assert.equal(permission.context.turnId, 'old'); assert.equal(permission.context.parentItemId, 'item-1');
    const count = h.events.length;
    permission.emit({ kind: 'request-settled', requestId: 'request' });
    assert.equal(h.events.length, count + 1);
    old.inactive(); const next = h.owner('new'); next.invoke('p');
    h.children.accept(assistant('p', 'late', [{ type: 'text', text: 'late-canary' }]));
    assert.equal(permission.isCurrent(), false); assert.equal(h.children.resolveTool('t'), null);
    permission.emit({ kind: 'request-settled', requestId: 'late' });
    assert.ok(!JSON.stringify(h.events).includes('late-canary'));
    assert.ok(!h.events.some(e => e.kind === 'request-settled' && e.requestId === 'late'));
});

test('Stop publishes stopped snapshots after inactive, freezes unknown buffers and is owner scoped', async () => {
    const h = await harness(), a = h.owner('a'), b = h.owner('b'); a.invoke('a'); b.invoke('b');
    h.children.accept(assistant('a', 'm', [tool('ta')]));
    h.children.accept(assistant('b', 'm', [tool('tb')]));
    h.children.accept(assistant('unknown', 'm', [{ type: 'text', text: 'buffer-canary' }]));
    a.inactive(); h.children.stopOwner(a.context);
    assert.equal(h.events.filter(e => e.kind === 'tool' && e.turnId === 'a').at(-1)?.status, 'stopped');
    assert.equal(h.children.resolveTool('ta'), null); assert.ok(h.children.resolveTool('tb'));
    const count = h.events.length; h.children.stopOwner(a.context);
    h.children.accept(assistant('a', 'late', [tool('late')]));
    assert.equal(h.events.length, count);
    b.invoke('unknown'); h.children.accept({ type: 'system', subtype: 'init' });
    assert.ok(!JSON.stringify(h.events).includes('buffer-canary'));
});

test('stale generation suppresses Stop recording', async () => {
    const h = await harness(), p = h.owner('old'); p.invoke('p');
    h.children.accept(assistant('p', 'm', [tool('t')])); p.stale();
    const count = h.events.length; h.children.stopOwner(p.context); assert.equal(h.events.length, count);
});

test('captured terminal capability never authorizes requests, text or new child tools', async () => {
    const h = await harness(), p = h.owner('old'); p.invoke('p');
    h.children.accept(assistant('p', 'm', [tool('t')]));
    const permission = h.children.resolveTool('t'); assert.ok(permission);
    p.inactive(); p.stale(); p.terminalWindow(true);
    const before = h.events.length;
    assert.equal(permission.isCurrent(), false);
    permission.emit({ kind: 'request-settled', requestId: 'forbidden' });
    h.children.accept(assistant('p', 'late', [tool('new'), { type: 'text', text: 'forbidden' }]));
    assert.equal(h.events.length, before);
    h.children.stopOwner(p.context); p.terminalWindow(false);
    const passive = h.events.slice(before);
    assert.equal(passive.length, 1);
    assert.ok(passive.every(event => event.kind === 'tool' && event.status === 'stopped' && event.turnId === 'old'));
    assert.equal(h.children.resolveTool('new'), null); assert.equal(h.children.resolveTool('t'), null);
    assert.ok(!JSON.stringify(h.events).includes('forbidden'));
});

test('unlinked child and every task family are intercepted while parent frames pass through', async () => {
    const h = await harness();
    for (const subtype of ['task_started', 'task_progress', 'task_notification', 'task_updated'])
        assert.equal(h.children.accept(task(subtype, 'task', { patch: {} })), true);
    for (const type of ['assistant', 'user', 'stream_event', 'tool_progress', 'result', 'future'])
        assert.equal(h.children.accept({ type, parent_tool_use_id: 'missing' }), true);
    assert.equal(h.children.accept({ type: 'result', subtype: 'success', is_error: false, result: 'parent' }), false);
    assert.equal(h.children.accept({ type: 'system', subtype: 'init' }), false);
    assert.deepEqual(h.events, []);
});

test('child-before-parent publication replays only when real linkage exists', async () => {
    const h = await harness(), p = h.owner('old'); p.invoke('p', false);
    h.children.accept(assistant('p', 'm', [{ type: 'text', text: 'buffered' }])); assert.equal(h.events.length, 0);
    p.projection.tool('claude:tool:p', { name: 'Agent', status: 'running' });
    h.children.accept(task('task_started', 'task', { tool_use_id: 'p', description: 'work' }));
    assert.equal(h.events.filter(e => e.kind === 'message' && e.text === 'buffered').length, 1);
});

test('task notifications and updates before start replay in order and terminal status is monotonic', async () => {
    for (const [wire, expected] of [['completed', 'done'], ['failed', 'error'], ['killed', 'stopped']] as const) {
        const h = await harness(), p = h.owner('turn'); p.invoke('p');
        h.children.accept(task('task_updated', 'task', { patch: { status: wire } }));
        h.children.accept(task('task_started', 'task', { tool_use_id: 'p', description: 'work' }));
        const rows = h.events.filter(e => e.kind === 'tool' && e.parentItemId);
        assert.equal(rows.at(-1)?.status, expected);
        const count = h.events.length;
        h.children.accept(task('task_progress', 'task', { description: 'late-canary' }));
        h.children.accept(task('task_updated', 'task', { patch: { status: 'running' } }));
        assert.equal(h.events.length, count);
    }
});

test('task progress and terminal notification settle rows and unfinished tools without child final', async () => {
    const h = await harness(), p = h.owner('turn'); p.invoke('p');
    h.children.accept(assistant('p', 'm', [tool('t')]));
    h.children.accept(task('task_progress', 'task', { tool_use_id: 'p', description: 'working' }));
    h.children.accept(task('task_notification', 'task', { status: 'failed', summary: 'failed' }));
    const rows = h.events.filter(e => e.kind === 'tool' && e.parentItemId);
    assert.equal(rows.at(-1)?.status, 'error'); assert.equal(h.children.resolveTool('t'), null);
    const count = h.events.length;
    h.children.accept({ type: 'result', parent_tool_use_id: 'p', subtype: 'success', is_error: false, result: 'child-final' });
    assert.equal(h.events.length, count); assert.ok(!h.events.some(e => e.kind === 'turn-end'));
});

test('streamed child tools resolve approvals and nested children use prefixed published parents', async () => {
    const h = await harness(), p = h.owner('turn'); p.invoke('p');
    for (const event of [{ type: 'message_start', message: { id: 'm' } },
        { type: 'content_block_start', index: 0, content_block: tool('nested') }])
        h.children.accept({ type: 'stream_event', parent_tool_use_id: 'p', event });
    assert.ok(h.children.resolveTool('nested'));
    h.children.accept(assistant('nested', 'm', [tool('grandchild')]));
    const last = h.events.at(-1); assert.ok(last && 'itemId' in last);
    assert.equal(last.parentItemId, 'claude-child-1-item-1'); assert.notEqual(last.itemId, last.parentItemId);
});

test('prelink buffer admits only 32 frames and 64KiB total, with bounded overflow notice', async () => {
    for (const size of [10, 20000, 65537]) {
        const h = await harness(), p = h.owner('turn'); p.invoke('p', false);
        for (let i = 0; i < 40; i++) h.children.accept(assistant('p', 'm' + i, [{ type: 'text', text: 'x'.repeat(size) }]));
        p.projection.tool('claude:tool:p', { name: 'Agent', status: 'running' });
        h.children.accept({ type: 'system', subtype: 'init' });
        assert.equal(h.events.filter(e => e.kind === 'message').length, size === 10 ? 32 : size === 20000 ? 3 : 0);
        assert.ok(h.notices.includes('capacity'));
    }
});

test('child/task/tool identity caps never evict and rebind admitted identities', async () => {
    const h = await harness(), p = h.owner('turn');
    for (let i = 0; i < 129; i++) { p.invoke('p' + i); h.children.accept(assistant('p' + i, 'm', [tool('t' + i)])); }
    assert.ok(h.children.resolveTool('t0')); assert.equal(h.children.resolveTool('t128'), null);
    const h2 = await harness(), p2 = h2.owner('turn'); p2.invoke('p');
    for (let i = 0; i < 129; i++) h2.children.accept(task('task_started', 'task' + i, { tool_use_id: 'p', description: 'work' }));
    assert.equal(h2.events.filter(e => e.kind === 'tool' && e.parentItemId).length, 128);
    const h3 = await harness(), p3 = h3.owner('turn');
    for (let c = 0; c < 4; c++) { p3.invoke('p' + c);
        h3.children.accept(assistant('p' + c, 'm', Array.from({ length: 128 }, (_, i) => tool('t' + (c * 128 + i))))); }
    p3.invoke('overflow'); h3.children.accept(assistant('overflow', 'm', [tool('overflow')]));
    assert.ok(h3.children.resolveTool('t511')); assert.equal(h3.children.resolveTool('overflow'), null);
});

test('result-only tool IDs cannot authorize callbacks and child tools cannot steal root IDs', async () => {
    const h = await harness(), p = h.owner('turn'); p.invoke('p');
    h.children.accept({ type: 'user', parent_tool_use_id: 'p', message: {
        content: [{ type: 'tool_result', tool_use_id: 'result-only', content: 'ok' }] } });
    assert.equal(h.children.resolveTool('result-only'), null);
    h.children.accept(assistant('p', 'm', [tool('p')]));
    assert.equal(h.children.resolveTool('p'), null);
});

test('child result settles its tools and task row without publishing usage, final or turn-end', async () => {
    for (const [subtype, is_error, expected] of [['success', false, 'done'], ['error_during_execution', true, 'error']] as const) {
        const h = await harness(), p = h.owner('turn'); p.invoke('p');
        h.children.accept(task('task_started', 'task', { tool_use_id: 'p', description: 'work' }));
        h.children.accept(assistant('p', 'm', [tool('t'), { type: 'text', text: 'partial' }]));
        h.children.accept({ type: 'result', parent_tool_use_id: 'p', subtype, is_error, result: 'child-final', usage: { input_tokens: 10 } });
        const states = new Map(h.events.filter(e => e.kind === 'tool' && e.parentItemId).map(e => [e.itemId, e.status]));
        assert.deepEqual([...states.values()], [expected, expected === 'error' ? 'error' : 'stopped']);
        assert.ok(!h.events.some(e => e.kind === 'turn-end' || e.kind === 'usage' || e.kind === 'message' && e.phase === 'final'));
    }
});

test('unpublished linkage retains its original owner and conflicting task identity cannot move it', async () => {
    const h = await harness(), old = h.owner('old'); old.invoke('p', false);
    h.children.accept(assistant('p', 'm', [{ type: 'text', text: 'old-buffer' }]));
    old.inactive(); const next = h.owner('new'); next.invoke('p');
    h.children.accept(task('task_started', 'task', { tool_use_id: 'p', description: 'work' }));
    next.invoke('other');
    h.children.accept(task('task_progress', 'task', { tool_use_id: 'other', description: 'wrong-canary' }));
    assert.ok(!h.events.some(e => e.parentItemId));
});

test('task-only prelink overflow reports incomplete projection once an owner is known', async () => {
    const h = await harness(), p = h.owner('turn');
    for (let i = 0; i < 33; i++) h.children.accept(task('task_progress', 'task', { description: 'progress' + i }));
    p.invoke('p'); h.children.accept(task('task_started', 'task', { tool_use_id: 'p', description: 'work' }));
    assert.ok(h.notices.includes('capacity'));
});

test('unsupported task status cannot fabricate running state and active task previews are bounded', async () => {
    const h = await harness(), p = h.owner('turn'); p.invoke('p');
    h.children.accept(task('task_updated', 'task', { patch: { status: 'future-status' } }));
    h.children.accept(task('task_started', 'task', { tool_use_id: 'p', description: 'work' }));
    assert.equal(h.events.filter(e => e.kind === 'tool' && e.parentItemId).length, 1);
    h.children.accept(task('task_progress', 'task', { description: 'x'.repeat(65537) }));
    assert.ok(h.notices.includes('capacity'));
    h.children.accept(task('task_notification', 'task', { status: 'stopped', summary: 'stopped' }));
    assert.equal(h.events.filter(e => e.kind === 'tool' && e.parentItemId).at(-1)?.status, 'stopped');
});

test('a published child retains approval ownership after later recording failure', async () => {
    const h = await harness(), p = h.owner('turn'); p.invoke('p');
    h.children.accept(assistant('p', 'm', [tool('first')]));
    const before = h.children.resolveTool('first'); assert.ok(before);
    h.fail(); h.children.accept(assistant('p', 'm2', [tool('second')]));
    const first = h.children.resolveTool('first'), second = h.children.resolveTool('second');
    assert.ok(first && second); assert.strictEqual(first.context, before.context);
    assert.strictEqual(second.context, before.context); assert.ok(second.isCurrent());
    h.children.stopOwner(p.context);
    assert.equal(second.isCurrent(), false); assert.equal(h.children.resolveTool('second'), null);
});

const rootAgentResult = (toolUseId: string, output?: object) => ({ type: 'user', parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'completed' }] },
    ...(output === undefined ? {} : { tool_use_result: output }) });

test('foreground Agent structured completed result settles its existing child before parent closes', async () => {
    const h = await harness(), p = h.owner('turn'); p.invoke('p'); p.invoke('other');
    for (const name of ['p', 'other']) {
        h.children.accept(task('task_started', 'task-' + name, { tool_use_id: name, description: 'work' }));
        h.children.accept(assistant(name, 'm', [tool('tool-' + name)]));
    }
    assert.equal(h.children.accept(rootAgentResult('p', { status: 'completed', totalToolUseCount: 0 })), false);
    const rows = new Map(h.events.filter(e => e.kind === 'tool' && e.parentItemId === 'item-1').map(e => [e.itemId, e.status]));
    assert.deepEqual([...rows.values()], ['done', 'stopped']);
    assert.equal(h.children.resolveTool('tool-p'), null); assert.ok(h.children.resolveTool('tool-other'));
    assert.ok(!h.events.some(e => e.kind === 'turn-end' || e.kind === 'message' && e.phase === 'final'));
    const count = h.events.length;
    h.children.accept(rootAgentResult('p', { status: 'completed' }));
    assert.equal(h.events.length, count);
});

test('async launched, plain tool text and ordinary parent result never imply child completion or Stop', async () => {
    const h = await harness(), p = h.owner('turn'); p.invoke('p');
    h.children.accept(task('task_started', 'task', { tool_use_id: 'p', description: 'work' }));
    h.children.accept(assistant('p', 'm', [tool('t')]));
    const count = h.events.length;
    for (const raw of [rootAgentResult('p', { status: 'async_launched', isAsync: true, totalToolUseCount: 10 }),
        rootAgentResult('p'), rootAgentResult('unknown', { status: 'completed' }),
        { type: 'result', subtype: 'success', is_error: false, result: 'completed' }]) {
        assert.equal(h.children.accept(raw), false); assert.equal(h.events.length, count);
    }
    assert.ok(h.children.resolveTool('t'));
});

test('foreground completion is fenced by captured active turn and generation', async () => {
    for (const fence of ['inactive', 'stale'] as const) {
        const h = await harness(), old = h.owner('old'); old.invoke('p');
        h.children.accept(task('task_started', 'task', { tool_use_id: 'p', description: 'work' }));
        h.children.accept(assistant('p', 'm', [tool('t')]));
        old[fence](); const next = h.owner('new'); next.invoke('p');
        const count = h.events.length;
        assert.equal(h.children.accept(rootAgentResult('p', { status: 'completed' })), false);
        assert.equal(h.events.length, count); assert.equal(h.children.resolveTool('t'), null);
    }
});

test('foreground completed signal and parent outcome remain effective with no journal writes', async () => {
    const h = await harness(), p = h.owner('turn'); p.invoke('p');
    h.children.accept(assistant('p', 'm', [tool('t')]));
    h.fail();
    assert.equal(h.children.accept(rootAgentResult('p', { status: 'completed' })), false);
    assert.equal(h.children.resolveTool('t'), null);
    const parent = new ClaudeSdkEvents(p.projection);
    const result = { type: 'result', subtype: 'success', is_error: false, result: 'parent final' };
    assert.equal(h.children.accept(result), false);
    assert.deepEqual(parent.accept(result), { status: 'done', finalText: 'parent final', partialText: '' });
});

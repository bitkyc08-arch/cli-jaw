import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeEvent, RuntimeEventBody } from '../../src/shared/runtime-contract.ts';
import type { RuntimeEventContext } from '../../src/agent/runtime/events.ts';
import type { RuntimeTranscriptObserver, RuntimeEnd } from '../../src/agent/runtime/projection.ts';
import type { ClaudeChildOwner } from '../../src/agent/runtime/claude-sdk-children.ts';
import type { ClaudeSessionOptions } from '../../src/agent/runtime/claude-sdk-session.ts';
import { createClaudeInput } from '../../src/agent/runtime/claude-sdk-input.ts';
import { FULLTEXT_MAX_CHARS } from '../../src/agent/events/fulltext-bound.ts';

let defaultWrites = 0;
mock.module('../../src/trace/activity-journal.js', { namedExports: {
    appendActivityBody: () => { defaultWrites++; throw new Error('Unexpected default journal'); },
    markActivityFailure: () => {},
} });
test.after(() => assert.equal(defaultWrites, 0));
const { RuntimeProjection } = await import('../../src/agent/runtime/projection.ts');
const { ClaudeSdkChildren } = await import('../../src/agent/runtime/claude-sdk-children.ts');
const { createClaudeSdkSession } = await import('../../src/agent/runtime/claude-sdk-session.ts');
const { AcpSession } = await import('../../src/agent/runtime/acp/session.ts');
const { AcpRuntimeSession } = await import('../../src/agent/runtime/acp/runtime-session.ts');
const { RuntimeRequests } = await import('../../src/agent/runtime/requests.ts');

const context: RuntimeEventContext = {
    runId: 'run', sessionId: 'session', scope: 'scope', turnId: 'turn', audience: 'internal',
};
const end: RuntimeEnd = { kind: 'turn-end', status: 'done', finalText: 'answer' };
function recorder() {
    const events: RuntimeEvent[] = [];
    const record = (owner: RuntimeEventContext, body: RuntimeEventBody): RuntimeEvent => {
        const event: RuntimeEvent = { ...owner, version: 1, seq: events.length + 1, ...body };
        events.push(event); return event;
    };
    return { events, record };
}
function transcript() {
    const texts: Parameters<RuntimeTranscriptObserver['text']>[] = [];
    const tools: Parameters<RuntimeTranscriptObserver['tool']>[] = [];
    const ends: RuntimeEnd[] = [];
    const observer: RuntimeTranscriptObserver = {
        text: (...args) => { texts.push(args); },
        tool: (...args) => { tools.push(args); },
        close: value => { ends.push(value); },
    };
    return { observer, texts, tools, ends };
}
function fixture(observer?: RuntimeTranscriptObserver) {
    const r = recorder(), notices: string[] = [];
    return { ...r, notices, projection: new RuntimeProjection(context, r.record, reason => notices.push(reason), observer) };
}

test('raw text exceeds field and total preview budgets without changing default preview bytes', () => {
    const raw = transcript(), observed = fixture(raw.observer), baseline = fixture();
    const values = Array.from({ length: 12 }, (_, i) => `message ${i}: ` + 'x'.repeat(4000));
    for (const f of [baseline, observed]) {
        for (const [i, value] of values.entries()) f.projection.text('message', `native-${i}`, value, 'replace', 'commentary');
        f.projection.text('message', 'native-0', '\ntrailing patch', 'append');
    }
    assert.ok(values.reduce((sum, text) => sum + text.length, 0) > 24000);
    assert.deepEqual(raw.texts.slice(0, 12), values.map((value, i) => ['message', `native-${i}`, value, 'replace', 'commentary']));
    assert.deepEqual(raw.texts.at(-1), ['message', 'native-0', '\ntrailing patch', 'append', 'unknown']);
    assert.equal(JSON.stringify(observed.events), JSON.stringify(baseline.events));
    assert.deepEqual(observed.projection.diagnostics(), baseline.projection.diagnostics());
    assert.ok(baseline.events.every(event => event.kind !== 'message' || event.text.length <= 3000));
    assert.equal(baseline.events[0]?.kind, 'message');
    assert.ok(baseline.events.some(event => event.kind === 'message' && event.text === ''));
    assert.ok(baseline.projection.diagnostics().previewChars <= 24000);
});

test('item 161 and later raw tools, messages and reasoning reach the observer before allocation', () => {
    const raw = transcript(), observed = fixture(raw.observer), baseline = fixture();
    for (const f of [baseline, observed]) {
        for (let i = 0; i < 180; i++) f.projection.tool(`tool-${i}`, { status: 'done' });
        f.projection.text('message', 'beyond-cap', 'full answer'.repeat(400), 'replace', 'final');
        f.projection.text('reasoning', 'beyond-cap', 'full reasoning'.repeat(400), 'append');
    }
    assert.equal(raw.tools.length, 180);
    assert.deepEqual(raw.tools[160], ['tool-160', { status: 'done' }, {}]);
    assert.equal(raw.texts[0]?.[2], 'full answer'.repeat(400));
    assert.equal(raw.texts[1]?.[2], 'full reasoning'.repeat(400));
    assert.equal(observed.projection.itemId('tool', 'tool-160'), null);
    assert.equal(baseline.events.length, 160);
    assert.equal(baseline.projection.diagnostics().items, 160);
    assert.equal(JSON.stringify(observed.events), JSON.stringify(baseline.events));
    assert.deepEqual(observed.projection.diagnostics(), baseline.projection.diagnostics());
});

test('tool patches retain raw structured fragments, operations and late terminal enrichment', () => {
    const raw = transcript(), f = fixture(raw.observer);
    const first = { status: 'running' as const, delta: '{"password":"secret-', outputStructured: true };
    const second = { status: 'done' as const, delta: 'canary","ok":true}', outputStructured: true };
    const late = { name: 'Read', status: 'running' as const, input: '{"path":"file"}', inputStructured: true, output: 'must not replace' };
    const refresh = { status: 'done' as const, output: 'explicit terminal refresh' };
    f.projection.tool('native', first); f.projection.tool('native', second);
    f.projection.tool('native', late);
    f.projection.tool('native', refresh, { allowTerminalUpdates: true });
    assert.deepEqual(raw.tools, [['native', first, {}], ['native', second, {}], ['native', late, {}],
        ['native', refresh, { allowTerminalUpdates: true }]]);
    const enriched = f.events[2]; assert.ok(enriched?.kind === 'tool');
    assert.equal(enriched.status, 'done'); assert.equal(enriched.name, 'Read');
    assert.equal(enriched.input, '{"path":"file"}');
    assert.ok(!JSON.stringify(f.events).includes('secret-canary'));
    assert.ok(!JSON.stringify(f.events).includes('must not replace'));
});

test('preview source retirement never retires subsequent raw patches', () => {
    const lengths: number[] = [];
    const f = fixture({ text: (_kind, _ref, value) => { lengths.push(value.length); }, tool: () => {}, close: () => {} });
    f.projection.text('message', 'huge', 'x'.repeat(FULLTEXT_MAX_CHARS + 1), 'replace');
    f.projection.text('message', 'huge', 'after retirement', 'append');
    assert.deepEqual(lengths, [FULLTEXT_MAX_CHARS + 1, 16]);
    assert.equal(f.projection.diagnostics().recordingFailed, false);
    assert.ok(f.notices.includes('capacity'));
});

test('raw tool input, output and detail retain full fields beyond the total preview budget', () => {
    const raw = transcript(), f = fixture(raw.observer);
    const input = 'input '.repeat(700), output = 'output '.repeat(700), detail = 'detail '.repeat(700);
    for (let i = 0; i < 10; i++) f.projection.tool(`tool-${i}`, { name: 'Read', input, output, detail, status: 'done' });
    assert.equal(raw.tools.length, 10);
    for (const [, patch] of raw.tools) {
        assert.equal(patch.input, input); assert.equal(patch.output, output); assert.equal(patch.detail, detail);
    }
    assert.ok(f.projection.diagnostics().previewChars <= 24000);
    assert.ok(f.events.every(event => event.kind !== 'tool' || (event.output?.length ?? 0) <= 3000));
});

test('close notifies once before preview terminal writes and rejects reentrant or late patches', () => {
    const order: string[] = [], raw = transcript();
    let projection: InstanceType<typeof RuntimeProjection>;
    const r = recorder();
    projection = new RuntimeProjection(context, (owner, body) => {
        if (body.kind === 'tool' && body.status === 'stopped') projection.close(end);
        order.push(body.kind); return r.record(owner, body);
    }, () => {}, { ...raw.observer, close(value) {
        order.push('observer-close'); raw.observer.close(value);
        projection.close(end); projection.text('message', 'late', 'reentrant', 'replace');
    } });
    projection.tool('pending', { status: 'running' });
    projection.close(end); projection.close(end);
    projection.text('message', 'late', 'late', 'replace'); projection.tool('late', { status: 'running' });
    assert.deepEqual(order, ['tool', 'observer-close', 'tool', 'turn-end']);
    assert.deepEqual(raw.ends, [end]); assert.equal(raw.tools.length, 1); assert.equal(raw.texts.length, 0);
});

for (const method of ['text', 'tool', 'close'] as const) test(`throwing ${method} observer preserves owner failure closure and fences preview completion`, () => {
    const error = new Error('durable write failed');
    let persistenceFailure: unknown, cleanup = 0;
    const failPersistence = (failure: unknown) => {
        if (persistenceFailure) return;
        persistenceFailure = failure; cleanup++;
    };
    const raw = transcript();
    const observer = { ...raw.observer, [method]: () => { failPersistence(error); throw error; } };
    const f = fixture(observer);
    assert.doesNotThrow(() => {
        if (method === 'text') f.projection.text('message', 'm', 'lost', 'append');
        if (method === 'tool') f.projection.tool('t', { status: 'running' });
        f.projection.close(end); f.projection.close(end);
        f.projection.text('message', 'late', 'lost', 'replace');
    });
    assert.equal(persistenceFailure, error); assert.equal(cleanup, 1);
    assert.deepEqual(f.events, []); assert.deepEqual(f.notices, ['persistence']);
    assert.equal(f.projection.diagnostics().recordingFailed, true);
});

test('existing persistence failure guard prevents invoking the raw observer', () => {
    const raw = transcript(), f = fixture(raw.observer);
    f.projection.report('persistence');
    f.projection.text('message', 'm', 'ignored', 'append'); f.projection.tool('t', {}); f.projection.close(end);
    assert.deepEqual(raw.texts, []); assert.deepEqual(raw.tools, []); assert.deepEqual(raw.ends, []);
});

const assistant = (parent: string, id: string, content: object[]) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id, content } });
const tool = (id: string) => ({ type: 'tool_use', id, name: 'Agent', input: {} });
function childrenFixture(options: {
    transcript?: (owner: RuntimeEventContext) => RuntimeTranscriptObserver;
    resolveTranscriptParent?: (owner: RuntimeEventContext, nativeRef: string) => string | null;
} = {}) {
    const root = fixture(), parents = new Set<string>();
    const owner: ClaudeChildOwner = { context, projection: root.projection, record: root.record,
        isCurrent: () => true, isActive: () => true };
    const children = new ClaudeSdkChildren({ resolveParent: id => parents.has(id) ? owner : null, ...options });
    return { root, parents, children };
}

test('Code child and nested child link outside preview capacity using captured ancestor context', () => {
    const observers: Array<{ owner: RuntimeEventContext; raw: ReturnType<typeof transcript> }> = [];
    const lookups: Array<[RuntimeEventContext, string]> = [];
    const h = childrenFixture({ transcript(owner) {
        const raw = transcript(); observers.push({ owner, raw }); return raw.observer;
    }, resolveTranscriptParent(owner, ref) {
        lookups.push([owner, ref]);
        if (ref === 'claude:tool:parent' && !owner.parentItemId) return 'code-parent';
        if (ref === 'claude:tool:nested' && owner.parentItemId === 'code-parent') return 'code-nested';
        return null;
    } });
    for (let i = 0; i < 160; i++) h.root.projection.tool(`filler-${i}`, { status: 'done' });
    h.parents.add('parent'); h.root.projection.tool('claude:tool:parent', { name: 'Agent' });
    assert.equal(h.root.projection.itemId('tool', 'claude:tool:parent'), null);
    h.children.accept(assistant('parent', 'child', [tool('nested'), { type: 'text', text: 'child'.repeat(1000) }]));
    h.children.accept(assistant('nested', 'grandchild', [{ type: 'text', text: 'grandchild'.repeat(400) }]));
    assert.equal(observers.length, 2);
    assert.equal(observers[0]?.owner.parentItemId, 'code-parent');
    assert.equal(observers[1]?.owner.parentItemId, 'code-nested');
    assert.ok(lookups.some(([owner, ref]) => owner.parentItemId === 'code-parent' && ref === 'claude:tool:nested'));
    assert.equal(observers[0]?.raw.texts.at(-1)?.[2], 'child'.repeat(1000));
    assert.equal(observers[1]?.raw.texts.at(-1)?.[2], 'grandchild'.repeat(400));
    assert.ok(observers.every(item => Object.isFrozen(item.owner) && item.owner.turnId === 'turn'));
    h.children.stopOwner(context); h.children.stopOwner(context);
    assert.deepEqual(observers.map(item => item.raw.ends), [
        [{ kind: 'turn-end', status: 'stopped', finalText: null }],
        [{ kind: 'turn-end', status: 'stopped', finalText: null }],
    ]);
});

test('missing Code parent remains buffered even when preview parent exists, then flushes once', () => {
    let parent: string | null = null, creations = 0;
    const raw = transcript();
    const h = childrenFixture({ transcript: () => { creations++; return raw.observer; }, resolveTranscriptParent: () => parent });
    h.parents.add('parent'); h.root.projection.tool('claude:tool:parent', {});
    h.children.accept(assistant('parent', 'child', [{ type: 'text', text: 'buffered content' }]));
    h.children.reconcile(); assert.equal(creations, 0);
    parent = 'code-committed-parent'; h.children.reconcile(); h.children.reconcile();
    assert.equal(creations, 1); assert.equal(raw.texts.length, 1); assert.equal(raw.texts[0]?.[2], 'buffered content');
    assert.equal(h.root.events.at(-1)?.parentItemId, 'code-committed-parent');
});

test('default children preserve preview prefixes and cannot link to item 161', () => {
    const h = childrenFixture(); h.parents.add('parent'); h.root.projection.tool('claude:tool:parent', {});
    h.children.accept(assistant('parent', 'child', [tool('nested')]));
    h.children.accept(assistant('nested', 'grandchild', [{ type: 'text', text: 'nested text' }]));
    const grandchild = h.root.events.at(-1); assert.ok(grandchild?.kind === 'message');
    assert.equal(grandchild.itemId, 'claude-child-2-item-1'); assert.equal(grandchild.parentItemId, 'claude-child-1-item-1');
    const capped = childrenFixture();
    for (let i = 0; i < 160; i++) capped.root.projection.tool(`filler-${i}`, { status: 'done' });
    capped.parents.add('parent'); capped.root.projection.tool('claude:tool:parent', {});
    capped.children.accept(assistant('parent', 'child', [{ type: 'text', text: 'unlinked' }])); capped.children.reconcile();
    assert.equal(capped.root.events.length, 160);
});

test('child observer failure invokes the owner closure despite swallowed callbacks', () => {
    const error = new Error('child write failed'); let failure: unknown, cleanup = 0;
    const h = childrenFixture({ resolveTranscriptParent: () => 'code-parent', transcript: () => ({
        text() { if (!failure) { failure = error; cleanup++; } throw error; },
        tool() {}, close() {},
    }) });
    h.parents.add('parent');
    h.children.accept(assistant('parent', 'child', [{ type: 'text', text: 'not committed' }]));
    h.children.accept({ type: 'result', parent_tool_use_id: 'parent', subtype: 'success', is_error: false });
    assert.equal(failure, error); assert.equal(cleanup, 1);
    assert.deepEqual(h.root.events, []); assert.equal(h.root.projection.diagnostics().recordingFailed, true);
});

test('child task outside its own preview cap receives terminal patch and one transcript close', () => {
    const raw = transcript();
    const h = childrenFixture({ resolveTranscriptParent: () => 'code-parent', transcript: () => raw.observer });
    h.parents.add('parent');
    h.children.accept(assistant('parent', 'child', Array.from({ length: 160 }, (_, i) => tool(`child-${i}`))));
    h.children.accept({ type: 'system', subtype: 'task_started', task_id: 'overflow-task', tool_use_id: 'parent' });
    assert.ok(raw.tools.some(([ref, patch]) => ref === 'claude:task:overflow-task' && patch.status === 'running'));
    assert.equal(h.root.events.filter(event => event.kind === 'tool').length, 160);
    h.children.stopOwner(context); h.children.stopOwner(context);
    assert.ok(raw.tools.some(([ref, patch]) => ref === 'claude:task:overflow-task' && patch.status === 'stopped'));
    assert.deepEqual(raw.ends, [{ kind: 'turn-end', status: 'stopped', finalText: null }]);
});

async function claudeFixture(extra: Partial<ClaudeSessionOptions> = {}) {
    const output = createClaudeInput<SDKMessage>(512), r = recorder();
    let current = { ...context, isCurrent: () => true };
    let inputFailure: unknown;
    const session = await createClaudeSdkSession({
        prepared: { cwd: process.cwd(), binary: process.execPath, env: {}, model: 'default', systemPrompt: 'instructions', permissions: 'safe', fastMode: false },
        promptTimeoutMs: 1000, closeTimeoutMs: 100, record: r.record, registry: new RuntimeRequests(),
        getTurnContext: () => current,
        queryFactory: ({ prompt }) => {
            void (async () => { for await (const _message of prompt) { /* consume admitted input */ } })()
                .catch(error => { inputFailure = error; });
            return { ...output.stream, close: output.close };
        }, ...extra,
    });
    return { session, ...r, next: () => { current = { ...current, runId: 'run-2', turnId: 'turn-2' }; },
        // Wire fixtures intentionally omit unrelated SDK metadata; the native parser validates them.
        frame: (value: unknown) => { assert.equal(inputFailure, undefined); assert.equal(output.offer(value as SDKMessage), true); } };
}
const result = (text: string) => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'native' });

test('Claude session forwards captured factories to main and child projections across turns', async t => {
    const captured: Array<{ owner: RuntimeEventContext; raw: ReturnType<typeof transcript> }> = [];
    const f = await claudeFixture({ transcript(owner) {
        const raw = transcript(); captured.push({ owner, raw }); return raw.observer;
    }, resolveTranscriptParent: (_owner, ref) => ref === 'claude:tool:parent' ? 'code-parent' : null });
    t.after(() => f.session.close());
    const first = f.session.send({ text: 'one' }, () => {});
    f.next();
    f.frame({ type: 'assistant', message: { id: 'main', content: [tool('parent')] } });
    f.frame(assistant('parent', 'child', [{ type: 'text', text: 'child answer'.repeat(400) }]));
    f.frame(result('main answer'.repeat(400)));
    assert.equal((await first).status, 'done');
    assert.equal(captured[0]?.owner.turnId, 'turn'); assert.equal(captured[1]?.owner.turnId, 'turn');
    assert.equal(captured[1]?.owner.parentItemId, 'code-parent');
    assert.equal(captured[0]?.raw.texts.at(-1)?.[2], 'main answer'.repeat(400));
    assert.equal(captured[1]?.raw.texts.at(-1)?.[2], 'child answer'.repeat(400));
    const second = f.session.send({ text: 'two' }, () => {}); f.frame(result('second')); await second;
    assert.equal(captured[2]?.owner.turnId, 'turn-2');
});

test('Claude native success cannot clear an owner failure latched in finish', async t => {
    const error = new Error('finish write failed'); let failure: unknown, cleanup = 0;
    const f = await claudeFixture({ transcript: () => ({ text() {}, tool() {}, close() {
        if (!failure) { failure = error; cleanup++; } throw error;
    } }) });
    t.after(() => f.session.close());
    const send = f.session.send({ text: 'one' }, () => {}); f.frame(result('native success'));
    assert.equal((await send).status, 'done', 'native outcome is not the durable Code terminal authority');
    assert.equal(failure, error); assert.equal(cleanup, 1);
    assert.equal(f.events.some(event => event.kind === 'turn-end'), false);
});

test('ACP session forwards one immutable turn context and full normalized chunks through real protocol parsing', async t => {
    const child = Object.assign(new EventEmitter(), { pid: 65000, exitCode: null as number | null,
        signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable() });
    const raw = transcript(), r = recorder(), registry = new RuntimeRequests();
    const captured: RuntimeEventContext[] = [];
    const current = { ...context, isCurrent: () => true };
    const text = 'ACP content '.repeat(3000);
    const send = (frame: object) => child.stdout.write(JSON.stringify(frame) + '\n');
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
        const frame = JSON.parse(String(chunk)) as Record<string, unknown>;
        const reply = (value: object) => queueMicrotask(() => send({ jsonrpc: '2.0', id: frame['id'], result: value }));
        if (frame['method'] === 'initialize') reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
        else if (frame['method'] === 'session/new') reply({ sessionId: 'native' });
        else if (frame['method'] === 'session/prompt') {
            current.turnId = 'mutated';
            queueMicrotask(() => send({ jsonrpc: '2.0', method: 'session/update', params: {
                sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
            } }));
            reply({ stopReason: 'end_turn' });
        }
        callback();
    } });
    // In-memory protocol pipes exercise the real parser without creating a process.
    const protocol = new AcpSession(child as unknown as ChildProcessWithoutNullStreams, {
        permissions: 'auto', registry, promptTimeoutMs: 1000, ownedProcessOptions: { terminateTree: () => {
            queueMicrotask(() => { child.exitCode = 143; child.emit('exit', 143); child.emit('close', 143); });
        } },
    });
    t.after(() => protocol.close()); await protocol.start({ cwd: process.cwd() });
    const runtime = new AcpRuntimeSession(protocol, { provider: 'cursor', registry, record: r.record,
        getTurnContext: () => current, transcript: owner => { captured.push(owner); return raw.observer; },
        capabilities: { transport: 'native', steer: 'restart', resume: true, tools: true, toolOutput: true,
            approvals: true, questions: false, images: false, subagents: false },
    });
    assert.equal((await runtime.send({ text: 'prompt' }, () => {})).finalText, text);
    assert.equal(captured.length, 1); assert.equal(captured[0]?.turnId, 'turn'); assert.ok(Object.isFrozen(captured[0]));
    assert.deepEqual(raw.texts, [['message', 'message-1', text, 'append', 'unknown'], ['message', 'message-1', text, 'replace', 'final']]);
    assert.deepEqual(raw.ends, [{ kind: 'turn-end', status: 'done', finalText: text }]);
    assert.ok(r.events.every(event => event.kind !== 'message' || event.text.length <= 3000));
});

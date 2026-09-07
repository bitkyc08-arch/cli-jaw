import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { CodeTurnNormalizer, CODE_ITEM_MAX_CHARS } from '../../src/code-mode/normalize.ts';
import type { CodeTurnNormalizerOptions } from '../../src/code-mode/normalize.ts';
import type { CodeTurnContext } from '../../src/code-mode/provider.ts';
import type { CodeItem } from '../../src/code-mode/wire.ts';
import type { RuntimeEventContext } from '../../src/agent/runtime/events.ts';
import type { RuntimeEnd, RuntimeToolPatch } from '../../src/agent/runtime/projection.ts';
import type { RuntimeEventBody, RuntimeTurnOutcome } from '../../src/shared/runtime-contract.ts';
import { parseRuntimeEvent } from '../../src/shared/runtime-event-parse.ts';

let journalWrites = 0, publications = 0;
mock.module('../../src/trace/activity-journal.js', { namedExports: {
    appendActivityBody: () => { journalWrites++; throw new Error('unexpected Jaw journal'); },
    markActivityFailure: () => { journalWrites++; },
} });
mock.module('../../src/core/event-bus.js', { namedExports: { publish: () => { publications++; } } });
const { RuntimeProjection } = await import('../../src/agent/runtime/projection.ts');
test.after(() => { assert.equal(journalWrites, 0); assert.equal(publications, 0); });

const done: RuntimeTurnOutcome = { status: 'done', finalText: null, partialText: '' };
const end: RuntimeEnd = { kind: 'turn-end', status: 'done', finalText: null };
const approval: Extract<RuntimeEventBody, { kind: 'request' }> = {
    kind: 'request', requestId: 'permission-1', requestType: 'approval', view: {
        title: 'Read README', fields: [{ id: 'decision', label: 'Permission', multiSelect: false, allowFreeform: false,
            options: [{ id: 'opaque-allow', label: 'Allow once' }, { id: 'opaque-deny', label: 'Deny' }] }],
    },
};
function fixture(options: Partial<CodeTurnNormalizerOptions> = {}) {
    let current = true, time = 10;
    const context: CodeTurnContext = { runId: 'run', sessionId: 'session', turnId: 'turn', scope: 'code:session',
        audience: 'internal', epoch: 7, isCurrent: () => current };
    const writes: CodeItem[] = [], items = new Map<string, CodeItem>(), failures: unknown[] = [];
    const normalizer = new CodeTurnNormalizer({ context, now: () => ++time,
        commitItem: item => { writes.push(structuredClone(item)); items.set(item.itemId, structuredClone(item)); },
        failPersistence: error => { failures.push(error); }, ...options });
    const observer = normalizer.observer(context);
    const rows = (kind?: CodeItem['kind']) => [...items.values()].filter(item => !kind || item.kind === kind);
    return { context, normalizer, observer, writes, items, failures, rows, stale: () => { current = false; } };
}

test('raw observer retains >3000 per field, >160 items and >24000 total through the real preview projection', () => {
    const f = fixture();
    const projection = new RuntimeProjection(f.context, (owner, body) => f.normalizer.record(owner, body), () => {}, f.observer);
    const values = Array.from({ length: 180 }, (_, i) => `${i}:` + 'readable text '.repeat(320));
    for (const [i, value] of values.entries()) projection.text('message', `native-${i}`, value, 'replace', 'commentary');
    projection.tool('beyond-preview', { name: 'Read', input: 'input '.repeat(700), output: 'output '.repeat(700), status: 'done' });
    projection.close(end);
    f.normalizer.finish({ ...done, finalText: values.join('') });
    assert.deepEqual(f.rows('assistant_message').map(item => item.text), values);
    assert.ok(values.every(value => value.length > 3000));
    assert.ok(values.join('').length > 24000);
    assert.equal(f.rows('tool_call')[0]?.tool?.output, 'output '.repeat(700));
    assert.ok(f.normalizer.resolveParent(f.context, 'beyond-preview') === null, 'finished turns reject lookups');
    assert.ok(projection.diagnostics().items <= 160);
    assert.ok(projection.diagnostics().previewChars <= 24000);
    assert.equal(f.rows('notice').length, 0);
    assert.deepEqual(f.failures, []);
});

test('append/replace, empty answers, first appearance order and real phases survive item updates', () => {
    const f = fixture();
    f.observer.text('message', 'a', 'first', 'append', 'commentary');
    f.observer.tool('b', { name: 'Read' }, {});
    const original = f.rows()[0]!;
    f.observer.text('message', 'a', ' second', 'append', 'unknown');
    assert.equal(f.rows()[0]?.text, 'first second');
    assert.equal(f.rows()[0]?.phase, 'commentary');
    f.observer.text('message', 'a', '', 'replace', 'final');
    f.normalizer.finish({ ...done, finalText: 'must not replace authoritative empty' });
    const after = f.rows()[0]!;
    assert.equal(after.itemId, original.itemId);
    assert.equal(after.createdAt, original.createdAt);
    assert.ok(after.updatedAt > original.updatedAt);
    assert.equal(after.text, ''); assert.equal(after.phase, 'final');
    assert.deepEqual(f.rows().map(item => item.kind), ['assistant_message', 'tool_call']);
    assert.equal(after.firstSequence, undefined, 'store alone owns firstSequence');
});

test('split structured JSON secrets remain withheld on every intermediate commit', () => {
    const f = fixture();
    f.observer.tool('json', { delta: '{"password":"first-', outputStructured: true }, {});
    const first = f.rows('tool_call')[0]!;
    assert.equal(first.tool?.output, '[structured content withheld]');
    assert.match(first.truncation!.reason, /structured_incomplete/);
    f.observer.tool('json', { delta: 'second","ok":true}', outputStructured: true, status: 'done' }, {});
    assert.deepEqual(JSON.parse(f.rows('tool_call')[0]!.tool!.output!), { password: '[REDACTED]', ok: true });
    assert.equal(f.rows('tool_call')[0]?.truncation, undefined);
    assert.ok(!JSON.stringify(f.writes).includes('first-'));
    assert.ok(!JSON.stringify(f.writes).includes('second'));
});

test('JSON-shaped message chunks are withheld even without a structured tool hint', () => {
    const f = fixture();
    f.observer.text('message', 'json', '{"token":"private-', 'append', 'unknown');
    f.observer.text('message', 'json', 'value","message":"ok"}', 'append', 'final');
    assert.equal(f.writes[0]?.text, '[structured content withheld]');
    assert.deepEqual(JSON.parse(f.rows('assistant_message')[0]!.text!), { token: '[REDACTED]', message: 'ok' });
    assert.ok(!JSON.stringify(f.writes).includes('private-'));
});

test('a split JSON fence is reconstructed before secret redaction while Markdown links remain prose', () => {
    const f = fixture();
    f.observer.text('message', 'fence', '`', 'append', 'unknown');
    f.observer.text('message', 'fence', '``json\n{"password":"hidden', 'append', 'unknown');
    assert.equal(f.rows('assistant_message')[0]?.text, '[structured content withheld]');
    f.observer.text('message', 'fence', '"}\n```', 'append', 'final');
    assert.ok(!JSON.stringify(f.writes).includes('hidden'));
    f.observer.text('message', 'link', '[', 'append', 'commentary');
    f.observer.text('message', 'link', 'docs](https://example.test) are useful', 'append', 'commentary');
    assert.equal(f.rows('assistant_message')[1]?.text, '[docs](https://example.test) are useful');
});

test('full source redaction precedes clipping and partial plaintext credentials never leak', () => {
    const f = fixture({ maxFieldChars: 64 });
    f.observer.text('message', 'prose', 'prefix TOKEN=' + 'canary'.repeat(40), 'replace', 'final');
    assert.equal(f.rows('assistant_message')[0]?.text, 'prefix TOKEN=[REDACTED]');
    f.observer.text('message', 'chunks', 'key sk-partial', 'append', 'unknown');
    f.observer.text('message', 'chunks', 'credentialmaterial0123456789', 'append', 'final');
    assert.ok(!JSON.stringify(f.writes).includes('canary'));
    assert.ok(!JSON.stringify(f.writes).includes('sk-partial'));
});

test('1Mi field cap retains plaintext and exposes accurate source/stored counts with one capacity notice', () => {
    const f = fixture();
    f.observer.text('message', 'large', 'x'.repeat(CODE_ITEM_MAX_CHARS + 100), 'replace', 'final');
    let row = f.rows('assistant_message')[0]!;
    assert.equal(row.text?.length, 1_048_576);
    assert.equal(row.truncation?.storedChars, 1_048_576);
    assert.equal(row.truncation?.sourceChars, 1_048_676);
    assert.match(row.truncation!.reason, /field_limit/);
    f.observer.text('message', 'large', 'tail', 'append', 'unknown');
    row = f.rows('assistant_message')[0]!;
    assert.equal(row.text?.length, 1_048_576);
    assert.equal(row.truncation?.sourceChars, 1_048_680);
    assert.equal(f.rows('notice').length, 1);
});

test('raw cap retirement preserves old text and a fresh replacement can recover', () => {
    const f = fixture({ maxFieldChars: 32 });
    f.observer.text('message', 'm', 'retained', 'append', 'unknown');
    f.observer.text('message', 'm', 'x'.repeat(33), 'append', 'unknown');
    f.observer.text('message', 'm', 'later', 'append', 'unknown');
    assert.equal(f.rows('assistant_message')[0]?.text, 'retained');
    assert.equal(f.rows('assistant_message')[0]?.truncation?.sourceChars, 46);
    f.observer.text('message', 'm', 'recovered', 'replace', 'final');
    assert.equal(f.rows('assistant_message')[0]?.text, 'recovered');
    assert.equal(f.rows('assistant_message')[0]?.truncation, undefined);
});

test('structured cap retirement never joins a clipped JSON prefix to a later suffix', () => {
    const f = fixture({ maxFieldChars: 48 });
    f.observer.tool('m', { delta: '{"password":"', outputStructured: true }, {});
    f.observer.tool('m', { delta: 'private'.repeat(20), outputStructured: true }, {});
    f.observer.tool('m', { delta: '"}', status: 'done' }, {});
    assert.equal(f.rows('tool_call')[0]?.tool?.output, '[structured content withheld]');
    assert.ok(!JSON.stringify(f.writes).includes('private'));
    assert.match(f.rows('tool_call')[0]!.truncation!.reason, /field_limit/);
    assert.equal(f.rows('notice').length, 1);
});

test('total cap includes raw and sanitized accumulation without evicting existing item text', () => {
    const f = fixture({ maxTotalChars: 100, maxFieldChars: 100 });
    f.observer.text('message', 'a', 'a'.repeat(40), 'replace', 'unknown');
    f.observer.text('message', 'b', 'b'.repeat(40), 'replace', 'unknown');
    f.observer.text('message', 'c', 'c'.repeat(40), 'replace', 'unknown');
    assert.equal(f.rows('assistant_message')[0]?.text, 'a'.repeat(40));
    assert.equal(f.rows('assistant_message')[1]?.text, 'b'.repeat(20));
    assert.match(f.rows('assistant_message')[1]!.truncation!.reason, /total_limit/);
    assert.equal(f.rows('assistant_message').length, 2);
    assert.equal(f.rows('notice').length, 1);
});

test('item cap allocates one reserved capacity notice and existing tools can still settle', () => {
    const f = fixture({ maxItems: 2 });
    f.observer.tool('first', {}, {}); f.observer.tool('second', {}, {});
    for (let i = 0; i < 100; i++) f.observer.tool(`overflow-${i}`, {}, {});
    f.observer.tool('first', { status: 'done', output: 'finished' }, {});
    assert.equal(f.rows().length, 3);
    assert.equal(f.rows('notice').length, 1);
    assert.equal(f.rows('tool_call')[0]?.status, 'done');
    assert.equal(f.normalizer.resolveParent(f.context, 'overflow-0'), null);
});

test('clipping does not leave half of a surrogate pair', () => {
    const f = fixture({ maxFieldChars: 4 });
    f.observer.text('message', 'emoji', 'abc😀tail', 'replace', 'final');
    assert.equal(f.rows('assistant_message')[0]?.text, 'abc');
    assert.equal(f.rows('assistant_message')[0]?.truncation?.storedChars, 3);
});

test('stable namespaces distinguish kind, child, nested parent and turn without exposing native refs', () => {
    const f = fixture();
    f.observer.tool('native-secret-ref', { name: 'Agent' }, {});
    const parent = f.normalizer.resolveParent(f.context, 'native-secret-ref')!;
    assert.ok(parent);
    const child: RuntimeEventContext = { ...f.context, parentItemId: parent };
    const observer = f.normalizer.observer(child);
    observer.tool('native-secret-ref', { name: 'Agent' }, {});
    const nested = f.normalizer.resolveParent(child, 'native-secret-ref')!;
    f.normalizer.observer({ ...f.context, parentItemId: nested }).text('message', 'same', 'nested', 'replace', 'final');
    observer.text('message', 'same', 'child', 'replace', 'final');
    f.observer.text('message', 'same', 'root', 'replace', 'final');
    f.observer.text('reasoning', 'same', 'reasoning', 'replace', 'commentary');
    assert.equal(new Set(f.rows().map(item => item.itemId)).size, 6);
    assert.notEqual(parent, nested);
    assert.equal(f.rows('assistant_message')[0]?.parentItemId, nested);
    assert.equal(f.rows('assistant_message')[1]?.parentItemId, parent);
    assert.ok(!JSON.stringify(f.writes).includes('native-secret-ref'));
    const again = fixture(); again.observer.tool('native-secret-ref', { name: 'Agent' }, {});
    assert.equal(again.rows()[0]?.itemId, parent);
    const other = fixture({ context: { ...f.context, turnId: 'other' } });
    other.normalizer.observer({ ...f.context, turnId: 'other' }).tool('native-secret-ref', {}, {});
    assert.notEqual(other.rows()[0]?.itemId, parent);
});

test('a parent cannot be resolved reentrantly before its first commit returns', () => {
    let normalizer: CodeTurnNormalizer | undefined;
    const observations: Array<string | null> = [];
    const f = fixture({ commitItem() {
        observations.push(normalizer!.resolveParent(f.context, 'parent'));
    } });
    normalizer = f.normalizer;
    f.observer.tool('parent', { name: 'Agent' }, {});
    assert.deepEqual(observations, [null]);
    assert.ok(f.normalizer.resolveParent(f.context, 'parent'));
});

test('child close affects only its own unfinished rows and never commits a global turn terminal', () => {
    const f = fixture(); f.observer.tool('parent', { name: 'Agent' }, {});
    f.observer.tool('root-tool', {}, {});
    const parentItemId = f.normalizer.resolveParent(f.context, 'parent')!;
    const child = f.normalizer.observer({ ...f.context, parentItemId });
    child.tool('child-tool', {}, {}); child.text('message', 'child-message', 'child result', 'append', 'unknown');
    child.close(end); child.close(end);
    child.tool('late', { status: 'done' }, {});
    assert.deepEqual(f.rows('tool_call').map(item => item.status), ['running', 'running', 'cancelled']);
    assert.equal(f.rows('assistant_message')[0]?.status, 'done');
    f.observer.text('message', 'root', 'root alive', 'append', 'commentary');
    assert.equal(f.rows('assistant_message')[1]?.status, 'running');
    f.normalizer.finish({ ...done, status: 'error' });
    assert.deepEqual(f.rows('tool_call').map(item => item.status), ['error', 'error', 'cancelled']);
    assert.equal(f.rows('assistant_message')[1]?.status, 'error');
    assert.ok(f.rows().every(item => !item.kind.startsWith('turn_')));
});

test('root close leaves child content active until whole-turn finish', () => {
    const f = fixture(); f.observer.tool('parent', { name: 'Agent' }, {});
    const child = f.normalizer.observer({ ...f.context, parentItemId: f.normalizer.resolveParent(f.context, 'parent')! });
    child.text('message', 'child', 'first', 'append', 'unknown');
    f.observer.close(end);
    child.text('message', 'child', ' second', 'append', 'final');
    assert.equal(f.rows('assistant_message')[0]?.text, 'first second');
    assert.equal(f.rows('assistant_message')[0]?.status, 'running');
    f.normalizer.finish(done);
    assert.equal(f.rows('assistant_message')[0]?.status, 'done');
});

test('terminal tool result survives late start; only explicit terminal refresh replaces authority', () => {
    const f = fixture();
    f.observer.tool('tool', { status: 'error', output: 'original', detail: 'original detail' }, {});
    f.observer.tool('tool', { name: 'Read', input: '{"path":"file"}', status: 'running', output: 'late', detail: 'late' }, {});
    let row = f.rows('tool_call')[0]!;
    assert.equal(row.status, 'error');
    assert.deepEqual(row.tool, { name: 'Read', input: '{"path":"file"}', output: 'original', detail: 'original detail' });
    f.observer.tool('tool', { status: 'done', output: 'ignored' }, {});
    assert.equal(f.rows('tool_call')[0]?.tool?.output, 'original');
    f.observer.tool('tool', { status: 'done', output: 'refreshed' }, { allowTerminalUpdates: true });
    row = f.rows('tool_call')[0]!;
    assert.equal(row.status, 'done'); assert.equal(row.tool?.output, 'refreshed');
    f.observer.close(end); f.observer.tool('tool', { status: 'error' }, { allowTerminalUpdates: true });
    assert.equal(f.rows('tool_call')[0]?.status, 'done');
});

test('aggregate final text never duplicates several observed native assistant items', () => {
    const f = fixture();
    f.observer.text('message', 'one', 'one', 'replace', 'commentary');
    f.observer.text('message', 'two', 'two', 'replace', 'final');
    f.observer.close({ ...end, finalText: 'onetwo' });
    f.normalizer.finish({ ...done, finalText: 'onetwo' });
    assert.deepEqual(f.rows('assistant_message').map(item => [item.text, item.phase]), [['one', 'commentary'], ['two', 'final']]);
});

for (const [finalText, partialText, expected, phase] of [
    ['fallback', '', 'fallback', 'final'], ['', 'partial', '', 'final'],
    [null, 'partial', 'partial', 'unknown'], [null, '', null, null],
] as const) test(`unobserved final fallback preserves null/empty/partial distinction: ${JSON.stringify(finalText)}, ${partialText}`, () => {
    const f = fixture();
    f.normalizer.finish({ status: 'stopped', finalText, partialText });
    const rows = f.rows('assistant_message');
    if (expected === null) assert.equal(rows.length, 0);
    else { assert.equal(rows[0]?.text, expected); assert.equal(rows[0]?.phase, phase); assert.equal(rows[0]?.status, 'cancelled'); }
});

test('child assistant output does not suppress an unobserved root fallback', () => {
    const f = fixture(); f.observer.tool('parent', {}, {});
    f.normalizer.observer({ ...f.context, parentItemId: f.normalizer.resolveParent(f.context, 'parent')! })
        .text('message', 'child', 'child', 'replace', 'final');
    f.normalizer.finish({ ...done, finalText: 'root fallback' });
    assert.deepEqual(f.rows('assistant_message').map(item => item.text), ['child', 'root fallback']);
});

test('preview recording provides monotonic validated internal identities without canonical duplicate writes', () => {
    const f = fixture();
    const bodies: RuntimeEventBody[] = [{ kind: 'turn-start', provider: 'claude' },
        { kind: 'message', itemId: 'preview', text: 'preview only', operation: 'replace', phase: 'final' },
        { kind: 'reasoning', itemId: 'preview', text: 'preview only', operation: 'replace' },
        { kind: 'tool', itemId: 'preview', status: 'done', name: 'Read', output: 'preview only' },
        { kind: 'usage', inputTokens: 7 }, { ...end, finalText: 'x'.repeat(300_000) }];
    const events = bodies.map(body => f.normalizer.record(f.context, body));
    assert.deepEqual(events.map(event => event?.seq), [1, 2, 3, 4, 5, 6]);
    for (const event of events) assert.deepEqual(parseRuntimeEvent(event), event);
    assert.equal(f.writes.length, 0);
    f.observer.text('message', 'native', 'still running', 'replace', 'commentary');
    assert.equal(f.rows()[0]?.status, 'running');
});

test('permission projection uses immutable root epoch even when helper context omits private fields', () => {
    const f = fixture();
    const helper: RuntimeEventContext = { runId: 'run', sessionId: 'session', scope: 'code:session', turnId: 'turn', audience: 'internal' };
    f.context.epoch = 99;
    f.normalizer.record(helper, approval);
    const row = f.rows('permission_request')[0]!;
    assert.equal(row.status, 'pending'); assert.equal(row.permission?.epoch, 7);
    assert.deepEqual(row.permission?.options, [{ optionId: 'opaque-allow', label: 'Allow once', kind: 'approval' },
        { optionId: 'opaque-deny', label: 'Deny', kind: 'approval' }]);
    f.normalizer.record(helper, { kind: 'request-settled', requestId: approval.requestId });
    f.normalizer.record(helper, approval);
    assert.equal(f.rows('permission_request')[0]?.status, 'done');
    assert.equal(f.rows('permission_request').length, 1);
});

test('permission settlement before request metadata cannot reopen a pending approval', () => {
    const f = fixture();
    f.normalizer.record(f.context, { kind: 'request-settled', requestId: approval.requestId });
    f.normalizer.record(f.context, approval);
    assert.equal(f.rows('permission_request').length, 1);
    assert.equal(f.rows('permission_request')[0]?.status, 'done');
    assert.equal(f.rows('permission_request')[0]?.permission, undefined);
});

test('duplicate requests do not spend capacity again and control notices cannot collide with native IDs', () => {
    const f = fixture({ maxTotalChars: 600 });
    f.normalizer.record(f.context, approval);
    f.normalizer.record(f.context, approval);
    assert.equal(f.rows('permission_request').length, 1);
    assert.equal(f.rows('notice').length, 0);
    const capped = fixture({ maxItems: 1 });
    capped.normalizer.record(capped.context, { ...approval, requestType: 'question', requestId: 'capacity' });
    capped.observer.tool('over-capacity', {}, {});
    assert.equal(capped.rows('notice').length, 2);
});

test('recorder allocates distinct sequences even when persistence reenters recording', () => {
    let nestedSequence: number | undefined;
    const f = fixture({ commitItem() {
        nestedSequence = f.normalizer.record(f.context, { kind: 'usage' })?.seq;
    } });
    const outer = f.normalizer.record(f.context, approval);
    assert.equal(outer?.seq, 1); assert.equal(nestedSequence, 2);
    assert.equal(f.normalizer.record(f.context, { kind: 'usage' })?.seq, 3);
});

test('request labels are sanitized before persistence; unsupported questions are visible without invented answers', () => {
    const f = fixture();
    f.normalizer.record(f.context, { ...approval, view: { ...approval.view, title: 'TOKEN=canary' } });
    f.normalizer.record(f.context, { ...approval, requestId: 'question', requestType: 'question' });
    assert.equal(f.rows('permission_request')[0]?.permission?.title, 'TOKEN=[REDACTED]');
    assert.equal(f.rows('notice').length, 1);
    assert.match(f.rows('notice')[0]!.text!, /Unsupported native question/);
    assert.equal(f.rows('notice')[0]?.permission, undefined);
    assert.ok(!JSON.stringify(f.writes).includes('canary'));
});

test('multi-field/freeform approval cannot be silently flattened', () => {
    const f = fixture();
    for (const [index, fields] of [
        [{ ...approval.view.fields[0]!, allowFreeform: true }],
        [{ ...approval.view.fields[0]!, multiSelect: true }],
        [approval.view.fields[0]!, { ...approval.view.fields[0]!, id: 'second' }],
    ].entries()) f.normalizer.record(f.context, { ...approval, requestId: `unsupported-${index}`, view: { ...approval.view, fields } });
    assert.equal(f.rows('permission_request').length, 0); assert.equal(f.rows('notice').length, 3);
});

test('permission payload capacity is counted and pending permission is cancelled on finish', () => {
    const small = fixture({ maxTotalChars: 64 });
    small.normalizer.record(small.context, approval);
    assert.equal(small.rows('permission_request').length, 0); assert.equal(small.rows('notice').length, 1);
    const f = fixture(); f.normalizer.record(f.context, approval); f.normalizer.finish(done);
    assert.equal(f.rows('permission_request')[0]?.status, 'cancelled');
});

test('wrong session/run/turn/scope/audience/unlinked parent are rejected before writes or sequence allocation', () => {
    const f = fixture();
    for (const patch of [{ sessionId: 'foreign' }, { runId: 'foreign' }, { turnId: 'foreign' },
        { scope: 'foreign' }, { audience: 'public' as const }, { parentItemId: 'missing' }]) {
        const context = { ...f.context, ...patch };
        const observer = f.normalizer.observer(context);
        observer.text('message', 'bad', 'bad', 'replace', 'final'); observer.close(end);
        assert.equal(f.normalizer.record(context, approval), null);
        assert.equal(f.normalizer.resolveParent(context, 'anything'), null);
    }
    assert.equal(f.writes.length, 0);
    assert.equal(f.normalizer.record(f.context, { kind: 'usage' })?.seq, 1);
});

test('captured observer identity survives external mutation, then current predicate fences all late work', () => {
    const f = fixture();
    const mutable = { ...f.context }, observer = f.normalizer.observer(mutable);
    mutable.turnId = 'other'; f.context.turnId = 'also-other';
    observer.text('message', 'm', 'captured', 'replace', 'final');
    assert.equal(f.rows()[0]?.turnId, 'turn');
    f.stale(); observer.text('message', 'm', 'late', 'replace', 'final'); observer.close(end);
    f.normalizer.finish({ ...done, finalText: 'late' });
    assert.equal(f.rows()[0]?.text, 'captured'); assert.equal(f.rows()[0]?.status, 'running');
});

for (const stage of ['text', 'tool', 'close', 'record', 'finish', 'child'] as const) test(`persistence failure at ${stage} latches before throw and blocks all later writes`, () => {
    const error = new Error('injected persistence failure');
    let armed = false, writes = 0;
    const failures: unknown[] = [];
    const f = fixture({ commitItem() { writes++; if (armed) throw error; }, failPersistence: error => { failures.push(error); } });
    let observer = f.observer;
    if (stage === 'child') {
        observer.tool('parent', {}, {});
        observer = f.normalizer.observer({ ...f.context, parentItemId: f.normalizer.resolveParent(f.context, 'parent')! });
    }
    if (stage === 'close' || stage === 'finish') observer.tool('unfinished', {}, {});
    armed = true;
    assert.throws(() => {
        if (stage === 'text' || stage === 'child') observer.text('message', 'm', 'text', 'append', 'unknown');
        if (stage === 'tool') observer.tool('tool', {}, {});
        if (stage === 'close') observer.close(end);
        if (stage === 'record') f.normalizer.record(f.context, approval);
        if (stage === 'finish') f.normalizer.finish(done);
    }, error);
    assert.deepEqual(failures, [error]);
    const count = writes;
    observer.text('message', 'late', 'late', 'replace', 'final'); observer.close(end);
    f.normalizer.finish({ ...done, finalText: 'native success' });
    assert.equal(f.normalizer.record(f.context, approval), null);
    assert.equal(writes, count);
});

test('projection-swallowed observer failure still reaches the owning persistence latch', () => {
    const error = new Error('write failed'), failures: unknown[] = [];
    const f = fixture({ commitItem: () => { throw error; }, failPersistence: error => { failures.push(error); } });
    const projection = new RuntimeProjection(f.context, (owner, body) => f.normalizer.record(owner, body), () => {}, f.observer);
    assert.doesNotThrow(() => projection.text('message', 'm', 'lost', 'replace', 'final'));
    projection.close(end); f.normalizer.finish({ ...done, finalText: 'native success' });
    assert.deepEqual(failures, [error]); assert.equal(projection.diagnostics().recordingFailed, true);
});

test('failure latch precedes reentrant cleanup and preserves the original write error', () => {
    const original = new Error('original write failure'), nested = new Error('cleanup failed');
    let writes = 0, callbacks = 0;
    const f = fixture({ commitItem() { writes++; throw original; }, failPersistence() {
        callbacks++;
        f.normalizer.finish({ ...done, finalText: 'reentrant success' });
        f.observer.tool('late', {}, {});
        throw nested;
    } });
    assert.throws(() => f.observer.text('message', 'm', 'lost', 'replace', 'final'), original);
    assert.equal(writes, 1); assert.equal(callbacks, 1);
});

test('malformed raw patch and invalid recorded event latch normalization failure without leaking content', () => {
    const raw = fixture();
    assert.throws(() => raw.observer.tool('tool', { output: 42 } as unknown as RuntimeToolPatch, {}), /invalid_code_native_text/);
    assert.equal(raw.failures.length, 1); assert.equal(raw.writes.length, 0);
    const record = fixture();
    assert.throws(() => record.normalizer.record(record.context, { kind: 'usage', inputTokens: -1 }), /invalid_runtime_event/);
    assert.equal(record.failures.length, 1); assert.equal(record.writes.length, 0);
    const closed = fixture();
    assert.throws(() => closed.observer.close({ ...end, status: 'running' } as unknown as RuntimeEnd), /invalid_code_native_end/);
    assert.equal(closed.failures.length, 1); assert.equal(closed.writes.length, 0);
});

test('malformed structured text remains explicit withholding, not an invented successful JSON value', () => {
    const f = fixture();
    f.observer.tool('malformed', { output: '{broken password', outputStructured: true, status: 'error' }, {});
    f.normalizer.finish({ ...done, status: 'error' });
    assert.equal(f.rows('tool_call')[0]?.tool?.output, '[structured content withheld]');
    assert.match(f.rows('tool_call')[0]!.truncation!.reason, /structured_incomplete/);
    assert.equal(f.rows('tool_call')[0]?.status, 'error');
});

test('finish is idempotent, ignores later native terminals and never overwrites established tool status', () => {
    const f = fixture(); f.observer.tool('done', { status: 'done', output: 'actual' }, {});
    f.observer.tool('open', {}, {}); f.normalizer.finish({ ...done, status: 'stopped' });
    const before = structuredClone(f.rows());
    f.normalizer.finish({ ...done, finalText: 'late' }); f.observer.close(end);
    f.observer.tool('open', { status: 'done' }, { allowTerminalUpdates: true });
    assert.equal(f.normalizer.record(f.context, { ...end, finalText: 'late' }), null);
    assert.deepEqual(f.rows(), before);
    assert.deepEqual(f.rows('tool_call').map(item => item.status), ['done', 'cancelled']);
});

test('invalid budgets reject construction rather than disabling bounded accumulation', () => {
    for (const value of [0, -1, NaN, Infinity, 1.5]) {
        assert.throws(() => fixture({ maxFieldChars: value }), /invalid_code_normalizer_limit/);
        assert.throws(() => fixture({ maxTotalChars: value }), /invalid_code_normalizer_limit/);
        assert.throws(() => fixture({ maxItems: value }), /invalid_code_normalizer_limit/);
    }
});

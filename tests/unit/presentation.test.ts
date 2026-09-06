import test from 'node:test';
import assert from 'node:assert/strict';
import { isPresentationMode, presentationMode, parseActivityIdentity } from '../../src/shared/presentation.js';
import { parseRuntimeEvent, parseRuntimeRequestView } from '../../src/shared/runtime-event-parse.js';

test('display defaults are independent of provider transport and preserve explicit legacy', () => {
    for (const input of [undefined, null, [], 42, {}, { presentation: null }, { presentation: [] },
        { presentation: { mode: 'native' } }, { perCli: { claude: { transport: 'native' } } }]) {
        assert.equal(presentationMode(input), 'activity');
    }
    assert.equal(presentationMode({ presentation: { mode: 'legacy' } }), 'legacy');
    for (const mode of ['activity', 'legacy']) assert.equal(isPresentationMode(mode), true);
    for (const mode of ['', 'native', 'print', null, true]) assert.equal(isPresentationMode(mode), false);
});

test('server identity is bounded, detached and contains only the public pair', () => {
    const input = { sessionId: 'jaw-chat', scope: 'mention-watch:separate', providerSession: 'private' };
    const parsed = parseActivityIdentity(input);
    assert.deepEqual(parsed, { sessionId: 'jaw-chat', scope: 'mention-watch:separate' });
    input.scope = 'changed';
    assert.equal(parsed?.scope, 'mention-watch:separate');
    for (const invalid of [null, [], {}, { sessionId: '', scope: 'a' }, { sessionId: 'a', scope: 1 },
        { sessionId: 'a'.repeat(241), scope: 'b' }, { sessionId: 'a', scope: 'b'.repeat(241) }]) {
        assert.equal(parseActivityIdentity(invalid), null);
    }
    assert.ok(parseActivityIdentity({ sessionId: 'a'.repeat(240), scope: 'b'.repeat(240) }));
});

test('public request view export uses the existing event parser policy', () => {
    const field = { id: 'decision', label: 'Permission', options: [{ id: 'allow', label: 'Allow' }],
        multiSelect: false, allowFreeform: false };
    const view = { title: 'Continue?', fields: [field], callback: 'private' };
    const safe = parseRuntimeRequestView(view);
    assert.deepEqual(safe, { title: 'Continue?', fields: [field] });
    assert.notEqual(safe?.fields[0], field);
    const event = parseRuntimeEvent({ version: 1, runId: 'run', sessionId: 'chat', scope: 'scope',
        turnId: 'turn', seq: 1, kind: 'request', requestType: 'approval', requestId: 'request', view });
    assert.ok(event?.kind === 'request');
    assert.deepEqual(event.view, safe);
    assert.equal(parseRuntimeRequestView({ ...view, fields: [field, field] }), null);
    assert.equal(parseRuntimeRequestView({ ...view, fields: [{ ...field, options: [field.options[0], field.options[0]] }] }), null);
    assert.equal(parseRuntimeRequestView({ ...view, title: 'x'.repeat(501) }), null);
});

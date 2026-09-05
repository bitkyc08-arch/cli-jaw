import test from 'node:test';
import assert from 'node:assert/strict';
import {
    automaticPermission, normalizeNativePermissions, permissionOptions, permissionResponse,
    preparePermissionRequest, validatedPermissionParams,
    type AcpPermissionOption, type AcpPermissionResponse,
} from '../../src/agent/runtime/acp/permissions.ts';

function option(overrides: Partial<AcpPermissionOption> = {}): AcpPermissionOption {
    return { optionId: 'native-once-private', name: 'Allow once', kind: 'allow_once', ...overrides };
}
function params(overrides: Record<string, unknown> = {}) {
    return { sessionId: 'native-session', toolCall: { toolCallId: 'native-tool' }, options: [option()], ...overrides };
}
const cancelled: AcpPermissionResponse = { outcome: { outcome: 'cancelled' } };

test('options reject malformed collections, duplicates, sparse items and over-limit cardinality', () => {
    for (const value of [undefined, null, {}, 'allow', [], Array.from({ length: 21 }, (_, i) => option({ optionId: String(i) }))]) {
        assert.throws(() => permissionOptions(value), { message: 'acp_invalid_options' });
    }
    for (const value of [[option(), option()], new Array(1), [null], [[]], [new Date()], [true], [{}]]) {
        assert.throws(() => permissionOptions(value), { message: 'acp_invalid_option' });
    }
});

test('option fields reject invalid types, unknown kinds and over-limit strings', () => {
    const invalid = [
        { optionId: '' }, { optionId: null }, { optionId: 1 }, { optionId: 'x'.repeat(241) },
        { name: null }, { name: 1 }, { name: 'x'.repeat(1001) },
        { kind: 'allow' }, { kind: 'ALLOW_ONCE' }, { kind: null },
    ];
    for (const fields of invalid) {
        assert.throws(() => permissionOptions([{ ...option(), ...fields }]), { message: 'acp_invalid_option' });
    }
});

test('options accept exact bounds and all protocol kinds, copying only validated fields', () => {
    const kinds = ['reject_once', 'reject_always', 'allow_always', 'allow_once'] as const;
    const raw = Array.from({ length: 20 }, (_, i) => ({
        optionId: String(i).padEnd(240, 'x'), name: 'x'.repeat(1000), kind: kinds[i % 4]!, extra: 'private-extra',
    }));
    const result = permissionOptions(raw);
    assert.equal(result.length, 20);
    assert.deepEqual(result[0], { optionId: '0'.padEnd(240, 'x'), name: 'x'.repeat(1000), kind: 'reject_once' });
    assert.notEqual(result[0], raw[0]);
    raw[0]!.optionId = 'mutated';
    assert.equal(result[0]!.optionId, '0'.padEnd(240, 'x'));
    assert.equal(permissionOptions([option({ name: '' })])[0]!.name, '');
});

test('params reject malformed records and a missing, malformed or foreign native session', () => {
    for (const value of [null, undefined, [], new Date(), 'params']) {
        assert.throws(() => validatedPermissionParams(value, 'native-session'), { message: 'acp_invalid_permission' });
    }
    for (const sessionId of [undefined, null, 1, '', 'foreign-session']) {
        assert.throws(() => validatedPermissionParams(params({ sessionId }), 'native-session'), { message: 'acp_wrong_session' });
    }
    assert.throws(() => validatedPermissionParams(params({ sessionId: '' }), ''), { message: 'acp_wrong_session' });
});

test('params validate tool identity, nullable title types and options at the actual boundary', () => {
    for (const toolCall of [null, [], new Date(), {}, { toolCallId: '' }, { toolCallId: 7 }, { toolCallId: 'x'.repeat(241) }]) {
        assert.throws(() => validatedPermissionParams(params({ toolCall }), 'native-session'), { message: 'acp_invalid_tool' });
    }
    for (const title of [1, false, {}, [], 'x'.repeat(1001)]) {
        assert.throws(() => validatedPermissionParams(params({ toolCall: { toolCallId: 't', title } }), 'native-session'),
            { message: 'acp_invalid_tool' });
    }
    assert.throws(() => validatedPermissionParams(params({ options: [option(), option()] }), 'native-session'),
        { message: 'acp_invalid_option' });
});

test('null and absent titles fall back while empty and exact-limit strings remain intact', () => {
    for (const toolCall of [{ toolCallId: 't' }, { toolCallId: 't', title: null }]) {
        assert.deepEqual(validatedPermissionParams(params({ toolCall }), 'native-session'),
            { options: [option()], title: 'Permission request' });
    }
    for (const title of ['', 'Read local file', 'x'.repeat(1000)]) {
        const result = validatedPermissionParams(params({ toolCall: { toolCallId: 'x'.repeat(240), title } }), 'native-session');
        assert.equal(result.title, title);
    }
});

test('normalization rejects unknown modes, malformed tokens and sparse arrays', () => {
    for (const value of [undefined, null, {}, 'custom', 'AUTO', ' auto ', [1], ['read', null],
        ['read write'], ['a/b'], ['x'.repeat(65)], ['read\nwrite'], new Array(1)]) {
        assert.throws(() => normalizeNativePermissions(value), { message: 'invalid_native_permissions' });
    }
});

test('normalization preserves literals and takes independent immutable custom snapshots', () => {
    assert.equal(normalizeNativePermissions('auto'), 'auto');
    assert.equal(normalizeNativePermissions('safe'), 'safe');
    const saved = [' read ', '', '  ', 'mcp.future:*', 'auto', 'read', 'x'.repeat(64)];
    const before = [...saved];
    const snapshot = normalizeNativePermissions(saved);
    const another = normalizeNativePermissions(saved);
    assert.deepEqual(snapshot, ['read', 'mcp.future:*', 'auto', 'read', 'x'.repeat(64)]);
    assert.deepEqual(saved, before);
    assert.notEqual(snapshot, saved);
    assert.notEqual(snapshot, another);
    assert.ok(Array.isArray(snapshot));
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(saved), false);
    assert.equal(Reflect.set(snapshot, '0', 'write'), false);
    saved[0] = 'bash';
    saved.push('edit');
    assert.deepEqual(snapshot, ['read', 'mcp.future:*', 'auto', 'read', 'x'.repeat(64)]);
});

test('safe and every custom array remain human decisions, including empty and auto tokens', () => {
    for (const value of ['safe', [], ['auto'], ['read', 'write', 'bash', 'mcp.*'], [' ', '']]) {
        const normalized = normalizeNativePermissions(value);
        assert.equal(automaticPermission(normalized, [option()]), undefined);
        assert.equal(automaticPermission(normalized, [option({ kind: 'reject_once' })]), undefined);
        if (Array.isArray(value)) {
            assert.ok(Array.isArray(normalized));
            assert.equal(Object.isFrozen(normalized), true);
            assert.notEqual(normalized, value);
        }
    }
});

test('auto prefers allow_once by kind despite reject-first and misleading localized labels', () => {
    const options = permissionOptions([
        option({ optionId: 'reject', kind: 'reject_once', name: 'Allow everything / 모두 허용' }),
        option({ optionId: 'always', kind: 'allow_always', name: '이번만 허용' }),
        option({ optionId: 'once', kind: 'allow_once', name: '거부 / 拒否' }),
    ]);
    assert.equal(automaticPermission(normalizeNativePermissions('auto'), options), 'once');
    assert.equal(automaticPermission('auto', options.slice(0, 2)), 'always');
    assert.equal(automaticPermission('auto', [options[0]!, option({ optionId: 'reject-all', kind: 'reject_always', name: 'allow' })]), null);
});

test('native-wire responses require membership and distinguish selected rejection from cancellation', () => {
    const options = permissionOptions([option(), option({ optionId: 'reject', kind: 'reject_once' })]);
    assert.deepEqual(permissionResponse({ optionId: 'native-once-private' }, options),
        { outcome: { outcome: 'selected', optionId: 'native-once-private' } });
    assert.deepEqual(permissionResponse({ optionId: 'reject' }, options), { outcome: { outcome: 'selected', optionId: 'reject' } });
    assert.deepEqual(permissionResponse({ optionId: null }, options), cancelled);
    assert.throws(() => permissionResponse({ optionId: 'foreign-native-id' }, options), { message: 'invalid_option' });
});

test('both response validators reject missing, inherited, extra and non-string selections', () => {
    const options = permissionOptions([option()]);
    const prepared = preparePermissionRequest('Approve?', options);
    const validators = [(value: unknown) => permissionResponse(value, options), prepared.validate];
    for (const validate of validators) {
        for (const value of [null, undefined, [], 'allow', {}, Object.create({ optionId: null }),
            { optionId: null, approved: true }, { optionId: null, [Symbol('extra')]: true },
            Object.defineProperty({ optionId: null }, 'hidden', { value: true })]) {
            assert.throws(() => validate(value), { message: 'invalid_response' });
        }
        for (const optionId of [undefined, false, 1, {}, [], '', 'foreign']) {
            assert.throws(() => validate({ optionId }), { message: 'invalid_option' });
        }
    }
    prepared.dispose();
});

test('prepared views use opaque handles and map only this request handles to private native IDs', () => {
    const options = permissionOptions([option(), option({ optionId: 'native-reject-private', kind: 'reject_once', name: 'Reject' })]);
    const first = preparePermissionRequest('Approve?', options);
    const second = preparePermissionRequest('Approve?', options);
    const field = first.view.fields[0]!;
    const handles = field.options.map(entry => entry.id);
    const allHandles = [field.id, ...handles, second.view.fields[0]!.id, ...second.view.fields[0]!.options.map(entry => entry.id)];
    assert.equal(new Set(allHandles).size, 6);
    for (const handle of allHandles) assert.match(handle, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(Object.keys(first).sort(), ['dispose', 'validate', 'view']);
    assert.deepEqual({ label: field.label, multiSelect: field.multiSelect, allowFreeform: field.allowFreeform },
        { label: 'Permission', multiSelect: false, allowFreeform: false });
    for (const native of options) {
        assert.equal(JSON.stringify(first).includes(native.optionId), false);
        assert.throws(() => first.validate({ optionId: native.optionId }), { message: 'invalid_option' });
    }
    assert.throws(() => first.validate({ optionId: field.id }), { message: 'invalid_option' });
    assert.throws(() => first.validate({ optionId: second.view.fields[0]!.options[0]!.id }), { message: 'invalid_option' });
    assert.throws(() => second.validate({ optionId: handles[0] }), { message: 'invalid_option' });
    assert.deepEqual(first.validate({ optionId: handles[0] }), { outcome: { outcome: 'selected', optionId: 'native-once-private' } });
    assert.deepEqual(first.validate({ optionId: handles[1] }), { outcome: { outcome: 'selected', optionId: 'native-reject-private' } });
    first.dispose(); second.dispose();
});

test('mapping snapshots survive input/view mutation and disposal blocks all previous handles', () => {
    const options = permissionOptions([option()]);
    const prepared = preparePermissionRequest('Approve?', options);
    const handle = prepared.view.fields[0]!.options[0]!.id;
    options[0]!.optionId = 'replacement-native';
    options[0]!.name = 'replacement label';
    assert.equal(prepared.view.fields[0]!.options[0]!.label, 'Allow once');
    prepared.view.fields[0]!.options[0]!.id = 'forged-handle';
    assert.throws(() => prepared.validate({ optionId: 'forged-handle' }), { message: 'invalid_option' });
    assert.deepEqual(prepared.validate({ optionId: handle }), { outcome: { outcome: 'selected', optionId: 'native-once-private' } });
    assert.deepEqual(prepared.validate({ optionId: null }), cancelled);
    prepared.dispose(); prepared.dispose();
    assert.throws(() => prepared.validate({ optionId: handle }), { message: 'invalid_option' });
    assert.deepEqual(prepared.validate({ optionId: null }), cancelled);
});

test('preparation preserves complete prose for the canonical registry sanitizer, never pre-clips it', () => {
    const title = '[docs](https://example.test) ' + 't'.repeat(600);
    const label = '[ -f file ] ' + 'l'.repeat(600);
    const prepared = preparePermissionRequest(title, permissionOptions([option({ name: label })]));
    assert.equal(prepared.view.title, title);
    assert.equal(prepared.view.fields[0]!.options[0]!.label, label);
    prepared.dispose();
});

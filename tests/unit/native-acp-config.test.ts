import test from 'node:test';
import assert from 'node:assert/strict';
import { configureAcpModel, parseAcpSelectConfigs, type AcpConfigPort } from '../../src/agent/runtime/acp/config.ts';

const choice = (value: string, name = value) => ({ value, name });
function select(id = 'model', currentValue = 'old', options: unknown = [choice('old'), choice('new')],
    category: string | null = 'model', name = id) {
    return { id, name, type: 'select', currentValue, options, category };
}
const effort = (id = 'effort', category = 'thought_level', name = 'Reasoning effort') =>
    select(id, 'high', [choice('high'), choice('medium'), choice('extra-high')], category, name);

function fixture(initial: unknown, update?: (id: string, value: string) => unknown | Promise<unknown>) {
    let snapshot: unknown = initial;
    const writes: Array<[string, string]> = [];
    let reads = 0;
    const port: AcpConfigPort = {
        getConfigOptions() { reads++; return snapshot; },
        async setConfigOption(id, value) {
            writes.push([id, value]);
            if (update) { snapshot = await update(id, value); return; }
            assert.ok(Array.isArray(snapshot));
            snapshot = snapshot.map((entry: Record<string, unknown>) => entry['id'] === id
                ? { ...entry, currentValue: value } : entry);
        },
    };
    return { port, writes, get reads() { return reads; }, get snapshot() { return snapshot; } };
}

test('parses copied flat and single-level grouped choices without rewriting wire identifiers', () => {
    const raw = [select(' Model.ID ', 'old', [choice('old', ''),
        { group: 'vendor', name: 'Vendor', options: [choice('new-high-thinking[fast=false]', 'New')] },
    ])];
    const parsed = parseAcpSelectConfigs(raw);
    assert.deepEqual(parsed, [{ id: ' Model.ID ', name: ' Model.ID ', category: 'model', currentValue: 'old',
        options: [{ value: 'old', name: '' }, { value: 'new-high-thinking[fast=false]', name: 'New' }] }]);
    assert.notEqual(parsed[0], raw[0]);
    assert.deepEqual(raw[0]?.options, [choice('old', ''),
        { group: 'vendor', name: 'Vendor', options: [choice('new-high-thinking[fast=false]', 'New')] }]);
});

test('absent config snapshots and unknown config types remain unavailable', () => {
    for (const value of [undefined, null, []]) assert.deepEqual(parseAcpSelectConfigs(value), []);
    assert.deepEqual(parseAcpSelectConfigs([
        { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false },
        { id: 'future', name: 'Future', type: 'future-type', currentValue: { private: 'ignored' } },
    ]), []);
});

test('rejects malformed shapes, identifiers, names, current values and choices', () => {
    const malformed: unknown[] = [
        {}, 'options', true, 3, [null], [false], [[]], [Object.create({ id: 'model' })],
        [select('', 'old')], [select(' \t', 'old')], [{ ...select(), id: 1 }],
        [{ ...select(), name: null }], [{ ...select(), name: 'n'.repeat(1001) }],
        [{ ...select(), type: false }], [{ ...select(), category: {} }],
        [{ ...select(), currentValue: null }], [{ ...select(), currentValue: false }],
        [{ ...select(), currentValue: '' }], [{ ...select(), currentValue: 'not-a-choice' }],
        [{ ...select(), currentValue: 'v'.repeat(1025) }],
        [select('model', 'old', {})], [select('model', 'old', [null])],
        [select('model', 'old', [{ value: true, name: 'True' }])],
        [select('model', 'old', [choice('')])], [select('model', 'old', [choice('   ')])],
        [select('model', 'old', [{ value: 'old', name: 42 }])],
        [select('model', 'old', [choice('old', 'n'.repeat(1001))])],
        [select('model', 'old', [choice('old'), choice('v'.repeat(1025))])],
        [select('model', 'old', [{ group: '', name: 'Group', options: [choice('old')] }])],
        [select('model', 'old', [{ group: 'g', name: false, options: [choice('old')] }])],
        [select('model', 'old', [{ group: 'g', name: 'Group', options: 'bad' }])],
        [select('model', 'old', [{ group: 'g', name: 'Group', value: 'old', options: [] }])],
        [select('model', 'old', [{ group: 'g', name: 'Group', options: [
            { group: 'nested', name: 'Nested', options: [choice('old')] },
        ] }])],
        [{ id: 'effort', name: 'Effort', type: 'boolean', currentValue: 'true' }],
    ];
    for (const raw of malformed) assert.throws(() => parseAcpSelectConfigs(raw), /^Error: acp_config_/);
});

test('rejects duplicate config IDs, group IDs and values including across groups', () => {
    assert.throws(() => parseAcpSelectConfigs([select(), select()]), /acp_config_duplicate_id/);
    assert.throws(() => parseAcpSelectConfigs([select(), { id: 'model', name: 'Future', type: 'future' }]),
        /acp_config_duplicate_id/);
    assert.throws(() => parseAcpSelectConfigs([select('model', 'old', [choice('old'), choice('old')])]),
        /acp_config_duplicate_value/);
    assert.throws(() => parseAcpSelectConfigs([select('model', 'old', [
        { group: 'a', name: 'A', options: [choice('old')] },
        { group: 'b', name: 'B', options: [choice('old')] },
    ])]), /acp_config_duplicate_value/);
    assert.throws(() => parseAcpSelectConfigs([select('model', 'old', [
        { group: 'a', name: 'A', options: [choice('old')] },
        { group: 'a', name: 'A', options: [] },
    ])]), /acp_config_duplicate_group/);
});

test('enforces 64 configs, 2048 aggregate choices and 64 aggregate groups at exact boundaries', () => {
    const configs = Array.from({ length: 64 }, (_, i) => select(`c${i}`, 'old', [choice('old')], null));
    assert.equal(parseAcpSelectConfigs(configs).length, 64);
    assert.throws(() => parseAcpSelectConfigs([...configs, select('overflow')]), /acp_config_invalid_configs/);
    const many = Array.from({ length: 1024 }, (_, i) => choice(`v${i}`));
    assert.equal(parseAcpSelectConfigs([select('a', 'v0', many), select('b', 'v0', many)]).length, 2);
    assert.throws(() => parseAcpSelectConfigs([select('a', 'v0', many), select('b', 'v0', many),
        select('c', 'v0', [choice('v0')])]), /acp_config_choice_limit/);
    const groups = Array.from({ length: 32 }, (_, i) => ({ group: `g${i}`, name: 'G', options: [choice(`v${i}`)] }));
    assert.equal(parseAcpSelectConfigs([select('a', 'v0', groups), select('b', 'v0', groups)]).length, 2);
    assert.throws(() => parseAcpSelectConfigs([select('a', 'v0', groups), select('b', 'v0', groups),
        select('c', 'v0', [groups[0]])]), /acp_config_group_limit/);
    const long = 'x'.repeat(1024);
    assert.equal(parseAcpSelectConfigs([select(long, long, [choice(long, 'n'.repeat(1000))], 'model', 'Model')])[0]?.id, long);
    assert.throws(() => parseAcpSelectConfigs([select(`${long}x`)]), /acp_config_invalid_id/);
});

test('exact model value wins over labels and preserves suffixes, brackets, case and whitespace', async () => {
    const value = ' Model-X-high-thinking-fast[reasoning=medium] ';
    const f = fixture([select(' Model.Config ', 'old', [choice('old', value), choice(value, 'Friendly label')])]);
    await configureAcpModel(f.port, { model: value });
    assert.deepEqual(f.writes, [[' Model.Config ', value]]);
    for (const model of ['Friendly label', value.trim(), 'Model-X', 'default']) {
        await assert.rejects(configureAcpModel(f.port, { model }), /acp_config_unsupported_model/);
    }
    assert.equal(f.writes.length, 1);
});

test('configures grouped model and effort choices through the public helper', async () => {
    const f = fixture([
        select('model', 'old', [{ group: 'models', name: 'Models', options: [choice('old'), choice('new')] }]),
        select('effort', 'low', [{ group: 'levels', name: 'Levels', options: [choice('low'), choice('wire-M', 'Medium')] }],
            'model_config'),
    ]);
    await configureAcpModel(f.port, { model: 'new', effort: 'MEDIUM' });
    assert.deepEqual(f.writes, [['model', 'new'], ['effort', 'wire-M']]);
});

test('the public helper refuses malformed and over-budget snapshots before any write', async () => {
    const huge = Array.from({ length: 2049 }, (_, i) => choice(`v${i}`));
    for (const raw of [{}, [select(), { ...effort(), currentValue: false }],
        Array.from({ length: 65 }, (_, i) => select(`model${i}`)),
        [select('model', 'v0', huge)]]) {
        const f = fixture(raw);
        await assert.rejects(configureAcpModel(f.port, { model: 'new', effort: 'medium' }), /^Error: acp_config_/);
        assert.deepEqual(f.writes, []);
    }
});

test('model ID compatibility requires an advertised unambiguous exact model selector', async () => {
    const f = fixture([select('model', 'old', undefined, null)]);
    await configureAcpModel(f.port, { model: 'new' });
    assert.deepEqual(f.writes, [['model', 'new']]);
    for (const raw of [[], [select('other', 'old', undefined, null, 'Model')],
        [select(), select('second')], [select('other'), select('model', 'old', undefined, null)]]) {
        const g = fixture(raw);
        await assert.rejects(configureAcpModel(g.port, { model: 'new' }), /acp_config_(unsupported|ambiguous)_model/);
        assert.deepEqual(g.writes, []);
    }
});

test('empty requests retain provider defaults; explicit default is only an advertised value', async () => {
    const f = fixture([select('model', 'composer-2.5', [choice('composer-2.5')])]);
    for (const input of [{}, { model: '', effort: '' }, { model: null, effort: undefined }, { model: '  ', effort: '\t' }]) {
        await configureAcpModel(f.port, input);
    }
    await configureAcpModel(f.port, { model: 'composer-2.5' });
    assert.deepEqual(f.writes, []);
    await assert.rejects(configureAcpModel(f.port, { model: 'default' }), /acp_config_unsupported_model/);
    const advertised = fixture([select('model', 'old', [choice('old'), choice('default')])]);
    await configureAcpModel(advertised.port, { model: 'default' });
    assert.deepEqual(advertised.writes, [['model', 'default']]);
    await configureAcpModel(fixture(undefined).port, {});
});

test('awaits model write, then uses only refreshed effort selector/choices and verifies application', async () => {
    let release: () => void = () => { throw new Error('gate not installed'); };
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fresh = [select('model', 'new'), select('fresh-effort', 'low', [choice('low'), choice('wire-X', 'Extra High')],
        'model_config', 'Reasoning')];
    const f = fixture([select(), effort('old-effort')], async (id, value) => {
        if (id === 'model') { await gate; return fresh; }
        assert.equal(id, 'fresh-effort');
        assert.equal(value, 'wire-X');
        return [select('model', 'new'), { ...fresh[1], currentValue: 'wire-X' }];
    });
    const pending = configureAcpModel(f.port, { model: 'new', effort: 'xhigh' });
    assert.deepEqual(f.writes, [['model', 'new']]);
    assert.equal(f.reads, 1);
    release();
    await pending;
    assert.deepEqual(f.writes, [['model', 'new'], ['fresh-effort', 'wire-X']]);
    assert.equal(f.reads, 3);
});

test('Composer 2.5 model change removes effort: explicit medium errors without an effort RPC', async () => {
    const models = [choice('grok-4.6'), choice('composer-2.5')];
    const changed = [select('model', 'composer-2.5', models)];
    const f = fixture([select('model', 'grok-4.6', models), effort()], () => changed);
    await assert.rejects(configureAcpModel(f.port, { model: 'composer-2.5', effort: 'medium' }),
        /acp_config_unsupported_effort/);
    assert.deepEqual(f.writes, [['model', 'composer-2.5']]);
    assert.deepEqual(f.snapshot, changed);
    await configureAcpModel(f.port, { model: 'composer-2.5', effort: '' });
    assert.equal(f.writes.length, 1);
});

test('accepts each supported effort selector shape and sends original option wire value', async () => {
    const selectors = [effort('reasoning', 'model_option'), effort('reasoning_effort', 'model_config'),
        effort('effort', ''), effort('opaque', 'thought_level', 'Depth'),
        effort('opaque', 'MODEL_CONFIG', 'Reasoning Effort')];
    for (const config of selectors) {
        const f = fixture([{ ...config, category: config.category || null }]);
        await configureAcpModel(f.port, { effort: 'Extra_HIGH' });
        assert.deepEqual(f.writes, [[config.id, 'extra-high']]);
    }
});

test('recognizes only exact known normalized effort IDs or names in legacy/standard categories', async () => {
    for (const category of ['model_option', 'model_config']) {
        for (const label of ['Effort', 'Reasoning', 'Reasoning Effort', 'reasoning-level', 'THINKING_LEVEL', 'Thought Level']) {
            for (const [id, name] of [[label, 'Depth'], ['opaque', label]]) {
                const f = fixture([effort(id, category, name)]);
                await configureAcpModel(f.port, { effort: 'medium' });
                assert.deepEqual(f.writes, [[id, 'medium']]);
            }
        }
    }
});

test('summary-only and verbosity-only selectors never receive an effort RPC', async () => {
    for (const category of ['model_option', 'model_config']) {
        for (const [id, name] of [['reasoning-summary', 'Reasoning Summary'], ['reasoning-verbosity', 'Reasoning Verbosity']]) {
            const f = fixture([select(id, 'low', [choice('low'), choice('high')], category, name)]);
            await assert.rejects(configureAcpModel(f.port, { effort: 'high' }),
                { message: 'acp_config_unsupported_effort' });
            assert.deepEqual(f.writes, []);
        }
    }
});

test('normalizes known effort case/separators but preserves exact opaque future values', async () => {
    for (const requested of ['xhigh', 'XHIGH', 'extra-high', 'Extra High', 'extra_high', 'extraHigh']) {
        const f = fixture([select('effort', 'low', [choice('low'), choice('EXTRA_HIGH')], 'thought_level')]);
        await configureAcpModel(f.port, { effort: requested });
        assert.deepEqual(f.writes, [['effort', 'EXTRA_HIGH']]);
    }
    const f = fixture([select('effort', 'low', [choice('low'), choice('Custom-Depth')], 'thought_level')]);
    await assert.rejects(configureAcpModel(f.port, { effort: 'customdepth' }), /acp_config_unsupported_effort/);
    await configureAcpModel(f.port, { effort: 'Custom-Depth' });
    assert.deepEqual(f.writes, [['effort', 'Custom-Depth']]);
});

test('refuses missing/unsupported/boolean effort and ambiguous selectors or normalized choices', async () => {
    for (const raw of [[], [select()], [{ id: 'effort', name: 'Effort', type: 'boolean', currentValue: true }],
        [effort('reasoning', 'unrecognized')]]) {
        const f = fixture(raw);
        await assert.rejects(configureAcpModel(f.port, { effort: 'medium' }), /acp_config_unsupported_effort/);
        assert.deepEqual(f.writes, []);
    }
    const ambiguous = fixture([effort('legacy', 'model_option'), effort('effort', 'model_config')]);
    await assert.rejects(configureAcpModel(ambiguous.port, { effort: 'high' }), /acp_config_ambiguous_effort/);
    const values = fixture([select('effort', 'low', [choice('low'), choice('xhigh'), choice('extra-high')], 'thought_level')]);
    await assert.rejects(configureAcpModel(values.port, { effort: 'xhigh' }), /acp_config_ambiguous_effort_value/);
    const names = fixture([select('effort', 'low', [choice('low'), choice('wire1', 'Medium'), choice('wire2', 'MEDIUM')], 'thought_level')]);
    await assert.rejects(configureAcpModel(names.port, { effort: 'medium' }), /acp_config_ambiguous_effort_value/);
    const unsupported = fixture([effort()]);
    await assert.rejects(configureAcpModel(unsupported.port, { effort: 'ultra' }), /acp_config_unsupported_effort/);
    for (const f of [ambiguous, values, names, unsupported]) assert.deepEqual(f.writes, []);
});

test('skips only confirmed current selections without emitting redundant writes', async () => {
    const f = fixture([select(), effort()]);
    await configureAcpModel(f.port, { model: 'old', effort: 'HIGH' });
    assert.deepEqual(f.writes, []);
    await configureAcpModel(f.port, { effort: 'medium' });
    await configureAcpModel(f.port, { effort: 'Medium' });
    assert.deepEqual(f.writes, [['effort', 'medium']]);
});

test('does not report success for ignored model/effort writes or effort-induced model drift', async () => {
    const initial = [select(), effort()];
    const ignoredModel = fixture(initial, () => initial);
    await assert.rejects(configureAcpModel(ignoredModel.port, { model: 'new', effort: 'medium' }), /acp_config_model_not_applied/);
    assert.deepEqual(ignoredModel.writes, [['model', 'new']]);
    const ignoredEffort = fixture(initial, () => initial);
    await assert.rejects(configureAcpModel(ignoredEffort.port, { effort: 'medium' }), /acp_config_effort_not_applied/);
    const drift = fixture(initial, () => [select('model', 'new'), { ...effort(), currentValue: 'medium' }]);
    await assert.rejects(configureAcpModel(drift.port, { model: 'old', effort: 'medium' }), /acp_config_model_not_applied/);
});

test('malformed refreshed metadata and rejected writes stop configuration without fallback or retry', async () => {
    const f = fixture([select(), effort()], () => [{ ...select(), currentValue: false }]);
    await assert.rejects(configureAcpModel(f.port, { model: 'new', effort: 'medium' }), /acp_config_invalid_current/);
    assert.deepEqual(f.writes, [['model', 'new']]);
    const failure = new Error('transport_closed');
    const g = fixture([select(), effort()], () => { throw failure; });
    await assert.rejects(configureAcpModel(g.port, { model: 'new', effort: 'medium' }), error => error === failure);
    assert.deepEqual(g.writes, [['model', 'new']]);
});

test('invalid explicit requests fail before writes; errors never interpolate provider metadata', async () => {
    const f = fixture([select(), effort()]);
    await assert.rejects(configureAcpModel(f.port, { model: 'x'.repeat(1025) }), /acp_config_invalid_requested_model/);
    await assert.rejects(configureAcpModel(f.port, { model: 'new', effort: 'x'.repeat(1025) }), /acp_config_invalid_requested_effort/);
    assert.deepEqual(f.writes, []);
    assert.throws(() => parseAcpSelectConfigs([{ ...select(), id: 'SECRET'.repeat(200) }]),
        { message: 'acp_config_invalid_id' });
});

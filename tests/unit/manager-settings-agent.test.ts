import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDirtyStore } from '../../public/manager/src/settings/dirty-store';
import { splitAgentSaveBundle } from '../../public/manager/src/settings/pages/Agent';
import { expandPatch } from '../../public/manager/src/settings/pages/path-utils';
import {
    buildRuntimeEmployeeDiff,
    makeDefaultRuntimeEmployee,
    runtimeEmployeeChangeSummary,
    unwrapRuntimeEmployees,
    type RuntimeEmployeeRecord,
} from '../../public/manager/src/settings/pages/components/agent/runtime-employees-helpers';
import {
    metaFor,
    runtimeEffortFor,
    runtimeModelFor,
} from '../../public/manager/src/settings/pages/components/agent/agent-meta';

const dbEmployee: RuntimeEmployeeRecord = {
    id: 'db-1',
    name: 'Frontend',
    cli: 'claude',
    model: 'claude-sonnet-4-6',
    role: 'UI',
    status: 'idle',
    source: 'db',
};

const staticEmployee: RuntimeEmployeeRecord = {
    id: 'static:control',
    name: 'Control',
    cli: 'codex',
    model: 'gpt-5.4',
    role: 'Computer use',
    status: 'idle',
    source: 'static',
};

test('splitAgentSaveBundle keeps synthetic keys out of /api/settings patch', () => {
    const bundle = {
        cli: 'codex',
        workingDir: '/work',
        'activeOverrides.codex.model': 'gpt-5.5',
        permissions: 'auto',
        flushCli: 'claude',
        flushModel: 'claude-haiku-4-5',
        runtimeEmployees: [dbEmployee],
    };
    const split = splitAgentSaveBundle(bundle);
    assert.deepEqual(expandPatch(split.settingsBundle), {
        cli: 'codex',
        workingDir: '/work',
        activeOverrides: { codex: { model: 'gpt-5.5' } },
        permissions: 'auto',
    });
    assert.deepEqual(split.flushPatch, { cli: 'claude', model: 'claude-haiku-4-5' });
    assert.deepEqual(split.runtimeEmployeesNext, [dbEmployee]);
});

test('runtime model and effort prefer active overrides over per-cli defaults', () => {
    const perCli = { codex: { model: 'gpt-5.4', effort: 'medium' } };
    const overrides = { codex: { model: 'gpt-5.5', effort: 'high' } };
    assert.equal(runtimeModelFor('codex', perCli, overrides), 'gpt-5.5');
    assert.equal(runtimeEffortFor('codex', perCli, overrides), 'high');
});

test('claude-e id is displayed as Claude E', () => {
    assert.equal(metaFor('claude-e').label, 'Claude E');
});

test('runtime employee GET wrapper unwraps { ok, data } responses', () => {
    const rows = unwrapRuntimeEmployees({ ok: true, data: [staticEmployee, dbEmployee] });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.source, 'static');
    assert.equal(rows[1]?.source, 'db');
});

test('runtime employee diff respects static model-only edits and DB deletion', () => {
    const nextStatic = { ...staticEmployee, model: 'gpt-5.5' };
    const diff = buildRuntimeEmployeeDiff(
        [staticEmployee, dbEmployee],
        [nextStatic, { ...dbEmployee, role: 'Frontend UI' }],
    );
    assert.deepEqual(diff.updated.map((item) => item.patch), [
        { model: 'gpt-5.5' },
        { role: 'Frontend UI' },
    ]);

    const removed = buildRuntimeEmployeeDiff([staticEmployee, dbEmployee], [staticEmployee]);
    assert.deepEqual(removed.removed, [dbEmployee]);
});

test('runtime employee summary counts added, updated, and removed rows', () => {
    const next: RuntimeEmployeeRecord[] = [
        { ...staticEmployee, model: 'gpt-5.5' },
        { ...dbEmployee, id: 'new:1', name: 'Backend' },
    ];
    const summary = runtimeEmployeeChangeSummary([staticEmployee, dbEmployee], next);
    assert.deepEqual(summary, { added: 1, updated: 1, removed: 1 });
});

test('new runtime employee defaults to first live CLI metadata model', () => {
    const row = makeDefaultRuntimeEmployee(['codex'], {
        codex: {
            label: 'Codex',
            models: ['gpt-5.5', 'kiro/claude-opus-4.8', 'opencode-go/kimi-k2.7-code'],
            efforts: ['low', 'medium', 'high', 'xhigh'],
        },
    });
    assert.equal(row.cli, 'codex');
    assert.equal(row.model, 'gpt-5.5');
});

test('new runtime employee can default to active ocx routed metadata model', () => {
    const row = makeDefaultRuntimeEmployee(['codex'], {
        codex: {
            label: 'Codex',
            models: ['kiro/claude-opus-4.8', 'gpt-5.5'],
            efforts: ['low', 'medium', 'high', 'xhigh'],
        },
    });
    assert.equal(row.model, 'kiro/claude-opus-4.8');
});

test('new runtime employee keeps default model when live CLI metadata is absent', () => {
    const row = makeDefaultRuntimeEmployee(['codex'], null);
    assert.equal(row.cli, 'codex');
    assert.equal(row.model, 'default');
});

test('runtimeEmployees dirty key is valid only when rows are valid', () => {
    const store = createDirtyStore();
    const invalid = [{ ...dbEmployee, model: '' }];
    store.set('runtimeEmployees', { value: invalid, original: [dbEmployee], valid: false });
    assert.equal(store.isDirty(), true);
    assert.equal('runtimeEmployees' in store.saveBundle(), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const settingsCoreSrc = fs.readFileSync(
    path.join(import.meta.dirname, '../../public/js/features/settings-core.ts'),
    'utf8',
);

const employeesSrc = fs.readFileSync(
    path.join(import.meta.dirname, '../../public/js/features/employees.ts'),
    'utf8',
);

test('FCC-001: settings-core normalizeModelForDisplay is trim-only (passthrough policy)', () => {
    assert.ok(settingsCoreSrc.includes('function normalizeModelForDisplay'));
    assert.ok(/return\s*\(model\s*\|\|\s*''\)\.trim\(\);/.test(settingsCoreSrc),
        'normalizeModelForDisplay must be a trim-only no-op');
    assert.ok(!settingsCoreSrc.includes("case 'claude-opus-4-6[1m]':"),
        'no legacy-rewrite cases should remain');
    assert.ok(!settingsCoreSrc.includes("case 'claude-opus-4-7':"),
        'no legacy-rewrite cases should remain');
    assert.ok(!settingsCoreSrc.includes("return 'sonnet[1m]';"),
        'no alias-rewrite return statements should remain');
});

test('FCC-002: employees normalizeEmployeeModel is trim-only (passthrough policy)', () => {
    assert.ok(employeesSrc.includes('function normalizeEmployeeModel'));
    assert.ok(/return trimmed \|\| 'default';/.test(employeesSrc),
        'normalizeEmployeeModel must return trimmed-or-default');
    assert.ok(!employeesSrc.includes("case 'claude-sonnet-4-6':"),
        'no legacy-rewrite cases should remain');
    assert.ok(!employeesSrc.includes("case 'claude-opus-4-7':"),
        'no legacy-rewrite cases should remain');
    assert.ok(employeesSrc.includes('const selectedModel = normalizeEmployeeModel(a.cli, a.model);'),
        'render call site must still use the helper');
});

test('FCC-003: employees use Opus 4.8 as Claude default on CLI switch', () => {
    assert.ok(employeesSrc.includes('function getDefaultEmployeeModel'));
    assert.ok(employeesSrc.includes("if (models.includes('claude-opus-4-8')) return 'claude-opus-4-8';"));
    assert.ok(employeesSrc.includes('updateEmployee(id, { cli, model: nextModel });'));
});

test('FCC-004: employees Codex default follows live model order on CLI switch', () => {
    const defaultHelper = employeesSrc.slice(
        employeesSrc.indexOf('function getDefaultEmployeeModel'),
        employeesSrc.indexOf('export async function loadEmployees'),
    );
    assert.ok(defaultHelper.includes("return models[0] || 'default';"),
        'Codex/Codex App should fall through to the first live MODEL_MAP entry');
    assert.ok(!defaultHelper.includes("cli === 'codex'"),
        'getDefaultEmployeeModel must not special-case Codex');
    assert.ok(!defaultHelper.includes("cli === 'codex-app'"),
        'getDefaultEmployeeModel must not special-case Codex App');
    assert.ok(!defaultHelper.includes("if (models.includes('gpt-5.5')) return 'gpt-5.5';"),
        'stale gpt-5.5 override must not return ahead of active ocx ordering');
});

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

test('FCC-001: settings-core normalizes legacy Claude aliases to canonical IDs for display', () => {
    assert.ok(settingsCoreSrc.includes("case 'sonnet': return 'claude-sonnet-4-6';"));
    assert.ok(settingsCoreSrc.includes("case 'opus': return 'claude-opus-4-6';"));
    assert.ok(settingsCoreSrc.includes("case 'sonnet[1m]': return 'claude-sonnet-4-6[1m]';"));
    assert.ok(settingsCoreSrc.includes("case 'opus[1m]': return 'claude-opus-4-6[1m]';"));
    assert.ok(!settingsCoreSrc.includes("case 'claude-sonnet-4-6': return 'sonnet';"));
});

test('FCC-002: employees normalizes legacy Claude aliases before rendering', () => {
    assert.ok(employeesSrc.includes('function normalizeEmployeeModel'));
    assert.ok(employeesSrc.includes("case 'sonnet': return 'claude-sonnet-4-6';"));
    assert.ok(employeesSrc.includes('const selectedModel = normalizeEmployeeModel(a.cli, a.model);'));
});

test('FCC-003: employees use canonical Claude default on CLI switch', () => {
    assert.ok(employeesSrc.includes('function getDefaultEmployeeModel'));
    assert.ok(employeesSrc.includes("if (models.includes('claude-sonnet-4-6')) return 'claude-sonnet-4-6';"));
    assert.ok(employeesSrc.includes('updateEmployee(id, { cli, model: nextModel });'));
});

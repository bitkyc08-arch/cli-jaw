import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const a1System = fs.readFileSync(join(__dirname, '../../src/prompt/templates/a1-system.md'), 'utf8');
const employee = fs.readFileSync(join(__dirname, '../../src/prompt/templates/employee.md'), 'utf8');

test('PBP-001: a1 system prompt prefers debug console for debug inspection', () => {
    assert.match(a1System, /debug console/i);
});

test('PBP-002: a1 system prompt uses --agent for automated browser sessions', () => {
    assert.match(a1System, /browser start --agent/);
});

test('PBP-003: employee prompt uses --agent for automated browser sessions', () => {
    assert.match(employee, /browser start --agent/);
});

test('PBP-004: employee prompt forbids visible test browser for debug inspection', () => {
    assert.match(employee, /Do NOT open a visible test browser/i);
});

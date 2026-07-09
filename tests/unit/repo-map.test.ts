import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRepoMap, renderRepoMap } from '../../src/workflows/repo-map/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(__dirname, '../fixtures/repo-map');

test('repo map extracts TS/JS definitions and class methods', () => {
    const repoMap = buildRepoMap(fixtureRoot, { budgetTokens: 4096 });
    const output = renderRepoMap(repoMap);

    assert.match(output, /sample\.ts\n(?:.*\n)*\s+1: interface WidgetConfig/);
    assert.match(output, /\s+5: type WidgetId/);
    assert.match(output, /\s+7: enum WidgetMode/);
    assert.match(output, /\s+11: const widgetLimit/);
    assert.match(output, /\s+13: function createWidget/);
    assert.match(output, /\s+17: class WidgetRegistry/);
    assert.match(output, /\s+18: method register/);
    assert.match(output, /\s+22: method find/);
    assert.match(output, /nested\/consumer\.js\n\s+3: function renderWidget/);
});

test('repo map scopes scans to the requested subtree', () => {
    const repoMap = buildRepoMap(join(fixtureRoot, 'nested'), { budgetTokens: 4096 });
    const output = renderRepoMap(repoMap);

    assert.match(output, /consumer\.js/);
    assert.match(output, /function renderWidget/);
    assert.doesNotMatch(output, /WidgetRegistry/);
});

test('repo map respects token budget with a truncation marker', () => {
    const output = renderRepoMap(buildRepoMap(fixtureRoot, { budgetTokens: 20 }));

    assert.ok(output.length <= 100, `expected budgeted output, got ${output.length} chars`);
    assert.match(output, /truncated to budget/);
});

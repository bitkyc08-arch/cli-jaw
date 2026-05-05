// Orchestrator snapshot reconnect — Phase 9 (source-shape, no browser import)
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wsPathTs = join(__dirname, '../../public/js/ws.ts');
const wsPathJs = join(__dirname, '../../public/js/ws.js');
const scopeHelperPathTs = join(__dirname, '../../public/js/features/orchestrate-scope.ts');
const scopeHelperPathJs = join(__dirname, '../../public/js/features/orchestrate-scope.js');
const wsPath = existsSync(wsPathTs) ? wsPathTs : wsPathJs;
const scopeHelperPath = existsSync(scopeHelperPathTs) ? scopeHelperPathTs : scopeHelperPathJs;
const hasWs = existsSync(wsPath);
const hasScopeHelper = existsSync(scopeHelperPath);

test('OSR-001: ws source exports hydrateAgentPhases function', { skip: !hasWs && 'public/js/ws source not found' }, () => {
    const wsSrc = readFileSync(wsPath, 'utf8');
    assert.ok(wsSrc.includes('hydrateAgentPhases'),
        'ws source should define hydrateAgentPhases');
});

test('OSR-002: hydrateAgentPhases handles phase and phaseLabel fields', { skip: !hasWs && 'public/js/ws source not found' }, () => {
    const wsSrc = readFileSync(wsPath, 'utf8');
    assert.ok(wsSrc.includes('phase') && wsSrc.includes('phaseLabel'),
        'hydrateAgentPhases should reference phase and phaseLabel');
});

test('OSR-003: ws source tracks current orc scope and ignores foreign orc_state events', { skip: !hasWs && 'public/js/ws source not found' }, () => {
    const wsSrc = readFileSync(wsPath, 'utf8');
    assert.ok(wsSrc.includes('currentOrcScope'), 'ws should track current orc scope');
    assert.ok(wsSrc.includes("import { shouldApplyOrcStateEvent } from './features/orchestrate-scope.js'"), 'ws should use shared scope predicate');
    assert.ok(wsSrc.includes('if (!shouldApplyOrcStateEvent(msg.scope, currentOrcScope)) return'), 'ws should filter foreign scope events before applying state');
});

test('OSR-003b: orc_state scope predicate accepts global scope and rejects foreign concrete scopes', { skip: !hasScopeHelper && 'orchestrate scope helper source not found' }, async () => {
    const { shouldApplyOrcStateEvent } = await import(scopeHelperPath);
    assert.equal(shouldApplyOrcStateEvent('other', 'default'), false, 'foreign concrete scope should be ignored');
    assert.equal(shouldApplyOrcStateEvent('default', 'default'), true, 'matching concrete scope should apply');
    assert.equal(shouldApplyOrcStateEvent('all', 'default'), true, 'global scope should apply');
    assert.equal(shouldApplyOrcStateEvent(undefined, 'default'), true, 'missing event scope should preserve legacy apply behavior');
    assert.equal(shouldApplyOrcStateEvent('other', ''), true, 'unknown current scope should preserve legacy apply behavior');
});

test('OSR-004: orchestrate snapshot returns queued overlay detail and active run payload', () => {
    const routePath = join(__dirname, '../../src/routes/orchestrate.ts');
    const routeSrc = readFileSync(routePath, 'utf8');
    assert.ok(routeSrc.includes('queued: getQueuedMessageSnapshotForScope(scope)'), 'snapshot route should include queued overlay detail');
    assert.ok(routeSrc.includes('activeRun: getSafeLiveRun(scope)'), 'snapshot route should include bounded active run payload');
});

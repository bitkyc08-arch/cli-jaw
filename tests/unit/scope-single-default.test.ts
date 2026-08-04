import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveOrcScope, findActiveScope } from '../../src/orchestrator/scope.ts';
import { getCtx, setState, resetState } from '../../src/orchestrator/state-machine.ts';
import { slackTargetFromId } from '../../src/messaging/slack-target.ts';

afterEach(() => { resetState('default'); });

test('SSD-001: OFF stays default; ON isolates target and honors persisted scope', () => {
    assert.equal(resolveOrcScope({ multiSessionEnabled: false }), 'default');
    assert.equal(resolveOrcScope({ multiSessionEnabled: false, persistedScopeId: 'legacy:old' }), 'default');
    assert.equal(
        resolveOrcScope({ multiSessionEnabled: true, target: slackTargetFromId('C1') }),
        'jaw:slack:channel:C1',
    );
    assert.equal(
        resolveOrcScope({ multiSessionEnabled: true, persistedScopeId: 'persisted:scope' }),
        'persisted:scope',
    );
});

test('SSD-002: findActiveScope always returns default', () => {
    assert.equal(findActiveScope('web'), 'default');
    assert.equal(findActiveScope('telegram', 123, { workingDir: '/tmp' }), 'default');
    assert.equal(findActiveScope('discord'), 'default');
});

test('SSD-003: normalizeQueueItem hardcodes scope to default', () => {
    const queueSrc = readFileSync(new URL('../../src/agent/spawn/queue.ts', import.meta.url), 'utf8');
    assert.ok(queueSrc.includes("scope: 'default',"),
        'normalizeQueueItem must hardcode scope to default');
});

test('SSD-004: ctx.scopeId is persisted in default scope', () => {
    resetState('default');
    setState('P', {
        originalPrompt: 'test',
        workingDir: null,
        scopeId: 'default',
        plan: null,
        workerResults: [],
        origin: 'web',
    }, 'default');

    const ctx = getCtx('default');
    assert.equal(ctx?.scopeId, 'default');
    resetState('default');
});

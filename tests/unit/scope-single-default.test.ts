// #458: this file writes the shared `orc_state` 'default' row. tests/run.mts forks
// per file but every child inherits ONE CLI_JAW_HOME, so without an isolated home a
// concurrent file's resetState() clobbers this file's setState() mid-assertion.
// Must be the FIRST import: config.ts binds DB_PATH at module evaluation.
import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    LOCAL_SESSION_SCOPE_ACTIVATION,
    resolveOrcScope,
    findActiveScope,
    scopeForChatSession,
} from '../../src/orchestrator/scope.ts';
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

test('SSD-001a: chat-session scope canonicalizes default, remote, local, and gate-off identities', () => {
    assert.equal(LOCAL_SESSION_SCOPE_ACTIVATION, true, 'local execution scopes are live now that native-state isolation guards them');
    assert.equal(scopeForChatSession('default'), 'default');
    assert.equal(scopeForChatSession('default', 'jaw:slack:channel:C1'), 'default');
    assert.equal(scopeForChatSession('remote-session', 'jaw:slack:channel:C1'), 'jaw:slack:channel:C1');
    assert.equal(scopeForChatSession('local-session'), 'local:local-session');
    assert.equal(scopeForChatSession('local-session', undefined, false), 'default');
    assert.equal(scopeForChatSession('remote-session', 'jaw:slack:channel:C1', false), 'default');
});

test('SSD-002: findActiveScope always returns default', () => {
    assert.equal(findActiveScope('web'), 'default');
    assert.equal(findActiveScope('telegram', 123, { workingDir: '/tmp' }), 'default');
    assert.equal(findActiveScope('discord'), 'default');
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

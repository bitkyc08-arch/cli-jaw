import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getSessionOwnershipGeneration,
    resetSessionOwnershipGenerationForTest,
    shouldPersistMainSession,
} from '../../src/agent/session-persistence.ts';
import {
    isNativeStateIsolatedScope,
    scopeForChatSession,
} from '../../src/orchestrator/scope.ts';

// 072 §1.2b — a local session scope on a runtime without a scoped bucket must not read
// or write the shared native state, because that state belongs to the default session.

test('local session scopes are the only ones isolated from native state', () => {
    assert.equal(isNativeStateIsolatedScope('local:sess-2'), true);
    assert.equal(isNativeStateIsolatedScope('default'), false);
    // Remote scopes share a bucket today too, but cutting their resume here would break
    // working Slack sessions. That separation belongs to unit 073.
    assert.equal(isNativeStateIsolatedScope('jaw:slack:T1:C1'), false);
    assert.equal(isNativeStateIsolatedScope(undefined), false);
});

test('the canonical scope helper is what produces the isolated prefix', () => {
    assert.equal(isNativeStateIsolatedScope(scopeForChatSession('sess-2')), true);
    assert.equal(isNativeStateIsolatedScope(scopeForChatSession('default')), false);
    assert.equal(isNativeStateIsolatedScope(scopeForChatSession('sess-2', 'jaw:slack:T1:C1')), false);
    assert.equal(isNativeStateIsolatedScope(scopeForChatSession('sess-2', undefined, false)), false);
});

test('a local scope without a scoped bucket does not persist the shared session row', () => {
    resetSessionOwnershipGenerationForTest();
    const scopeKey = scopeForChatSession('sess-2');
    const ok = shouldPersistMainSession({
        persistenceOwner: getSessionOwnershipGeneration(scopeKey),
        scopeKey,
        cli: 'claude',
        model: 'default',
        effort: 'medium',
        sessionId: 'vendor-session-from-tab-2',
        code: 0,
    });
    assert.equal(ok, false);
});

test('the default scope keeps persisting exactly as before', () => {
    resetSessionOwnershipGenerationForTest();
    const scopeKey = scopeForChatSession('default');
    const ok = shouldPersistMainSession({
        persistenceOwner: getSessionOwnershipGeneration(scopeKey),
        scopeKey,
        cli: 'claude',
        model: 'default',
        effort: 'medium',
        sessionId: 'vendor-session-from-tab-1',
        code: 0,
    });
    assert.equal(ok, true);
});

test('a remote scope keeps persisting so existing Slack resume survives', () => {
    resetSessionOwnershipGenerationForTest();
    const scopeKey = scopeForChatSession('sess-slack', 'jaw:slack:T1:C1');
    const ok = shouldPersistMainSession({
        persistenceOwner: getSessionOwnershipGeneration(scopeKey),
        scopeKey,
        cli: 'claude',
        model: 'default',
        effort: 'medium',
        sessionId: 'vendor-session-from-slack',
        code: 0,
    });
    assert.equal(ok, true);
});

test('codex-app multiplex carries the scope in its bucket and stays a normal owner', () => {
    resetSessionOwnershipGenerationForTest();
    const scopeKey = scopeForChatSession('sess-2');
    const ok = shouldPersistMainSession({
        persistenceOwner: getSessionOwnershipGeneration(scopeKey),
        scopeKey,
        cli: 'codex-app',
        model: 'gpt-5.5',
        effort: 'medium',
        sessionId: 'thread-2',
        code: 0,
        codexAppBucket: `codex-app:${scopeKey}`,
    });
    assert.equal(ok, true);
});

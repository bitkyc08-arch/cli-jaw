import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getSessionOwnershipGeneration,
    resetSessionOwnershipGenerationForTest,
    shouldPersistMainSession,
} from '../../src/agent/session-persistence.ts';
import { resolveScopedSessionBucket } from '../../src/agent/args.ts';
import { scopeForChatSession } from '../../src/orchestrator/scope.ts';

// This file was written for 072, which kept a non-default scope away from the shared
// vendor state because sharing it would have destroyed the default session's
// conversation. 073 gave every scope a bucket of its own, so the contract is now the
// opposite: each scope persists, and what it must not do is reach into another's.

test('every scope gets a bucket of its own, and the default keeps the legacy name', () => {
    assert.equal(resolveScopedSessionBucket('claude', 'default', null, 'default', 'high', 'native', false), 'claude');
    assert.equal(resolveScopedSessionBucket('claude', 'default', null, 'local:sess-2', 'high', 'native', false), 'claude:local:sess-2');
    assert.equal(
        resolveScopedSessionBucket('claude', 'default', null, 'jaw:slack:T1:C1', 'high', 'native', false),
        'claude:jaw:slack:T1:C1',
        'a remote scope is separated too — 072 deferred this and 073 owns it',
    );
});

test('two scopes on the same runtime never land on the same bucket', () => {
    const a = resolveScopedSessionBucket('claude', 'default', null, 'local:a', 'high', 'native', false);
    const b = resolveScopedSessionBucket('claude', 'default', null, 'local:b', 'high', 'native', false);
    const slack = resolveScopedSessionBucket('claude', 'default', null, 'jaw:slack:T1:C1', 'high', 'native', false);
    assert.equal(new Set([a, b, slack]).size, 3);
});

test('the canonical scope helper produces the keys those buckets are built from', () => {
    assert.equal(scopeForChatSession('default'), 'default');
    assert.equal(scopeForChatSession('sess-2'), 'local:sess-2');
    assert.equal(scopeForChatSession('sess-2', 'jaw:slack:T1:C1'), 'jaw:slack:T1:C1');
    assert.equal(scopeForChatSession('sess-2', undefined, false), 'default', 'gate off collapses to default');
});

test('a local scope persists now that it owns a bucket', () => {
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
    assert.equal(ok, true);
});

test('the default scope and a remote scope persist as they always did', () => {
    for (const scopeKey of ['default', 'jaw:slack:channel:C1']) {
        resetSessionOwnershipGenerationForTest();
        const ok = shouldPersistMainSession({
            persistenceOwner: getSessionOwnershipGeneration(scopeKey),
            scopeKey,
            cli: 'claude',
            model: 'default',
            effort: 'medium',
            sessionId: `vendor-${scopeKey}`,
            code: 0,
        });
        assert.equal(ok, true, `${scopeKey} must still persist`);
    }
});

// codex-app multiplex folds lane mode and effort into its key, and that is unchanged.
test('codex-app multiplex keeps its own key shape', () => {
    assert.equal(
        resolveScopedSessionBucket('codex-app', 'gpt-5.5', null, 'local:sess-2', 'high', 'native', true),
        'codex-app:local:sess-2',
    );
    assert.equal(
        resolveScopedSessionBucket('codex-app', 'gpt-5.5', null, 'local:sess-2', 'high', 'fallback', true),
        'codex-app:local:sess-2:gpt-5.5:high',
    );
    assert.equal(
        resolveScopedSessionBucket('codex-app', 'gpt-5.5', null, 'default', 'high', 'native', false),
        'codex-app',
        'multiplex off keeps the bare name on the default scope',
    );
});

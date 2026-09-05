import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, getSession, getSessionBucket } from '../../src/core/db.ts';
import { resolveScopedSessionBucket } from '../../src/agent/args.ts';
import { runtimeSessionBucket } from '../../src/agent/runtime/selection.ts';
import { persistMainSession, getSessionOwnershipGeneration, bumpScopeSessionGeneration,
    resetSessionOwnershipGenerationForTest, type SessionPersistenceInput } from '../../src/agent/session-persistence.ts';

test.beforeEach(() => {
    db.prepare('DELETE FROM session_buckets').run();
    db.prepare("UPDATE session SET session_id = NULL WHERE id = 'default'").run();
    resetSessionOwnershipGenerationForTest();
});

const key = (cli: string, scope: string, native = false) => runtimeSessionBucket(
    resolveScopedSessionBucket(cli, 'fixture', null, scope, '', 'fallback', false), native ? 'native' : 'print');
const sid = (bucket: string) => (getSessionBucket.get(bucket) as { session_id?: string } | undefined)?.session_id;
function input(scope = 'default', cli = 'cursor'): SessionPersistenceInput {
    return { cli, model: 'fixture', effort: '', scopeKey: scope,
        persistenceOwner: getSessionOwnershipGeneration(scope), sessionId: 'P', code: 0, scopedBucket: key(cli, scope) };
}

test('print/native/print reads P/N/P while native writes never replace singleton P', () => {
    assert.equal(persistMainSession(input()), true);
    const native = { ...input(), runtimeTransport: 'native' as const, sessionId: 'N', scopedBucket: key('cursor', 'default', true) };
    assert.equal(persistMainSession(native), true);
    assert.deepEqual([sid(key('cursor', 'default')), sid(native.scopedBucket), sid(key('cursor', 'default'))], ['P', 'N', 'P']);
    assert.equal((getSession() as { session_id: string }).session_id, 'P');
});

test('native writes require a native scoped key and cannot fall back into print', () => {
    assert.equal(persistMainSession(input()), true);
    for (const scopedBucket of [undefined, '', 'cursor', 'cursor:scope']) {
        const candidate = { ...input(), runtimeTransport: 'native' as const, sessionId: 'must-not-save', scopedBucket };
        assert.equal(persistMainSession(candidate), false);
    }
    assert.equal(sid('cursor'), 'P');
    assert.equal((getSession() as { session_id: string }).session_id, 'P');
});

test('a native-prefixed key without native selection cannot overwrite singleton through legacy defaults', () => {
    const candidate = { ...input(), scopedBucket: key('cursor', 'default', true), sessionId: 'N' };
    assert.equal(persistMainSession(candidate), false);
    assert.equal(persistMainSession({ ...candidate, runtimeTransport: 'print' }), false);
    assert.equal(sid(candidate.scopedBucket), undefined);
});

test('native prefix alone cannot authorize a different provider or scope bucket', () => {
    const owner = { ...input('local:a'), runtimeTransport: 'native' as const, sessionId: 'N' };
    for (const scopedBucket of ['native-v1:', key('grok', 'local:a', true), key('cursor', 'local:a:b', true), key('cursor', 'default', true)]) {
        assert.equal(persistMainSession({ ...owner, scopedBucket }), false);
        assert.equal(sid(scopedBucket), undefined);
    }
});

test('native scope ownership remains exact and stale owners cannot repersist', () => {
    const a = { ...input('local:a'), runtimeTransport: 'native' as const, scopedBucket: key('cursor', 'local:a', true), sessionId: 'A' };
    const b = { ...input('local:a:b'), runtimeTransport: 'native' as const, scopedBucket: key('cursor', 'local:a:b', true), sessionId: 'B' };
    assert.equal(persistMainSession(a), true); assert.equal(persistMainSession(b), true);
    bumpScopeSessionGeneration('local:a');
    assert.equal(persistMainSession({ ...a, sessionId: 'stale' }), false);
    assert.equal(persistMainSession({ ...b, sessionId: 'B2' }), true);
    assert.equal(sid(a.scopedBucket), 'A'); assert.equal(sid(b.scopedBucket), 'B2');
});

test('builtin native runtimes retain their legacy bucket and singleton behavior', () => {
    for (const cli of ['codex-app', 'pi']) {
        const builtin = { ...input('default', cli), runtimeTransport: 'native' as const, sessionId: cli + '-session' };
        assert.equal(persistMainSession(builtin), true);
        assert.equal(sid(key(cli, 'default')), cli + '-session');
        assert.equal((getSession() as { session_id: string }).session_id, cli + '-session');
        assert.equal(persistMainSession({ ...builtin, scopedBucket: 'native-v1:' + cli }), false);
    }
});

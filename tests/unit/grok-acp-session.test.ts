import test from 'node:test';
import assert from 'node:assert/strict';
import { grokAcpArgs, grokAuthMethod } from '../../src/agent/runtime/acp/grok-options.ts';

test('only literal auto opts into Grok always-approve; every process is dedicated', () => {
    assert.deepEqual(grokAcpArgs('auto'), ['agent', '--no-leader', '--always-approve', 'stdio']);
    for (const permissions of ['safe', [], ['auto'], ['read', 'Bash'], ['  read  ', '']] as const) {
        assert.deepEqual(grokAcpArgs(permissions), ['--permission-mode', 'default', 'agent', '--no-leader', 'stdio']);
    }
    for (const invalid of [undefined, null, true, 'default', 'AUTO', [1], ['read;write']]) {
        assert.throws(() => grokAcpArgs(invalid), /invalid_native_permissions/);
    }
});

test('existing auth is explicitly selected from advertised methods without fallback', () => {
    const methods = [{ id: 'cached_token' }, { id: 'xai.api_key' }];
    assert.equal(grokAuthMethod({}, methods), 'cached_token');
    assert.equal(grokAuthMethod({ XAI_API_KEY: '   ' }, methods), 'cached_token');
    assert.equal(grokAuthMethod({ XAI_API_KEY: 'fixture-not-a-secret' }, methods), 'xai.api_key');
    assert.throws(() => grokAuthMethod({}, [{ id: 'xai.api_key' }]), /grok_existing_auth_unavailable/);
    assert.throws(() => grokAuthMethod({ XAI_API_KEY: 'fixture' }, [{ id: 'cached_token' }]), /grok_existing_auth_unavailable/);
    for (const malformed of [null, {}, [], [null], [{ id: 42 }]]) {
        assert.throws(() => grokAuthMethod({}, malformed));
    }
});

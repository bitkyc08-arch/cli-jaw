import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const serverSrc = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');

test('SOS-001: startup resets all active scoped orc_state rows', () => {
    assert.ok(serverSrc.includes('listActiveOrcStates'), 'server should enumerate active scoped states on startup');
    assert.ok(serverSrc.includes('resetState(row.id)'), 'server should reset each stale scope row');
});

test('SOS-002: snapshot endpoint includes scope', () => {
    assert.ok(serverSrc.includes("orc: { scope, state: getState(scope)"), 'snapshot should include scope');
});

test('SOS-003: WebSocket initial state includes scope', () => {
    assert.ok(serverSrc.includes("scope: webScope, ts: Date.now()"), 'WS initial orc_state should include scope');
});

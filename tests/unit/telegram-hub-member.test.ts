// P2b — hub-member outbound SSRF guard. resolveHubCallback must only ever return a
// loopback http origin so a misconfigured/hostile hubCallbackUrl cannot redirect agent
// output (and file paths) to an arbitrary host. See doc 05 (GPT Pro hubCallbackUrl SSRF).
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHubCallback } from '../../src/telegram/hub-callback.ts';

delete process.env['JAW_HUB_CALLBACK_URL']; // deterministic: undefined → fallback
const FALLBACK = 'http://127.0.0.1:24576';

test('resolveHubCallback: loopback http origins pass through (path/query stripped)', () => {
    assert.equal(resolveHubCallback('http://127.0.0.1:24576'), 'http://127.0.0.1:24576');
    assert.equal(resolveHubCallback('http://localhost:24576'), 'http://localhost:24576');
    assert.equal(resolveHubCallback('http://127.0.0.1:9999/ignored'), 'http://127.0.0.1:9999');
});

test('resolveHubCallback: SSRF guard → fallback for non-loopback / https / creds / garbage', () => {
    assert.equal(resolveHubCallback('http://evil.com:24576'), FALLBACK);
    assert.equal(resolveHubCallback('http://10.0.0.5:24576'), FALLBACK);
    assert.equal(resolveHubCallback('https://127.0.0.1:24576'), FALLBACK); // https not allowed
    assert.equal(resolveHubCallback('http://user:pass@127.0.0.1:24576'), FALLBACK); // creds not allowed
    assert.equal(resolveHubCallback('not a url'), FALLBACK);
    assert.equal(resolveHubCallback(undefined), FALLBACK);
    assert.equal(resolveHubCallback(123), FALLBACK);
});

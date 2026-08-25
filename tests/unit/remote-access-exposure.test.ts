// #449: remote access exposed the bearer token and the secrets it protects.
//
// These are source-shape assertions on purpose. Reproducing them behaviourally
// needs a listening server on a non-loopback interface, which is an integration
// fixture and npm test does not run those. What can be checked here is that the
// guard exists on the route that lacked it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { isLoopbackAddress } from '../../src/http/loopback.ts';

const root = join(import.meta.dirname, '../..');
const read = (p: string) => fs.readFileSync(join(root, p), 'utf8');

test('SEC-449a: loopback detection accepts the IPv4-mapped form', () => {
    // A dual-stack listener reports 127.0.0.1 as ::ffff:127.0.0.1; missing that
    // would lock the local UI out of its own token.
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('192.168.1.50'), false);
    assert.equal(isLoopbackAddress('10.0.0.4'), false);
    assert.equal(isLoopbackAddress(''), false);
    assert.equal(isLoopbackAddress(undefined), false);
});

test('SEC-449b: the auth-token route refuses non-loopback callers', () => {
    const src = read('src/routes/system.ts');
    const route = src.slice(src.indexOf("'/api/auth/token'"));
    // Bounded by where the token is actually handed out, so the window cannot
    // accidentally exclude the guard it is meant to find.
    const respondIdx = route.indexOf('deps.jawAuthToken');
    assert.ok(respondIdx > -1, 'the route must still return the token somewhere');
    const beforeResponse = route.slice(0, respondIdx);
    assert.match(beforeResponse, /isLoopbackAddress/,
        'Sec-Fetch-Site is absent from curl, so it cannot be the only guard — '
        + 'the loopback check must run before the token is returned');
});

test('SEC-449c: settings and mcp reads are authenticated', () => {
    const src = read('src/routes/settings.ts');
    assert.match(src, /app\.get\('\/api\/settings', requireAuth/);
    assert.match(src, /app\.get\('\/api\/mcp', requireAuth/);
});

test('SEC-449d: channel bot tokens never leave through the settings read', () => {
    const src = read('src/routes/settings.ts');
    const fn = src.slice(src.indexOf('function redactRuntimeSettings'));
    assert.match(fn.slice(0, 2000), /MASKED_SECRET/,
        'only the Slack env case was masked; a file-configured token came back verbatim');
});

test('SEC-449e: env-provided channel tokens are stripped before the file is written', () => {
    const src = read('src/core/config.ts');
    const fn = src.slice(src.indexOf('function serializeSettingsForSave'));
    const body = fn.slice(0, 1200);
    for (const key of ['TELEGRAM_TOKEN', 'DISCORD_TOKEN']) {
        assert.match(body, new RegExp(key),
            `${key} must be stripped like the Slack keys already are`);
    }
});

test('SEC-449f: conversation and memory reads are authenticated', () => {
    const messages = read('src/routes/messages.ts');
    const memory = read('src/routes/memory.ts');
    assert.match(messages, /app\.get\('\/api\/messages', requireAuth/);
    assert.match(messages, /app\.get\('\/api\/messages\/search', requireAuth/);
    assert.match(memory, /app\.get\('\/api\/memory', requireAuth/);
    assert.match(memory, /app\.get\('\/api\/memory-file', requireAuth/);
});

test('SEC-449g: health stays public — the guard must not break liveness checks', () => {
    const src = read('src/routes/system.ts');
    const route = src.slice(src.indexOf("'/api/health'"), src.indexOf("'/api/health'") + 200);
    assert.doesNotMatch(route, /requireAuth/,
        'a monitor must be able to poll health without a bearer');
});

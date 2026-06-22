import { readSource } from './source-normalize.js';
// Auth bypass contract — issue #108
// Verifies that requireAuth in server.ts allows loopback + (lanBypass && isPrivateIP).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '../..');
const serverSrc = readSource(join(projectRoot, 'server.ts'), 'utf8');

test('AB-001: requireAuth uses isLoopback || isLanBypass branch', () => {
    const fnStart = serverSrc.indexOf('function requireAuth(');
    assert.ok(fnStart >= 0, 'requireAuth should exist in server.ts');
    const fnEnd = serverSrc.indexOf('\n}\n', fnStart);
    const fnBody = serverSrc.slice(fnStart, fnEnd);

    assert.ok(fnBody.includes('remoteIp'), 'requireAuth must use remoteIp (not hostname)');
    assert.ok(fnBody.includes('req.ip'), 'requireAuth must read req.ip');
    assert.ok(fnBody.includes('::ffff:127.0.0.1'), 'must handle IPv4-mapped loopback');
    assert.ok(fnBody.includes('isLoopback'), 'requireAuth must define isLoopback');
    assert.ok(fnBody.includes('isLanBypass'), 'requireAuth must define isLanBypass');
    assert.ok(fnBody.includes('lanAllowed()'), 'isLanBypass must gate on lanAllowed()');
    assert.ok(fnBody.includes('isPrivateIP'), 'isLanBypass must call isPrivateIP');
    assert.ok(/if\s*\(\s*isLoopback\s*\|\|\s*isLanBypass\s*\)/.test(fnBody),
        'requireAuth must short-circuit on isLoopback || isLanBypass');
});

test('AB-002: CORS + Host middlewares use predicate (not Set.has)', () => {
    assert.ok(!serverSrc.includes('ALLOWED_HOSTS.has'),
        'ALLOWED_HOSTS.has() should be removed');
    assert.ok(!serverSrc.includes('ALLOWED_ORIGINS.has'),
        'ALLOWED_ORIGINS.has() should be removed');
    assert.ok(serverSrc.includes('isAllowedHost('),
        'Host middleware must call isAllowedHost()');
    assert.ok(serverSrc.includes('isAllowedOrigin('),
        'CORS middleware must call isAllowedOrigin()');
});

test('AB-003: worker server.ts serves no WebSocket — HTTP middleware owns host/origin checks (X-01)', () => {
    // devlog 260609, 50: the WS server (and its verifyClient) was removed.
    // SSE rides plain HTTP, so the AB-002 middleware guards cover it.
    assert.equal(serverSrc.includes('WebSocketServer'), false, 'X-01: no WebSocketServer in server.ts');
    assert.equal(serverSrc.includes('verifyClient:'), false, 'X-01: WS verifyClient must be gone');
});

test('AB-004: lanAllowed() reads lanMode OR settings.network.lanBypass', () => {
    const lan = serverSrc.indexOf('const lanAllowed');
    assert.ok(lan >= 0, 'lanAllowed should be defined');
    const line = serverSrc.slice(lan, lan + 150);
    assert.ok(line.includes('settings.network?.lanBypass') || line.includes('settings["network"]?.lanBypass'),
        'lanAllowed must read settings.network.lanBypass');
    assert.ok(line.includes('lanMode'),
        'lanAllowed must include lanMode override');
});

test('AB-005: listen bind uses lanMode or settings.network.bindHost', () => {
    const listenIdx = serverSrc.indexOf('server.listen(PORT,');
    assert.ok(listenIdx >= 0, 'server.listen should exist');
    const block = serverSrc.slice(listenIdx - 1500, listenIdx + 100);
    assert.ok(block.includes('settings.network?.bindHost') || block.includes('settings["network"]?.bindHost'),
        'bind host must read settings.network.bindHost');
    assert.ok(block.includes('lanMode'),
        'bind host must consider lanMode override');
    assert.ok(block.includes('remoteMode'),
        'bind host must consider remoteMode for upgrade');
    assert.ok(!/server\.listen\(PORT,\s*['"]127\.0\.0\.1['"]/.test(serverSrc),
        'server.listen must not hardcode 127.0.0.1 anymore');
});

test('AB-006: 403 responses include LAN hint', () => {
    assert.ok(serverSrc.includes('LAN_HINT'),
        'LAN_HINT constant should be defined for 403 body hint');
    assert.ok(/settings\.network\.bindHost.*lanBypass/.test(serverSrc),
        'LAN_HINT should reference both bindHost and lanBypass');
});

test('AB-007: settings.network defaults include bindHost + lanBypass', () => {
    const configSrc = readSource(join(projectRoot, 'src/core/config.ts'), 'utf8');
    assert.ok(configSrc.includes("bindHost: '127.0.0.1'"),
        'createDefaultSettings must set network.bindHost default');
    assert.ok(/lanBypass:\s*false/.test(configSrc),
        'createDefaultSettings must set network.lanBypass=false default');
    assert.ok(configSrc.includes('network: { ...defaults.network, ...(raw.network || {}) }'),
        'loadSettings must deep-merge the network block');
});

test('AB-008: settings-merge includes network in nested merge list', () => {
    const mergeSrc = readSource(join(projectRoot, 'src/core/settings-merge.ts'), 'utf8');
    const arrayIdx = mergeSrc.indexOf("['heartbeat', 'telegram'");
    assert.ok(arrayIdx >= 0, 'nested merge array should exist');
    const arrayLine = mergeSrc.slice(arrayIdx, mergeSrc.indexOf(']', arrayIdx) + 1);
    assert.ok(arrayLine.includes("'network'"),
        'settings-merge nested array must include network');
});

// ─── Security Hardening (PR#2) ─────────────────────────

test('SC-001: requireAuth preserves loopback/LAN bypass', () => {
    const fnStart = serverSrc.indexOf('function requireAuth(');
    const fnEnd = serverSrc.indexOf('\n}\n', fnStart);
    const fnBody = serverSrc.slice(fnStart, fnEnd);
    assert.ok(/isLoopback\s*\|\|\s*isLanBypass/.test(fnBody),
        'requireAuth must short-circuit on isLoopback || isLanBypass');
});

test('SC-002: trust proxy only enabled with both trustProxies + trustForwardedFor', () => {
    assert.ok(serverSrc.includes("app.set('trust proxy'"),
        'server.ts must have trust proxy setting');
    assert.ok(serverSrc.includes('trustProxies') && serverSrc.includes('trustForwardedFor'),
        'trust proxy gate must check both flags');
});

test('SC-003: config defaults remoteAccess.requireAuth=true', () => {
    const configSrc = readSource(join(projectRoot, 'src/core/config.ts'), 'utf8');
    assert.ok(configSrc.includes('requireAuth: true'),
        'default remoteAccess.requireAuth must be true');
});

test('SC-004: server startup log includes curl example (token NOT hardcoded in output)', () => {
    assert.ok(serverSrc.includes('cat ~/.cli-jaw/token'),
        'startup log curl example must read token from file, not print raw token');
});

test('SC-005: bindHost upgrade respects non-loopback settings', () => {
    assert.ok(serverSrc.includes('isLoopbackBind'),
        'bindHost upgrade must check if current bind is loopback before overriding');
});

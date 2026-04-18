// Auth bypass contract — issue #108
// Verifies that requireAuth in server.ts allows loopback + (lanBypass && isPrivateIP).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '../..');
const serverSrc = fs.readFileSync(join(projectRoot, 'server.ts'), 'utf8');

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

test('AB-003: WebSocket verifyClient uses predicate', () => {
    const wssStart = serverSrc.indexOf('verifyClient:');
    assert.ok(wssStart >= 0, 'verifyClient should exist');
    const block = serverSrc.slice(wssStart, wssStart + 700);
    assert.ok(block.includes('isAllowedHost'), 'verifyClient must use isAllowedHost');
    assert.ok(block.includes('isAllowedOrigin'), 'verifyClient must use isAllowedOrigin');
});

test('AB-004: lanAllowed() reads lanMode OR settings.network.lanBypass', () => {
    const lan = serverSrc.indexOf('const lanAllowed');
    assert.ok(lan >= 0, 'lanAllowed should be defined');
    const line = serverSrc.slice(lan, lan + 150);
    assert.ok(line.includes('settings.network?.lanBypass'),
        'lanAllowed must read settings.network.lanBypass');
    assert.ok(line.includes('lanMode'),
        'lanAllowed must include lanMode override');
});

test('AB-005: listen bind uses lanMode or settings.network.bindHost', () => {
    const listenIdx = serverSrc.indexOf('server.listen(PORT,');
    assert.ok(listenIdx >= 0, 'server.listen should exist');
    const block = serverSrc.slice(listenIdx - 300, listenIdx + 100);
    assert.ok(block.includes('settings.network?.bindHost'),
        'bind host must read settings.network.bindHost');
    assert.ok(block.includes('lanMode'),
        'bind host must consider lanMode override');
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
    const configSrc = fs.readFileSync(join(projectRoot, 'src/core/config.ts'), 'utf8');
    assert.ok(configSrc.includes("bindHost: '127.0.0.1'"),
        'createDefaultSettings must set network.bindHost default');
    assert.ok(/lanBypass:\s*false/.test(configSrc),
        'createDefaultSettings must set network.lanBypass=false default');
    assert.ok(configSrc.includes('network: { ...defaults.network, ...(raw.network || {}) }'),
        'loadSettings must deep-merge the network block');
});

test('AB-008: settings-merge includes network in nested merge list', () => {
    const mergeSrc = fs.readFileSync(join(projectRoot, 'src/core/settings-merge.ts'), 'utf8');
    const arrayIdx = mergeSrc.indexOf("['heartbeat', 'telegram'");
    assert.ok(arrayIdx >= 0, 'nested merge array should exist');
    const arrayLine = mergeSrc.slice(arrayIdx, mergeSrc.indexOf(']', arrayIdx) + 1);
    assert.ok(arrayLine.includes("'network'"),
        'settings-merge nested array must include network');
});

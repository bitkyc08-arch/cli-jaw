// Network ACL unit tests — issue #108
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isPrivateIP,
    isAllowedHost,
    isAllowedOrigin,
    originMatchesHost,
    extractHost,
} from '../../src/security/network-acl.ts';

// ─── isPrivateIP ─────────────────────────────

test('NA-001: isPrivateIP recognises RFC 1918 v4 ranges', () => {
    for (const ip of [
        '10.0.0.1', '10.255.255.255',
        '172.16.0.1', '172.31.255.255',
        '192.168.0.1', '192.168.255.254',
    ]) {
        assert.equal(isPrivateIP(ip), true, ip);
    }
});

test('NA-002: isPrivateIP rejects public v4', () => {
    for (const ip of ['8.8.8.8', '172.32.0.1', '192.169.0.1', '11.0.0.1', '1.1.1.1']) {
        assert.equal(isPrivateIP(ip), false, ip);
    }
});

test('NA-003: isPrivateIP handles link-local + ULA + mapped', () => {
    assert.equal(isPrivateIP('169.254.1.5'), true);
    assert.equal(isPrivateIP('fe80::1'), true);
    assert.equal(isPrivateIP('febf::1'), true);
    assert.equal(isPrivateIP('fd00::beef'), true);
    assert.equal(isPrivateIP('fc00::1'), true);
    assert.equal(isPrivateIP('::ffff:192.168.1.42'), true);
    assert.equal(isPrivateIP('::ffff:8.8.8.8'), false);
});

test('NA-004: isPrivateIP rejects malformed + empty', () => {
    for (const s of ['', null, undefined, 'not-an-ip', '256.256.256.256', '1.2.3']) {
        assert.equal(isPrivateIP(s as any), false);
    }
});

test('NA-004b: isPrivateIP handles loopback explicitly', () => {
    assert.equal(isPrivateIP('127.0.0.1'), true);
    assert.equal(isPrivateIP('::1'), true);
});

// ─── isAllowedHost ─────────────────────────────

test('NA-005: isAllowedHost allows loopback regardless of lanAllowed', () => {
    for (const h of ['localhost', '127.0.0.1', '127.0.0.1:3457', '[::1]:3457']) {
        assert.equal(isAllowedHost(h, false), true, h);
    }
});

test('NA-006: isAllowedHost allows LAN only when lanAllowed=true', () => {
    assert.equal(isAllowedHost('192.168.1.42:3457', false), false);
    assert.equal(isAllowedHost('192.168.1.42:3457', true), true);
    assert.equal(isAllowedHost('10.0.0.5:3457', true), true);
    assert.equal(isAllowedHost('8.8.8.8:3457', true), false);
});

test('NA-006b: isAllowedHost rejects empty Host header', () => {
    assert.equal(isAllowedHost('', true), false);
    assert.equal(isAllowedHost(undefined, true), false);
});

// ─── isAllowedOrigin ─────────────────────────────

test('NA-007: isAllowedOrigin rejects arbitrary external domains', () => {
    assert.equal(isAllowedOrigin('http://evil.com', '192.168.1.42:3457', true), false);
    assert.equal(isAllowedOrigin('http://attacker.example.com', 'localhost:3457', true), false);
});

test('NA-008: isAllowedOrigin DNS-rebinding — Origin host must match Host header', () => {
    // Attacker: evil.com → 192.168.1.42 → browser sends Origin=evil.com, Host=192.168.1.42
    assert.equal(isAllowedOrigin('http://evil.com', '192.168.1.42:3457', true), false);
    // Legit: Origin and Host match
    assert.equal(isAllowedOrigin('http://192.168.1.42:3457', '192.168.1.42:3457', true), true);
});

test('NA-008b: isAllowedOrigin rejects port mismatch', () => {
    assert.equal(isAllowedOrigin('http://192.168.1.42:9999', '192.168.1.42:3457', true), false);
});

test('NA-008c: isAllowedOrigin handles IPv6 brackets on both sides', () => {
    assert.equal(isAllowedOrigin('http://[fe80::1]:3457', '[fe80::1]:3457', true), true);
});

test('NA-009: isAllowedOrigin localhost passes without rebinding check', () => {
    assert.equal(isAllowedOrigin('http://localhost:3457', 'localhost:3457', false), true);
    assert.equal(isAllowedOrigin('http://127.0.0.1:3457', '127.0.0.1:3457', false), true);
});

test('NA-009b: isAllowedOrigin with no Origin header returns true (same-origin/CLI)', () => {
    assert.equal(isAllowedOrigin(undefined, 'localhost:3457', false), true);
    assert.equal(isAllowedOrigin('', 'localhost:3457', false), true);
});

test('NA-009c: isAllowedOrigin rejects non-http(s) protocols', () => {
    assert.equal(isAllowedOrigin('file:///etc/passwd', 'localhost:3457', true), false);
    assert.equal(isAllowedOrigin('javascript:alert(1)', 'localhost:3457', true), false);
});

test('NA-009d: isAllowedOrigin LAN requires lanAllowed=true', () => {
    assert.equal(isAllowedOrigin('http://192.168.1.42:3457', '192.168.1.42:3457', false), false);
    assert.equal(isAllowedOrigin('http://192.168.1.42:3457', '192.168.1.42:3457', true), true);
});

// ─── originMatchesHost ─────────────────────────────

test('NA-010: originMatchesHost matches host + port', () => {
    assert.equal(originMatchesHost('http://192.168.1.42:3457', '192.168.1.42:3457'), true);
    assert.equal(originMatchesHost('http://192.168.1.42:3457', '192.168.1.42:9999'), false);
    assert.equal(originMatchesHost('http://192.168.1.42:3457', '10.0.0.5:3457'), false);
});

test('NA-010b: originMatchesHost normalizes IPv6 brackets', () => {
    assert.equal(originMatchesHost('http://[fe80::1]:3457', '[fe80::1]:3457'), true);
    assert.equal(originMatchesHost('http://[::1]:3457', '[::1]:3457'), true);
});

test('NA-010c: originMatchesHost defaults Origin port 80 for http', () => {
    assert.equal(originMatchesHost('http://192.168.1.42', '192.168.1.42:80'), true);
    assert.equal(originMatchesHost('http://192.168.1.42', '192.168.1.42'), true);
});

// ─── extractHost ─────────────────────────────

test('NA-011: extractHost strips port for IPv4 and hostname', () => {
    assert.equal(extractHost('192.168.1.42:3457'), '192.168.1.42');
    assert.equal(extractHost('localhost:3457'), 'localhost');
    assert.equal(extractHost('127.0.0.1'), '127.0.0.1');
});

test('NA-011b: extractHost handles IPv6 bracket form', () => {
    assert.equal(extractHost('[::1]:3457'), '::1');
    assert.equal(extractHost('[fe80::1]:3457'), 'fe80::1');
});

test('NA-011c: extractHost returns null for empty', () => {
    assert.equal(extractHost(''), null);
    assert.equal(extractHost(undefined), null);
});

// ─── Tailscale (Issue #119) ─────────────────────────

test('TS-001: 100.64.0.1 is private (Tailscale CGNAT)', () => {
    assert.equal(isPrivateIP('100.64.0.1'), true);
});

test('TS-002: 100.127.255.254 is private (upper CGNAT bound)', () => {
    assert.equal(isPrivateIP('100.127.255.254'), true);
});

test('TS-003: 100.63.255.255 is NOT private (below CGNAT)', () => {
    assert.equal(isPrivateIP('100.63.255.255'), false);
});

test('TS-004: 100.128.0.0 is NOT private (above CGNAT)', () => {
    assert.equal(isPrivateIP('100.128.0.0'), false);
});

test('TS-005: fd7a:115c:a1e0::1 is private (Tailscale ULA)', () => {
    assert.equal(isPrivateIP('fd7a:115c:a1e0::1'), true);
});

test('TS-006: ::ffff:100.64.1.1 is private (mapped-v6 CGNAT)', () => {
    assert.equal(isPrivateIP('::ffff:100.64.1.1'), true);
});

test('TS-007: *.ts.net host passes with lanAllowed=true', () => {
    assert.equal(isAllowedHost('server.tail-fe8c.ts.net:3457', true), true);
});

test('TS-008: *.ts.net host blocked with lanAllowed=false', () => {
    assert.equal(isAllowedHost('server.tail-fe8c.ts.net:3457', false), false);
});

test('TS-009: 100.64.1.1 host passes with lanAllowed=true', () => {
    assert.equal(isAllowedHost('100.64.1.1:3457', true), true);
});

test('TS-010: *.ts.net origin passes with matching host', () => {
    assert.equal(
        isAllowedOrigin('http://foo.ts.net:3457', 'foo.ts.net:3457', true),
        true,
    );
});

test('TS-011: 100.x origin passes with matching host', () => {
    assert.equal(
        isAllowedOrigin('http://100.64.1.1:3457', '100.64.1.1:3457', true),
        true,
    );
});

test('TS-012: *.ts.net origin blocked when Host mismatches (rebinding guard)', () => {
    assert.equal(
        isAllowedOrigin('http://evil.ts.net:3457', 'foo.ts.net:3457', true),
        false,
    );
});

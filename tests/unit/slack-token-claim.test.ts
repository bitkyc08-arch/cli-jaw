import test from 'node:test';
import assert from 'node:assert/strict';
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
    SLACK_TOKEN_CLAIM_FRESH_MS,
    acquireSlackTokenClaim,
    inspectSlackTokenClaim,
    slackTokenClaimPath,
    type SlackTokenClaim,
} from '../../src/slack/token-claim.ts';

function fixture() {
    const base = mkdtempSync(join(tmpdir(), 'jaw-slack-claim-'));
    const rootDir = join(base, 'claims');
    const homeA = join(base, 'home-a');
    const homeB = join(base, 'home-b');
    mkdirSync(homeA);
    mkdirSync(homeB);
    return { base, rootDir, homeA, homeB, token: 'xapp-test-shared' };
}

function stored(f: ReturnType<typeof fixture>): SlackTokenClaim {
    return JSON.parse(readFileSync(slackTokenClaimPath(f.token, f.rootDir), 'utf8')) as SlackTokenClaim;
}

function writeClaim(f: ReturnType<typeof fixture>, claim: Partial<SlackTokenClaim> = {}): void {
    const path = slackTokenClaimPath(f.token, f.rootDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
        version: 1,
        claimId: 'a'.repeat(32),
        home: f.homeA,
        port: '3457',
        pid: process.pid,
        claimedAt: new Date().toISOString(),
        connected: true,
        ...claim,
    }));
}

test('1: acquire writes connectivity and private modes', t => {
    const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
    const result = acquireSlackTokenClaim({ appToken: f.token, home: f.homeA, port: '3457', connected: false, rootDir: f.rootDir });
    assert.equal(result.kind, 'acquired');
    assert.equal(stored(f).connected, false);
    assert.equal(statSync(f.rootDir).mode & 0o777, 0o700);
    assert.equal(statSync(slackTokenClaimPath(f.token, f.rootDir)).mode & 0o777, 0o600);
    if (result.kind === 'acquired') result.lease.release();
});

test('2: same-home fresh live claim is adopted without replacement', t => {
    const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
    writeClaim(f);
    const result = acquireSlackTokenClaim({ appToken: f.token, home: f.homeA, port: '3458', connected: true, rootDir: f.rootDir });
    assert.equal(result.kind, 'same_home');
    assert.equal(stored(f).claimId, 'a'.repeat(32));
});

test('3-4: only a connected foreign live claim blocks', t => {
    const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
    writeClaim(f, { connected: true });
    assert.equal(inspectSlackTokenClaim({ appToken: f.token, home: f.homeB, port: '3458', connected: true, rootDir: f.rootDir }).kind, 'foreign_live');
    writeClaim(f, { connected: false });
    assert.equal(inspectSlackTokenClaim({ appToken: f.token, home: f.homeB, port: '3458', connected: true, rootDir: f.rootDir }).kind, 'none');
});

test('5: stale foreign claim is replaced', t => {
    const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
    writeClaim(f, { claimedAt: new Date(Date.now() - SLACK_TOKEN_CLAIM_FRESH_MS - 1).toISOString() });
    const result = acquireSlackTokenClaim({ appToken: f.token, home: f.homeB, port: '3458', connected: true, rootDir: f.rootDir });
    assert.equal(result.kind, 'acquired');
    assert.equal(stored(f).home, realpathSync.native(f.homeB));
    if (result.kind === 'acquired') result.lease.release();
});

test('6-7: dead or EPERM-like unverifiable pid evidence does not block replacement', t => {
    const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
    writeClaim(f);
    for (const pidAlive of [() => false, () => false]) {
        const result = acquireSlackTokenClaim({ appToken: f.token, home: f.homeB, port: '3458', connected: true, rootDir: f.rootDir, pidAlive });
        assert.equal(result.kind, 'acquired');
        if (result.kind === 'acquired') result.lease.release();
        writeClaim(f);
    }
});

test('8: throwing pid probe is uncertain and acquire remains unavailable rather than refusing', t => {
    const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
    writeClaim(f);
    const pidAlive = () => { throw new Error('probe uncertain'); };
    assert.equal(inspectSlackTokenClaim({ appToken: f.token, home: f.homeB, port: '3458', connected: true, rootDir: f.rootDir, pidAlive }).kind, 'uncertain');
    assert.equal(acquireSlackTokenClaim({ appToken: f.token, home: f.homeB, port: '3458', connected: true, rootDir: f.rootDir, pidAlive }).kind, 'unavailable');
});

test('9: malformed and wrong-version claim data is ignored', t => {
    const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
    const path = slackTokenClaimPath(f.token, f.rootDir); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{bad');
    assert.equal(inspectSlackTokenClaim({ appToken: f.token, home: f.homeB, port: '', connected: true, rootDir: f.rootDir }).kind, 'none');
    writeFileSync(path, JSON.stringify({ version: 2 }));
    assert.equal(inspectSlackTokenClaim({ appToken: f.token, home: f.homeB, port: '', connected: true, rootDir: f.rootDir }).kind, 'none');
});

test('10: realpath uncertainty is reported by inspect and acquire fails open by replacing', t => {
    const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
    writeClaim(f); rmSync(f.homeA, { recursive: true });
    assert.equal(inspectSlackTokenClaim({ appToken: f.token, home: f.homeB, port: '', connected: true, rootDir: f.rootDir }).kind, 'uncertain');
    const result = acquireSlackTokenClaim({ appToken: f.token, home: f.homeB, port: '3458', connected: true, rootDir: f.rootDir });
    assert.equal(result.kind, 'acquired');
    if (result.kind === 'acquired') result.lease.release();
});

test('11: root creation failure is unavailable', t => {
    const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
    const occupied = join(f.base, 'occupied'); writeFileSync(occupied, 'x');
    const result = acquireSlackTokenClaim({ appToken: f.token, home: f.homeA, port: '', connected: true, rootDir: join(occupied, 'claims') });
    assert.equal(result.kind, 'unavailable');
});

test('12: lock contention falls through to final inspection and stays fail-open', t => {
    const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
    writeClaim(f, { connected: false });
    writeFileSync(`${slackTokenClaimPath(f.token, f.rootDir)}.lock`, 'busy');
    const result = acquireSlackTokenClaim({ appToken: f.token, home: f.homeB, port: '', connected: true, rootDir: f.rootDir });
    assert.equal(result.kind, 'unavailable');
});

test('13: refresh pauses while disconnected and resumes when connected', async t => {
    const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
    let tick = 0;
    const now = () => new Date(1_700_000_000_000 + tick++ * 1000);
    const result = acquireSlackTokenClaim({ appToken: f.token, home: f.homeA, port: '', connected: false, rootDir: f.rootDir, now, refreshMs: 10 });
    assert.equal(result.kind, 'acquired');
    const before = stored(f).claimedAt;
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(stored(f).claimedAt, before);
    if (result.kind === 'acquired') result.lease.markConnected();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.notEqual(stored(f).claimedAt, before);
    if (result.kind === 'acquired') result.lease.release();
});

test('14: refresh IO failure is swallowed', async t => {
    const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
    const result = acquireSlackTokenClaim({ appToken: f.token, home: f.homeA, port: '', connected: true, rootDir: f.rootDir, refreshMs: 5 });
    assert.equal(result.kind, 'acquired');
    writeFileSync(`${slackTokenClaimPath(f.token, f.rootDir)}.lock`, 'busy');
    await new Promise(resolve => setTimeout(resolve, 15));
    if (result.kind === 'acquired') assert.doesNotThrow(() => result.lease.markConnected());
});

test('15: release removes only its own claim id and is idempotent', t => {
    const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
    const result = acquireSlackTokenClaim({ appToken: f.token, home: f.homeA, port: '', connected: true, rootDir: f.rootDir });
    assert.equal(result.kind, 'acquired');
    writeClaim(f, { claimId: 'b'.repeat(32), home: f.homeB });
    if (result.kind === 'acquired') { result.lease.release(); result.lease.release(); }
    assert.equal(stored(f).claimId, 'b'.repeat(32));
});

test('16: release IO failure is swallowed', t => {
    const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
    const result = acquireSlackTokenClaim({ appToken: f.token, home: f.homeA, port: '', connected: true, rootDir: f.rootDir });
    assert.equal(result.kind, 'acquired');
    writeFileSync(`${slackTokenClaimPath(f.token, f.rootDir)}.lock`, 'busy');
    if (result.kind === 'acquired') assert.doesNotThrow(() => result.lease.release());
});

test('17: pid reuse only blocks within the freshness window', t => {
    const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
    writeClaim(f, { claimedAt: new Date(Date.now() - SLACK_TOKEN_CLAIM_FRESH_MS - 1).toISOString(), pid: process.pid });
    const result = acquireSlackTokenClaim({ appToken: f.token, home: f.homeB, port: '', connected: true, rootDir: f.rootDir, pidAlive: () => true });
    assert.equal(result.kind, 'acquired');
    if (result.kind === 'acquired') result.lease.release();
});

test('l: a non-blocking home loses safely when another home connects first', t => {
    const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
    const a = acquireSlackTokenClaim({ appToken: f.token, home: f.homeA, port: '3457', connected: false, rootDir: f.rootDir });
    assert.equal(a.kind, 'acquired');
    const b = acquireSlackTokenClaim({ appToken: f.token, home: f.homeB, port: '3458', connected: true, rootDir: f.rootDir });
    assert.equal(b.kind, 'acquired');
    if (a.kind === 'acquired') a.lease.markConnected();
    assert.equal(inspectSlackTokenClaim({ appToken: f.token, home: f.homeA, port: '3457', connected: true, rootDir: f.rootDir }).kind, 'foreign_live');
    assert.equal(stored(f).home, realpathSync.native(f.homeB));
    if (a.kind === 'acquired') a.lease.release();
    assert.equal(stored(f).home, realpathSync.native(f.homeB));
    if (b.kind === 'acquired') b.lease.release();
});

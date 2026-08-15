import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    launchFingerprint, ensureInstanceIdentity, parseIdentity,
    checkHealthOwnership, generateInstanceId,
} from '../../src/core/instance-identity.ts';

function fakeDeps(files: Record<string, string>, ids: string[] = ['a'.repeat(32)]) {
    let next = 0;
    return {
        files,
        deps: {
            readFile: (p: string) => {
                if (!(p in files)) throw new Error('ENOENT');
                return files[p]!;
            },
            createExclusive: (p: string, contents: string) => {
                if (p in files) throw new Error('EEXIST');
                files[p] = contents;
            },
            now: () => new Date('2026-08-15T00:00:00.000Z'),
            randomId: () => ids[Math.min(next++, ids.length - 1)]!,
        },
    };
}

test('II-001: the fingerprint separates the same executable with different arguments', () => {
    const a = launchFingerprint('C:\\home', 3457, 'node.exe', ['serve', '--port', '3457']);
    const b = launchFingerprint('C:\\home', 3457, 'node.exe', ['serve', '--port', '3458']);
    // Hashing only (home, port, argv0) would collide here, and a foreign command line
    // would then pass ownership verification.
    assert.notEqual(a, b);
});

test('II-002: length framing prevents component-boundary collisions', () => {
    // Without framing, ['a','bc'] and ['ab','c'] concatenate identically.
    const a = launchFingerprint('a', 1, 'x', ['a', 'bc']);
    const b = launchFingerprint('a', 1, 'x', ['ab', 'c']);
    assert.notEqual(a, b);
    const c = launchFingerprint('ab', 1, 'x', []);
    const d = launchFingerprint('a', 1, 'bx', []);
    assert.notEqual(c, d);
});

test('II-003: home and port both participate in identity', () => {
    const base = launchFingerprint('C:\\home', 3457, 'node.exe', ['serve']);
    assert.notEqual(base, launchFingerprint('C:\\other', 3457, 'node.exe', ['serve']));
    assert.notEqual(base, launchFingerprint('C:\\home', 3458, 'node.exe', ['serve']));
    // Same inputs must be stable, or ownership checks would fail randomly.
    assert.equal(base, launchFingerprint('C:\\home', 3457, 'node.exe', ['serve']));
});

test('II-004: a generated id is 128 random bits, not a digest of the home path', () => {
    const a = generateInstanceId();
    const b = generateInstanceId();
    assert.match(a, /^[0-9a-f]{32}$/);
    // Distinctness matters: a digest of (home, port) would be identical across runs
    // and enumerable offline from an unauthenticated health endpoint.
    assert.notEqual(a, b);
});

test('II-005: ensureInstanceIdentity creates once, then loads', () => {
    const { files, deps } = fakeDeps({});
    const first = ensureInstanceIdentity('C:\\home\\instance-id.json', deps);
    assert.match(first.id, /^[0-9a-f]{32}$/);
    assert.ok('C:\\home\\instance-id.json' in files);
    const second = ensureInstanceIdentity('C:\\home\\instance-id.json', deps);
    assert.equal(second.id, first.id, 'a second call must LOAD, never regenerate');
});

test('II-006: a concurrent create race leaves exactly one id and both agree', () => {
    // The loser must adopt the winner's value. Returning its own intended id would
    // leave two actors disagreeing about which instance they own.
    const files: Record<string, string> = {};
    const winnerId = 'b'.repeat(32);
    const loserId = 'c'.repeat(32);
    const path = 'C:\\home\\instance-id.json';

    const winner = ensureInstanceIdentity(path, {
        readFile: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]!; },
        createExclusive: (p, c) => { if (p in files) throw new Error('EEXIST'); files[p] = c; },
        now: () => new Date('2026-08-15T00:00:00.000Z'),
        randomId: () => winnerId,
    });
    const loser = ensureInstanceIdentity(path, {
        readFile: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]!; },
        createExclusive: () => { throw new Error('EEXIST'); },
        now: () => new Date('2026-08-15T00:00:00.000Z'),
        randomId: () => loserId,
    });
    assert.equal(winner.id, winnerId);
    assert.equal(loser.id, winnerId, 'the loser must adopt the id it READ');
    assert.equal(Object.keys(files).length, 1);
});

test('II-007: a corrupt identity file is not silently accepted', () => {
    for (const bad of [
        '', '{', 'null', '{"createdAt":"x"}',
        // Shape matters, not just type: a short, non-hex, or over-long id would be",
        // accepted by a bare typeof check and then compared against a health response.
        '{"id":"short","createdAt":"x"}',
        '{"id":"' + 'z'.repeat(32) + '","createdAt":"x"}',
        '{"id":"' + 'a'.repeat(31) + '","createdAt":"x"}',
        '{"id":"' + 'a'.repeat(33) + '","createdAt":"x"}',
        '{"id":"' + 'A'.repeat(32) + '","createdAt":"x"}',
        '{"id":12345,"createdAt":"x"}',
    ]) {
        assert.equal(parseIdentity(bad), null, `must reject: ${bad.slice(0, 24)}`);
    }
    // A well-formed record still parses.
    assert.deepEqual(
        parseIdentity('{"id":"' + 'a'.repeat(32) + '","createdAt":"2026-08-15T00:00:00.000Z"}'),
        { id: 'a'.repeat(32), createdAt: '2026-08-15T00:00:00.000Z' },
    );
});

test('II-008: a corrupt file that cannot be replaced raises rather than regenerating', () => {
    // Regenerating here would orphan the registration that references the old id.
    const files: Record<string, string> = { 'p': 'not json' };
    assert.throws(() => ensureInstanceIdentity('p', {
        readFile: (k) => files[k]!,
        createExclusive: () => { throw new Error('EEXIST'); },
        now: () => new Date(),
        randomId: () => 'd'.repeat(32),
    }), /unreadable or corrupt/);
});

test('II-009: health ownership distinguishes owned, conflict, and unverified', () => {
    const local = { id: 'e'.repeat(32), createdAt: '2026-08-15T00:00:00.000Z' };
    assert.equal(checkHealthOwnership(local, 3457, { id: local.id, port: 3457 }), 'owned');
    // A different instance answering our recorded port is a conflict, never healthy.
    assert.equal(checkHealthOwnership(local, 3457, { id: 'f'.repeat(32), port: 3457 }), 'conflict');
    assert.equal(checkHealthOwnership(local, 3457, { id: local.id, port: 9999 }), 'conflict');
    // Missing local identity must NOT read as owned; a reader may not regenerate.
    assert.equal(checkHealthOwnership(null, 3457, { id: local.id, port: 3457 }), 'unverified-identity');
    assert.equal(checkHealthOwnership(local, 3457, null), 'unverified-identity');
});

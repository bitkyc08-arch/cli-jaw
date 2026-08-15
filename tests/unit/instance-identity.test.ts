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

test('II-010: EVERY argument position participates in the fingerprint', () => {
    // Changing only the last arg let `args.slice(1)` survive. Vary each position.
    const base = ['serve', '--port', '3457', '--home', 'C:\\h'];
    const baseline = launchFingerprint('C:\\home', 3457, 'node.exe', base);
    for (let i = 0; i < base.length; i++) {
        const mutated = [...base];
        mutated[i] = `${mutated[i]}X`;
        assert.notEqual(launchFingerprint('C:\\home', 3457, 'node.exe', mutated), baseline,
            `argument ${i} must affect the fingerprint`);
    }
    // Dropping an argument entirely must also change it.
    assert.notEqual(launchFingerprint('C:\\home', 3457, 'node.exe', base.slice(1)), baseline);
});

test('II-011: no delimiter-injection collision is possible', () => {
    // A join on any separator collides when that separator appears in the data.
    for (const sep of ['|', ':', '\0', ',']) {
        assert.notEqual(
            launchFingerprint('h', 1, `x${sep}`, ['y']),
            launchFingerprint('h', 1, 'x', [`${sep}y`]),
            `a '${sep}' join would collide here`,
        );
    }
});

test('II-012: lone surrogates do not collide', () => {
    // UTF-8 encoding maps every unpaired surrogate to U+FFFD, so a utf8 digest makes
    // these identical. Windows paths and command lines are UTF-16, so this is a real
    // input domain, not a theoretical one.
    assert.notEqual(launchFingerprint('\uD800', 1, 'x'), launchFingerprint('\uD801', 1, 'x'));
    assert.notEqual(launchFingerprint('a\uDC00b', 1, 'x'), launchFingerprint('a\uDC01b', 1, 'x'));
    // Valid pairs still behave normally.
    assert.equal(launchFingerprint('😀', 1, 'x'), launchFingerprint('😀', 1, 'x'));
    assert.notEqual(launchFingerprint('😀', 1, 'x'), launchFingerprint('😁', 1, 'x'));
});

test('II-013: the whole home and port are hashed, not a fragment', () => {
    // `home.slice(-1)` and `port % 10` survived the original vectors.
    assert.notEqual(launchFingerprint('C:\\aaa', 1, 'x'), launchFingerprint('C:\\bba', 1, 'x'));
    assert.notEqual(launchFingerprint('C:\\h', 13457, 'x'), launchFingerprint('C:\\h', 23457, 'x'));
    assert.notEqual(launchFingerprint('C:\\h', 3457, 'x'), launchFingerprint('C:\\h', 13457, 'x'));
});

test('II-014: generated ids carry real entropy, not a counter', () => {
    // A padded incrementing counter is distinct and well-formed but has none.
    const ids = Array.from({ length: 64 }, () => generateInstanceId());
    assert.equal(new Set(ids).size, ids.length, 'ids must not repeat');
    // A counter's high nibbles are constant; random ones vary.
    assert.ok(new Set(ids.map(i => i.slice(0, 4))).size > 32, 'leading bits must vary');
    // And it must not be sequential.
    const asInts = ids.map(i => BigInt('0x' + i.slice(0, 8)));
    const ascending = asInts.every((v, i) => i === 0 || v > asInts[i - 1]!);
    assert.ok(!ascending, 'ids must not increment');
});

test('II-015: loading returns the persisted record intact, not just its id', () => {
    const { deps } = fakeDeps({});
    const created = ensureInstanceIdentity('p', deps);
    const loaded = ensureInstanceIdentity('p', deps);
    // Comparing only ids let a mutation swap createdAt on load.
    assert.deepEqual(loaded, created);
});

test('II-016: the WINNER also returns what was persisted', () => {
    // The original implementation returned its in-memory candidate unread, so a
    // create that stored something else went unnoticed.
    const files: Record<string, string> = {};
    const persisted = { id: 'b'.repeat(32), createdAt: '2026-01-01T00:00:00.000Z' };
    const result = ensureInstanceIdentity('p', {
        readFile: (k) => { if (!(k in files)) throw new Error('ENOENT'); return files[k]!; },
        // Simulates any layer that normalizes or rewrites on write.
        createExclusive: (k) => { files[k] = JSON.stringify(persisted); },
        now: () => new Date('2026-08-15T00:00:00.000Z'),
        randomId: () => 'a'.repeat(32),
    });
    assert.deepEqual(result, persisted, 'the winner must return the record on disk');
});

test('II-017: a valid id with a bad timestamp is rejected', () => {
    // Every earlier vector had a bad id, so createdAt validation was untested.
    const id = 'a'.repeat(32);
    for (const bad of ['x', '', 'yesterday', '2026-13-45T99:99:99Z', '1755216000']) {
        assert.equal(parseIdentity(JSON.stringify({ id, createdAt: bad })), null, `must reject ${bad}`);
    }
    assert.equal(parseIdentity(JSON.stringify({ id })), null, 'a missing timestamp is invalid');
    assert.ok(parseIdentity(JSON.stringify({ id, createdAt: '2026-08-15T00:00:00.000Z' })));
});

test('II-018: an empty identity file is repaired under a lock, not silently trusted', () => {
    // A crash between exclusive-create and write leaves exactly this state. Both
    // racers must not deadlock, and neither may invent an id while the other repairs.
    const files: Record<string, string> = { p: '' };
    const deps = {
        readFile: (k: string) => { if (!(k in files)) throw new Error('ENOENT'); return files[k]!; },
        createExclusive: (k: string, c: string) => { if (k in files) throw new Error('EEXIST'); files[k] = c; },
        now: () => new Date('2026-08-15T00:00:00.000Z'),
        randomId: () => 'c'.repeat(32),
        remove: (k: string) => { delete files[k]; },
    };
    const repaired = ensureInstanceIdentity('p', deps);
    assert.equal(repaired.id, 'c'.repeat(32));
    assert.ok(!('p.lock' in files), 'the repair lock must be released');
    // A second call now loads rather than repairing again.
    assert.deepEqual(ensureInstanceIdentity('p', deps), repaired);
});

test('II-019: a losing repairer WAITS and adopts the winner record', () => {
    // The old version asserted immediate failure, which codified the defect: a loser
    // that peeked once at the instant before the repairer finished failed permanently
    // on a file that was about to become valid.
    const winner = { id: '9'.repeat(32), createdAt: '2026-08-15T00:00:00.000Z' };
    const files: Record<string, string> = { p: 'corrupt', 'p.lock': new Date().toISOString() };
    let polls = 0;
    const result = ensureInstanceIdentity('p', {
        readFile: (k) => { if (!(k in files)) throw new Error('ENOENT'); return files[k]!; },
        createExclusive: (k) => { if (k in files) { const e: any = new Error('EEXIST'); e.code = 'EEXIST'; throw e; } files[k] = 'x'; },
        now: () => new Date(),
        randomId: () => 'd'.repeat(32),
        remove: (k) => { delete files[k]; },
        sleep: () => {
            // The other repairer finishes while we back off.
            if (++polls === 2) { files['p'] = JSON.stringify(winner); delete files['p.lock']; }
        },
    });
    assert.deepEqual(result, winner, 'must adopt the record the other repairer wrote');
    assert.notEqual(result.id, 'd'.repeat(32), 'must not mint its own id');
});

test('II-019b: a lock abandoned by a crashed holder is taken over', () => {
    // finally does not run when a process dies, so a lock with no owner must age out
    // or every later repair fails permanently.
    const files: Record<string, string> = {
        p: 'corrupt',
        'p.lock': new Date(Date.now() - 120_000).toISOString(),
    };
    const result = ensureInstanceIdentity('p', {
        readFile: (k) => { if (!(k in files)) throw new Error('ENOENT'); return files[k]!; },
        createExclusive: (k, c) => { if (k in files) { const e: any = new Error('EEXIST'); e.code = 'EEXIST'; throw e; } files[k] = c; },
        now: () => new Date(),
        randomId: () => 'e'.repeat(32),
        remove: (k) => { delete files[k]; },
        staleLockMs: 30_000,
        sleep: () => {},
    });
    assert.equal(result.id, 'e'.repeat(32), 'the stale lock must not block repair forever');
    assert.ok(!('p.lock' in files), 'the lock must be released');
});

test('II-019c: a creator that slips into the repair gap is adopted, not rejected', () => {
    // Between remove(path) and createExclusive(path) another ordinary caller can
    // create the identity. Their record is as valid as ours, so failing with EEXIST
    // would break 'every caller returns the id it read'.
    const theirs = { id: '7'.repeat(32), createdAt: '2026-08-15T00:00:00.000Z' };
    const files: Record<string, string> = { p: 'corrupt' };
    let removed = false;
    const result = ensureInstanceIdentity('p', {
        readFile: (k) => { if (!(k in files)) throw new Error('ENOENT'); return files[k]!; },
        createExclusive: (k, c) => {
            if (k === 'p' && removed) { files['p'] = JSON.stringify(theirs); const e: any = new Error('EEXIST'); e.code = 'EEXIST'; throw e; }
            if (k in files) { const e: any = new Error('EEXIST'); e.code = 'EEXIST'; throw e; }
            files[k] = c;
        },
        now: () => new Date(),
        randomId: () => '8'.repeat(32),
        remove: (k) => { if (k === 'p') removed = true; delete files[k]; },
        sleep: () => {},
    });
    assert.deepEqual(result, theirs, 'the interloper record must be adopted');
});

test('II-019d: a non-EEXIST failure keeps its cause instead of becoming contention', () => {
    // EACCES is a permissions problem, not a race. Routing it into repair reports a
    // misleading 'being repaired by another process'.
    assert.throws(() => ensureInstanceIdentity('p', {
        readFile: () => { throw new Error('ENOENT'); },
        createExclusive: () => { const e: any = new Error('permission denied'); e.code = 'EACCES'; throw e; },
        now: () => new Date(),
        randomId: () => 'a'.repeat(32),
        remove: () => {},
    }), /permission denied/);
});

test('II-019e: an unreleasable lock surfaces rather than being swallowed', () => {
    // Swallowing the removal failure returns success while leaving a lock that makes
    // every future repair fail.
    const files: Record<string, string> = { p: 'corrupt' };
    assert.throws(() => ensureInstanceIdentity('p', {
        readFile: (k) => { if (!(k in files)) throw new Error('ENOENT'); return files[k]!; },
        createExclusive: (k, c) => { if (k in files) { const e: any = new Error('EEXIST'); e.code = 'EEXIST'; throw e; } files[k] = c; },
        now: () => new Date(),
        randomId: () => 'b'.repeat(32),
        remove: (k) => { if (k === 'p.lock') throw new Error('lock is stuck'); delete files[k]; },
        sleep: () => {},
    }), /lock is stuck/);
});

test('II-019f: an impossible timestamp is rejected, not normalized', () => {
    // Date.parse('2026-02-30') rolls into March and would otherwise pass.
    const id = 'a'.repeat(32);
    assert.equal(parseIdentity(JSON.stringify({ id, createdAt: '2026-02-30T00:00:00.000Z' })), null);
    assert.equal(parseIdentity(JSON.stringify({ id, createdAt: '2026-08-15T25:00:00.000Z' })), null);
    assert.ok(parseIdentity(JSON.stringify({ id, createdAt: '2026-08-15T00:00:00.000Z' })));
});

test('II-020: health identity comparison uses the FULL id and exact port', () => {
    // Comparing id[0] and port % 100 survived the original vectors.
    const local = { id: 'a'.repeat(32), createdAt: '2026-08-15T00:00:00.000Z' };
    const nearMiss = 'a'.repeat(31) + 'b';
    assert.equal(checkHealthOwnership(local, 3457, { id: nearMiss, port: 3457 }), 'conflict');
    assert.equal(checkHealthOwnership(local, 3457, { id: local.id, port: 13457 }), 'conflict');
    assert.equal(checkHealthOwnership(local, 3457, { id: local.id, port: 3557 }), 'conflict');
});

test('II-021: a real create race — loser adopts, and neither invents an id', () => {
    // The earlier race test let a mutation that skipped the re-read survive, because
    // the loser's own randomId was never distinguishable from the winner's on disk.
    const files: Record<string, string> = {};
    const winnerId = '1'.repeat(32);
    const loserId = '2'.repeat(32);
    const mk = (id: string, canCreate: boolean) => ({
        readFile: (k: string) => { if (!(k in files)) throw new Error('ENOENT'); return files[k]!; },
        createExclusive: (k: string, c: string) => {
            if (!canCreate || k in files) throw new Error('EEXIST');
            files[k] = c;
        },
        now: () => new Date('2026-08-15T00:00:00.000Z'),
        randomId: () => id,
    });
    const winner = ensureInstanceIdentity('p', mk(winnerId, true));
    const loser = ensureInstanceIdentity('p', mk(loserId, false));
    assert.equal(winner.id, winnerId);
    assert.equal(loser.id, winnerId, 'the loser must adopt the persisted id');
    assert.notEqual(loser.id, loserId, 'the loser must NOT return the id it generated');
    assert.deepEqual(loser, winner);
});

test('II-022: an empty file is never mistaken for a valid identity', () => {
    // An empty file is the crash-between-create-and-write state. Treating it as a
    // reason to mint a fresh id without the repair lock would let two actors mint
    // different ids for the same home.
    const files: Record<string, string> = { p: '' };
    const seen: string[] = [];
    const deps = {
        readFile: (k: string) => { if (!(k in files)) throw new Error('ENOENT'); return files[k]!; },
        createExclusive: (k: string, c: string) => {
            if (k in files) throw new Error('EEXIST');
            seen.push(k);
            files[k] = c;
        },
        now: () => new Date('2026-08-15T00:00:00.000Z'),
        randomId: () => '3'.repeat(32),
        remove: (k: string) => { delete files[k]; },
    };
    const result = ensureInstanceIdentity('p', deps);
    // The lock must have been taken: repair without it is the race this prevents.
    assert.ok(seen.includes('p.lock'), 'repair must serialize through the lock');
    assert.equal(result.id, '3'.repeat(32));
    // And the repaired record must be on disk, parseable, not just returned.
    assert.deepEqual(parseIdentity(files['p']!), result);
});

test('II-023: the TOCTOU loser adopts the winner id it could not see initially', () => {
    // The real race: our first read finds NOTHING, so we generate a candidate and
    // attempt create — and only then does the winner's file exist. Every earlier test
    // had the file present up front, so the catch-branch re-read was never exercised
    // and a mutation that skipped it survived.
    const winnerId = '4'.repeat(32);
    const loserId = '5'.repeat(32);
    const winnerRecord = JSON.stringify({ id: winnerId, createdAt: '2026-08-15T00:00:00.000Z' });
    let fileExists = false;   // appears only AFTER our create attempt
    const createdPaths: string[] = [];
    const result = ensureInstanceIdentity('p', {
        readFile: () => {
            if (!fileExists) throw new Error('ENOENT');
            return winnerRecord;
        },
        createExclusive: (path: string) => {
            createdPaths.push(path);
            // The winner won between our read and our write.
            fileExists = true;
            throw new Error('EEXIST');
        },
        now: () => new Date('2026-08-15T00:00:00.000Z'),
        randomId: () => loserId,
        remove: () => { throw new Error('must not repair a healthy file'); },
    });
    assert.equal(result.id, winnerId, 'must adopt the winner');
    assert.notEqual(result.id, loserId, 'must not return the id it generated');
    // A readable file is not corrupt, so the repair path must never be entered.
    // Falling into repair here is how a skipped re-read hid: repair happens to",
    // recover the same value, masking the missing adoption step.
    assert.deepEqual(createdPaths, ['p'], 'only the identity file may be created; no lock');
});

test('II-024: EACCES on create never reaches the repair path at all', () => {
    // Removing the isAlreadyExists guard sends a permissions failure into repair,
    // where the message becomes 'being repaired by another process'. Prove repair is
    // never entered by making any repair-side call explode loudly.
    let repairTouched = false;
    assert.throws(() => ensureInstanceIdentity('p', {
        readFile: () => { throw new Error('ENOENT'); },
        createExclusive: (k) => {
            if (k.endsWith('.lock')) { repairTouched = true; throw new Error('lock attempted'); }
            const e: any = new Error('permission denied'); e.code = 'EACCES'; throw e;
        },
        now: () => new Date(),
        randomId: () => 'a'.repeat(32),
        remove: () => { repairTouched = true; },
        sleep: () => { repairTouched = true; },
    }), /permission denied/);
    assert.equal(repairTouched, false, 'an IO failure must not be handled as contention');
});

test('II-025: the losing creator adopts WITHOUT the repair path rescuing it', () => {
    // The adoption re-read in the catch branch is the property. Repair happens to
    // recover the same value, which masked a skipped re-read — so deny repair here.
    const winnerId = '6'.repeat(32);
    const winnerRecord = JSON.stringify({ id: winnerId, createdAt: '2026-08-15T00:00:00.000Z' });
    let visible = false;
    const result = ensureInstanceIdentity('p', {
        readFile: () => { if (!visible) throw new Error('ENOENT'); return winnerRecord; },
        createExclusive: (k) => {
            if (k.endsWith('.lock')) throw new Error('repair must not be needed');
            visible = true;
            const e: any = new Error('EEXIST'); e.code = 'EEXIST'; throw e;
        },
        now: () => new Date('2026-08-15T00:00:00.000Z'),
        randomId: () => '0'.repeat(32),
        remove: () => { throw new Error('repair must not be needed'); },
        sleep: () => { throw new Error('repair must not be needed'); },
    });
    assert.equal(result.id, winnerId, 'the catch branch must adopt the persisted record');
});

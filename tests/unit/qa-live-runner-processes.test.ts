// The two mechanisms the live runners rely on for safety are a process group
// and an exclusive lock. Neither can be verified by reading source: the
// reviewer's point was that a `strayGroup` filter which is structurally always
// empty, and a reclamation race between two runners, both look perfectly fine
// in a regex. So these tests create real processes and real contention.
import { strict as assert } from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { acquireLock, releaseLockSync } from '../../scripts/qa/live-lock.mjs';

// Temp dirs were piling up between runs; clean them at the end.
const dirs: string[] = [];
const children: import('node:child_process').ChildProcess[] = [];
after(() => {
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Live members of a process group, the way live-boot-check reads them. */
function groupMembers(pgid: number): number[] {
    try {
        const out = execFileSync('/bin/ps', ['-eo', 'pid=,pgid='], { encoding: 'utf8' });
        return out.trim().split('\n')
            .map((line) => line.trim().split(/\s+/).map(Number))
            .filter(([, pg]) => pg === pgid)
            .map(([pid]) => pid!);
    } catch { return []; }
}

test('a detached child leads its own group, and late children join it', async () => {
    // This is what makes the "zero survivors" claim possible: a helper spawned
    // late and reparented to PID 1 leaves any tree we can walk, but never
    // leaves the group.
    const child = spawn('/bin/sh', ['-c', 'sleep 30 & sleep 30'], { detached: true, stdio: 'ignore' });
    child.unref();
    await new Promise((r) => setTimeout(r, 800));

    const members = groupMembers(child.pid!);
    assert.ok(members.includes(child.pid!), 'the child leads the group');
    assert.ok(members.length >= 2, `the grandchild joined the group (saw ${members.length})`);

    // And the group can be swept in one call, which is what teardown relies on.
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 800));
    assert.deepEqual(groupMembers(child.pid!).filter(alive), [], 'the whole group is gone');
});

test('a group sweep that remembers first can never find a stray', () => {
    // The bug, reduced: fold the group into the registry, then look for members
    // the registry does not know. The answer is always none, so late arrivals
    // were reported as leftovers and left running.
    const groupNow = [11, 22, 33];
    const registry = new Map<number, object>([[11, {}]]);

    const wrongOrder = (): number[] => {
        for (const pid of groupNow) registry.set(pid, {});          // remember first
        return groupNow.filter((pid) => !registry.has(pid));        // then look
    };
    const rightOrder = (): number[] => {
        const stray = groupNow.filter((pid) => !registry.has(pid)); // look first
        for (const pid of groupNow) registry.set(pid, {});
        return stray;
    };

    assert.deepEqual(wrongOrder(), [], 'this is why strayGroupMembers was always empty');
    registry.clear();
    registry.set(11, {});
    assert.deepEqual(rightOrder(), [22, 33], 'looking first actually finds them');
});

// ── the lock, exercised through the real implementation ─────────────────────
//
// Earlier versions of these tests reimplemented the acquisition algorithm
// inline, which is how a permanent deadlock in the production path passed a
// green suite. They call `acquireLock`/`releaseLockSync` now.
//
// "A live holder" is expressed as a pid that is genuinely running — a long
// `sleep` we own — rather than a helper process racing its own lifetime, which
// is what made the previous attempts measure timing instead of exclusion.

/** A process that will stay alive until we kill it, and its pid. */
function livePid(): { pid: number; kill: () => void } {
    const p = spawn('/bin/sleep', ['60'], { stdio: 'ignore', detached: true });
    p.unref();
    children.push(p);
    return { pid: p.pid!, kill: () => { try { process.kill(p.pid!, 'SIGKILL'); } catch { /* gone */ } } };
}

test('a lock held by a live process is not taken', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wplive-lock-'));
    dirs.push(dir);
    const lockPath = join(dir, 'runner.lock');

    const holder = livePid();
    writeFileSync(lockPath, `${holder.pid}-holder`);

    const attempt = await acquireLock(lockPath, 'second');
    assert.equal(attempt.held, false, 'a live holder blocks the second runner');
    assert.match(attempt.reason ?? '', /still running/);
    assert.equal(readFileSync(lockPath, 'utf8'), `${holder.pid}-holder`, 'and the lock is untouched');

    holder.kill();
});

test('a lock left by a crashed run is reclaimed, not a permanent block', async () => {
    // The property the reclaim-guard version broke: a run killed while holding
    // the guard blocked every future run forever.
    const dir = mkdtempSync(join(tmpdir(), 'wplive-lock-'));
    dirs.push(dir);
    const lockPath = join(dir, 'runner.lock');

    const crashed = livePid();
    writeFileSync(lockPath, `${crashed.pid}-crashed`);
    crashed.kill();
    await new Promise((r) => setTimeout(r, 400));

    const next = await acquireLock(lockPath, `${process.pid}-next`);
    assert.equal(next.held, true, 'a dead holder must not block the next run');
    assert.equal(next.reclaimedFrom, crashed.pid);

    // And reclamation must leave a usable state, not debris that blocks the
    // run after that — which is exactly how the guard file failed.
    assert.equal(releaseLockSync(lockPath, `${process.pid}-next`), true);
    const third = await acquireLock(lockPath, `${process.pid}-third`);
    assert.equal(third.held, true, 'the lock is usable after a reclamation');
    releaseLockSync(lockPath, `${process.pid}-third`);
});

test('several runners racing one stale lock produce exactly one holder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wplive-lock-'));
    dirs.push(dir);
    const lockPath = join(dir, 'runner.lock');
    writeFileSync(lockPath, '999999-stale');   // a pid that is not running

    // All six race the real implementation concurrently.
    const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => acquireLock(lockPath, `${process.pid}-c${i}`)));
    const winners = results.filter((r) => r.held);
    assert.equal(winners.length, 1,
        `exactly one runner may hold it, saw ${JSON.stringify(results.map((r) => r.held))}`);
    assert.equal(readFileSync(lockPath, 'utf8'), winners[0]!.id, 'the lock names the winner');
});

test('a runner never deletes a lock that is no longer its own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wplive-lock-'));
    dirs.push(dir);
    const lockPath = join(dir, 'runner.lock');

    writeFileSync(lockPath, 'someone-else');
    assert.equal(releaseLockSync(lockPath, 'mine'), false, 'not ours to release');
    assert.ok(existsSync(lockPath), 'and it is still there');

    writeFileSync(lockPath, 'mine');
    assert.equal(releaseLockSync(lockPath, 'mine'), true);
    assert.ok(!existsSync(lockPath));
});



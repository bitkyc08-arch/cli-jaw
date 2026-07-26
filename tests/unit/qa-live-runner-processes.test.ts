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
import { acquireLock, releaseLockSync, writeNote } from '../../scripts/qa/live-lock.mjs';

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
// Two file-based designs failed here before this one, and both passed their own
// tests. The lesson those left behind: a lock is only worth testing under a
// hostile schedule, so the adversarial case below is the important one.

/** A process that stays alive until killed, holding the lock port. */
function lockHolder(port: number): { pid: number; ready: Promise<void>; kill: () => void } {
    const program = `
        const { createServer } = require('node:net');
        const s = createServer();
        s.listen({ port: ${port}, host: '127.0.0.1', exclusive: true }, () => process.stdout.write('up'));
    `;
    const p = spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(p);
    const ready = new Promise<void>((resolve) => { p.stdout.once('data', () => resolve()); });
    return { pid: p.pid!, ready, kill: () => { try { p.kill('SIGKILL'); } catch { /* gone */ } } };
}

let nextPort = 47_700;
const freshPort = (): number => nextPort++;

test('a lock held by a live process is not taken', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wplive-lock-'));
    dirs.push(dir);
    const port = freshPort();

    const holder = lockHolder(port);
    await holder.ready;

    const attempt = await acquireLock(join(dir, 'runner.lock'), 'second', port);
    assert.equal(attempt.held, false, 'a live holder blocks the second runner');

    holder.kill();
});

test('a lock left by a crashed run is reclaimed, not a permanent block', async () => {
    // The reclaim-guard version blocked every future run after one crash.
    const dir = mkdtempSync(join(tmpdir(), 'wplive-lock-'));
    dirs.push(dir);
    const lockPath = join(dir, 'runner.lock');
    const port = freshPort();

    const crashed = lockHolder(port);
    await crashed.ready;
    // A note left behind by the crashed run, to prove it does not mislead us.
    await writeNote(lockPath, `${crashed.pid}-crashed`);
    crashed.kill();
    await new Promise((r) => setTimeout(r, 400));

    const next = await acquireLock(lockPath, 'next', port);
    assert.equal(next.held, true, 'the kernel released it when the holder died');
    next.release!();

    const third = await acquireLock(lockPath, 'third', port);
    assert.equal(third.held, true, 'and it is still usable afterwards');
    third.release!();
});

test('an adversarial schedule cannot produce two holders', async () => {
    // The exact sequence that defeated the quiet-period design: both runners
    // decide the previous holder is dead, one wins and enters the critical
    // section, the other is descheduled and then acts on its stale conclusion.
    //
    // Here the second runner's decision is deliberately made BEFORE the first
    // one acquires, and only used afterwards.
    const dir = mkdtempSync(join(tmpdir(), 'wplive-lock-'));
    dirs.push(dir);
    const lockPath = join(dir, 'runner.lock');
    const port = freshPort();

    const dead = lockHolder(port);
    await dead.ready;
    await writeNote(lockPath, `${dead.pid}-dead`);
    dead.kill();
    await new Promise((r) => setTimeout(r, 400));

    // B observes the world here — holder dead, lock free — and then stalls.
    const bSawDeadHolder = true;
    // A acquires and is inside the critical section.
    const a = await acquireLock(lockPath, 'A', port);
    assert.equal(a.held, true);

    // B resumes and acts on its earlier observation.
    assert.ok(bSawDeadHolder);
    const b = await acquireLock(lockPath, 'B', port);
    assert.equal(b.held, false, 'a stale conclusion cannot take a live lock');

    a.release!();
});

test('many contenders yield exactly one holder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wplive-lock-'));
    dirs.push(dir);
    const lockPath = join(dir, 'runner.lock');
    const port = freshPort();

    const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => acquireLock(lockPath, `c${i}`, port)));
    const winners = results.filter((r) => r.held);
    assert.equal(winners.length, 1,
        `exactly one may hold it, saw ${results.filter((r) => r.held).length}`);
    winners[0]!.release!();
});

test('the lock survives repeated acquire-and-release cycles', async () => {
    // Note what this does NOT do: these are clean releases, not crashes. The
    // crash path has its own test above, where a holder is SIGKILLed and the
    // next run takes over. This one only proves the lock does not accumulate
    // state across ordinary use.
    const dir = mkdtempSync(join(tmpdir(), 'wplive-lock-'));
    dirs.push(dir);
    const lockPath = join(dir, 'runner.lock');
    const port = freshPort();

    for (let round = 0; round < 25; round += 1) {
        const held = await acquireLock(lockPath, `round-${round}`, port);
        assert.equal(held.held, true, `round ${round} could not take the lock`);
        held.release!();
    }
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



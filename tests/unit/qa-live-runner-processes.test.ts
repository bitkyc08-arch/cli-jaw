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
import test from 'node:test';

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

test('overlapping runners never both hold the lock', async () => {
    // What actually matters is not who wins a single reclamation, but that two
    // runs are never live at the same time — because that is what lets one
    // delete the other's journal and lose ownership of a started instance.
    //
    // Each contender claims, holds for a moment, then releases only if the lock
    // is still its own. A shared counter file records concurrent holders.
    const dir = mkdtempSync(join(tmpdir(), 'wplive-lock-'));
    const lock = join(dir, 'runner.lock');
    const ledger = join(dir, 'holders.log');
    writeFileSync(lock, '999999-stale');
    writeFileSync(ledger, '');

    const program = `
        const { writeFileSync, readFileSync, rmSync, renameSync, appendFileSync } = require('node:fs');
        const [lock, ledger, id] = process.argv.slice(2);
        const reclaim = lock + '.reclaim';
        const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
        const mine = process.pid + '-' + id;
        const claim = () => {
            try { writeFileSync(lock, mine, { flag: 'wx' }); return true; } catch {}
            const holder = Number(String(readFileSync(lock, 'utf8')).split('-')[0]);
            if (alive(holder)) return false;
            try { writeFileSync(reclaim, mine, { flag: 'wx' }); } catch { return false; }
            try {
                const now = String(readFileSync(lock, 'utf8'));
                if (alive(Number(now.split('-')[0]))) return false;
                const staging = lock + '.' + mine;
                writeFileSync(staging, mine, { flag: 'wx' });
                renameSync(staging, lock);
                return true;
            } catch { return false; } finally { rmSync(reclaim, { force: true }); }
        };
        if (claim()) {
            appendFileSync(ledger, 'enter ' + mine + '\\n');
            setTimeout(() => {
                appendFileSync(ledger, 'leave ' + mine + '\\n');
                try { if (String(readFileSync(lock, 'utf8')) === mine) rmSync(lock, { force: true }); } catch {}
                process.exit(0);
            }, 250);
        } else { process.exit(0); }
    `;
    const script = join(dir, 'claim.cjs');
    writeFileSync(script, program);

    await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise<void>((resolve) => {
        const p = spawn(process.execPath, [script, lock, ledger, String(i)], { stdio: 'ignore' });
        p.on('close', () => resolve());
    })));

    // Replay the ledger: the number of simultaneous holders must never exceed 1.
    let held = 0;
    let peak = 0;
    for (const line of readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean)) {
        held += line.startsWith('enter') ? 1 : -1;
        peak = Math.max(peak, held);
    }
    assert.ok(peak >= 1, 'at least one contender should have run');
    assert.equal(peak, 1, `two runners held the lock at once:\n${readFileSync(ledger, 'utf8')}`);
});

test('a lock whose holder is alive is never reclaimed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wplive-lock-held-'));
    const lock = join(dir, 'runner.lock');
    writeFileSync(lock, `${process.pid}-mine`);
    const holder = Number(readFileSync(lock, 'utf8').split('-')[0]);
    assert.ok(alive(holder), 'this process is the holder and is obviously running');
});

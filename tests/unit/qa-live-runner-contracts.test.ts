// Every fix in the live runners was a false-pass: a check that reported success
// while the thing it names had not happened. A green run on a healthy machine
// cannot demonstrate any of them, because none of those paths are taken when
// everything works. These tests exercise the failure contracts directly.
//
// They read the runner sources rather than importing them, because the scripts
// are top-level-await programs that connect to a browser and a live manager on
// import. What is being pinned here is the decision logic, and the shapes it
// must refuse.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { cleanupDecision, lockVerdict, recoveryDecision, stopConfirmed } from '../../scripts/qa/live-ownership.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const LIVE = readFileSync(join(ROOT, 'scripts/qa/live-app-qa.mjs'), 'utf8');
const BOOT = readFileSync(join(ROOT, 'scripts/qa/live-boot-check.mjs'), 'utf8');
const VERIFY = join(ROOT, 'scripts/qa/verify-live-window-evidence.mjs');

/** Run the evidence validator over a literal object. */
function validate(evidence: unknown): { code: number; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'wplive-evidence-'));
    const file = join(dir, 'evidence.json');
    writeFileSync(file, JSON.stringify(evidence));
    try {
        const out = execFileSync(process.execPath, [VERIFY, file], { encoding: 'utf8' });
        return { code: 0, out };
    } catch (error) {
        const e = error as { status?: number; stderr?: string };
        return { code: e.status ?? 1, out: e.stderr ?? '' };
    }
}

const goodResize = {
    windowRef: 'window "Jaw"',
    before: { width: 1440, height: 960 },
    requested: { width: 1180, height: 820 },
    after: { width: 1180, height: 820 },
    restored: { width: 1440, height: 960 },
};
const goodEvidence = {
    rendererOrigin: 'http://127.0.0.1:24577',
    windowPid: 8108,
    managerPid: 8955,
    managerPort: 24577,
    instanceSnapshotHash: '1b7f42aae71b83e9',
    buildIdentity: '2026-07-25T21:57:30',
    timestamp: new Date().toISOString(),
    nativeResize: goodResize,
};

test('complete evidence validates and yields the origin', () => {
    const { code, out } = validate(goodEvidence);
    assert.equal(code, 0, out);
});

test('evidence without a native resize measurement is refused', () => {
    const { nativeResize, ...without } = goodEvidence;
    void nativeResize;
    const { code, out } = validate(without);
    assert.equal(code, 1);
    assert.match(out, /nativeResize/);
});

test('a resize the window ignored is not evidence that resizing works', () => {
    const { code } = validate({
        ...goodEvidence,
        nativeResize: { ...goodResize, after: { width: 1440, height: 960 } },
    });
    assert.equal(code, 1, 'after == before means the window did not obey');
});

test('a resize that never restored the window is refused', () => {
    const { code } = validate({
        ...goodEvidence,
        nativeResize: { ...goodResize, restored: { width: 1180, height: 820 } },
    });
    assert.equal(code, 1, 'leaving the window resized is not a clean measurement');
});

test('an origin that disagrees with the manager port is refused', () => {
    const { code, out } = validate({ ...goodEvidence, rendererOrigin: 'http://127.0.0.1:24576' });
    assert.equal(code, 1);
    assert.match(out, /does not match managerPort/);
});

test('stale evidence is refused', () => {
    const { code, out } = validate({
        ...goodEvidence,
        timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    assert.equal(code, 1);
    assert.match(out, /minutes old/);
});

// ── the ownership decisions, exercised for real ──────────────────────────────
//
// These used to be regexes over the runner's source, which is why a swallowed
// error and a missing pid survived a green suite. The decision logic now lives
// in a pure module and is called directly.

const ORIGIN = 'http://127.0.0.1:24577';
const onlineRow = (port: number, pid: number | null) => ({
    port, status: 'online', lifecycle: pid === null ? {} : { pid },
});

test('no journal means nothing to do', () => {
    assert.equal(recoveryDecision(null, null, ORIGIN).action, 'none');
});

test('an unreadable journal is refused, not ignored', () => {
    // Something claimed ownership and we cannot tell what. Treating that as
    // "no journal" was the fail-open path.
    const d = recoveryDecision('unreadable', null, ORIGIN);
    assert.equal(d.action, 'refuse');
    assert.match(d.reason, /could not be read/);
});

test('an intent-phase journal never stops anything', () => {
    const d = recoveryDecision(
        { port: 3457, origin: ORIGIN, phase: 'intent', managerPid: 1, instancePid: 2 },
        { managerPid: 1, instance: onlineRow(3457, 2) }, ORIGIN);
    assert.equal(d.action, 'refuse');
    assert.match(d.reason, /intent/);
});

test('a journal without an instance pid cannot justify a stop', () => {
    const d = recoveryDecision(
        { port: 3457, origin: ORIGIN, phase: 'online', managerPid: 1, instancePid: null },
        { managerPid: 1, instance: onlineRow(3457, 99) }, ORIGIN);
    assert.equal(d.action, 'refuse');
    assert.match(d.reason, /missing a manager or instance pid/);
});

test('a restarted manager makes the port someone else\'s', () => {
    const d = recoveryDecision(
        { port: 3457, origin: ORIGIN, phase: 'online', managerPid: 1, instancePid: 2 },
        { managerPid: 77, instance: onlineRow(3457, 2) }, ORIGIN);
    assert.equal(d.action, 'refuse');
    assert.match(d.reason, /manager 1, now 77/);
});

test('a different process on our port is left alone', () => {
    const d = recoveryDecision(
        { port: 3457, origin: ORIGIN, phase: 'online', managerPid: 1, instancePid: 2 },
        { managerPid: 1, instance: onlineRow(3457, 4242) }, ORIGIN);
    assert.equal(d.action, 'refuse');
    assert.match(d.reason, /not the 2 we started/);
});

test('a failed instance query is refused, not read as "already gone"', () => {
    const d = recoveryDecision(
        { port: 3457, origin: ORIGIN, phase: 'online', managerPid: 1, instancePid: 2 },
        { queryFailed: true }, ORIGIN);
    assert.equal(d.action, 'refuse');
    assert.match(d.reason, /could not read/);
});

test('a matching pid is the one case that authorises a stop', () => {
    const d = recoveryDecision(
        { port: 3457, origin: ORIGIN, phase: 'online', managerPid: 1, instancePid: 2 },
        { managerPid: 1, instance: onlineRow(3457, 2) }, ORIGIN);
    assert.equal(d.action, 'stop');
});

test("this run's own cleanup refuses without a confirmed pid", () => {
    // The SIGINT path used to post a stop for a bare port. If the start failed
    // and someone else took that port, it would have stopped their process.
    const d = cleanupDecision({ port: 3457, managerPid: 1, instancePid: null },
        { managerPid: 1, instance: onlineRow(3457, 4242) });
    assert.equal(d.action, 'refuse');
    assert.match(d.reason, /never confirmed its pid/);
});

test("this run's cleanup refuses when the pid no longer matches", () => {
    const d = cleanupDecision({ port: 3457, managerPid: 1, instancePid: 2 },
        { managerPid: 1, instance: onlineRow(3457, 4242) });
    assert.equal(d.action, 'refuse');
});

test('only offline confirms a stop', () => {
    for (const status of ['timeout', 'error', 'unknown', 'online']) {
        assert.equal(stopConfirmed({ instance: { port: 1, status } }).done, false, status);
    }
    assert.equal(stopConfirmed({ instance: { port: 1, status: 'offline' } }).done, true);
    assert.equal(stopConfirmed({ queryFailed: true }).done, false);
});

test('an unreachable instance is never counted as stopped', () => {
    // timeout/error/unknown all describe a manager that cannot reach the
    // instance, which is what a live but wedged process looks like. Reading
    // them as "already stopped" deletes the journal and abandons it.
    const journal = { port: 3457, origin: ORIGIN, phase: 'online', managerPid: 1, instancePid: 2 };
    const owned = { port: 3457, managerPid: 1, instancePid: 2 };
    for (const status of ['timeout', 'error', 'unknown']) {
        const observed = { managerPid: 1, instance: { port: 3457, status, lifecycle: { pid: 2 } } };
        assert.equal(recoveryDecision(journal, observed, ORIGIN).action, 'refuse', `recovery/${status}`);
        assert.equal(cleanupDecision(owned, observed).action, 'refuse', `cleanup/${status}`);
    }
    // And offline really is the one that means done.
    const off = { managerPid: 1, instance: { port: 3457, status: 'offline', lifecycle: { pid: 2 } } };
    assert.equal(recoveryDecision(journal, off, ORIGIN).action, 'none');
    assert.equal(cleanupDecision(owned, off).action, 'none');
});

test('a manager that restarted cannot confirm our stop', () => {
    const off = { managerPid: 99, instance: { port: 3457, status: 'offline' } };
    assert.equal(stopConfirmed(off, 1).done, false, 'a different manager is answering about another world');
    assert.equal(stopConfirmed({ ...off, managerPid: 1 }, 1).done, true);
});

test('a lock held by a live process blocks, a stale one does not', () => {
    assert.equal(lockVerdict('12345-abc', () => true).verdict, 'held');
    assert.equal(lockVerdict('12345-abc', () => false).verdict, 'stale');
    assert.equal(lockVerdict('', () => true).verdict, 'stale');
});

test('the runner takes exclusion from the OS, not from file timing', () => {
    // Two file-based designs failed here: a reclaim guard whose orphan blocked
    // every future run, and an atomic rename plus a quiet period, which is a
    // guess about scheduling rather than mutual exclusion. Exclusion is now a
    // bound loopback port, which the kernel releases on process death.
    // Behaviour is covered in qa-live-runner-processes.test.ts, including the
    // adversarial schedule that defeated the quiet period.
    assert.match(LIVE, /import \{ acquireLock \} from '\.\/live-lock\.mjs'/);
    assert.match(LIVE, /const lock = await acquireLock\(LOCK, RUN_ID\)/);
    assert.match(LIVE, /lock\.release\(\)/, 'the port must be handed back on exit');
    assert.doesNotMatch(LIVE, /require\('node:fs'\)/, 'require does not exist in an .mjs module');
    assert.doesNotMatch(LIVE, /`\$\{LOCK\}\.reclaim`/, 'the orphan-prone guard file is gone');

    const LOCKMOD = readFileSync(join(ROOT, 'scripts/qa/live-lock.mjs'), 'utf8');
    assert.match(LOCKMOD, /exclusive: true/, 'the port binding must be exclusive');
    assert.doesNotMatch(LOCKMOD, /settle/, 'no quiet-period heuristic may remain');
});

// ── the boot check's ownership rules ─────────────────────────────────────────
test('an unidentified process is never claimed as ours', () => {
    assert.match(BOOT, /if \(!entry\?\.started\?\.trim\(\) \|\| !entry\?\.command\?\.trim\(\)\) return false/,
        'empty identity must not satisfy the ownership check');
    assert.match(BOOT, /now\.started === entry\.started && now\.command === entry\.command/,
        'ownership must be exact equality, not a substring match');
});

test('failing to identify the root kills it and stops', () => {
    assert.match(BOOT, /record\('root-process-identified', false[\s\S]{0,700}process\.exit\(1\)/,
        'an unidentifiable root must not be left running');
    assert.match(BOOT, /process\.kill\(-child\.pid, 'SIGKILL'\)/,
        'the whole group must go: children may already exist that the handle does not own');
    assert.match(BOOT, /child\.kill\('SIGKILL'\)/,
        'and the handle itself, which needs no identity');
});

test('survivors are checked against the registry, not the process tree', () => {
    assert.match(BOOT, /\[\.\.\.registry\.values\(\)\]\.filter\(\(e\) => alive\(e\.pid\) && stillOurs\(e\)\)/,
        'a reparented child leaves the tree but not the registry');
});

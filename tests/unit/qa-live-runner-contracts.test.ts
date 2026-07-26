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

// ── the live runner's decision logic ─────────────────────────────────────────

test('a failed instances query cannot be read as a stopped instance', () => {
    // The bug: `.catch(() => ({}))` produced an empty list, "no online instance
    // with that port" came out true, and cleanup claimed success.
    assert.doesNotMatch(LIVE, /getJson\('\/api\/dashboard\/instances'\)\.catch\(\(\) => \(\{\}\)\)\)\.instances \?\? \[\];[\s\S]{0,200}stopped =/,
        'the cleanup loop must not derive "stopped" from a swallowed error');
    assert.match(LIVE, /stopped = row\.status === 'offline'/,
        'only an explicit offline status may count as stopped');
});

test('timeout, error and unknown are not treated as offline', () => {
    assert.doesNotMatch(LIVE, /stopped = row\.status !== 'online'/,
        'a non-online status can still be a live but unreachable process');
});

test('orphan recovery is called, and a bad outcome stops the run', () => {
    assert.match(LIVE, /const recovery = await recoverOrphans\(\)/,
        'recovery must actually be invoked');
    assert.match(LIVE, /if \(recovery !== 'clean'\)[\s\S]{0,300}process\.exit\(1\)/,
        'an unresolved orphan must abort before starting anything new');
});

test('recovery refuses to act on an ambiguous claim', () => {
    for (const guard of [
        /journal\.phase === 'intent'/,       // may never have started
        /journal\.managerPid !== health\.pid/, // manager restarted
        /row\.lifecycle\.pid !== journal\.instancePid/, // someone else's process
    ]) {
        assert.match(LIVE, guard, `recovery is missing a safety guard: ${guard}`);
    }
});

test('the journal records ownership, not just a port', () => {
    for (const field of ['runId', 'managerPid', 'instancePid', 'phase']) {
        assert.match(LIVE, new RegExp(`${field}:`), `journal is missing ${field}`);
    }
});

test('two runners cannot share the journal', () => {
    assert.match(LIVE, /flag: 'wx'/, 'the lock must be created exclusively');
});

test('the session id is always compared, including with several sessions', () => {
    assert.match(LIVE, /Boolean\(expectedSession\) && selection\.sessionId === expectedSession/,
        'a null expected session must fail rather than pass by default');
});

test('the start CTA is bound to the port, not to a label', () => {
    assert.match(LIVE, /\.d2-instance-node[\s\S]{0,120}hasText: `:\$\{candidate\.port\}`/,
        'the CTA must be scoped to the row carrying the port');
    assert.match(LIVE, /ctaRequests\[0\]\?\.port === candidate\.port/,
        'the request body port must be checked, not just the URL');
});

// ── the boot check's ownership rules ─────────────────────────────────────────

test('an unidentified process is never claimed as ours', () => {
    assert.match(BOOT, /if \(!entry\?\.started\?\.trim\(\) \|\| !entry\?\.command\?\.trim\(\)\) return false/,
        'empty identity must not satisfy the ownership check');
    assert.match(BOOT, /now\.started === entry\.started && now\.command === entry\.command/,
        'ownership must be exact equality, not a substring match');
});

test('failing to identify the root kills it and stops', () => {
    assert.match(BOOT, /record\('root-process-identified', false[\s\S]{0,400}process\.exit\(1\)/,
        'an unidentifiable root must not be left running');
    assert.match(BOOT, /child\.kill\('SIGKILL'\)/,
        'the child handle needs no identity and is the way out');
});

test('survivors are checked against the registry, not the process tree', () => {
    assert.match(BOOT, /\[\.\.\.registry\.values\(\)\]\.filter\(\(e\) => alive\(e\.pid\) && stillOurs\(e\)\)/,
        'a reparented child leaves the tree but not the registry');
});

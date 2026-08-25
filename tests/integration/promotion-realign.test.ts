import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// #466: promote-to-main.sh squash-merges preview into main, which makes main stop
// being an ancestor of preview — and the guard at the top of that same script
// demands exactly that ancestry on the next cycle. The script therefore breaks its
// own precondition every release, and the manual recovery that gap forced is what
// dropped #418's code from the published 2.17.13 tarball.
//
// These run the realignment against a REAL git repository rather than reading the
// script's text, because the failure being guarded is a wrong merge DIRECTION —
// something only a tree comparison can catch.

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function git(cwd: string, ...args: string[]): string {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
}

/** upstream + a clone, shaped like the repo right after a squash promotion. */
function makeRepo(): { work: string; upstream: string; mainSha: string; previewSha: string } {
    const root = mkdtempSync(join(tmpdir(), 'jaw-promote-'));
    const upstream = join(root, 'upstream.git');
    const work = join(root, 'work');
    mkdirSync(upstream);
    git(upstream, 'init', '--bare', '--initial-branch=main');
    git(root, 'clone', upstream, 'work');
    git(work, 'config', 'user.email', 'test@example.com');
    git(work, 'config', 'user.name', 'test');

    writeFileSync(join(work, 'shipped.txt'), 'base\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'base');
    git(work, 'push', 'origin', 'main');

    // preview gains the release work.
    git(work, 'checkout', '-b', 'preview');
    writeFileSync(join(work, 'shipped.txt'), 'base\nfeature\n');
    writeFileSync(join(work, 'only-on-preview.txt'), 'this must survive\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'the release work');
    git(work, 'push', 'origin', 'preview');
    const previewSha = git(work, 'rev-parse', 'HEAD');

    // main gets it as a SQUASH — same tree, unrelated commit. This is what
    // gh pr merge --squash produces, and why the ancestry breaks.
    git(work, 'checkout', 'main');
    git(work, 'merge', '--squash', 'preview');
    git(work, 'commit', '-m', 'chore: promote v9.9.9');
    git(work, 'push', 'origin', 'main');
    const mainSha = git(work, 'rev-parse', 'HEAD');

    return { work, upstream, mainSha, previewSha };
}

test('PRA-001: after a squash promotion, main is NOT an ancestor of preview', () => {
    const { work, mainSha, previewSha } = makeRepo();
    const r = spawnSync('git', ['merge-base', '--is-ancestor', mainSha, previewSha], { cwd: work });
    assert.notEqual(r.status, 0,
        'this is the precondition the guard rejects; if it ever passes, the premise of #466 changed');
});

test('PRA-002: the realignment records main as an ancestor without touching the tree', () => {
    const { work, mainSha } = makeRepo();
    git(work, 'checkout', 'preview');
    const treeBefore = git(work, 'rev-parse', 'HEAD^{tree}');

    // The realignment promote-to-main.sh performs.
    git(work, 'merge', mainSha, '-s', 'ours', '-m', 'chore: record the promotion as an ancestor');

    const treeAfter = git(work, 'rev-parse', 'HEAD^{tree}');
    assert.equal(treeAfter, treeBefore, 'realignment must not change what ships');
    assert.equal(
        spawnSync('git', ['merge-base', '--is-ancestor', mainSha, 'HEAD'], { cwd: work }).status,
        0,
        'main must now be an ancestor so the next promotion is not blocked',
    );
    assert.equal(readFileSync(join(work, 'only-on-preview.txt'), 'utf8'), 'this must survive\n');
});

test('PRA-003: the reverse merge direction silently takes the wrong tree — the 2.17.13 failure', () => {
    // Recorded so the danger stays visible: -s ours keeps the CURRENT branch's
    // tree, so running it from main discards preview's work while reporting
    // success. fbefa754 did exactly this and shipped a tarball missing #418.
    const { work } = makeRepo();
    git(work, 'checkout', 'preview');
    writeFileSync(join(work, 'only-on-preview.txt'), 'newer preview content\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'later preview work');
    const previewTree = git(work, 'rev-parse', 'HEAD^{tree}');

    git(work, 'checkout', 'main');
    const mainTree = git(work, 'rev-parse', 'HEAD^{tree}');
    git(work, 'merge', 'preview', '-s', 'ours', '-m', 'take preview tree');

    assert.equal(git(work, 'rev-parse', 'HEAD^{tree}'), mainTree,
        'from main, -s ours keeps MAIN — the commit message claiming otherwise is not enforcement');
    assert.notEqual(git(work, 'rev-parse', 'HEAD^{tree}'), previewTree,
        'this is the silent data loss: a clean merge that contributed nothing from preview');
});

test('PRA-004: the shipped helper realigns a squash-broken branch, tree untouched', () => {
    // Runs the REAL helper against a real repository. The script-text checks that
    // used to live here proved wording, not behavior.
    const { work, upstream, mainSha } = makeRepo();
    const helper = join(projectRoot, 'scripts/promotion-checkout.sh');
    const before = git(work, 'rev-parse', 'origin/preview^{tree}');

    const r = spawnSync('bash', ['-c',
        `set -euo pipefail; source "${helper}"; realign_branch_onto_main preview "${mainSha}" "chore: test realign"`,
    ], { cwd: work, encoding: 'utf8' });
    assert.equal(r.status, 0, `helper failed: ${r.stdout}${r.stderr}`);

    const head = git(work, 'ls-remote', upstream, 'refs/heads/preview').split(/\s+/)[0]!;
    assert.equal(git(work, 'rev-parse', `${head}^{tree}`), before,
        'the realignment must not change what ships');
    assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', mainSha, head], { cwd: work }).status, 0,
        'main must be an ancestor afterwards, or the next promotion is blocked again');
});

test('PRA-005: promote-to-main.sh actually calls the helper for both branches', () => {
    const src = readFileSync(join(projectRoot, 'scripts/promote-to-main.sh'), 'utf8');
    for (const branch of ['preview', 'dev']) {
        assert.ok(src.includes(`realign_branch_onto_main ${branch}`),
            `${branch} must be realigned; skipping either one re-breaks the next cycle`);
    }
});

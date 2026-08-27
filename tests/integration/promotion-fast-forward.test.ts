import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// #480: promotion used to squash preview onto main, which folded history into a
// NEW commit and made main stop being an ancestor of preview — the precondition
// the same script demands on the next cycle. #468 patched that with a realignment
// commit built per branch, but it minted a SEPARATE commit for dev and preview,
// so the two branches diverged permanently instead (8 such twins accumulated).
//
// Promotion now extends preview with the bump commit and fast-forwards main onto
// it. These run against a REAL git repository because the property under test is
// about ancestry and tree identity, which only a real object graph can show.

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function git(cwd: string, ...args: string[]): string {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
}

/** upstream + clone, shaped like the repo just before a promotion. */
function makeRepo(): { work: string; mainSha: string; previewSha: string } {
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

    return {
        work,
        mainSha: git(work, 'rev-parse', 'main'),
        previewSha: git(work, 'rev-parse', 'preview'),
    };
}

/** What the new promotion does: bump on top of preview, then ff main onto it. */
function promote(work: string): string {
    git(work, 'checkout', 'preview');
    writeFileSync(join(work, 'version.txt'), '9.9.9\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'chore: promote v9.9.9');
    const promotionCommit = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', 'origin', 'preview');
    git(work, 'push', 'origin', `${promotionCommit}:refs/heads/main`);
    return promotionCommit;
}

test('FFP-001: after promotion, main IS an ancestor of preview', () => {
    const { work } = makeRepo();
    promote(work);
    const r = spawnSync('git', ['merge-base', '--is-ancestor', 'origin/main', 'origin/preview'], { cwd: work });
    assert.equal(r.status, 0,
        'ff promotion must leave main as an ancestor of preview — that is the precondition promote-to-main.sh demands next cycle');
});

test('FFP-002: main HEAD is the exact commit CI certified, not a same-tree copy', () => {
    const { work } = makeRepo();
    const promotionCommit = promote(work);
    assert.equal(git(work, 'rev-parse', 'origin/main'), promotionCommit,
        'main must take the certified SHA itself; a squash would produce a different SHA with the same tree');
    assert.equal(git(work, 'rev-parse', 'origin/preview'), promotionCommit,
        'preview and main must point at the same commit right after a promotion');
});

test('FFP-003: promotion preserves preview-only content', () => {
    const { work } = makeRepo();
    promote(work);
    // Read the pushed ref, not a local checkout: `git push` moves the remote
    // branch without touching the local one, so a local `checkout main` would
    // inspect the pre-promotion tree and pass for the wrong reason.
    assert.equal(git(work, 'show', 'origin/main:only-on-preview.txt'), 'this must survive',
        'the released tree must still carry everything preview had');
});

test('FFP-004: a squash promotion would break the ancestry — the #466 regression', () => {
    // Kept as a NEGATIVE control: if someone reinstates --squash, FFP-001 must
    // start failing for this reason, and this test documents what that looks like.
    const { work } = makeRepo();
    git(work, 'checkout', 'main');
    git(work, 'merge', '--squash', 'preview');
    git(work, 'commit', '-m', 'chore: promote v9.9.9');
    git(work, 'push', 'origin', 'main');
    const r = spawnSync('git', ['merge-base', '--is-ancestor', 'origin/main', 'origin/preview'], { cwd: work });
    assert.notEqual(r.status, 0,
        'a squash promotion detaches main from preview; this is why promotion no longer squashes');
});

test('FFP-005: main can never gain a commit preview lacks', () => {
    const { work } = makeRepo();
    const promotionCommit = promote(work);
    assert.equal(git(work, 'rev-list', '--count', `origin/preview..origin/main`), '0',
        'main must hold no commit that preview does not; that asymmetry is what forced the realignment step');
    // And the release line is linear: no merge commit was minted anywhere.
    assert.equal(git(work, 'rev-list', '--count', '--merges', `${promotionCommit}~1..${promotionCommit}`), '0',
        'promotion must not create a merge commit');
});

test('FFP-006: promote-to-main.sh pushes refs instead of merging a PR', () => {
    const script = readFileSync(join(projectRoot, 'scripts/promote-to-main.sh'), 'utf8');

    assert.ok(!script.includes('gh pr create'),
        'promotion must not open a PR: a PR merge always mints a new SHA, which is what broke the ancestry');
    assert.ok(!script.includes('--squash'),
        'promotion must not squash');
    assert.ok(script.includes('git -C "$WORKTREE" push origin "$PROMOTION_COMMIT:refs/heads/main"'),
        'promotion must fast-forward main onto the certified commit');

    // A plain push (no --force) is what makes "fast-forward only" enforceable by
    // git itself rather than by convention.
    assert.ok(!/git push[^\n]*--force[^\n]*refs\/heads\/main/.test(script),
        'the main push must never be forced: refusing a non-ff is the actual guarantee');

    // preview moves first and must be pinned to the SHA this run certified.
    assert.ok(script.includes('--force-with-lease="refs/heads/preview:$PREVIEW_SHA"'),
        'the preview push must be leased to the certified SHA so a concurrent push is refused, not discarded');
});

test('FFP-007: the realignment helper is gone along with what required it', () => {
    const helper = readFileSync(join(projectRoot, 'scripts/promotion-checkout.sh'), 'utf8');
    const script = readFileSync(join(projectRoot, 'scripts/promote-to-main.sh'), 'utf8');

    assert.ok(!helper.includes('realign_branch_onto_main()'),
        'the realignment helper must be removed: ff promotion leaves nothing to realign');
    assert.ok(!/^\s*realign_branch_onto_main /m.test(script),
        'promotion must not call the realignment helper');
});

test('FFP-008: publish.yml no longer carries the certified-sha workaround', () => {
    const workflow = readFileSync(join(projectRoot, '.github/workflows/publish.yml'), 'utf8');

    // certified-sha existed only because a squash gave main a DIFFERENT SHA with
    // the same tree, so the gates had to be pointed at the PR head instead. With
    // ff promotion the published SHA is the certified SHA.
    assert.ok(!workflow.includes('certified-sha:'),
        'the certified-sha input must be gone');
    assert.ok(!workflow.includes('steps.certified.outputs.sha'),
        'no step may still read the certified-sha output');
    assert.ok(!workflow.includes('tree-identity'),
        'the tree-identity fast path must be gone');

    // The real gates must survive.
    assert.ok(workflow.includes('Verify dispatched SHA'),
        'publish must still verify the dispatched SHA matches HEAD');
    assert.ok(workflow.includes('latest:main'),
        'real latest publishes must still be pinned to main');
    assert.ok(workflow.includes('preview:preview'),
        'real preview publishes must still be pinned to preview');
});

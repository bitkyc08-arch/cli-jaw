import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const helperPath = join(projectRoot, 'scripts', 'promotion-checkout.sh');

function run(
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; expect?: number } = {},
) {
    const result = spawnSync(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        encoding: 'utf8',
    });
    const expected = options.expect ?? 0;
    assert.equal(
        result.status,
        expected,
        [
            `${command} ${args.join(' ')} exited ${result.status}, expected ${expected}`,
            result.stdout,
            result.stderr,
        ].filter(Boolean).join('\n'),
    );
    return result;
}

function git(cwd: string, ...args: string[]): string {
    return run('git', args, { cwd }).stdout.trim();
}

function bashHelper(
    cwd: string,
    tempRoot: string,
    body: string,
    args: string[],
    expect = 0,
) {
    return run('bash', ['-c', `source "$1"; ${body}`, 'bash', helperPath, ...args], {
        cwd,
        expect,
        env: {
            ...process.env,
            CLI_JAW_PROMOTION_TMP_ROOT: tempRoot,
        },
    });
}

test('promotion checkout stays isolated when invoked from a submodule and fails closed on unsafe states', () => {
    const root = mkdtempSync(join(tmpdir(), 'promotion-checkout-test-'));
    try {
        const source = join(root, 'source');
        const remote = join(root, 'origin.git');
        const parent = join(root, 'parent');
        mkdirSync(source);
        mkdirSync(parent);

        git(source, 'init', '-b', 'preview');
        git(source, 'config', 'user.name', 'Promotion Test');
        git(source, 'config', 'user.email', 'promotion@example.invalid');
        writeFileSync(join(source, 'README.md'), 'preview\n');
        git(source, 'add', 'README.md');
        git(source, 'commit', '-m', 'preview');
        const previewSha = git(source, 'rev-parse', 'HEAD');
        run('git', ['clone', '--bare', source, remote]);

        git(parent, 'init', '-b', 'main');
        git(parent, 'config', 'user.name', 'Promotion Test');
        git(parent, 'config', 'user.email', 'promotion@example.invalid');
        writeFileSync(join(parent, 'README.md'), 'parent\n');
        git(parent, 'add', 'README.md');
        git(parent, 'commit', '-m', 'parent');
        git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', `file://${remote}`, 'child');
        git(parent, 'commit', '-am', 'add child');
        const child = join(parent, 'child');
        assert.ok(existsSync(join(child, '.git')), 'fixture must invoke the helper from a real submodule checkout');

        const promotionBranch = 'codex/promote-test';
        const checkout = mkdtempSync(join(root, 'cli-jaw-promote.'));
        bashHelper(
            child,
            root,
            'prepare_promotion_checkout "$2" "$3" "$4" "$5"',
            [`file://${remote}`, previewSha, promotionBranch, checkout],
        );
        assert.equal(realpathSync(git(checkout, 'rev-parse', '--show-toplevel')), realpathSync(checkout));
        assert.equal(git(checkout, 'rev-parse', 'HEAD'), previewSha);
        assert.equal(git(checkout, 'status', '--porcelain'), '');

        bashHelper(
            child,
            root,
            'assert_promotion_checkout_ready_to_push "$2" "$3" "$4"',
            [checkout, previewSha, promotionBranch],
            1,
        );
        git(checkout, 'config', 'user.name', 'Promotion Test');
        git(checkout, 'config', 'user.email', 'promotion@example.invalid');
        writeFileSync(join(checkout, 'VERSION'), 'stable\n');
        git(checkout, 'add', 'VERSION');
        git(checkout, 'commit', '-m', 'promote');
        bashHelper(
            child,
            root,
            'assert_promotion_checkout_ready_to_push "$2" "$3" "$4"',
            [checkout, previewSha, promotionBranch],
        );
        bashHelper(child, root, 'cleanup_promotion_checkout "$2"', [checkout]);
        assert.equal(existsSync(checkout), false, 'validated promotion clone must be removed');

        const staleBranch = 'codex/promote-stale';
        run('git', [`--git-dir=${remote}`, 'branch', staleBranch, previewSha]);
        const staleCheckout = mkdtempSync(join(root, 'cli-jaw-promote.'));
        const stale = bashHelper(
            child,
            root,
            'prepare_promotion_checkout "$2" "$3" "$4" "$5"',
            [`file://${remote}`, previewSha, staleBranch, staleCheckout],
            1,
        );
        assert.match(stale.stderr, /remote promotion branch already exists/);
        assert.equal(git(source, 'rev-parse', 'HEAD'), previewSha, 'stale-branch failure must not mutate source');

        const unsafe = join(root, 'unsafe-checkout');
        mkdirSync(unsafe);
        writeFileSync(join(unsafe, 'keep.txt'), 'keep\n');
        const rejected = bashHelper(child, root, 'cleanup_promotion_checkout "$2"', [unsafe], 1);
        assert.match(rejected.stderr, /refusing unsafe promotion checkout path/);
        assert.equal(existsSync(join(unsafe, 'keep.txt')), true, 'unsafe cleanup target must remain intact');

        const symlinkTarget = join(root, 'symlink-target');
        mkdirSync(symlinkTarget);
        writeFileSync(join(symlinkTarget, 'keep.txt'), 'keep\n');
        const symlinkCheckout = join(root, 'cli-jaw-promote.symlink');
        symlinkSync(symlinkTarget, symlinkCheckout);
        const symlinkRejected = bashHelper(
            child,
            root,
            'cleanup_promotion_checkout "$2"',
            [symlinkCheckout],
            1,
        );
        assert.match(symlinkRejected.stderr, /refusing symlink promotion checkout path/);
        assert.equal(existsSync(join(symlinkTarget, 'keep.txt')), true, 'symlink target must remain intact');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

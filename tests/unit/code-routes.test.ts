import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCodeRoutes } from '../../src/routes/code.ts';

function git(cwd: string, args: string[]): string {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
        '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function withServer(run: (url: string) => Promise<void>): Promise<void> {
    const app = express();
    app.use(express.json());
    registerCodeRoutes(app, (_req, _res, next) => next());
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try { await run(`http://127.0.0.1:${address.port}`); }
    finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
}

test('workspace metadata validates absolute directories and reports non-repositories honestly', async t => {
    const folder = mkdtempSync(join(tmpdir(), 'code-git-empty-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    await withServer(async url => {
        assert.equal((await fetch(`${url}/api/code/git-info?cwd=relative`)).status, 400);
        const response = await fetch(`${url}/api/code/git-info?cwd=${encodeURIComponent(folder)}`);
        assert.deepEqual(await response.json(), { ok: true, isRepo: false, branch: null, worktrees: [] });
    });
});

test('workspace metadata binds the actual worktree for subdirectories despite shared core.worktree', async t => {
    const parent = mkdtempSync(join(tmpdir(), 'code-git-owner-'));
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    const root = join(parent, 'repo');
    const foreign = join(parent, 'foreign');
    mkdirSync(root); mkdirSync(foreign);
    git(root, ['init', '-b', 'main']);
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'file.txt'), 'baseline');
    git(root, ['add', '.']); git(root, ['commit', '-m', 'fixture']);
    const head = git(root, ['rev-parse', '--short', 'HEAD']);
    git(root, ['config', 'core.worktree', foreign]);
    writeFileSync(join(root, 'nested', 'file.txt'), 'modified');
    writeFileSync(join(root, 'new.txt'), 'new');
    await withServer(async url => {
        const response = await fetch(`${url}/api/code/git-info?cwd=${encodeURIComponent(join(root, 'nested'))}`);
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.equal(data.isRepo, true);
        assert.equal(data.repoRoot, realpathSync(root));
        assert.equal(data.relativePath, 'nested');
        assert.equal(data.branch, 'main');
        assert.equal(data.head, head);
        assert.deepEqual(data.status, { dirty: true, changed: 1, untracked: 1 });
    });
});

test('workspace metadata recognizes linked worktrees without changing repository configuration', async t => {
    const parent = mkdtempSync(join(tmpdir(), 'code-git-linked-'));
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    const root = join(parent, 'repo'); const linked = join(parent, 'linked');
    mkdirSync(root); git(root, ['init', '-b', 'main']);
    writeFileSync(join(root, 'file.txt'), 'baseline');
    git(root, ['add', '.']); git(root, ['commit', '-m', 'fixture']);
    git(root, ['worktree', 'add', '-b', 'linked', linked]);
    const configuration = git(root, ['config', '--local', '--get-regexp', '^core\.']);
    await withServer(async url => {
        const data = await (await fetch(`${url}/api/code/git-info?cwd=${encodeURIComponent(linked)}`)).json();
        assert.equal(data.repoRoot, realpathSync(linked));
        assert.equal(data.branch, 'linked');
        assert.equal(data.currentWorktree.path, realpathSync(linked));
        assert.equal(data.currentWorktree.current, true);
    });
    assert.equal(git(root, ['config', '--local', '--get-regexp', '^core\.']), configuration);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

test('FolderPanel consumes worktree hook unconditionally and keeps project surfaces separate', () => {
    const panel = read('public/manager/src/folder-panel/FolderPanel.tsx');
    const operations = read('public/manager/src/folder-panel/use-folder-worktree-operations.ts');

    assert.ok(panel.includes("import { useGitWorktrees } from './use-git-worktrees'"), 'FolderPanel must consume the worktree hook');
    assert.ok(panel.includes('const worktreeState = useGitWorktrees({'), 'FolderPanel must call the worktree hook unconditionally');
    assert.ok(panel.includes("enabled: source.kind === 'electron-folder' && gitStatus.available"), 'worktree hook must be gated by an enabled flag');
    assert.ok(panel.includes('worktreeOps.openWorktreeRoot(path)'), 'FolderPanel must route worktree opening through the operation hook');
    assert.ok(operations.includes('openFolderRoot(path, { registerGitWorktree: true'), 'worktree opening must use the shared root opener');
    assert.ok(operations.includes('repoRoot: worktreeState.repoRoot'), 'worktree opening must pass repoRoot through the normalized opener path');
    assert.equal(panel.includes('projectDirs'), false, 'FolderPanel must not mutate projectDirs');
    assert.equal(panel.includes('terminal'), false, 'FolderPanel worktree switching must not touch terminal cwd');
    assert.equal(panel.includes('iframe'), false, 'FolderPanel worktree switching must not touch preview iframe state');
});

test('worktree client keeps frontend type ownership local and normalizes null repo roots', () => {
    const client = read('public/manager/src/folder-panel/folder-worktree-client.ts');
    const hook = read('public/manager/src/folder-panel/use-git-worktrees.ts');
    const bridge = read('public/manager/src/panels/desktop-bridge.ts');

    assert.ok(client.includes("import type { GitWorktreeEntry } from './folder-worktree-types'"), 'worktree client must use the frontend mirror type');
    assert.ok(bridge.includes("import type { GitWorktreeEntry } from '../folder-panel/folder-worktree-types'"), 'desktop bridge must use the frontend mirror type');
    assert.equal(client.includes('src/manager/git/worktree-service'), false, 'frontend must not import backend worktree service modules');
    assert.ok(client.includes('const requestedRepoRoot = repoRoot ?? undefined'), 'client must normalize nullable repo roots before bridge/HTTP calls');
    assert.ok(client.includes('} catch (error) {'), 'client must catch bridge/fetch/json failures and return state instead of rejecting');
    assert.ok(hook.includes('repoRoot ?? undefined'), 'hook path must avoid leaking null repo roots to the client boundary');
    assert.ok(hook.includes('loading: false'), 'hook must always be able to leave loading state from client results');
});

test('FolderPanel toolbar renders compact worktree dropdown using existing dense UI surface', () => {
    const toolbar = read('public/manager/src/folder-panel/FolderPanelToolbar.tsx');
    const css = read('public/manager/src/folder-panel/folder-panel.css');

    assert.ok(toolbar.includes('worktreeSummary?: FolderWorktreeState'), 'toolbar must accept worktree state');
    assert.ok(toolbar.includes('Worktrees'), 'toolbar must expose compact worktree copy');
    assert.ok(toolbar.includes('folder-worktree-menu'), 'toolbar must render a worktree menu');
    assert.ok(toolbar.includes('folder-worktree-current'), 'toolbar must mark the current worktree');
    assert.ok(css.includes('left: 0;'), 'worktree menu must open from the button left edge so it does not clip against the panel left edge');
    assert.equal(css.includes('right: 0;'), false, 'worktree menu must not right-anchor a wide popup from a mid-toolbar button');
    assert.ok(css.includes('width: min(320px, calc(100vw - 24px));'), 'worktree menu width must stay compact enough for the right sidebar');
    for (const selector of [
        '.folder-worktree',
        '.folder-worktree-btn',
        '.folder-worktree-menu',
        '.folder-worktree-row',
        '.folder-worktree-title',
        '.folder-worktree-meta',
        '.folder-worktree-actions',
    ]) {
        assert.ok(css.includes(selector), `folder panel CSS must include ${selector}`);
    }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSourceControlGroups, readSourceControlSnapshotOptions } from '../../src/manager/git/source-control-service.js';
import type { GitFileDecoration } from '../../src/manager/git/status-service.js';

function gitFile(input: Partial<GitFileDecoration> & Pick<GitFileDecoration, 'repoRelativePath' | 'kind'>): GitFileDecoration {
    return {
        path: `/Users/test/repo/${input.repoRelativePath}`,
        staged: false,
        unstaged: false,
        ignored: false,
        conflict: false,
        submodule: false,
        ...input,
    };
}

test('source control snapshot groups conflict, staged, unstaged, and untracked files', () => {
    const groups = buildSourceControlGroups([
        gitFile({ repoRelativePath: 'conflict.ts', kind: 'conflict', conflict: true, staged: true, unstaged: true }),
        gitFile({ repoRelativePath: 'staged.ts', kind: 'modified', staged: true }),
        gitFile({ repoRelativePath: 'changed.ts', kind: 'modified', unstaged: true }),
        gitFile({ repoRelativePath: 'new.ts', kind: 'untracked', unstaged: true }),
        gitFile({ repoRelativePath: 'ignored.log', kind: 'ignored', ignored: true }),
        gitFile({ repoRelativePath: 'module', kind: 'submodule', submodule: true }),
    ]);

    assert.deepEqual(groups.map(group => group.id), ['conflicts', 'staged', 'changes', 'untracked']);
    assert.deepEqual(groups.find(group => group.id === 'conflicts')?.files.map(file => file.repoRelativePath), ['conflict.ts']);
    assert.deepEqual(groups.find(group => group.id === 'staged')?.files.map(file => file.repoRelativePath), ['staged.ts']);
    assert.deepEqual(groups.find(group => group.id === 'changes')?.files.map(file => file.repoRelativePath), ['changed.ts']);
    assert.deepEqual(groups.find(group => group.id === 'untracked')?.files.map(file => file.repoRelativePath), ['new.ts']);
});

test('source control snapshot options include untracked files by default', () => {
    assert.deepEqual(readSourceControlSnapshotOptions(undefined), { includeUntracked: true });
    assert.deepEqual(readSourceControlSnapshotOptions({ includeUntracked: false }), { includeUntracked: false });
});

test('source control snapshot is exposed through web and Electron diff bridges', () => {
    const bridgeSource = readFileSync('public/manager/src/panels/desktop-bridge.ts', 'utf8');
    const preloadSource = readFileSync('electron/src/preload/index.ts', 'utf8');
    const ipcSource = readFileSync('electron/src/main/lib/git/ipc.ts', 'utf8');
    const routeSource = readFileSync('src/manager/routes/dashboard-git.ts', 'utf8');
    const clientSource = readFileSync('public/manager/src/diff-panel/diff-client.ts', 'utf8');
    const panelSource = readFileSync('public/manager/src/diff-panel/DiffPanel.tsx', 'utf8');

    assert.ok(bridgeSource.includes('getScmSnapshot'), 'desktop bridge type must expose SCM snapshot reads');
    assert.ok(preloadSource.includes("ipcRenderer.invoke('diff:getScmSnapshot'"), 'preload must expose Electron SCM snapshot IPC');
    assert.ok(ipcSource.includes("ipcMain.handle('diff:getScmSnapshot'"), 'Electron main must implement SCM snapshot IPC');
    assert.ok(routeSource.includes("router.post('/scm-snapshot'"), 'web dashboard route must expose SCM snapshot reads');
    assert.ok(clientSource.includes("'/api/dashboard/git/scm-snapshot'"), 'web diff client must call SCM snapshot route');
    assert.ok(panelSource.includes('groupedDiffFiles(scmSnapshot, files)'), 'DiffPanel must render grouped SCM files');
    assert.ok(panelSource.includes('diff-file-group-heading'), 'DiffPanel must render group headings');
});

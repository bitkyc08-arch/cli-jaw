import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSourceControlOperation } from '../../src/manager/git/source-control-operations.js';

test('source control operation reader accepts only safe relative paths', () => {
    assert.deepEqual(readSourceControlOperation({
        kind: 'stage',
        paths: ['src/a.ts', 'src/../src/b.ts', 'src/a.ts'],
    }), {
        kind: 'stage',
        paths: ['src/a.ts', 'src/b.ts'],
    });

    assert.throws(() => readSourceControlOperation({ kind: 'commit', paths: ['a.ts'] }), /unsupported/);
    assert.throws(() => readSourceControlOperation({ kind: 'stage', paths: ['/tmp/a.ts'] }), /at least one/);
    assert.throws(() => readSourceControlOperation({ kind: 'stage', paths: ['../a.ts'] }), /at least one/);
    assert.throws(() => readSourceControlOperation({ kind: 'stage', paths: [] }), /at least one/);
});

test('safe stage and unstage operations are exposed without discard or commit routes', () => {
    const bridgeSource = readFileSync('public/manager/src/panels/desktop-bridge.ts', 'utf8');
    const preloadSource = readFileSync('electron/src/preload/index.ts', 'utf8');
    const ipcSource = readFileSync('electron/src/main/lib/git/ipc.ts', 'utf8');
    const routeSource = readFileSync('src/manager/routes/dashboard-git.ts', 'utf8');
    const clientSource = readFileSync('public/manager/src/diff-panel/diff-client.ts', 'utf8');
    const panelSource = readFileSync('public/manager/src/diff-panel/DiffPanel.tsx', 'utf8');

    assert.ok(bridgeSource.includes('runScmOperation'), 'desktop bridge must expose guarded SCM operation runner');
    assert.ok(preloadSource.includes("ipcRenderer.invoke('diff:runScmOperation'"), 'preload must expose Electron SCM operation IPC');
    assert.ok(ipcSource.includes("ipcMain.handle('diff:runScmOperation'"), 'Electron main must implement SCM operation IPC');
    assert.ok(routeSource.includes("router.post('/scm-operation'"), 'web route must expose guarded SCM operation runner');
    assert.ok(clientSource.includes("'/api/dashboard/git/scm-operation'"), 'web diff client must call SCM operation route');
    assert.ok(panelSource.includes("group.id === 'staged'"), 'DiffPanel must inspect the staged group for unstage actions');
    assert.ok(panelSource.includes("action: 'unstage'"), 'DiffPanel must map staged group to unstage action');
    assert.ok(panelSource.includes("group.id === 'changes' || group.id === 'untracked'"), 'DiffPanel must inspect changes and untracked groups for stage actions');
    assert.ok(panelSource.includes("action: 'stage'"), 'DiffPanel must map changes and untracked groups to stage action');
    assert.ok(!routeSource.includes("router.post('/commit'"), 'Cycle 3 must not expose commit operation');
    assert.ok(!routeSource.includes("router.post('/discard'"), 'Cycle 3 must not expose discard operation');
});

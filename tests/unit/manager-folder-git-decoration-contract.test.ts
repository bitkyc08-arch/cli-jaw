import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

test('FolderPanel git decoration hook is unconditional and independent from project roots', () => {
    const panel = read('public/manager/src/folder-panel/FolderPanel.tsx');

    assert.ok(panel.includes("import { useFolderGitStatus } from './use-folder-git-status'"), 'FolderPanel must consume the git status hook');
    assert.ok(panel.includes('const gitStatus = useFolderGitStatus({'), 'FolderPanel must call the hook unconditionally');
    assert.ok(panel.includes("enabled: source.kind === 'electron-folder'"), 'FolderPanel must pass an enabled flag instead of conditionally calling a hook');
    assert.equal(panel.includes('projectDirs'), false, 'FolderPanel must remain independent from projectDirs');
});

test('folder tree rows render stable git decoration classes and badges', () => {
    const rows = read('public/manager/src/folder-panel/FolderTreeRows.tsx');
    const css = read('public/manager/src/folder-panel/folder-panel.css');

    assert.ok(rows.includes('decorationsByPath: Map<string, FolderPanelRowDecoration>'), 'row component must accept a decoration map');
    assert.ok(rows.includes('props.decorationsByPath.get(entry.path)'), 'row component must look up decorations by absolute path');
    assert.ok(rows.includes('folder-entry-git-badge'), 'row component must render a stable git badge element');
    for (const token of ['git-modified', 'git-added', 'git-deleted', 'git-renamed', 'git-untracked', 'git-ignored', 'git-conflict', 'git-submodule']) {
        assert.ok(css.includes(token), `folder panel CSS must define ${token}`);
    }
});

test('desktop git bridge exposes status map without reusing DiffPanel capability contracts', () => {
    const bridge = read('public/manager/src/panels/desktop-bridge.ts');
    const preload = read('electron/src/preload/index.ts');
    const ipc = read('electron/src/main/lib/git/ipc.ts');
    const route = read('src/manager/routes/dashboard-git.ts');

    assert.ok(bridge.includes("DesktopShellCapability = 'terminal' | 'diff' | 'git'"), 'desktop capability union must include git');
    assert.ok(bridge.includes('git?: GitBridgeApi'), 'desktop bridge must expose a top-level git API');
    assert.ok(preload.includes("ipcRenderer.invoke('git:getStatusMap'"), 'preload must expose git:getStatusMap');
    assert.ok(ipc.includes("ipcMain.handle('git:getStatusMap'"), 'Electron main must register git:getStatusMap');
    assert.ok(route.includes("router.post('/status-map'"), 'dashboard git router must expose status-map route');
    assert.ok(route.includes('resolveFolderGitRoot(folderPanelRoot, repoRoot)'), 'status-map route must use FolderPanel root validation');
});

test('folder git status self-heals on repo root mismatch by retrying without the stale repoRoot hint', () => {
    const hook = read('public/manager/src/folder-panel/use-folder-git-status.ts');

    assert.ok(hook.includes('/repo root mismatch/i.test(result.error)'), 'hook must detect repo root mismatch errors');
    assert.ok(hook.includes('const healed = await loadFolderGitStatus(rootPath, {'), 'hook must retry git status without the stale repoRoot hint');
    assert.ok(!/healed = await loadFolderGitStatus\(rootPath, \{[^}]*repoRoot/s.test(hook), 'self-heal retry must omit the repoRoot hint so the folder root auto-detects');
    assert.ok(hook.includes('setState(stateFromStatus(healed.status))'), 'a successful self-heal retry must replace the unavailable state');
});

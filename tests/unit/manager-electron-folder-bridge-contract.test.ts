import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

test('Electron folder bridge exposes safe move, create, rename, and reveal operations', () => {
    const preload = read('electron/src/preload/index.ts');
    const desktopBridge = read('public/manager/src/panels/desktop-bridge.ts');

    assert.ok(preload.includes("ipcRenderer.invoke('folder:movePath'"), 'preload must expose folder move through IPC');
    assert.ok(preload.includes("ipcRenderer.invoke('folder:createFile'"), 'preload must expose folder file creation through IPC');
    assert.ok(preload.includes("ipcRenderer.invoke('folder:createFolder'"), 'preload must expose folder creation through IPC');
    assert.ok(preload.includes("ipcRenderer.invoke('folder:renamePath'"), 'preload must expose folder rename through IPC');
    assert.ok(preload.includes("ipcRenderer.invoke('folder:revealPath'"), 'preload must expose folder reveal through IPC');
    assert.ok(desktopBridge.includes('export type FolderMoveResult'), 'desktop bridge must type folder move results');
    assert.ok(desktopBridge.includes('export type FolderMutationResult'), 'desktop bridge must type folder mutation results');
    assert.ok(desktopBridge.includes('code?: string'), 'folder mutation results must carry typed failure codes for guarded mutations');
    assert.ok(
        desktopBridge.includes('movePath: (sourcePath: string, targetDirectory: string) => Promise<FolderMoveResult>'),
        'FolderBridgeApi must include movePath',
    );
    assert.ok(
        desktopBridge.includes('revealPath: (path: string) => Promise<{ ok: boolean; error?: string }>'),
        'FolderBridgeApi must include revealPath',
    );
    assert.ok(
        desktopBridge.includes('createFile: (parentDirectory: string, name: string) => Promise<FolderMutationResult>'),
        'FolderBridgeApi must include createFile',
    );
    assert.ok(
        desktopBridge.includes('createFolder: (parentDirectory: string, name: string) => Promise<FolderMutationResult>'),
        'FolderBridgeApi must include createFolder',
    );
    assert.ok(
        desktopBridge.includes('renamePath: (sourcePath: string, name: string) => Promise<FolderMutationResult>'),
        'FolderBridgeApi must include renamePath',
    );
});

test('Electron folder rename rejects existing targets before filesystem rename', () => {
    const ipc = read('electron/src/main/lib/folder/ipc.ts');
    const targetExistsGuard = ipc.indexOf("code: 'target_exists'");
    const renameCall = ipc.indexOf('await rename(source, target)');

    assert.ok(targetExistsGuard > 0, 'folder rename IPC must return a target_exists failure code');
    assert.ok(renameCall > 0, 'folder rename IPC must still call filesystem rename for valid targets');
    assert.ok(targetExistsGuard < renameCall, 'target existence must be checked before filesystem rename');
    assert.ok(ipc.includes('await lstat(target)'), 'folder rename IPC must check target existence using lstat');
});

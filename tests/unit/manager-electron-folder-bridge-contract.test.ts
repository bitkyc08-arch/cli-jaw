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
    assert.ok(preload.includes("ipcRenderer.invoke('folder:authorizeRoot'"), 'preload must expose persisted root authorization through IPC');
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
        desktopBridge.includes('authorizeRoot?: (rootPath: string) => Promise<{ ok: boolean; path?: string; error?: string }>'),
        'FolderBridgeApi must include persisted root authorization',
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

test('Electron folder IPC can re-authorize persisted roots after app restart', () => {
    const ipc = read('electron/src/main/lib/folder/ipc.ts');
    const store = read('electron/src/main/lib/folder/approved-roots-store.ts');
    const authorizeHandler = ipc.indexOf("ipcMain.handle('folder:authorizeRoot'");
    const listHandler = ipc.indexOf("ipcMain.handle('folder:listDir'");

    assert.ok(authorizeHandler > 0, 'folder IPC must expose an authorizeRoot handler');
    assert.ok(listHandler > 0, 'folder IPC must still expose listDir');
    assert.ok(authorizeHandler < listHandler, 'persisted roots must be authorizable before listDir rejects unpicked paths');
    assert.ok(ipc.includes("from './approved-roots-store.js'"), 'folder IPC must use the durable approved roots store');
    assert.ok(ipc.includes('void ensureApprovedRootsSeeded()'), 'folder IPC registration must start allowlist rehydration');
    assert.ok(ipc.includes('await ensureApprovedRootsSeeded();'), 'folder IPC handlers must wait for rehydration before allowlist checks');
    assert.ok(ipc.includes('loadApprovedFolderRoots()'), 'folder IPC must load persisted roots on startup');
    assert.ok(ipc.includes('rememberApprovedFolderRoot(targetReal)'), 'successfully authorized roots must be persisted');
    assert.ok(ipc.includes('async function authorizeFolderRoot'), 'folder IPC must validate persisted roots through a shared authorizer');
    assert.ok(ipc.includes("if (!isWithinHome(target)) return { ok: false, error: 'path not allowed' }"), 'persisted roots must stay inside the user home');
    assert.ok(ipc.includes("if (ls.isSymbolicLink()) return { ok: false, error: 'symlinks not allowed' }"), 'persisted roots must reject symlinks');
    assert.ok(ipc.includes("if (!ls.isDirectory()) return { ok: false, error: 'root must be a directory' }"), 'persisted roots must be real directories');
    assert.ok(ipc.includes('pickedRoots.add(targetReal)'), 'authorized persisted roots must repopulate the process-local allowlist');
    assert.ok(store.includes("const STORE_FILE = 'folder-approved-roots.json'"), 'approved roots store must have a stable app-data filename');
    assert.ok(store.includes("app.getPath('userData')"), 'approved roots store must live under Electron userData');
    assert.ok(store.includes('export async function loadApprovedFolderRoots'), 'approved roots store must expose load');
    assert.ok(store.includes('export async function saveApprovedFolderRoots'), 'approved roots store must expose save');
    assert.ok(store.includes('export async function rememberApprovedFolderRoot'), 'approved roots store must expose append/update');
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

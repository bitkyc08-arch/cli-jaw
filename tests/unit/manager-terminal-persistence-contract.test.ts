import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeStrictPropertyAccess } from './source-normalize';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return normalizeStrictPropertyAccess(readFileSync(join(projectRoot, path), 'utf8'));
}

function cleanupBody(source: string): string {
    const cleanupStart = source.indexOf('return () => {\n            offData();');
    assert.notEqual(cleanupStart, -1, 'TerminalPanel must keep the bridge listener cleanup block');
    const cleanupEnd = source.indexOf('};\n    }, [bridge, disposeRuntime', cleanupStart);
    assert.notEqual(cleanupEnd, -1, 'TerminalPanel cleanup block must keep the expected dependency boundary');
    return source.slice(cleanupStart, cleanupEnd);
}

function closeSessionBody(source: string): string {
    const closeStart = source.indexOf('const closeSession = useCallback');
    assert.notEqual(closeStart, -1, 'TerminalPanel must keep an explicit closeSession callback');
    const closeEnd = source.indexOf('const handleTerminalDragOver', closeStart);
    assert.notEqual(closeEnd, -1, 'TerminalPanel closeSession block must keep the expected boundary');
    return source.slice(closeStart, closeEnd);
}

test('Electron terminal backend exposes live session snapshots for renderer remounts', () => {
    const terminalMain = read('electron/src/main/lib/terminal/index.ts');
    const preload = read('electron/src/preload/index.ts');
    const desktopBridge = read('public/manager/src/panels/desktop-bridge.ts');

    assert.ok(terminalMain.includes("ipcMain.handle('terminal:list'"), 'Electron main must expose terminal:list');
    assert.ok(terminalMain.includes('shell: string'), 'TermSession must persist shell for restored tabs');
    assert.ok(terminalMain.includes('cwd: string'), 'TermSession must persist cwd for restored tabs');
    assert.ok(terminalMain.includes('cols: number'), 'TermSession must persist cols for restored size');
    assert.ok(terminalMain.includes('rows: number'), 'TermSession must persist rows for restored size');
    assert.ok(terminalMain.includes('buffer: session.buffer'), 'terminal:list must return the capped scroll buffer');
    assert.ok(terminalMain.includes('session.cols = clampDimension(cols'), 'resize must persist the clamped column count');
    assert.ok(terminalMain.includes('session.rows = clampDimension(rows'), 'resize must persist the clamped row count');
    assert.ok(preload.includes("list: () => ipcRenderer.invoke('terminal:list')"), 'preload must expose terminal:list');
    assert.ok(preload.includes('create: (opts?: { cwd?: string; cols?: number; rows?: number })'), 'preload create opts must match renderer cols/rows');
    assert.ok(desktopBridge.includes('list: () => Promise<{ ok: boolean; sessions?: TerminalSessionSnapshot[]; error?: string }>'), 'desktop bridge must type terminal:list');
    assert.ok(desktopBridge.includes('export type TerminalSessionSnapshot'), 'desktop bridge must expose terminal snapshot type');
});

test('TerminalPanel restores sessions before creating and never kills PTYs on unmount', () => {
    const terminal = read('public/manager/src/terminal/TerminalPanel.tsx');
    const cleanup = cleanupBody(terminal);
    const closeSession = closeSessionBody(terminal);

    assert.ok(terminal.includes('hydrationCompleteRef'), 'TerminalPanel must gate create requests on hydration completion');
    assert.ok(terminal.includes('const result = await terminalBridge.list()'), 'TerminalPanel must hydrate from terminal:list before auto-create');
    assert.ok(terminal.includes('restoreSession'), 'TerminalPanel must restore listed sessions into tabs/runtimes');
    assert.ok(terminal.includes('queuedNewSessionCountRef'), 'new terminal requests during hydration must be queued');
    assert.ok(terminal.includes("detail === 'flushTerminalShortcutQueue'"), 'TerminalPanel must consume deferred provider shortcut requests');
    assert.equal(cleanup.includes('bridge.kill'), false, 'TerminalPanel unmount cleanup must not kill live PTY sessions');
    assert.ok(closeSession.includes('void bridge.kill(id)'), 'explicit terminal tab close must still kill only that session');
});

test('Manager terminal shortcuts separate reveal from new-session creation', () => {
    const shortcuts = read('public/manager/src/manager-shortcuts.ts');
    const panelProvider = read('public/manager/src/panels/PanelLayoutProvider.tsx');
    const runner = read('public/manager/src/manager-shortcut-runner.ts');
    const main = read('electron/src/main/index.ts');
    const previewBridge = read('public/js/features/preview-shortcut-bridge.ts');
    const desktopControls = read('public/manager/src/components/DesktopPanelControls.tsx');

    assert.ok(shortcuts.includes("focusTerminal: 'Ctrl+`'"), 'Ctrl+` must reveal/focus an existing terminal');
    assert.ok(shortcuts.includes("newTerminalSession: 'Ctrl+Shift+`'"), 'Ctrl+Shift+` must create a new terminal session');
    assert.ok(shortcuts.includes("focusTerminal: ['Ctrl+`', 'Meta+`']"), 'Meta+` must remain a reveal/focus alias');
    assert.ok(panelProvider.includes("case 'newTerminalSession':"), 'PanelLayoutProvider must own global new terminal routing');
    assert.ok(panelProvider.includes("__cliJawPendingTerminalActions"), 'global terminal shortcut routing must survive lazy TerminalPanel mount');
    assert.ok(runner.includes("panelShortcutBus.dispatch('newTerminalSession')"), 'menu new-tab action must create a terminal even outside terminal focus');
    assert.ok(main.includes("return 'newTerminalSession'"), 'Electron native Ctrl+Shift+Backquote must map to newTerminalSession');
    assert.ok(main.includes("return 'focusTerminal'"), 'Electron native Ctrl+Backquote/Meta+Backquote must map to focusTerminal');
    assert.ok(previewBridge.includes('e.ctrlKey && !e.metaKey && !e.altKey'), 'preview bridge must forward both Ctrl+` and Ctrl+Shift+`');
    assert.ok(desktopControls.includes('Terminal (Ctrl+`)'), 'desktop terminal button tooltip must show the reveal shortcut');
});

test('SidebarRailRouter keeps the bottom panel mounted when collapsed', () => {
    const router = read('public/manager/src/SidebarRailRouter.tsx');

    assert.ok(router.includes('bottomPanelContent={panelLayout.state.bottomPanel.tabs.length > 0 ? <BottomPanel'), 'bottom panel host must remain rendered while bottom tabs exist');
    assert.equal(router.includes('bottomPanelOpen && panelLayout.state.bottomPanel.tabs.length > 0'), false, 'bottomPanelOpen must not gate BottomPanel mounting');
}
);

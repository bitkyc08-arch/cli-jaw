import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

test('Terminal panel is an Electron PTY surface, not a Manager Code mode surface', () => {
    const terminalPanel = read('public/manager/src/terminal/TerminalPanel.tsx');
    const terminalBridge = read('public/manager/src/terminal/terminal-bridge.ts');
    const desktopBridge = read('public/manager/src/panels/desktop-bridge.ts');
    const panelCapabilities = read('public/manager/src/panels/panel-capabilities.ts');
    const router = read('public/manager/src/SidebarRailRouter.tsx');

    assert.match(terminalPanel, /import \{ getTerminalBridge \} from '\.\/terminal-bridge'/, 'TerminalPanel must use the terminal bridge boundary');
    assert.match(terminalPanel, /const bridge = getTerminalBridge\(\)/, 'TerminalPanel must acquire the Electron terminal bridge explicitly');
    assert.match(terminalBridge, /return getDesktop\(\)\?\.terminal \?\? null;/, 'terminal bridge must only expose window.cliJawDesktop.terminal');
    assert.match(desktopBridge, /export type TerminalBridgeApi = \{[\s\S]*list: \(\) => Promise<\{ ok: boolean; sessions\?: TerminalSessionSnapshot\[\]; error\?: string \}>/, 'desktop bridge must own terminal session snapshots');
    assert.match(panelCapabilities, /terminal: capability\('terminal', 'enabled'\)/, 'terminal must be enabled for the Electron Manager surface');
    assert.match(panelCapabilities, /terminal: capability\('terminal', 'disabled', 'Terminal requires the desktop PTY bridge\.'\)/, 'terminal must be disabled for the web Manager surface');
    assert.match(router, /case 'terminal': return <Suspense fallback=\{fallback\}><TerminalPanel/, 'terminal must mount as a bottom panel tab, not inside Code mode');

    assert.doesNotMatch(terminalPanel, /\/api\/code\b/, 'TerminalPanel must not call Manager Code APIs');
    assert.doesNotMatch(terminalPanel, /CodeCanvas|CodeWorkbench|CodeCommandPopup|CodeSessionList/, 'TerminalPanel must not import Code workbench modules');
    assert.doesNotMatch(terminalPanel, /code_child_exit|code_permission_request|code_available_commands_update/, 'TerminalPanel must not consume JWC ACP Code events');
    assert.doesNotMatch(terminalBridge, /\/api\/code\b|CodeCanvas|CodeWorkbench|code_child_exit/, 'terminal bridge must stay independent from Code mode');
});

test('Electron terminal IPC owns shell process lifecycle separately from Code ACP child lifecycle', () => {
    const terminalMain = read('electron/src/main/lib/terminal/index.ts');
    const preload = read('electron/src/preload/index.ts');
    const codeCanvas = read('public/manager/src/code/CodeCanvas.tsx');
    const codeWorkbench = read('public/manager/src/code/CodeWorkbench.tsx');

    assert.match(terminalMain, /import \{ spawn as spawnPty \} from 'node-pty'/, 'Electron terminal backend must use node-pty');
    assert.match(terminalMain, /const sessions = new Map<string, TermSession>\(\)/, 'terminal process sessions must live in the Electron terminal module');
    assert.match(terminalMain, /ipcMain\.handle\('terminal:create'/, 'terminal:create must be the shell process creation boundary');
    assert.match(terminalMain, /ipcMain\.handle\('terminal:write'/, 'terminal writes must route through terminal:write');
    assert.match(terminalMain, /ipcMain\.handle\('terminal:resize'/, 'terminal resize must route through terminal:resize');
    assert.match(terminalMain, /ipcMain\.handle\('terminal:kill'/, 'terminal kill must route through terminal:kill');
    assert.match(terminalMain, /win\.webContents\.send\('terminal:data'/, 'terminal output must be emitted as terminal:data');
    assert.match(terminalMain, /win\.webContents\.send\('terminal:exit'/, 'terminal process exit must be emitted as terminal:exit');
    assert.match(preload, /terminal: \{[\s\S]*create: \(opts\?: \{ cwd\?: string; cols\?: number; rows\?: number \}\) => ipcRenderer\.invoke\('terminal:create', opts\)/, 'preload must expose terminal IPC under cliJawDesktop.terminal');
    assert.match(preload, /ipcRenderer\.on\('terminal:data'/, 'preload must expose terminal data events');
    assert.match(preload, /ipcRenderer\.on\('terminal:exit'/, 'preload must expose terminal exit events');

    assert.match(codeCanvas, /kind === 'code_child_exit'/, 'CodeCanvas must own JWC ACP child exit recovery');
    assert.doesNotMatch(codeCanvas, /getTerminalBridge|TerminalPanel|terminal:create|terminal:exit/, 'CodeCanvas must not own Electron terminal lifecycle');
    assert.doesNotMatch(codeWorkbench, /getTerminalBridge|TerminalPanel|terminal:create|terminal:exit/, 'CodeWorkbench must not own Electron terminal lifecycle');
    assert.doesNotMatch(terminalMain, /code_child_exit|code_permission_request|\/api\/code|jwc --mode acp/, 'Electron terminal backend must not emit or host Code ACP sessions');
});

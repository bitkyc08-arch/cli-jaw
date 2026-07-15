import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const terminal = readFileSync('public/dashboard2/src/shell/panels/TerminalPanel.tsx', 'utf8');
const sidePane = readFileSync('public/dashboard2/src/shell/SidePane.tsx', 'utf8');

test('dashboard2 terminal resolves selected instance cwd with a stale-response guard', () => {
    assert.match(sidePane, /useManagerApi\(\)/);
    assert.match(sidePane, /api\.fetchInstances\(\)/);
    assert.match(sidePane, /cwdRequestGeneration\.current !== generation/);
    assert.match(sidePane, /setTerminalWorkingDir\(null\)/);
    assert.match(sidePane, /<TerminalPanel port=\{port\} workingDir=\{terminalWorkingDir\}/);
    assert.match(terminal, /workingDir: string \| null/);
    assert.match(terminal, /nativeTerminal\.create\(\{ cwd: workingDir, cols: terminal\.cols, rows: terminal\.rows \}\)/);
    assert.match(terminal, /if \(!container \|\| !nativeTerminal \|\| port === null \|\| !workingDir\) return/);
});

test('dashboard2 terminal is honest when native transport is unavailable', () => {
    assert.match(terminal, /Terminal requires the cli-jaw Electron app/);
    assert.doesNotMatch(terminal, /Local echo mode is active/);
    assert.doesNotMatch(terminal, /terminal\.write\('\\r\\n\$ '\)/);
    const nativeGuard = terminal.indexOf('if (!nativeTerminal)');
    const terminalConstruction = terminal.indexOf('const terminal = new Terminal');
    assert.ok(nativeGuard > terminalConstruction, 'render guard and lifecycle guard must both prevent non-native input setup');
});

test('dashboard2 terminal handles exit, restart, cwd mismatch, and shortcuts without duplicate sessions', () => {
    assert.match(terminal, /nativeTerminal\.onExit/);
    assert.match(terminal, /inputEnabledRef\.current = false/);
    assert.match(terminal, /Terminal exited with code/);
    assert.match(terminal, /Restart terminal/);
    assert.match(terminal, /setRestartGeneration/);
    assert.match(terminal, /actualCwd === workingDir/);
    assert.match(terminal, /Terminal requested \$\{workingDir\}; running in \$\{actualCwd\}/);
    assert.match(terminal, /action === 'terminalClear'/);
    assert.match(terminal, /terminalRef\.current\?\.clear\(\)/);
    assert.match(terminal, /action === 'terminalNewTab'/);
    assert.match(terminal, /New terminal tabs will be available in 089\.12/);
    assert.equal((terminal.match(/nativeTerminal\.create\(/g) ?? []).length, 1, 'terminalNewTab must not add a second create path');
    assert.match(terminal, /unsubscribeData\(\);[\s\S]*unsubscribeExit\(\);[\s\S]*inputDisposable\.dispose\(\)/);
});

test('terminal survives tab and pane hiding but is killed on actual unmount', () => {
    assert.match(sidePane, /id: 'terminal'[\s\S]*keepAlive: true/);
    assert.match(sidePane, /if \(desc\.keepAlive\)[\s\S]*mountedTabs\.has\(desc\.id\)/);
    assert.match(sidePane, /style=\{\{ display: isVisible \? undefined : 'none' \}\}/);
    assert.match(terminal, /return \(\) => \{[\s\S]*if \(id\) void nativeTerminal\.kill\(id\)/);
});

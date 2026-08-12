import assert from 'node:assert/strict';
import test from 'node:test';
import {
    detectWindowsShell,
    shellInvocationArgs,
    type WindowsShellProbes,
} from '../../src/core/windows-shell.ts';

function createProbes(options: {
    commands?: string[];
    paths?: string[];
    env?: NodeJS.ProcessEnv;
} = {}): WindowsShellProbes {
    const commands = new Set(options.commands ?? []);
    const paths = new Set(options.paths ?? []);
    return {
        commandExists: command => commands.has(command),
        pathExists: candidate => paths.has(candidate),
        env: options.env ?? {},
    };
}

test('detectWindowsShell prefers pwsh.exe when it is available', () => {
    const probes = createProbes({
        commands: ['pwsh.exe', 'powershell.exe'],
        paths: ['C:\\Program Files\\Git\\bin\\bash.exe'],
    });

    assert.equal(detectWindowsShell(probes), 'pwsh7');
});

test('detectWindowsShell falls back to Windows PowerShell before Git Bash', () => {
    const probes = createProbes({
        commands: ['powershell.exe'],
        paths: ['C:\\Program Files\\Git\\bin\\bash.exe'],
    });

    assert.equal(detectWindowsShell(probes), 'powershell5');
});

test('detectWindowsShell finds a common Git Bash installation after PowerShell probes fail', () => {
    const gitBash = 'D:\\Programs\\Git\\bin\\bash.exe';
    const probes = createProbes({
        paths: [gitBash],
        env: { ProgramFiles: 'D:\\Programs' },
    });

    assert.equal(detectWindowsShell(probes), 'gitbash');
});

test('detectWindowsShell checks the standard Git Bash path without environment hints', () => {
    const probes = createProbes({
        paths: ['C:\\Program Files\\Git\\bin\\bash.exe'],
    });

    assert.equal(detectWindowsShell(probes), 'gitbash');
});

test('detectWindowsShell uses cmd when no preferred shell is available', () => {
    assert.equal(detectWindowsShell(createProbes()), 'cmd');
});

test('shellInvocationArgs returns shell-specific script argv', () => {
    const scriptPath = 'C:\\Temp\\setup script.ps1';

    assert.deepEqual(
        shellInvocationArgs('powershell5', scriptPath),
        ['-NoLogo', '-NoProfile', '-File', scriptPath],
    );
    assert.deepEqual(
        shellInvocationArgs('pwsh7', scriptPath),
        ['-NoLogo', '-NoProfile', '-File', scriptPath],
    );
    assert.deepEqual(shellInvocationArgs('cmd', scriptPath), ['/d', '/c', scriptPath]);
    assert.deepEqual(shellInvocationArgs('gitbash', scriptPath), ['--login', scriptPath]);
    assert.deepEqual(shellInvocationArgs('unknown', scriptPath), [scriptPath]);
});

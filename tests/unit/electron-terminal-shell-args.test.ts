import { test } from 'node:test';
import assert from 'node:assert';
import { loginArgsForShell } from '../../electron/src/main/lib/terminal/shell-args.ts';

test('loginArgsForShell: Windows console hosts get no -l', () => {
    assert.deepStrictEqual(loginArgsForShell('powershell.exe', 'win32'), []);
    assert.deepStrictEqual(loginArgsForShell('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32'), []);
    assert.deepStrictEqual(loginArgsForShell('pwsh.exe', 'win32'), []);
    assert.deepStrictEqual(loginArgsForShell('cmd.exe', 'win32'), []);
});

test('loginArgsForShell: posix shells keep -l everywhere', () => {
    assert.deepStrictEqual(loginArgsForShell('bash', 'win32'), ['-l']);
    assert.deepStrictEqual(loginArgsForShell('C:\\Program Files\\Git\\bin\\bash.exe', 'win32'), ['-l']);
    assert.deepStrictEqual(loginArgsForShell('/bin/zsh', 'darwin'), ['-l']);
    assert.deepStrictEqual(loginArgsForShell('/bin/sh', 'linux'), ['-l']);
});

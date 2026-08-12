import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 as pathWin32 } from 'node:path';

export type WindowsShellKind = 'powershell5' | 'pwsh7' | 'cmd' | 'gitbash' | 'unknown';

export interface WindowsShellProbes {
    commandExists(command: string): boolean;
    pathExists(candidate: string): boolean;
    env: NodeJS.ProcessEnv;
}

const defaultProbes: WindowsShellProbes = {
    commandExists(command) {
        try {
            execFileSync('where.exe', [command], {
                stdio: 'ignore',
                timeout: 2_000,
                windowsHide: true,
            });
            return true;
        } catch {
            return false;
        }
    },
    pathExists(candidate) {
        return existsSync(candidate);
    },
    env: process.env,
};

export function windowsGitBashPaths(env: NodeJS.ProcessEnv = process.env): string[] {
    const candidates = [
        env['ProgramW6432'],
        env['ProgramFiles'],
        env['ProgramFiles(x86)'],
        'C:\\Program Files',
        'C:\\Program Files (x86)',
    ]
        .filter((root): root is string => Boolean(root))
        .map(root => pathWin32.join(root, 'Git', 'bin', 'bash.exe'));

    if (env['LOCALAPPDATA']) {
        candidates.push(pathWin32.join(env['LOCALAPPDATA'], 'Programs', 'Git', 'bin', 'bash.exe'));
    }

    return [...new Set(candidates)];
}

export function detectWindowsShell(probes: Partial<WindowsShellProbes> = {}): WindowsShellKind {
    const commandExists = probes.commandExists ?? defaultProbes.commandExists;
    const pathExists = probes.pathExists ?? defaultProbes.pathExists;
    const env = probes.env ?? defaultProbes.env;

    if (commandExists('pwsh.exe')) return 'pwsh7';
    if (commandExists('powershell.exe')) return 'powershell5';
    if (windowsGitBashPaths(env).some(pathExists)) return 'gitbash';
    return 'cmd';
}

export function shellInvocationArgs(shell: WindowsShellKind, scriptPath: string): string[] {
    switch (shell) {
        case 'powershell5':
        case 'pwsh7':
            return ['-NoLogo', '-NoProfile', '-File', scriptPath];
        case 'cmd':
            return ['/d', '/c', scriptPath];
        case 'gitbash':
            return ['--login', scriptPath];
        case 'unknown':
            return [scriptPath];
    }
}

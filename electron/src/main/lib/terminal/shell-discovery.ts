import { existsSync } from 'node:fs';
import {
    detectWindowsShell,
    windowsGitBashPaths,
    type WindowsShellKind,
} from '../../../../../src/core/windows-shell.js';

const SHELLS: Record<string, string[]> = {
    darwin: ['/bin/zsh', '/bin/bash', '/bin/sh'],
    linux: ['/bin/bash', '/bin/zsh', '/bin/sh'],
};

function windowsShellExecutable(kind: WindowsShellKind): string {
    switch (kind) {
        case 'pwsh7':
            return 'pwsh.exe';
        case 'powershell5':
            return 'powershell.exe';
        case 'gitbash':
            return windowsGitBashPaths(process.env).find(existsSync) ?? 'bash.exe';
        case 'cmd':
        case 'unknown':
            return process.env['ComSpec'] || process.env['COMSPEC'] || 'cmd.exe';
    }
}

export function discoverShell(): string {
    if (process.platform === 'win32') {
        return windowsShellExecutable(detectWindowsShell());
    }
    const envShell = process.env.SHELL;
    if (envShell && existsSync(envShell)) return envShell;
    const candidates = SHELLS[process.platform] ?? ['/bin/sh'];
    for (const s of candidates) {
        if (existsSync(s)) return s;
    }
    return candidates[0] ?? '/bin/sh';
}

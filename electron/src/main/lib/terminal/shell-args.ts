// Pure login-arg decision for Electron terminal PTYs (T3/wp5).
// No electron imports so tests/unit can import it directly.
const WIN_NO_LOGIN = new Set(['powershell.exe', 'pwsh.exe', 'cmd.exe', 'powershell', 'pwsh', 'cmd']);

export function loginArgsForShell(shell: string, platform: NodeJS.Platform = process.platform): string[] {
    if (platform !== 'win32') return ['-l'];
    const base = (shell.split(/[\\/]/).pop() || shell).toLowerCase();
    if (WIN_NO_LOGIN.has(base)) return [];
    if (base.includes('bash') || base.includes('zsh') || base.includes('fish') || base === 'sh' || base === 'sh.exe') return ['-l'];
    return [];
}

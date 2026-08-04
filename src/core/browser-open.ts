import { spawn } from 'node:child_process';
import { isWsl, defaultPlatformProbes, type PlatformProbes } from './platform-kind.js';

type BrowserOpenCommand = {
    command: string;
    args: string[];
};

type BrowserOpenOptions = {
    logPrefix?: string;
};

export function isWslEnvironment(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
    probes: PlatformProbes = defaultPlatformProbes,
): boolean {
    return isWsl(platform, env, probes);
}

export function browserOpenCommand(
    url: string,
    platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    probes: PlatformProbes = defaultPlatformProbes,
): BrowserOpenCommand {
    if (platform === 'darwin') return { command: 'open', args: [url] };
    if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
    // The resolver owns the linux guard, so re-testing platform here would
    // imply it cannot be trusted.
    if (isWslEnvironment(env, platform, probes)) {
        // Probe-injected so the command choice is testable too, not just the
        // WSL decision: on a real WSL host the absolute path exists and would
        // otherwise make these fixtures host-dependent.
        const cmd = probes.exists('/mnt/c/Windows/System32/cmd.exe')
            ? '/mnt/c/Windows/System32/cmd.exe'
            : 'cmd.exe';
        return { command: cmd, args: ['/c', 'start', '', url] };
    }
    return { command: 'xdg-open', args: [url] };
}

export function openUrlInBrowser(url: string, options: BrowserOpenOptions = {}): void {
    const logPrefix = options.logPrefix || 'browser';
    try {
        const { command, args } = browserOpenCommand(url);
        const opener = spawn(command, args, { detached: true, stdio: 'ignore' });
        opener.on('error', error => {
            console.warn(`[${logPrefix}] failed to open browser automatically: ${error.message}`);
            console.warn(`[${logPrefix}] open manually: ${url}`);
        });
        opener.unref();
    } catch (error) {
        console.warn(`[${logPrefix}] failed to open browser automatically: ${(error as Error).message}`);
        console.warn(`[${logPrefix}] open manually: ${url}`);
    }
}

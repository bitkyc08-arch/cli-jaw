import { isWsl, defaultPlatformProbes, type PlatformProbes } from './platform-kind.js';

export function isHeadlessBrowserEnvironment(
    env: NodeJS.ProcessEnv = process.env,
    platform = process.platform,
    probes: PlatformProbes = defaultPlatformProbes,
): boolean {
    if (env["CI"] || env["SSH_CONNECTION"] || env["SSH_TTY"] || env["REMOTE_CONTAINERS"] || env["CODESPACES"]) return true;
    if (platform !== 'linux') return false;
    // WSL has no X display unless WSLg is running, so treat it as headless.
    if (isWsl(platform, env, probes)) return true;
    return !env["DISPLAY"] && !env["WAYLAND_DISPLAY"];
}

export function shouldOpenBrowserByDefault(
    env: NodeJS.ProcessEnv = process.env,
    platform = process.platform,
    probes: PlatformProbes = defaultPlatformProbes,
): boolean {
    return !isHeadlessBrowserEnvironment(env, platform, probes);
}

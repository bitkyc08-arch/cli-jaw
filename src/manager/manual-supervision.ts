/**
 * Guidance for hosts with no service manager (#479).
 *
 * `jaw service` can only register autostart where a service manager exists.
 * On a systemd-less container (PID 1 = tini, a common shape) there is nothing
 * to register with, so the command has to hand the operator a working manual
 * recipe instead.
 *
 * The recipe it used to print — "run jaw serve under tmux/screen" — is not one.
 * The reporter's failing command was a one-shot `ssh host '...'`, and a
 * terminal multiplexer cannot be driven from that: it needs an interactive
 * session to attach to, which is what a one-shot SSH command does not have.
 * Worse, tmux inherits the same non-interactive PATH, so the multiplexer would
 * fail to find `jaw` for exactly the reason the operator is already stuck on.
 *
 * What does work is what the reporter arrived at by hand: absolute paths (no
 * PATH lookup to fail), `setsid` to detach from the SSH session so the
 * process outlives the connection, and stdin from /dev/null so it never
 * blocks on a terminal that is about to disappear.
 */
import { dirname } from 'node:path';

export interface ManualSupervisionContext {
    nodePath: string;
    jawPath: string;
    home: string;
    port: string;
    logPath: string;
}

/** Shell-quote a path only when it needs it, to keep the recipe readable. */
function q(value: string): string {
    return /[\s"'$`\\]/.test(value) ? `'${value.replace(/'/g, "'\\''")}'` : value;
}

/**
 * A copy-pasteable start command that survives a one-shot SSH connection.
 *
 * Absolute node + jaw paths are deliberate: on the hosts that reach this
 * message, a bare `jaw` is precisely what does not resolve.
 */
export function manualStartCommand(ctx: ManualSupervisionContext): string {
    return `setsid nohup ${q(ctx.nodePath)} ${q(ctx.jawPath)} --home ${q(ctx.home)} `
        + `serve --port ${ctx.port} --no-open >> ${q(ctx.logPath)} 2>&1 < /dev/null &`;
}

/**
 * The full operator message for a host with no service manager.
 */
export function manualSupervisionGuidance(ctx: ManualSupervisionContext): string[] {
    return [
        'No service manager available on this host.',
        '   Supported: macOS (launchd), Linux (systemd), Windows (startup), Docker',
        '',
        '   This host has neither, so start it manually. Use absolute paths — a',
        `   non-interactive shell (ssh host '...') does not have ${dirname(ctx.jawPath)} on PATH:`,
        '',
        `     ${manualStartCommand(ctx)}`,
        '',
        `   Verify it started (an empty result means it died):  jaw --home ${q(ctx.home)} service status`,
        `   Read the log on failure:                            tail -n 50 ${q(ctx.logPath)}`,
        '',
        '   To keep it running across crashes, re-run that command from a',
        '   supervisor loop (cron @reboot, a container entrypoint, or a 60s',
        '   while-loop that checks the port before restarting).',
    ];
}

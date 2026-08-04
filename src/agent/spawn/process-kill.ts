import { execFileSync } from 'child_process';
import type { ChildProcess } from 'child_process';

/**
 * Recursively kill a process tree using pgrep -P.
 * Codex sub-agents spawn children with separate PGIDs,
 * so process.kill(-pid) won't reach them.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* best effort */ }
        return;
    }
    let childPids: number[] = [];
    try {
        const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: 3000 });
        childPids = out.trim().split('\n').filter(Boolean).map(Number).filter(n => n > 0);
    } catch { /* no children or pgrep failed */ }
    for (const cpid of childPids) {
        killProcessTree(cpid, signal);
    }
    try { process.kill(pid, signal); } catch { /* already dead */ }
}

/**
 * Has this child already exited?
 *
 * `ChildProcess.killed` only records that a signal was delivered, so it is not a
 * liveness test: a process can be `killed === true` and still running. Node sets
 * exactly one of `exitCode`/`signalCode` once the process is reaped.
 */
export function hasChildExited(child: ChildProcess | null | undefined): boolean {
    if (!child) return true;
    return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Escalate to SIGKILL only while the child is still running.
 *
 * A delayed escalation must never fire blind: if the child exited during the
 * grace period, the OS may already have reassigned its PID, and because
 * `killProcessTree` walks `pgrep -P` it would take an unrelated process tree
 * down with it.
 */
export function killProcessTreeIfAlive(child: ChildProcess | null | undefined, pid?: number): void {
    if (hasChildExited(child)) return;
    const target = pid ?? child?.pid;
    if (!target) return;
    try { killProcessTree(target, 'SIGKILL'); } catch { /* already dead */ }
}

// ─── bgtask: boot recovery ───────────────────────────
// Called once on server start (after DB is ready). Re-attaches or settles
// tasks that were live when the previous server process exited, and re-sends
// notifications that never reached the gateway.
//
// Child rows: stdout of a previous child cannot be re-attached.
//   - pid dead  → failed('lost during server restart') → notify (boss decides retry)
//   - pid alive + respawn opt-in → kill stray, respawn fresh
//   - pid alive, no respawn → orphaned (unowned but possibly still working —
//     killing it could destroy real work; visible via bgtask list)
// Probe rows: always restart (probe is stateless/read-only).
// Terminal-but-unnotified rows: re-notify (gateway 5s dedup absorbs repeats).

import { loadRecoverable, markTerminal } from './registry.js';
import { startTask, isTaskRunnerActive } from './runner.js';
import { notifyTask, type NotifierDeps } from './notifier.js';
import type { BgTaskRow } from './types.js';

export interface RecoverSummary {
    resumedProbes: number;
    respawnedChildren: number;
    failedLost: number;
    orphaned: number;
    renotified: number;
}

function pidAlive(pid: number | null): boolean {
    if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

// SQLite CURRENT_TIMESTAMP yields a naive UTC string ("YYYY-MM-DD HH:MM:SS",
// no zone). `new Date()` parses that space-separated, zone-less form as LOCAL
// time, which skews computed task age by the host UTC offset (e.g. +9h in KST →
// a fresh orphan looks >30min old and gets killed immediately; negative offsets
// never expire). Normalize to explicit UTC before parsing.
function sqliteTimestampMs(ts: string): number {
    const hasZone = /[zZ]$|[+-]\d\d:?\d\d$/.test(ts);
    const iso = hasZone ? ts : `${ts.replace(' ', 'T')}Z`;
    return new Date(iso).getTime();
}

export async function recoverBgTasks(deps: Partial<NotifierDeps> = {}): Promise<RecoverSummary> {
    const summary: RecoverSummary = {
        resumedProbes: 0, respawnedChildren: 0, failedLost: 0, orphaned: 0, renotified: 0,
    };
    const onTerminal = (taskId: string): void => {
        notifyTask(taskId, deps).catch((err: Error) => {
            console.error(`[bgtask:${taskId}] recovery notify failed:`, err.message);
        });
    };

    let rows: BgTaskRow[];
    try {
        rows = loadRecoverable();
    } catch (err) {
        console.error('[bgtask] recovery load failed:', (err as Error).message);
        return summary;
    }

    for (const row of rows) {
        try {
            if (row.status !== 'running') {
                if (await notifyTask(row.id, deps)) summary.renotified += 1;
                continue;
            }
            // Idempotency: a runner in THIS process already owns the task —
            // never kill/respawn it from a repeated recovery pass.
            if (isTaskRunnerActive(row.id)) continue;
            if (row.spec.completion.type === 'session-status') {
                startTask(row, onTerminal);
                summary.resumedProbes += 1;
                continue;
            }
            const alive = pidAlive(row.pid);
            if (alive && row.spec.respawn === true) {
                try {
                    if (row.pid) process.kill(row.pid, 'SIGTERM');
                } catch { /* stray already gone */ }
                startTask(row, onTerminal);
                summary.respawnedChildren += 1;
            } else if (alive) {
                const ageMs = row.createdAt ? Date.now() - sqliteTimestampMs(row.createdAt) : Infinity;
                if (ageMs > 30 * 60_000) {
                    try { if (row.pid) process.kill(row.pid, 'SIGTERM'); } catch {}
                    const capture = JSON.stringify({
                        stdoutTail: [], stderrTail: [],
                        reason: `orphaned child killed after ${Math.round(ageMs / 60_000)}min`,
                    });
                    if (markTerminal(row.id, 'failed', capture)) onTerminal(row.id);
                    summary.failedLost += 1;
                    console.warn(`[bgtask:${row.id}] killed orphan (pid ${row.pid}, age ${Math.round(ageMs / 60_000)}min)`);
                } else {
                    // Keep the row recoverable: clearing pid/status here prevents
                    // later restarts from enforcing the grace-window cleanup.
                    summary.orphaned += 1;
                    console.warn(`[bgtask:${row.id}] orphaned — pid ${row.pid} alive, will kill after 30min`);
                }
            } else if (row.spec.respawn === true) {
                startTask(row, onTerminal);
                summary.respawnedChildren += 1;
            } else {
                const capture = JSON.stringify({
                    stdoutTail: [], stderrTail: [],
                    reason: 'lost during server restart (child process did not survive)',
                });
                if (markTerminal(row.id, 'failed', capture)) onTerminal(row.id);
                summary.failedLost += 1;
            }
        } catch (err) {
            console.error(`[bgtask:${row.id}] recovery failed:`, (err as Error).message);
        }
    }

    const total = summary.resumedProbes + summary.respawnedChildren + summary.failedLost
        + summary.orphaned + summary.renotified;
    if (total > 0) {
        console.log(`[bgtask] recovery: ${summary.resumedProbes} probes resumed, `
            + `${summary.respawnedChildren} children respawned, ${summary.failedLost} lost→failed, `
            + `${summary.orphaned} orphaned, ${summary.renotified} re-notified`);
    }
    return summary;
}

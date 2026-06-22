// bgtask boot recovery — probes resumed, dead children failed+notified,
// live unowned children orphaned, unnotified terminals re-notified.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

import { createSession } from '../../src/browser/web-ai/session.ts';
import type { QuestionEnvelope } from '../../src/browser/web-ai/types.ts';
import { createTask, getTask, markTerminal, setTaskPid } from '../../src/bgtask/registry.ts';
import { isTaskRunnerActive, stopAllBgTasks } from '../../src/bgtask/runner.ts';
import { recoverBgTasks } from '../../src/bgtask/recover.ts';
import { db } from '../../src/core/db.ts';
import type { SubmitResult } from '../../src/orchestrator/gateway.ts';
import type { BgTaskSpec } from '../../src/bgtask/types.ts';

let seq = 0;
function childSpec(overrides: Partial<BgTaskSpec> = {}): BgTaskSpec {
    seq += 1;
    return {
        command: [process.execPath, '-e', `setInterval(()=>{}, 1000) // recover ${seq}`],
        completion: { type: 'exit' },
        promptTemplate: 'r {{taskId}} {{status}}: {{result}}',
        ...overrides,
    };
}

function makeSubmitSpy() {
    const calls: string[] = [];
    const submit = ((text: string): SubmitResult => {
        calls.push(text);
        return { action: 'started', requestId: 'req' } as SubmitResult;
    }) as never;
    return { calls, submit };
}

/** A real PID that is alive for the duration of the test. */
function spawnLivePid(): { pid: number; kill: () => void } {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
    return { pid: child.pid!, kill: () => child.kill('SIGKILL') };
}

/** A real PID that is guaranteed dead. */
async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const pid = child.pid!;
    await new Promise((r) => child.on('exit', r));
    return pid;
}

test('recovery matrix: probe resumed, dead child failed+notified, young live child stays recoverable, unnotified re-notified', async () => {
    // probe row
    const session = createSession({
        vendor: 'chatgpt', targetId: `t-${Date.now()}`, url: 'https://chatgpt.com/',
        envelope: { user: { question: 'q' } } as unknown as QuestionEnvelope,
        assistantCount: 0, timeoutMs: 60_000,
    });
    const probe = createTask({
        kind: 'web-ai',
        spec: { completion: { type: 'session-status', sessionId: session.sessionId }, promptTemplate: 'p {{status}}' },
    });

    // dead child, no respawn → failed + notified
    const dead = createTask({ kind: 'shell', spec: childSpec() });
    setTaskPid(dead.id, await deadPid());

    // young live child, no respawn → left running with pid so the next boot can re-check the grace window
    const live = spawnLivePid();
    const orphan = createTask({ kind: 'shell', spec: childSpec() });
    setTaskPid(orphan.id, live.pid);

    // terminal but unnotified → re-notified
    const unnotified = createTask({ kind: 'shell', spec: childSpec() });
    markTerminal(unnotified.id, 'complete', JSON.stringify({ stdoutTail: ['done'], stderrTail: [] }));

    const { calls, submit } = makeSubmitSpy();
    try {
        const summary = await recoverBgTasks({ submit });

        assert.equal(summary.resumedProbes, 1);
        assert.ok(isTaskRunnerActive(probe.id), 'probe runner re-attached');

        assert.equal(summary.failedLost, 1);
        assert.equal(getTask(dead.id)?.status, 'failed');
        assert.ok(getTask(dead.id)?.notifiedAt, 'lost child notified');
        assert.ok(calls.some((t) => t.includes(dead.id) && t.includes('lost during server restart')));

        assert.equal(summary.orphaned, 1);
        assert.equal(getTask(orphan.id)?.status, 'running');
        assert.equal(getTask(orphan.id)?.pid, live.pid);

        assert.equal(summary.renotified, 1);
        assert.ok(getTask(unnotified.id)?.notifiedAt);
        assert.ok(calls.some((t) => t.includes(unnotified.id) && t.includes('done')));
    } finally {
        markTerminal(orphan.id, 'failed', 'test cleanup');
        live.kill();
        stopAllBgTasks();
    }
});

test('recovery kills live orphaned child after grace window while preserving fresh orphans for re-check', async () => {
    const live = spawnLivePid();
    const row = createTask({ kind: 'shell', spec: childSpec() });
    setTaskPid(row.id, live.pid);
    db.prepare("UPDATE background_tasks SET created_at = datetime('now', '-31 minutes') WHERE id = ?").run(row.id);

    const { calls, submit } = makeSubmitSpy();
    try {
        const summary = await recoverBgTasks({ submit });

        assert.equal(summary.failedLost, 1);
        assert.equal(summary.orphaned, 0);
        const recovered = getTask(row.id);
        assert.equal(recovered?.status, 'failed');
        assert.equal(recovered?.pid, null);
        assert.ok(calls.some((text) => text.includes(row.id) && text.includes('orphaned child killed after')));
    } finally {
        live.kill();
        stopAllBgTasks();
    }
});

test('recovery respawns dead child when respawn opt-in, and is idempotent for active runners', async () => {
    const row = createTask({ kind: 'shell', spec: childSpec({ respawn: true }) });
    setTaskPid(row.id, await deadPid());

    const { submit } = makeSubmitSpy();
    try {
        const first = await recoverBgTasks({ submit });
        assert.equal(first.respawnedChildren, 1);
        assert.ok(isTaskRunnerActive(row.id), 'fresh child spawned');
        assert.equal(getTask(row.id)?.status, 'running');

        // second recovery pass: row is running AND a runner is active → startTask no-ops
        const second = await recoverBgTasks({ submit });
        assert.equal(getTask(row.id)?.status, 'running');
        assert.ok(second.respawnedChildren <= 1, 'no duplicate spawn storm');
    } finally {
        stopAllBgTasks();
    }
});

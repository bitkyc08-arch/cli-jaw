// 260726 wp13 B3 — ACP host lifecycle, exercised rather than grepped.
//
// The existing recovery test reads source files and asserts they contain
// certain strings. That catches a deleted line but not a broken behaviour, and
// the behaviour here is the one that loses a user's work: sessions share one
// child process, so what happens to that child when a single RPC fails decides
// whether the OTHER sessions survive.
//
// These run the real host against a fake agent (tests/fixtures/fake-acp-server)
// driven by env, so a hung `session/close` or a mid-flight exit is a setting
// rather than a race to reproduce.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const FAKE = join(ROOT, 'tests/fixtures/fake-acp-server.mjs');

/**
 * Hosts created during the run, so their children do not outlive it.
 *
 * Each case gets its own module instance and therefore its own spawned agent
 * plus an idle-reaper interval. Left alone they keep the test runner alive
 * after the assertions have finished.
 */
const spawned: Array<{ dispose(): Promise<void> }> = [];
after(async () => {
    await Promise.allSettled(spawned.map(h => h.dispose()));
});

/**
 * A fresh host module bound to the fake agent.
 *
 * The host is a module singleton, so each case imports it with a cache-busting
 * query to get its own child process and session map.
 */
async function freshHost(env: Record<string, string> = {}) {
    const previous: Record<string, string | undefined> = {};
    // 30s is the production default; these cases deliberately hang an RPC, so
    // waiting it out would make the suite unusable.
    const applied = { JWC_ACP_CMD: `${process.execPath} ${FAKE}`, JWC_ACP_RPC_TIMEOUT_MS: '1200', ...env };
    for (const [k, v] of Object.entries(applied)) {
        previous[k] = process.env[k];
        process.env[k] = v;
    }
    const mod = await import(`../../src/code-mode/acp-host.ts?case=${Math.random()}`);
    spawned.push({
        dispose: async () => {
            const host = mod.acpHost as { listSessions(): Array<{ sessionId: string }>; closeSession(id: string): Promise<void> };
            for (const s of host.listSessions()) await host.closeSession(s.sessionId).catch(() => {});
            await (mod as { __disposeForTests?: () => Promise<void> }).__disposeForTests?.();
        },
    });
    return {
        host: mod.acpHost as {
            newSession(cwd?: string, model?: string): Promise<{ sessionId: string }>;
            closeSession(id: string): Promise<void>;
            listSessions(): Array<{ sessionId: string; status?: string }>;
            prompt(id: string, text: string): Promise<unknown>;
        },
        diagnostics: mod.getAcpHostDiagnosticSnapshot as () => { childAlive: boolean; sessionCount: number },
        restore: () => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } },
    };
}

test('R6: one session failing to close must not take its siblings down', async () => {
    // The shared child is the whole point of the bug. Before the fix, a close
    // RPC that never answered fell through to terminateChild(), which killed
    // every other live session on the same process.
    const { host, diagnostics, restore } = await freshHost({ FAKE_ACP_HANG: 'session/close' });
    try {
        const a = await host.newSession(ROOT);
        const b = await host.newSession(ROOT);
        assert.equal(host.listSessions().length, 2, 'both sessions start live');

        // This one cannot complete: the agent never answers session/close.
        await host.closeSession(a.sessionId).catch(() => {});
        // Re-establishment runs on the replacement child's handshake, which is
        // asynchronous; without this the assertion races the recovery it is
        // supposed to be checking.
        await new Promise(r => setTimeout(r, 900));

        const survivors = host.listSessions();
        assert.ok(
            survivors.some(s => s.sessionId === b.sessionId),
            `session B must survive A's failed close, saw ${JSON.stringify(survivors)}`,
        );
        assert.equal(diagnostics().childAlive, true, 'the shared child must still be usable for B');
    } finally { restore(); }
}, { timeout: 40_000 });

test('R1: sessions live at child exit are marked dead, not left pending', async () => {
    // Two requests get answered (initialize, authenticate), then the agent dies
    // mid-conversation. Anything still waiting has to be rejected rather than
    // hanging forever, and the session must not still claim to be live.
    const { host, diagnostics, restore } = await freshHost({ FAKE_ACP_EXIT_AFTER: '3' });
    try {
        const created = await host.newSession(ROOT).catch(() => null);
        // The agent exits right after answering session/new.
        await new Promise(r => setTimeout(r, 500));

        assert.equal(diagnostics().childAlive, false, 'the child is gone');
        const live = host.listSessions();
        assert.deepEqual(
            live.filter(s => s.sessionId === created?.sessionId),
            [],
            'a session whose child died must not be listed as live',
        );
    } finally { restore(); }
}, { timeout: 40_000 });

test('R3: a malformed line from the agent does not wedge the transport', async () => {
    // The host drops non-JSON lines silently. Dropping them is fine; losing the
    // reply that follows on the same stream is not.
    const { host, restore } = await freshHost({ FAKE_ACP_GARBAGE: '1' });
    try {
        const created = await host.newSession(ROOT);
        assert.match(created.sessionId, /^fake-session-/, 'a valid reply after garbage still resolves');
    } finally { restore(); }
}, { timeout: 40_000 });

test('a session can be created and closed against the fake agent', async () => {
    const { host, restore } = await freshHost();
    try {
        const created = await host.newSession(ROOT);
        assert.match(created.sessionId, /^fake-session-/);
        assert.equal(host.listSessions().length, 1);

        await host.closeSession(created.sessionId);
        assert.equal(host.listSessions().length, 0, 'closing removes the session');
    } finally { restore(); }
});

// Each case gets its own module instance, but they share this process, and the
// idle reaper plus a lingering child from an earlier case can still perturb the
// next one. Running R6 first keeps its child the only one alive.

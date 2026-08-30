// Releasing a held mention watch. The hold itself is proven in
// legacy-mention-watch-quarantine.test.ts; what is proven here is that a
// production path can actually CLEAR it, and that the clearing cannot happen by
// accident. A hold with no exit is the same defect shape as no hold at all.
import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';

import { registerHeartbeatRoutes } from '../../src/routes/heartbeat.ts';
import { loadHeartbeatFile, saveHeartbeatFile, settings } from '../../src/core/config.ts';
import { insertMentionWatchSeen, upsertMentionWatchCursor, findMentionWatchSeen, commitLegacyFreshStart } from '../../src/core/db.ts';
import { detectLegacyMentionWatch, isQuarantined, quarantineState } from '../../src/memory/legacy-mention-watch-quarantine.ts';
import { startHeartbeat, stopHeartbeat, getHeartbeatRuntimeState } from '../../src/memory/heartbeat.ts';
import { resetVerifiedSlackWorkspace } from '../../src/slack/verified-workspace.ts';

/** Present in the v1 table, which is what a losing claim must not have erased. */
const legacySeenExists = (jobId: string, channelId: string, ts: string): boolean =>
    findMentionWatchSeen.get(jobId, channelId, ts) !== undefined;

const WORKSPACE = 'T_TESTWS';

/** Answer auth.test locally and let every other request through.
 *
 *  The approval records the workspace the token actually points at, so these
 *  tests need one. Only auth.test is intercepted: the requests to the local
 *  server under test go through the real fetch. */
function stubSlackAuth(teamId: string | null): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
        if (url.includes('/api/auth.test')) {
            const body = teamId
                ? JSON.stringify({ ok: true, team_id: teamId, user_id: 'U_BOT' })
                : JSON.stringify({ ok: false, error: 'invalid_auth' });
            return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return original(input, init);
    }) as typeof fetch;
    settings['slack'] = { ...(settings['slack'] as Record<string, unknown> | undefined), enabled: true, botToken: 'xoxb-test-' + String(teamId) };
    resetVerifiedSlackWorkspace();
    return () => { globalThis.fetch = original; resetVerifiedSlackWorkspace(); };
}

async function withHeartbeatServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
    const app = express();
    app.use(express.json());
    const passAuth = (_req: Request, _res: Response, next: NextFunction) => next();
    registerHeartbeatRoutes(app, passAuth);
    const server: Server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
        await run('http://127.0.0.1:' + address.port);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

/** A job holding a v1 ledger, which is what an unmigrated install looks like. */
function seedHeldJob(jobId: string, since = '900.000100') {
    insertMentionWatchSeen.run(jobId, 'C_LEGACY', since, Date.now());
    upsertMentionWatchCursor.run(jobId, 'C_LEGACY', since, Date.now());
    saveHeartbeatFile({ jobs: [{
        id: jobId, name: jobId, enabled: true, schedule: { kind: 'every', minutes: 10 }, prompt: 'answer',
        mentionWatch: { channel: 'slack', userId: 'U_SUJI', channelIds: ['C_LEGACY'], since },
    }] });
    detectLegacyMentionWatch(Date.now());
    assert.equal(isQuarantined(jobId), true);
}

test('a held job is reported as held, so a hold is visible and not just a log line', async () => {
    const jobId = 'hold_visible';
    seedHeldJob(jobId);
    await withHeartbeatServer(async baseUrl => {
        const response = await fetch(baseUrl + '/api/heartbeat/' + jobId + '/mention-watch-hold');
        const body = await response.json() as { held?: boolean; state?: { status?: string } };
        assert.equal(response.status, 200);
        assert.equal(body.held, true);
        assert.equal(body.state?.status, 'pending');
    });
});

test('a fresh start needs an explicit floor, because an empty one replays history', async () => {
    const jobId = 'hold_needs_since';
    seedHeldJob(jobId);
    await withHeartbeatServer(async baseUrl => {
        for (const body of [{}, { since: '' }, { since: '   ' }]) {
            const response = await fetch(baseUrl + '/api/heartbeat/' + jobId + '/mention-watch-fresh-start', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            assert.equal(response.status, 400);
        }
        // Still held: a rejected request must not be a partial approval.
        assert.equal(isQuarantined(jobId), true);
    });
});

test('an ordinary save does not lift the hold', async () => {
    // Every shipped UI omits mentionWatch from the body, so a save click that
    // counted as consent would let any unrelated edit replay the backlog.
    const jobId = 'hold_survives_put';
    seedHeldJob(jobId);
    await withHeartbeatServer(async baseUrl => {
        const response = await fetch(baseUrl + '/api/heartbeat', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobs: [{ id: jobId, name: jobId, enabled: true, schedule: { kind: 'every', minutes: 10 }, prompt: 'answer' }] }),
        });
        assert.equal(response.status, 200);
        assert.equal(isQuarantined(jobId), true);
        // The watch itself must also survive the save that could not see it.
        const job = loadHeartbeatFile().jobs.find(candidate => candidate.id === jobId);
        assert.equal(job?.mentionWatch?.userId, 'U_SUJI');
    });
});

test('an explicit fresh start writes the new floor and then clears the hold', async () => {
    const jobId = 'hold_cleared';
    seedHeldJob(jobId, '900.000100');
    const restore = stubSlackAuth(WORKSPACE);
    try {
    await withHeartbeatServer(async baseUrl => {
        const response = await fetch(baseUrl + '/api/heartbeat/' + jobId + '/mention-watch-fresh-start', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ since: '1700000000.000100' }),
        });
        const body = await response.json() as { outcome?: string };
        assert.equal(response.status, 200);
        assert.equal(body.outcome, 'resolved');
        assert.equal(isQuarantined(jobId), false);
        // The floor is what stops the backlog, so it has to be persisted.
        const job = loadHeartbeatFile().jobs.find(candidate => candidate.id === jobId);
        assert.equal(job?.mentionWatch?.since, '1700000000.000100');
    });
    } finally { restore(); }
});

test('retrying the same fresh start is idempotent, and a different floor is a conflict', async () => {
    const jobId = 'hold_retry';
    seedHeldJob(jobId);
    const restore = stubSlackAuth(WORKSPACE);
    try {
    await withHeartbeatServer(async baseUrl => {
        const send = (since: string) => fetch(baseUrl + '/api/heartbeat/' + jobId + '/mention-watch-fresh-start', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ since }),
        });
        assert.equal((await send('1700000000.000100')).status, 200);
        const again = await send('1700000000.000100');
        assert.equal(again.status, 200);
        assert.equal(((await again.json()) as { outcome?: string }).outcome, 'already-resolved');
        // A second, different decision must not silently overwrite the recorded one.
        assert.equal((await send('1800000000.000100')).status, 409);
    });
    } finally { restore(); }
});

test('a job with no hold is a 404 rather than an invented approval', async () => {
    const restore = stubSlackAuth(WORKSPACE);
    try {
    await withHeartbeatServer(async baseUrl => {
        const response = await fetch(baseUrl + '/api/heartbeat/never_held/mention-watch-fresh-start', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ since: '1700000000.000100' }),
        });
        assert.equal(response.status, 404);
    });
    } finally { restore(); }
});

test('two jobs cannot share one id, because they would share one ledger namespace', async () => {
    await withHeartbeatServer(async baseUrl => {
        const response = await fetch(baseUrl + '/api/heartbeat', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobs: [
                { id: 'twin', name: 'a', schedule: { kind: 'every', minutes: 10 }, prompt: 'a' },
                { id: 'twin', name: 'b', schedule: { kind: 'every', minutes: 10 }, prompt: 'b' },
            ] }),
        });
        const body = await response.json() as { error?: string; jobId?: string };
        assert.equal(response.status, 400);
        assert.match(body.error ?? '', /duplicate heartbeat job id/);
        assert.equal(body.jobId, 'twin');
    });
});

test('approval refuses when the workspace cannot be verified, rather than recording a guess', async () => {
    // The ledger is keyed by workspace, so an approval that cannot name one would
    // record a namespace the job may not write to.
    const jobId = 'hold_no_workspace';
    seedHeldJob(jobId);
    const restore = stubSlackAuth(null);
    try {
        await withHeartbeatServer(async baseUrl => {
            const response = await fetch(baseUrl + '/api/heartbeat/' + jobId + '/mention-watch-fresh-start', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ since: '1700000000.000100' }),
            });
            assert.equal(response.status, 409);
            assert.match(((await response.json()) as { error?: string }).error ?? '', /verify the Slack workspace/);
            assert.equal(isQuarantined(jobId), true);
        });
    } finally { restore(); }
});

test('the recorded approval names the workspace it was granted under', async () => {
    const jobId = 'hold_records_workspace';
    seedHeldJob(jobId);
    const restore = stubSlackAuth(WORKSPACE);
    try {
        await withHeartbeatServer(async baseUrl => {
            const response = await fetch(baseUrl + '/api/heartbeat/' + jobId + '/mention-watch-fresh-start', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ since: '1700000000.000100' }),
            });
            assert.equal(response.status, 200);
            assert.match(quarantineState(jobId)?.resolution ?? '', new RegExp(WORKSPACE));
        });
    } finally { restore(); }
});

test('a retry whose floor no longer matches the file is a conflict, not a false success', async () => {
    // Reporting this floor as in force while a later edit governs the scan is the
    // one wrong answer available here: the caller believes a backlog is bounded
    // when it is not. Rewriting silently would undo the deliberate edit instead.
    const jobId = 'hold_drift';
    seedHeldJob(jobId);
    const restore = stubSlackAuth(WORKSPACE);
    try {
        await withHeartbeatServer(async baseUrl => {
            const send = (since: string) => fetch(baseUrl + '/api/heartbeat/' + jobId + '/mention-watch-fresh-start', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ since }),
            });
            assert.equal((await send('1700000000.000100')).status, 200);

            const file = loadHeartbeatFile();
            saveHeartbeatFile({ jobs: file.jobs.map(job => (job.id === jobId
                ? { ...job, mentionWatch: { ...job.mentionWatch!, since: '1600000000.000100' } }
                : job)) });

            const retry = await send('1700000000.000100');
            assert.equal(retry.status, 409);
            assert.equal(((await retry.json()) as { persistedSince?: string | null }).persistedSince, '1600000000.000100');
        });
    } finally { restore(); }
});

test('a losing claim leaves the v1 rows alone', () => {
    // The transaction claims the hold BEFORE archiving and deleting. A plain
    // return does not roll better-sqlite3 back, so doing the destructive half
    // first would commit it for an approval that reported failure.
    const jobId = 'hold_cas_loser';
    insertMentionWatchSeen.run(jobId, 'C_LEGACY', '900.000100', Date.now());
    detectLegacyMentionWatch(Date.now());
    assert.equal(commitLegacyFreshStart(jobId, 'first', 1), true);

    // Re-seed, then lose the claim: the row must survive.
    insertMentionWatchSeen.run(jobId, 'C_SECOND', '950.000100', Date.now());
    assert.equal(commitLegacyFreshStart(jobId, 'second', 2), false);
    assert.equal(legacySeenExists(jobId, 'C_SECOND', '950.000100'), true);
});

test('a held job gets no timer, so the hold is not merely a per-tick refusal', () => {
    const jobId = 'hold_not_scheduled';
    seedHeldJob(jobId);
    startHeartbeat();
    try {
        assert.equal(getHeartbeatRuntimeState().scheduled, 0);
    } finally { stopHeartbeat(); }
});

test('a losing concurrent approval cannot write its floor over the winner', async () => {
    // The defect this pins: reading the hold and the whole file, THEN awaiting
    // workspace verification, lets the loser resume with a stale whole-file copy
    // and save its floor. The DB then says conflict, but the file is already wrong.
    // Verification is awaited first so everything after it is synchronous.
    const jobId = 'hold_race';
    seedHeldJob(jobId);
    const restore = stubSlackAuth(WORKSPACE);
    try {
        await withHeartbeatServer(async baseUrl => {
            const send = (since: string) => fetch(baseUrl + '/api/heartbeat/' + jobId + '/mention-watch-fresh-start', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ since }),
            });
            const [a, b] = await Promise.all([send('1700000000.000100'), send('1800000000.000100')]);
            const codes = [a.status, b.status].sort();
            // Exactly one winner.
            assert.deepEqual(codes, [200, 409]);

            // The persisted floor must be the WINNER's, not whichever finished last.
            const winner = a.status === 200 ? '1700000000.000100' : '1800000000.000100';
            const persisted = loadHeartbeatFile().jobs.find(job => job.id === jobId)?.mentionWatch?.since;
            assert.equal(persisted, winner);
            assert.equal(isQuarantined(jobId), false);
        });
    } finally { restore(); }
});

/** Hold every auth.test inside the handler until released.
 *
 *  Promise.all only proves two clients STARTED. It does not prove both handlers
 *  suspended in verification before either read state, so the requests may
 *  serialize and the pre-fix code would pass too. This gate makes the overlap
 *  deterministic: nothing proceeds past verification until both are parked. */
function gatedSlackAuth(teamId: string) {
    const original = globalThis.fetch;
    const arrivals: Array<() => void> = [];
    let arrived = 0;
    let waiter: (() => void) | null = null;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
        if (url.includes('/api/auth.test')) {
            arrived += 1;
            if (waiter) { const w = waiter; waiter = null; w(); }
            await new Promise<void>(resolve => arrivals.push(resolve));
            return new Response(JSON.stringify({ ok: true, team_id: teamId, user_id: 'U_BOT' }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        }
        return original(input, init);
    }) as typeof fetch;
    settings['slack'] = { ...(settings['slack'] as Record<string, unknown> | undefined), enabled: true, botToken: 'xoxb-gated' };
    resetVerifiedSlackWorkspace();
    return {
        /** Resolve once N handlers are parked inside verification. */
        waitForArrivals: async (n: number) => {
            while (arrived < n) await new Promise<void>(resolve => { waiter = resolve; });
        },
        releaseOne: () => { arrivals.shift()?.(); },
        releaseAll: () => { while (arrivals.length) arrivals.shift()?.(); },
        restore: () => { globalThis.fetch = original; resetVerifiedSlackWorkspace(); },
    };
}

test('with both approvals parked inside verification, the loser cannot touch the file', async () => {
    // Deterministic version of the race: both handlers are held inside auth.test,
    // then released one at a time. Under the old shape the loser resumed with a
    // stale whole-file snapshot and saved its floor over the winner's.
    const jobId = 'hold_gated_race';
    seedHeldJob(jobId);
    const gate = gatedSlackAuth(WORKSPACE);
    try {
        await withHeartbeatServer(async baseUrl => {
            const send = (since: string) => fetch(baseUrl + '/api/heartbeat/' + jobId + '/mention-watch-fresh-start', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ since }),
            });
            const winner = send('1900000000.000100');
            const loser = send('1500000000.000100');
            await gate.waitForArrivals(2);

            gate.releaseOne();
            const first = await winner;
            assert.equal(first.status, 200);
            assert.equal(loadHeartbeatFile().jobs.find(job => job.id === jobId)?.mentionWatch?.since, '1900000000.000100');

            gate.releaseOne();
            const second = await loser;
            assert.equal(second.status, 409);
            // The whole point: the loser must not have rewritten the floor.
            assert.equal(loadHeartbeatFile().jobs.find(job => job.id === jobId)?.mentionWatch?.since, '1900000000.000100');
        });
    } finally { gate.releaseAll(); gate.restore(); }
});

test('a token swapped during verification aborts the approval instead of recording the old workspace', async () => {
    // The verified team id would describe the OLD credential while the released
    // job runs under the new one, so the recorded provenance and the namespace
    // actually written would disagree.
    const jobId = 'hold_token_swap';
    seedHeldJob(jobId, '900.000100');
    const gate = gatedSlackAuth(WORKSPACE);
    try {
        await withHeartbeatServer(async baseUrl => {
            const pending = fetch(baseUrl + '/api/heartbeat/' + jobId + '/mention-watch-fresh-start', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ since: '1700000000.000100' }),
            });
            await gate.waitForArrivals(1);
            // Someone rotates the credential while verification is in flight.
            settings['slack'] = { ...(settings['slack'] as Record<string, unknown> | undefined), botToken: 'xoxb-rotated' };
            gate.releaseOne();

            const response = await pending;
            assert.equal(response.status, 409);
            assert.match(((await response.json()) as { error?: string }).error ?? '', /token changed while verifying/);
            // Hold intact, file untouched.
            assert.equal(isQuarantined(jobId), true);
            assert.equal(loadHeartbeatFile().jobs.find(job => job.id === jobId)?.mentionWatch?.since, '900.000100');
        });
    } finally { gate.releaseAll(); gate.restore(); }
});

test('GET reports a held job as held, so operator surfaces stop calling it active', async () => {
    // `enabled` is intent and the hold is the system's judgement, stored apart on
    // purpose. Every operator surface counted the file flag, so a job that gets no
    // timer read as ACTIVE.
    const jobId = 'hold_listed';
    seedHeldJob(jobId);
    await withHeartbeatServer(async baseUrl => {
        const response = await fetch(baseUrl + '/api/heartbeat');
        const body = await response.json() as { jobs?: Array<{ id?: string; enabled?: boolean; held?: string }> };
        const job = body.jobs?.find(candidate => candidate.id === jobId);
        // Intent is untouched — the operator did enable it.
        assert.equal(job?.enabled, true);
        assert.equal(job?.held, 'unmigrated_mention_watch_ledger');
    });
});

test('a job with no hold carries no held marker', async () => {
    const jobId = 'not_held_listed';
    saveHeartbeatFile({ jobs: [{
        id: jobId, name: jobId, enabled: true, schedule: { kind: 'every', minutes: 10 }, prompt: 'x',
    }] });
    await withHeartbeatServer(async baseUrl => {
        const response = await fetch(baseUrl + '/api/heartbeat');
        const body = await response.json() as { jobs?: Array<{ id?: string; held?: string }> };
        assert.equal(body.jobs?.find(candidate => candidate.id === jobId)?.held, undefined);
    });
});

test('clearing the hold clears the marker', async () => {
    const jobId = 'hold_marker_cleared';
    seedHeldJob(jobId);
    const restore = stubSlackAuth(WORKSPACE);
    try {
        await withHeartbeatServer(async baseUrl => {
            await fetch(baseUrl + '/api/heartbeat/' + jobId + '/mention-watch-fresh-start', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ since: '1700000000.000100' }),
            });
            const response = await fetch(baseUrl + '/api/heartbeat');
            const body = await response.json() as { jobs?: Array<{ id?: string; held?: string }> };
            assert.equal(body.jobs?.find(candidate => candidate.id === jobId)?.held, undefined);
        });
    } finally { restore(); }
});

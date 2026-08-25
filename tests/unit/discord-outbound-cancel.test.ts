// Discord outbound cancellation (#417, L3).
//
// The design doc called this impossible: "channel.send() 로는 불가능". That was
// true of discord.js's high-level helper, which forwards no request options — but
// the repo since grew its own REST scheduler, and that one takes a signal AND
// applies it while a job is still queued behind a rate limit. So the fix is to
// route the two channel.send() sites through the scheduler, not to invent a seam.
//
// These drive sendDiscordTextRest against an injected scheduler so the assertions
// are about what production actually calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sendDiscordTextRest } from '../../src/discord/send-only-client.ts';

type Scheduled = { path: string; body: string; signal?: AbortSignal };

function fakeScheduler(onSchedule?: (job: Scheduled) => void) {
    const jobs: Scheduled[] = [];
    return {
        jobs,
        scheduler: {
            schedule: async (req: {
                path: string;
                makeInit: () => { body?: unknown } | Promise<{ body?: unknown }>;
                signal?: AbortSignal;
            }) => {
                const init = await req.makeInit();
                const job: Scheduled = {
                    path: req.path,
                    body: String(init.body ?? ''),
                    ...(req.signal ? { signal: req.signal } : {}),
                };
                jobs.push(job);
                onSchedule?.(job);
                if (req.signal?.aborted) {
                    return { ok: false as const, failure: { kind: 'transient', message: 'aborted' } };
                }
                return { ok: true as const, value: undefined, status: 200 };
            },
        },
    };
}

test('the caller signal reaches the scheduled request', async () => {
    const controller = new AbortController();
    const { jobs, scheduler } = fakeScheduler();

    await sendDiscordTextRest('tok', '555', 'hello', {
        signal: controller.signal,
        scheduler: scheduler as never,
    });

    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.signal, controller.signal,
        'the scheduler honours a signal while queued behind a rate limit — that is why it must arrive');
});

test('an already-aborted turn schedules nothing', async () => {
    const { jobs, scheduler } = fakeScheduler();

    const result = await sendDiscordTextRest('tok', '555', 'hello', {
        signal: AbortSignal.abort(),
        scheduler: scheduler as never,
    });

    assert.equal(jobs.length, 0);
    assert.equal(result.ok, false, 'a cancelled send did not deliver, and must not claim it did');
});

test('a multi-chunk answer stops at the chunk boundary once aborted', async () => {
    const controller = new AbortController();
    const { jobs, scheduler } = fakeScheduler(() => controller.abort());
    // Two chunks at Discord's 2000-char limit.
    const long = 'x'.repeat(3_000);

    await sendDiscordTextRest('tok', '555', long, {
        signal: controller.signal,
        scheduler: scheduler as never,
    });

    assert.equal(jobs.length, 1,
        'without a per-chunk re-check, shutdown still posts the rest of the answer');
});

test('no signal keeps the previous behaviour', async () => {
    const { jobs, scheduler } = fakeScheduler();
    const result = await sendDiscordTextRest('tok', '555', 'hello', { scheduler: scheduler as never });
    assert.equal(result.ok, true);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.signal, undefined);
});


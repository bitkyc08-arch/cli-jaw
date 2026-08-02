// wp3 defect classes: self-echo, duplicate delivery, zero-byte uploads, and
// treating a rate limit as a formatting problem.
//
// Behavior tests. Each one was mutation-verified by re-injecting the original
// defect and confirming this file goes red.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSeenSet, DELIVERY_DEDUPE_TTL_MS } from '../../src/messaging/dedupe.js';
import { classifySendFailure, retryAfterMs, MAX_INLINE_RATE_LIMIT_MS } from '../../src/messaging/retry.js';
import { validateDiscordFileSize } from '../../src/discord/discord-file.js';
import { validateFileSize } from '../../src/telegram/telegram-file.js';

// ─── Duplicate delivery ──────────────────────────────

test('a redelivered id is recognised inside the window', () => {
    const seen = createSeenSet(60_000);
    assert.equal(seen.seen('update-1'), false, 'first sight is not a duplicate');
    assert.equal(seen.seen('update-1'), true, 'the replay is');
    assert.equal(seen.seen('update-2'), false);
});

test('an id is forgotten once its window closes', () => {
    // A short TTL rather than a fake clock: the set reads Date.now() directly,
    // and a 2 ms window is deterministic enough without one.
    const seen = createSeenSet(2);
    assert.equal(seen.seen('x'), false);
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin past the window */ }
    assert.equal(seen.seen('x'), false, 'an expired id must be processable again');
});

test('the sweep never evicts an id that is still inside its window', () => {
    // Evicting unexpired ids to hit a size target reopens the very duplicate
    // this exists to close, so growth past the sweep threshold must not do it.
    const seen = createSeenSet(60_000, 4);
    for (let i = 0; i < 20; i += 1) seen.seen(`id-${i}`);
    for (let i = 0; i < 20; i += 1) {
        assert.equal(seen.seen(`id-${i}`), true, `id-${i} was dropped early`);
    }
});

test('the shared TTL is long enough to cover a vendor retry', () => {
    assert.ok(DELIVERY_DEDUPE_TTL_MS >= 5 * 60_000, 'a retry horizon is minutes, not seconds');
});

test('tracking stops growing once the budget is reached', () => {
    // A TTL bounds how LONG an id is remembered, not how many distinct ids
    // arrive inside it. Without a budget a flood walks memory upward and the
    // sweep turns quadratic.
    //
    // The budget is injected rather than exercised at its production size: a
    // test that has to push 60,000 entries through to prove a bound is slow
    // enough that it gets skipped, and it measures the constant instead of the
    // behavior.
    const seen = createSeenSet(60_000, 5_000, 100);
    for (let i = 0; i < 500; i += 1) seen.seen(`flood-${i}`);
    assert.equal(seen.size(), 100, `set grew to ${seen.size()}`);

    for (let i = 0; i < 500; i += 1) seen.seen(`more-${i}`);
    assert.equal(seen.size(), 100, 'the budget did not hold');
});

test('ids admitted before the budget keep their guarantee', () => {
    // Degrading to "may reprocess" for NEW ids is the accepted trade; silently
    // dropping ids already being tracked would be a different, worse one.
    const seen = createSeenSet(60_000, 5_000, 100);
    seen.seen('early');
    for (let i = 0; i < 500; i += 1) seen.seen(`flood-${i}`);
    assert.equal(seen.seen('early'), true, 'an early id was evicted by the flood');
});

test('rejecting ids past the budget stays cheap', () => {
    // Bounding memory is not enough if the rejection path still scans the map.
    // Sweeping the whole thing per insertion is O(n) each time and O(n^2) over
    // a burst — the flood stops eating memory and starts eating the event loop
    // instead, in a path that runs for every inbound message.
    const seen = createSeenSet(60_000, 5_000, 50);
    const started = Date.now();
    for (let i = 0; i < 200_000; i += 1) seen.seen(`flood-${i}`);
    const elapsed = Date.now() - started;

    assert.equal(seen.size(), 50, 'the budget did not hold');
    assert.ok(elapsed < 500, `rejecting 200k ids took ${elapsed}ms`);
});

test('expiry costs what expired, not what is resident', () => {
    // Head-ordered expiry: a Map iterates in insertion order and entries are
    // stamped on insert, so the walk stops at the first live entry.
    const seen = createSeenSet(60_000, 10);
    for (let i = 0; i < 50_000; i += 1) seen.seen(`live-${i}`);

    const started = Date.now();
    for (let i = 0; i < 20_000; i += 1) seen.seen(`more-${i}`);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `inserting into a large live set took ${elapsed}ms`);
});

test('a clock that jumps backwards does not strand expired entries', async () => {
    // Head-ordered expiry assumes stamps never decrease. Date.now() can go
    // backwards after an NTP correction, and one older stamp sitting behind a
    // newer one parks an expired entry in front of the walk's stopping point,
    // where it holds a slot until the newer entry expires too.
    const realNow = Date.now;
    let fake = 1_000_000;
    // eslint-disable-next-line no-global-assign
    Date.now = () => fake;
    try {
        // Budget of 2, so a stranded entry is immediately visible: if either
        // of the first two survives past its window, 'd' cannot be admitted.
        const seen = createSeenSet(100, 5_000, 2);
        seen.seen('a');            // t=1_000_000
        fake += 100;
        seen.seen('b');            // t=1_000_100 — 'a' is now expired
        fake -= 90;                // the clock steps back
        fake += 1_000;             // and then well past every window

        assert.equal(seen.seen('d'), false, 'd should be new');
        assert.equal(seen.seen('d'), true,
            'd was rejected by the budget, so an expired entry still held a slot');
    } finally {
        Date.now = realNow;
    }
});

// ─── Rate limit vs formatting ────────────────────────

test('a rate limit is not classified as a formatting problem', () => {
    // The fallback ladder caught everything and retried in another format.
    // Doing that to a 429 is the worst possible response to being told to
    // slow down: three sends instead of one wait.
    assert.equal(classifySendFailure({ error_code: 429, parameters: { retry_after: 3 } }), 'rate-limit');
    assert.equal(retryAfterMs({ error_code: 429, parameters: { retry_after: 3 } }), 3_000);
});

test('a parse failure is the one case that may fall back', () => {
    // grammY surfaces Telegram's description on `message`, so that is what the
    // classifier reads.
    for (const message of [
        "Bad Request: can't parse entities",
        'Bad Request: unsupported start tag',
        'Bad Request: reply markup is invalid',
    ]) {
        assert.equal(classifySendFailure({ error_code: 400, message }), 'format', message);
    }
});

test('a 400 that is not about formatting does not fall back', () => {
    // 400 is Telegram's catch-all. Re-sending "chat not found" in HTML fails
    // exactly the same way, so the ladder must not treat it as recoverable.
    assert.equal(classifySendFailure({ error_code: 400, message: 'Bad Request: chat not found' }), 'ambiguous');
});

test('an ambiguous failure does not fall back', () => {
    // The server may already have accepted it. Re-sending in another format
    // shows the user the same message twice.
    for (const failure of [
        { code: 'ETIMEDOUT' },
        { error_code: 500 },
        new Error('socket hang up'),
    ]) {
        assert.equal(classifySendFailure(failure), 'ambiguous', `misclassified: ${JSON.stringify(failure)}`);
    }
});

test('a long rate limit is not waited out inline', () => {
    // Blocking a send path for a minute is worse than failing it.
    assert.ok(MAX_INLINE_RATE_LIMIT_MS > 0 && MAX_INLINE_RATE_LIMIT_MS <= 10_000);
    assert.ok(retryAfterMs({ error_code: 429, parameters: { retry_after: 60 } }) > MAX_INLINE_RATE_LIMIT_MS);
});

// ─── Zero-byte uploads ───────────────────────────────

test('a zero-byte file is refused before it reaches the API', async () => {
    // Slack has refused these since it shipped; both older channels only
    // checked the upper bound and let the vendor return a 400 instead.
    assert.throws(() => validateDiscordFileSize('empty.bin', 0), /zero-byte|empty/i);

    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const empty = join(mkdtempSync(join(tmpdir(), 'cxc-empty-')), 'note.txt');
    writeFileSync(empty, '');
    assert.throws(() => validateFileSize(empty, 'document'), /zero-byte|empty/i);
});

test('an ordinary file still passes both guards', async () => {
    assert.doesNotThrow(() => validateDiscordFileSize('ok.bin', 1_024));

    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const file = join(mkdtempSync(join(tmpdir(), 'cxc-ok-')), 'note.txt');
    writeFileSync(file, 'content');
    assert.doesNotThrow(() => validateFileSize(file, 'document'));
});

test('an unknown file type is still size-checked', async () => {
    // The early `if (!limit) return` skipped stat entirely, so an unknown type
    // bypassed the empty-file check as well as the limit.
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const empty = join(mkdtempSync(join(tmpdir(), 'cxc-unknown-')), 'note.bin');
    writeFileSync(empty, '');
    assert.throws(() => validateFileSize(empty, 'sticker'), /zero-byte|empty/i);
});

test('the Hub file path cannot bypass the empty-file guard', async () => {
    // The Hub calls sendTelegramFile directly, so a guard that lives in the
    // callers left exactly one route through which empty uploads reached the
    // Bot API. Validation belongs to the send function.
    const { sendTelegramFile } = await import('../../src/telegram/telegram-file.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const empty = join(mkdtempSync(join(tmpdir(), 'cxc-hub-')), 'note.txt');
    writeFileSync(empty, '');

    let uploads = 0;
    const bot = {
        api: {
            sendDocument: async () => { uploads += 1; },
            sendPhoto: async () => { uploads += 1; },
            sendVoice: async () => { uploads += 1; },
        },
    } as unknown as Parameters<typeof sendTelegramFile>[0]; // justified: minimal Bot surface for an upload spy

    const result = await sendTelegramFile(bot, 1, empty, 'document');
    assert.equal(result.ok, false, 'an empty file was accepted');
    assert.equal(uploads, 0, 'the empty file reached the API');
});

// ─── The ladder, not just the classifier ─────────────

/** Count what each send form was asked to do. */
function ladderSpy(failWith: { rich?: unknown; html?: unknown }) {
    const calls = { rich: 0, html: 0, plain: 0 };
    const api = {
        sendRichMessage: async () => {
            calls.rich += 1;
            if (failWith.rich) throw failWith.rich;
        },
        sendMessage: async (_chat: unknown, _text: string, opts?: { parse_mode?: string }) => {
            if (opts?.parse_mode === 'HTML') {
                calls.html += 1;
                if (failWith.html) throw failWith.html;
                return;
            }
            calls.plain += 1;
        },
    };
    return { api, calls };
}

test('a rate limit waits instead of re-sending in another format', async () => {
    // The defect: a bare catch fell back on ANY failure, so a 429 produced
    // three sends. A classifier unit test proves nothing if the ladder never
    // calls it — this exercises the real send path.
    const { sendTelegramMarkdown } = await import('../../src/telegram/rich-message.js');
    const rateLimited = Object.assign(new Error('Too Many Requests'), {
        error_code: 429,
        parameters: { retry_after: 0.01 },
    });

    const { api, calls } = ladderSpy({ rich: rateLimited });
    // The rate limit is surfaced after the retry rather than swallowed, which
    // is what lets a caller decide to queue rather than keep hammering.
    await sendTelegramMarkdown(api as never, 1, 'hello').catch(() => { /* expected */ });

    assert.equal(calls.html, 0, 'a rate limit must not fall back to HTML');
    assert.equal(calls.plain, 0, 'a rate limit must not fall back to plaintext');
    assert.ok(calls.rich >= 2, 'the same form should be retried after the wait');
});

test('a parse failure is the case that does fall back', async () => {
    const { sendTelegramMarkdown } = await import('../../src/telegram/rich-message.js');
    const parseFailure = Object.assign(new Error("Bad Request: can't parse entities"), {
        error_code: 400,
    });

    const { api, calls } = ladderSpy({ rich: parseFailure });
    await sendTelegramMarkdown(api as never, 1, 'hello');

    assert.equal(calls.rich, 1, 'the rich form should be tried once');
    assert.equal(calls.html, 1, 'a formatting failure is what the fallback exists for');
});

test('an ambiguous failure is not re-sent in another form', async () => {
    // The server may already have accepted it; falling back shows the user the
    // same message twice.
    const { sendTelegramMarkdown } = await import('../../src/telegram/rich-message.js');
    const timeout = Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' });

    const { api, calls } = ladderSpy({ rich: timeout });
    await sendTelegramMarkdown(api as never, 1, 'hello').catch(() => { /* surfaced, not swallowed */ });

    assert.equal(calls.html, 0, 'an ambiguous failure must not fall back');
    assert.equal(calls.plain, 0);
});

// ─── Discord REST deadlines ──────────────────────────

test('a stalled Discord REST call is abandoned rather than waited on forever', async () => {
    // Without a deadline a hung socket holds the send path open indefinitely.
    // The signal must also CANCEL the request — racing a timer against the
    // promise would leave the socket open.
    const { sendDiscordTextRest } = await import('../../src/discord/send-only-client.js');

    const realFetch = globalThis.fetch;
    let signal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        // Abort immediately rather than waiting out the real deadline: what is
        // under test is that a signal exists and that aborting ends the call,
        // not the value of the constant.
        (init?.signal as AbortSignal & { throwIfAborted?: () => void });
        throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    }) as typeof fetch;

    try {
        const result = await sendDiscordTextRest('token', '1', 'hi');
        assert.ok(signal instanceof AbortSignal, 'the request carried no abort signal');
        assert.equal(result.ok, false, 'a stalled call must not report success');
    } finally {
        globalThis.fetch = realFetch;
    }
});

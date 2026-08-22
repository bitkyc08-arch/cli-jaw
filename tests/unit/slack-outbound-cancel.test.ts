// Slack outbound cancellation (#417, L4).
//
// slackApi already accepted a signal; nothing above it passed one. Three separate
// holes followed from that: the chunk loop, the rate-limit sleep in front of a
// retry, and the three-step file upload — where step 2 POSTs up to 50 MiB to a
// presigned URL with no cancellation at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sendSlackText } from '../../src/slack/send-only-client.ts';
import { sendSlackFile } from '../../src/slack/slack-file.ts';
import { slackTargetFromId } from '../../src/messaging/slack-target.ts';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TARGET = slackTargetFromId('C1');

function okJson(body: Record<string, unknown> = { ok: true, ts: '1.1' }) {
    return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

test('the caller signal reaches chat.postMessage', async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
        seen.push(init?.signal ?? undefined);
        return okJson();
    }) as unknown as Parameters<typeof sendSlackText>[3]['fetchImpl'];

    await sendSlackText('xoxb-t', TARGET, 'hi', { fetchImpl, signal: controller.signal });

    assert.equal(seen.length, 1);
    assert.ok(seen[0], 'slackApi has taken a signal all along; the caller never supplied one');
    assert.equal(seen[0]?.aborted, false);
});

test('an already-aborted turn posts nothing', async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return okJson(); }) as never;

    const result = await sendSlackText('xoxb-t', TARGET, 'hi', {
        fetchImpl, signal: AbortSignal.abort(),
    });

    assert.equal(calls, 0);
    assert.equal(result.ok, false, 'a cancelled send must not report success');
});

test('a multi-chunk answer stops at the chunk boundary once aborted', async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; controller.abort(); return okJson(); }) as never;
    // Slack's limit is 3000 chars per chunk.
    const long = 'x'.repeat(9_000);

    await sendSlackText('xoxb-t', TARGET, long, { fetchImpl, signal: controller.signal });

    assert.equal(calls, 1, 'without a per-chunk re-check, shutdown still posts the rest');
});

test('the rate-limit wait wakes on abort instead of sleeping it out', async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl = (async () => {
        calls += 1;
        // A retryable 429 with a wait long enough that sleeping it out would be
        // obvious in the elapsed time below.
        return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ ok: false, error: 'ratelimited' }),
            text: async () => '{"ok":false,"error":"ratelimited"}',
        } as unknown as Response;
    }) as never;

    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const result = await sendSlackText('xoxb-t', TARGET, 'hi', {
        fetchImpl, signal: controller.signal, retryWaitMs: 3_000,
    });
    const elapsed = Date.now() - started;

    assert.equal(result.ok, false);
    assert.ok(elapsed < 2_000, `retry wait must be abortable, took ${elapsed}ms`);
    assert.equal(calls, 1, 'an aborted wait must not proceed to the retry');
});

test('the file upload carries the signal through all three steps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slack-cancel-'));
    const file = join(dir, 'note.txt');
    await writeFile(file, 'body');

    const controller = new AbortController();
    const signals: Array<{ url: string; signal?: AbortSignal }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
        signals.push({ url: String(url), ...(init?.signal ? { signal: init.signal } : {}) });
        if (String(url).includes('getUploadURLExternal')) {
            return okJson({ ok: true, upload_url: 'https://files.slack.test/upload', file_id: 'F1' });
        }
        return okJson({ ok: true });
    }) as never;

    await sendSlackFile('xoxb-t', TARGET, file, { fetchImpl, signal: controller.signal });

    assert.equal(signals.length, 3, 'reserve, upload, complete');
    const upload = signals.find(s => s.url.includes('files.slack.test'));
    assert.ok(upload?.signal,
        'step 2 is the 50 MiB leg — the longest one, and it had no cancellation at all');
});

test('an aborted upload never reserves anything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slack-cancel-'));
    const file = join(dir, 'note.txt');
    await writeFile(file, 'body');
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return okJson(); }) as never;

    const result = await sendSlackFile('xoxb-t', TARGET, file, {
        fetchImpl, signal: AbortSignal.abort(),
    });

    assert.equal(calls, 0);
    assert.equal(result.ok, false);
});


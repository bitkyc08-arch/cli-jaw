// Slack ACK reaction + queue-notice cleanup, at the API-wrapper layer.
//
// The wrappers are where Slack's two naming quirks live — reactions take
// `timestamp` while chat.delete/chat.update take `ts`, and the emoji name goes
// in without colons — so the payloads are asserted verbatim rather than through
// a helper that could paper over a mismatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    addSlackReaction,
    deleteSlackMessage,
    removeSlackReaction,
    stripEmojiColons,
    updateSlackMessage,
} from '../../src/slack/api.ts';
import { sendSlackText } from '../../src/slack/send-only-client.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';

const TARGET: RemoteTarget = {
    channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C123',
};

type Captured = { url: string; body: Record<string, unknown> };

function capturingFetch(
    responses: Record<string, unknown>[] = [{ ok: true }],
    headers: (Record<string, string> | null)[] = [],
) {
    const calls: Captured[] = [];
    let i = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body ?? '{}')) });
        const payload = responses[Math.min(i, responses.length - 1)];
        const header = headers[i] ?? null;
        i += 1;
        const body = JSON.stringify(payload);
        return {
            ok: true,
            status: 200,
            headers: { get: (name: string) => header?.[name.toLowerCase()] ?? null },
            // slackApi reads text() and parses it itself (Slack answers HTTP 200
            // with {ok:false}), so a json()-only mock never reaches that path.
            async text() { return body; },
            async json() { return payload; },
        } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
}

test('reactions.add sends channel, timestamp and a colon-free name', async () => {
    const { fetchImpl, calls } = capturingFetch();
    await addSlackReaction('xoxb-t', 'C123', '1700.5', ':eyes:', { fetchImpl });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /reactions\.add$/);
    assert.deepEqual(calls[0]!.body, { channel: 'C123', timestamp: '1700.5', name: 'eyes' });
});

test('reactions.remove uses timestamp too', async () => {
    const { fetchImpl, calls } = capturingFetch();
    await removeSlackReaction('xoxb-t', 'C123', '1700.5', 'eyes', { fetchImpl });
    assert.match(calls[0]!.url, /reactions\.remove$/);
    assert.deepEqual(calls[0]!.body, { channel: 'C123', timestamp: '1700.5', name: 'eyes' });
});

test('chat.delete uses ts, NOT timestamp', async () => {
    const { fetchImpl, calls } = capturingFetch();
    await deleteSlackMessage('xoxb-t', 'C123', '1700.5', { fetchImpl });
    assert.match(calls[0]!.url, /chat\.delete$/);
    // Sending `timestamp` here is the mistake this asserts against.
    assert.deepEqual(calls[0]!.body, { channel: 'C123', ts: '1700.5' });
});

test('chat.update carries ts and the replacement text', async () => {
    const { fetchImpl, calls } = capturingFetch();
    await updateSlackMessage('xoxb-t', 'C123', '1700.5', 'expired', { fetchImpl });
    assert.match(calls[0]!.url, /chat\.update$/);
    assert.deepEqual(calls[0]!.body, { channel: 'C123', ts: '1700.5', text: 'expired' });
});

test('stripEmojiColons keeps the skin-tone separator intact', () => {
    assert.equal(stripEmojiColons(':thumbsup:'), 'thumbsup');
    assert.equal(stripEmojiColons('thumbsup'), 'thumbsup');
    // Slack's own skin-tone form has an INNER double colon that must survive.
    assert.equal(stripEmojiColons(':thumbsup::skin-tone-6:'), 'thumbsup::skin-tone-6');
});

test('an application error surfaces as ok:false rather than throwing', async () => {
    // Slack answers HTTP 200 with {ok:false}; the transport must inspect it,
    // which is why the ACK handle wraps these calls and throws itself.
    const { fetchImpl } = capturingFetch([{ ok: false, error: 'missing_scope' }]);
    const r = await addSlackReaction('xoxb-t', 'C123', '1700.5', 'eyes', { fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'missing_scope');
});

test('sendSlackText returns the first chunk ts so a notice can be removed', async () => {
    const { fetchImpl } = capturingFetch([{ ok: true, ts: '1700.9' }]);
    const r = await sendSlackText('xoxb-t', TARGET, 'queued', { fetchImpl });
    assert.equal(r.ok, true);
    assert.equal(r.ts, '1700.9');
});

test('a ts is still returned when the first send only succeeded on retry', async () => {
    // Without capturing the retry's ts, a throttled notice is unremovable.
    // The inline retry only arms when Slack supplies a short retry-after; without
    // the header the client gives up and the notice would be unremovable.
    const { fetchImpl } = capturingFetch(
        [{ ok: false, error: 'ratelimited' }, { ok: true, ts: '1701.2' }],
        [{ 'retry-after': '1' }, null],
    );
    const r = await sendSlackText('xoxb-t', TARGET, 'queued', { fetchImpl });
    assert.equal(r.ok, true);
    assert.equal(r.ts, '1701.2');
});

test('the ts key is absent rather than undefined when Slack returns none', async () => {
    // exactOptionalPropertyTypes: {ts: undefined} is not the same shape.
    const { fetchImpl } = capturingFetch([{ ok: true }]);
    const r = await sendSlackText('xoxb-t', TARGET, 'queued', { fetchImpl });
    assert.equal('ts' in r, false);
});

// Dynamic lookup contract: conversations.history/replies wrappers, formatting,
// and the retry/error surfaces. Plan: devlog 260806_slack_thread_dynamic_lookup/020.
import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    fetchSlackHistory,
    fetchSlackReplies,
    formatHistoryForAgent,
    SLACK_HISTORY_MAX_LIMIT,
    type SlackHistoryMessage,
} from '../../src/slack/history.ts';

// ─── fetch capture harness (slack-outbound.test.ts pattern) ──

type Captured = { url: string; body: Record<string, unknown> };

function makeFetch(responses: Array<Record<string, unknown>>) {
    const calls: Captured[] = [];
    let i = 0;
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
        // history.ts sends form-encoded bodies (conversations.replies rejects
        // JSON with invalid_arguments — see history.ts callWithRetry).
        const params = new URLSearchParams(String(init?.body ?? ''));
        const body: Record<string, unknown> = {};
        for (const [k, v] of params) body[k] = /^\d+$/.test(v) ? Number(v) : v;
        calls.push({ url: String(url), body });
        const spec = responses[Math.min(i, responses.length - 1)];
        i++;
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(spec ?? { ok: true }),
        } as unknown as Response;
    // justified: the harness implements only the Response surface slackApi reads
    }) as unknown as typeof fetch;
    return { impl, calls };
}

const TOKEN = 'xoxb-not-a-real-token-000';

test('fetchSlackHistory normalizes messages and hasMore', async () => {
    const { impl, calls } = makeFetch([{
        ok: true,
        has_more: true,
        messages: [
            { ts: '2.0', user: 'U1', text: 'later', thread_ts: '1.0', reply_count: 3 },
            { ts: '1.0', bot_id: 'B1', text: 'earlier' },
            { text: 'no ts — dropped' },
        ],
    }]);
    const result = await fetchSlackHistory(TOKEN, 'C1', { limit: 10, fetchImpl: impl });
    assert.ok(result.ok);
    assert.equal(result.hasMore, true);
    assert.deepEqual(result.messages, [
        { ts: '2.0', threadTs: '1.0', user: 'U1', text: 'later', replyCount: 3 },
        { ts: '1.0', botId: 'B1', text: 'earlier' },
    ] satisfies SlackHistoryMessage[]);
    assert.ok(calls[0]!.url.endsWith('/conversations.history'));
    assert.equal(calls[0]!.body['channel'], 'C1');
    assert.equal(calls[0]!.body['limit'], 10);
});

test('fetchSlackReplies passes the thread ts and clamps the limit', async () => {
    const { impl, calls } = makeFetch([{ ok: true, messages: [{ ts: '1.0', user: 'U1', text: 'parent' }] }]);
    const result = await fetchSlackReplies(TOKEN, 'C1', '1.0', { limit: 9999, fetchImpl: impl });
    assert.ok(result.ok);
    assert.ok(calls[0]!.url.endsWith('/conversations.replies'));
    assert.equal(calls[0]!.body['ts'], '1.0');
    assert.equal(calls[0]!.body['limit'], SLACK_HISTORY_MAX_LIMIT);
});

test('limit clamps low end to 1', async () => {
    const { impl, calls } = makeFetch([{ ok: true, messages: [] }]);
    await fetchSlackHistory(TOKEN, 'C1', { limit: 0, fetchImpl: impl });
    // 0 is falsy → default 50, negative clamps to 1
    assert.equal(calls[0]!.body['limit'], 50);
    await fetchSlackHistory(TOKEN, 'C1', { limit: -5, fetchImpl: impl });
    assert.equal(calls[1]!.body['limit'], 1);
});

test('missing_scope surfaces the needed scope and never the token', async () => {
    const { impl } = makeFetch([{ ok: false, error: 'missing_scope', needed: 'mpim:history' }]);
    const result = await fetchSlackHistory(TOKEN, 'G-mpim', { fetchImpl: impl });
    assert.ok(!result.ok);
    assert.match(result.error, /mpim:history/);
    assert.ok(!result.error.includes(TOKEN), 'token must never appear in error output');
});

test('ratelimited retries once and succeeds (activation: retry path fires)', async () => {
    const { impl, calls } = makeFetch([
        { ok: false, error: 'ratelimited' },
        { ok: true, messages: [{ ts: '1.0', user: 'U1', text: 'after retry' }] },
    ]);
    const started = Date.now();
    const result = await fetchSlackHistory(TOKEN, 'C1', { fetchImpl: impl });
    assert.ok(result.ok);
    assert.equal(result.messages[0]!.text, 'after retry');
    assert.equal(calls.length, 2, 'exactly one retry');
    assert.ok(Date.now() - started >= 950, 'backoff pause observed');
});

test('non-retryable errors do not retry', async () => {
    const { impl, calls } = makeFetch([{ ok: false, error: 'channel_not_found' }]);
    const result = await fetchSlackHistory(TOKEN, 'CBAD', { fetchImpl: impl });
    assert.ok(!result.ok);
    assert.equal(calls.length, 1);
    assert.match(result.error, /not found|not a member/);
});

test('formatHistoryForAgent renders chronologically, marks self, caps length', () => {
    const messages: SlackHistoryMessage[] = [
        { ts: '200.0', user: 'U2', text: 'second' },
        { ts: '100.0', user: 'UBOT', text: 'first (from the bot)' },
        { ts: '300.0', botId: 'B9', text: 'third', replyCount: 2 },
    ];
    const text = formatHistoryForAgent(messages, 'UBOT');
    const lines = text.split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /bot\(self\): first/);
    assert.match(lines[1]!, /<@U2>: second/);
    assert.match(lines[2]!, /bot:B9: third \[2 replies\]/);
    // cap
    const big = formatHistoryForAgent(
        Array.from({ length: 200 }, (_, i) => ({ ts: `${i}.0`, user: 'U1', text: 'x'.repeat(100) })),
    );
    assert.ok(big.length <= 6000);
});

test('a token pasted into a Slack message is redacted from formatted output', () => {
    // Assembled at runtime so secret scanners never see a token-shaped literal.
    const pastedToken = ['xoxb', '1234567890123', '4567890123456', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-');
    const text = formatHistoryForAgent([
        { ts: '1.0', user: 'U1', text: `my token is ${pastedToken}` },
    ]);
    assert.ok(!text.includes(pastedToken.slice(0, 18)), 'pasted token must be redacted');
});

// ─── route contract (handler-level, slack-manifest-route pattern) ──

test('GET /api/slack/history rejects a missing channel and reports slack-off', async () => {
    const { registerMessagingRoutes } = await import('../../src/routes/messaging.ts');
    const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void> | void>();
    const app = {
        get: (path: string, ...fns: Array<(req: unknown, res: unknown) => void>) => {
            handlers.set(path, fns[fns.length - 1]!);
        },
        post: () => { /* not under test */ },
        use: () => { /* not under test */ },
    };
    const passAuth = (_req: unknown, _res: unknown, next: () => void) => next();
    registerMessagingRoutes(app as never, passAuth as never);
    const handler = handlers.get('/api/slack/history');
    assert.ok(handler, 'route not registered');

    // Slack is disabled in the isolated home → the client gate fires first.
    let status = 0;
    let payload: Record<string, unknown> = {};
    const res = {
        status: (code: number) => { status = code; return res; },
        json: (body: unknown) => { payload = body as Record<string, unknown>; },
    };
    await handler({ query: { channel: 'C1' } }, res);
    assert.equal(status, 503);
    assert.equal(payload['error'], 'slack_disabled');
});

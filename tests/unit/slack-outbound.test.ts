import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    slackApi,
    describeSlackError,
    isRetryableSlackError,
    redactSlackTokens,
} from '../../src/slack/api.ts';
import { toMrkdwn, chunkSlackMessage } from '../../src/slack/format.ts';
import { sendSlackText, resolveSlackDmChannel } from '../../src/slack/send-only-client.ts';
import { sendSlackFile, validateSlackFileSize } from '../../src/slack/slack-file.ts';
import { slackTargetFromId } from '../../src/messaging/slack-target.ts';

// ─── fetch capture harness ──────────────────────────

type Captured = { url: string; init: RequestInit | undefined };

function makeFetch(responses: Array<Record<string, unknown> | { __raw: true; ok: boolean; status: number }>) {
    const calls: Captured[] = [];
    let i = 0;
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const spec = responses[Math.min(i, responses.length - 1)];
        i++;
        if (spec && '__raw' in spec) {
            return { ok: spec.ok, status: spec.status, text: async () => '' } as unknown as Response;
        }
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(spec ?? { ok: true }),
        } as unknown as Response;
    // justified: the capture harness implements only the Response surface these modules read
    }) as unknown as typeof fetch;
    return { impl, calls };
}

function bodyOf(call: Captured): Record<string, unknown> {
    return JSON.parse(String(call.init?.body ?? '{}')) as Record<string, unknown>;
}

function headerOf(call: Captured, name: string): string | undefined {
    const h = call.init?.headers as Record<string, string> | undefined;
    return h?.[name];
}

// ─── api.ts ─────────────────────────────────────────

test('slackApi treats HTTP 200 with ok:false as failure', async () => {
    // Slack signals application errors with a 200. Checking response.ok alone
    // silently swallows every auth, scope, and argument failure.
    const { impl } = makeFetch([{ ok: false, error: 'not_in_channel' }]);
    const result = await slackApi('xoxb-t', 'chat.postMessage', { channel: 'C1' }, { fetchImpl: impl });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not_in_channel');
});

test('slackApi sends a bearer token and JSON body by default', async () => {
    const { impl, calls } = makeFetch([{ ok: true }]);
    await slackApi('xoxb-secret', 'chat.postMessage', { channel: 'C1' }, { fetchImpl: impl });
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.equal(headerOf(calls[0]!, 'Authorization'), 'Bearer xoxb-secret');
    assert.match(String(headerOf(calls[0]!, 'Content-Type')), /application\/json/);
    assert.deepEqual(bodyOf(calls[0]!), { channel: 'C1' });
});

test('slackApi form mode POSTs urlencoded, never GET', async () => {
    // files.getUploadURLExternal takes form-encoded args. An earlier draft sent
    // it as GET, which is not Slack's documented contract.
    const { impl, calls } = makeFetch([{ ok: true }]);
    await slackApi('xoxb-t', 'files.getUploadURLExternal', { filename: 'a.txt', length: 12 }, { fetchImpl: impl, form: true });
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.match(String(headerOf(calls[0]!, 'Content-Type')), /x-www-form-urlencoded/);
    assert.equal(String(calls[0]!.init?.body), 'filename=a.txt&length=12');
    assert.ok(!calls[0]!.url.includes('?'), 'form mode must not put args in the query string');
});

test('slackApi surfaces unparseable bodies distinctly', async () => {
    const impl = (async () => ({ ok: true, status: 200, text: async () => 'not json' } as unknown as Response)) as unknown as typeof fetch;
    const result = await slackApi('xoxb-t', 'auth.test', undefined, { fetchImpl: impl });
    assert.equal(result.error, 'invalid_json_response');
});

test('describeSlackError gives actionable text for common codes', () => {
    assert.match(describeSlackError('not_in_channel'), /invite/i);
    assert.match(describeSlackError('missing_scope'), /scope/i);
    assert.match(describeSlackError('weird_new_code'), /weird_new_code/);
});

test('isRetryableSlackError separates transient from terminal', () => {
    assert.equal(isRetryableSlackError('ratelimited'), true);
    assert.equal(isRetryableSlackError('invalid_auth'), false);
    assert.equal(isRetryableSlackError(undefined), false);
});

test('redactSlackTokens masks both token families', () => {
    const out = redactSlackTokens('bot=xoxb-123-abc app=xapp-1-A-2-b');
    assert.ok(!out.includes('xoxb-123-abc'), 'bot token leaked');
    assert.ok(!out.includes('xapp-1-A-2-b'), 'app token leaked');
    assert.match(out, /redacted/);
});

// ─── format.ts ──────────────────────────────────────

test('toMrkdwn converts bold to single asterisks', () => {
    // '**x**' renders literally in Slack; this is the most visible breakage.
    assert.equal(toMrkdwn('**bold**'), '*bold*');
    assert.equal(toMrkdwn('__bold__'), '*bold*');
});

test('toMrkdwn handles bold and italic together', () => {
    assert.equal(toMrkdwn('**b** and _i_'), '*b* and _i_');
});

test('toMrkdwn converts links to angle form', () => {
    assert.equal(toMrkdwn('[label](https://x.dev/a)'), '<https://x.dev/a|label>');
});

test('toMrkdwn converts strikethrough and headings', () => {
    assert.equal(toMrkdwn('~~gone~~'), '~gone~');
    assert.equal(toMrkdwn('## Title'), '*Title*');
});

test('toMrkdwn leaves code spans untouched', () => {
    assert.equal(toMrkdwn('`**not bold**`'), '`**not bold**`');
    assert.equal(toMrkdwn('```\n**not bold**\n```'), '```\n**not bold**\n```');
});

test('toMrkdwn strips fence language tags', () => {
    assert.equal(toMrkdwn('```ts\nconst a = 1;\n```'), '```\nconst a = 1;\n```');
});

test('toMrkdwn converts bold+italic before plain bold', () => {
    // Slack has no combined marker, so ***x*** must become *_x_*. Handling
    // plain bold first would leave a stray '**both**'.
    assert.equal(toMrkdwn('***both***'), '*_both_*');
});

test('toMrkdwn converts links whose label contains brackets', () => {
    // Agent output routinely cites like "[see [1]](url)".
    assert.equal(toMrkdwn('[a [b] c](https://x.dev)'), '<https://x.dev|a [b] c>');
});

test('toMrkdwn survives a literal NUL in the source text', () => {
    // NUL is the code-span stash sentinel. Left in place, 'a\u00000\u0000b'
    // looks like a stash reference and silently eats the surrounding text.
    const out = toMrkdwn('lit\u0000000\u0000eral');
    assert.equal(out, 'lit000eral');
    assert.ok(!out.includes('\u0000'));
});

test('toMrkdwn fuzz: never throws and never emits the stash sentinel', () => {
    const samples = [
        '', '`', '```', '**', '~~', '[](', '[x](notaurl)', '*'.repeat(50),
        '\u0000'.repeat(10), '`a`'.repeat(100), '```\nx\n```'.repeat(20),
        '🎉**bold**🎉', 'a\r\n**b**\r\nc',
    ];
    for (const s of samples) {
        const out = toMrkdwn(s);
        assert.equal(typeof out, 'string');
        assert.ok(!out.includes('\u0000'), `sentinel leaked for ${JSON.stringify(s)}`);
    }
});

test('chunkSlackMessage fuzz: terminates, respects the limit, loses nothing', () => {
    const cases: Array<[string, number]> = [
        ['', 10],
        ['``````', 5],
        ['z'.repeat(500), 50],
        ['q'.repeat(200), 3],
        ['w'.repeat(100), 1],
        [('a'.repeat(30) + '\r\n').repeat(20), 50],
        ['```\n' + 'k'.repeat(300), 40],
        ['🎉'.repeat(300), 40],
    ];
    for (const [text, limit] of cases) {
        const chunks = chunkSlackMessage(text, limit);
        assert.ok(Array.isArray(chunks), `no array for limit ${limit}`);
        // Injected fences are the only permitted growth.
        const rebuilt = chunks.join('').replace(/```/g, '').replace(/\n/g, '');
        const source = text.replace(/```/g, '').replace(/[\n\r]/g, '');
        assert.ok(
            rebuilt.length >= source.length,
            `content lost: ${rebuilt.length} < ${source.length} for ${JSON.stringify(text.slice(0, 20))}`,
        );
    }
});

test('chunkSlackMessage returns one chunk under the limit', () => {
    assert.deepEqual(chunkSlackMessage('short'), ['short']);
});

test('chunkSlackMessage splits at the last newline before the limit', () => {
    const text = `${'a'.repeat(50)}\n${'b'.repeat(50)}`;
    const chunks = chunkSlackMessage(text, 60);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], 'a'.repeat(50));
    assert.equal(chunks[1], 'b'.repeat(50));
});

test('chunkSlackMessage keeps every chunk inside a closed code block', () => {
    // Agent output is code-heavy; a split mid-fence renders the remainder as
    // prose. Each chunk must therefore both open and close its own block:
    // a middle chunk reopens with ``` at the top and closes with ``` at the
    // bottom, so the invariant is "starts fenced and ends fenced", not "even
    // fence count" — a chunk that is entirely one continuing block has 2.
    const text = '```\n' + 'x'.repeat(80) + '\n```';
    const chunks = chunkSlackMessage(text, 40);
    assert.ok(chunks.length > 1, 'expected the input to split');
    for (const chunk of chunks) {
        assert.ok(chunk.startsWith('```'), `chunk does not reopen its block: ${JSON.stringify(chunk)}`);
        assert.ok(chunk.trimEnd().endsWith('```'), `chunk does not close its block: ${JSON.stringify(chunk)}`);
    }
});

test('chunkSlackMessage terminates on fenced input (loop-progress guard)', () => {
    // Regression: reopening a fence prepends 4 chars, so a naive loop whose cut
    // landed right after the opener never shrank the remainder and span forever
    // until the heap died. Any completing call proves progress.
    const text = '```\n' + 'y'.repeat(5000) + '\n```';
    const chunks = chunkSlackMessage(text, 100);
    assert.ok(chunks.length > 10);
    assert.ok(chunks.every(c => c.length <= 120), 'chunks must respect the limit plus fence reserve');
});

// ─── outbound text ──────────────────────────────────

test('sendSlackText omits thread_ts for a non-threaded target', () => {
    const { impl, calls } = makeFetch([{ ok: true }]);
    return sendSlackText('xoxb-t', slackTargetFromId('C1'), 'hi', { fetchImpl: impl }).then(() => {
        const body = bodyOf(calls[0]!);
        assert.equal(body['channel'], 'C1');
        assert.equal(body['text'], 'hi');
        assert.ok(!('thread_ts' in body), 'thread_ts must be absent, not undefined');
    });
});

test('sendSlackText passes thread_ts when the target carries one', async () => {
    const { impl, calls } = makeFetch([{ ok: true }]);
    await sendSlackText('xoxb-t', slackTargetFromId('C1', { threadTs: '1.1' }), 'hi', { fetchImpl: impl });
    assert.equal(bodyOf(calls[0]!)['thread_ts'], '1.1');
});

test('sendSlackText converts markdown before posting', async () => {
    const { impl, calls } = makeFetch([{ ok: true }]);
    await sendSlackText('xoxb-t', slackTargetFromId('C1'), '**bold**', { fetchImpl: impl });
    assert.equal(bodyOf(calls[0]!)['text'], '*bold*');
});

test('sendSlackText posts one call per chunk', async () => {
    const { impl, calls } = makeFetch([{ ok: true }]);
    const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
    await sendSlackText('xoxb-t', slackTargetFromId('C1'), long, { fetchImpl: impl });
    assert.ok(calls.length > 1, `expected multiple posts, got ${calls.length}`);
});

test('sendSlackText surfaces a mapped error message', async () => {
    const { impl } = makeFetch([{ ok: false, error: 'missing_scope' }]);
    const result = await sendSlackText('xoxb-t', slackTargetFromId('C1'), 'hi', { fetchImpl: impl });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /scope/i);
});

// ─── DM open ────────────────────────────────────────

test('resolveSlackDmChannel opens a DM for a user id', async () => {
    const { impl, calls } = makeFetch([{ ok: true, channel: { id: 'D999' } }]);
    const result = await resolveSlackDmChannel('xoxb-t', 'U123', impl);
    assert.equal(result.channelId, 'D999');
    assert.match(calls[0]!.url, /conversations\.open/);
    assert.equal(bodyOf(calls[0]!)['users'], 'U123');
});

test('resolveSlackDmChannel passes a D-id straight through', async () => {
    const { impl, calls } = makeFetch([{ ok: true }]);
    const result = await resolveSlackDmChannel('xoxb-t', 'D555', impl);
    assert.equal(result.channelId, 'D555');
    assert.equal(calls.length, 0, 'an existing DM id must not cost an API call');
});

// ─── file upload (three-step V2 flow) ───────────────

function tempFile(contents = 'hello'): string {
    const dir = mkdtempSync(join(tmpdir(), 'slack-upload-'));
    const path = join(dir, 'note.txt');
    writeFileSync(path, contents);
    return path;
}

test('sendSlackFile performs the three-step external upload in order', async () => {
    const { impl, calls } = makeFetch([
        { ok: true, upload_url: 'https://files.slack.com/upload/abc', file_id: 'F1' },
        { __raw: true, ok: true, status: 200 },
        { ok: true },
    ]);
    const result = await sendSlackFile('xoxb-t', slackTargetFromId('C1'), tempFile(), { fetchImpl: impl });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 3);
    assert.match(calls[0]!.url, /files\.getUploadURLExternal/);
    assert.equal(calls[1]!.url, 'https://files.slack.com/upload/abc');
    assert.match(calls[2]!.url, /files\.completeUploadExternal/);
});

test('sendSlackFile does not send the bot token to the upload URL', async () => {
    // Step 2 is not a Slack API method: no Authorization header belongs there.
    const { impl, calls } = makeFetch([
        { ok: true, upload_url: 'https://files.slack.com/upload/abc', file_id: 'F1' },
        { __raw: true, ok: true, status: 200 },
        { ok: true },
    ]);
    await sendSlackFile('xoxb-t', slackTargetFromId('C1'), tempFile(), { fetchImpl: impl });
    assert.equal(headerOf(calls[1]!, 'Authorization'), undefined);
});

test('sendSlackFile threads the completion call', async () => {
    const { impl, calls } = makeFetch([
        { ok: true, upload_url: 'https://u', file_id: 'F1' },
        { __raw: true, ok: true, status: 200 },
        { ok: true },
    ]);
    await sendSlackFile('xoxb-t', slackTargetFromId('C1', { threadTs: '1.1' }), tempFile(), {
        fetchImpl: impl, caption: 'see this',
    });
    const body = bodyOf(calls[2]!);
    assert.equal(body['thread_ts'], '1.1');
    assert.equal(body['initial_comment'], 'see this');
    assert.deepEqual(body['files'], [{ id: 'F1', title: 'note.txt' }]);
});

test('sendSlackFile fails cleanly when the URL reservation fails', async () => {
    const { impl, calls } = makeFetch([{ ok: false, error: 'missing_scope' }]);
    const result = await sendSlackFile('xoxb-t', slackTargetFromId('C1'), tempFile(), { fetchImpl: impl });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /scope/i);
    assert.equal(calls.length, 1, 'must not attempt the upload after a failed reservation');
});

test('sendSlackFile reports a missing file without calling the API', async () => {
    const { impl, calls } = makeFetch([{ ok: true }]);
    const result = await sendSlackFile('xoxb-t', slackTargetFromId('C1'), '/nope/missing.txt', { fetchImpl: impl });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /not found/i);
    assert.equal(calls.length, 0);
});

test('validateSlackFileSize rejects oversize uploads with a 413', () => {
    assert.throws(
        () => validateSlackFileSize(51 * 1024 * 1024),
        (e: unknown) => (e as { statusCode?: number }).statusCode === 413,
    );
    assert.doesNotThrow(() => validateSlackFileSize(1024));
});

// ─── send handler (ChannelSendRequest adapter) ──────

import { settings } from '../../src/core/config.ts';
import { slackSendHandler } from '../../src/slack/send-handler.ts';

function withSlack<T>(patch: Record<string, unknown>, fn: () => T): T {
    const prior = (settings as Record<string, unknown>)['slack'];
    (settings as Record<string, unknown>)['slack'] = patch;
    try {
        return fn();
    } finally {
        (settings as Record<string, unknown>)['slack'] = prior;
    }
}

test('slackSendHandler refuses when slack is disabled', async () => {
    const result = await withSlack({ enabled: false }, () =>
        slackSendHandler({ type: 'text', text: 'hi', target: slackTargetFromId('C1') }));
    assert.equal(result.ok, false);
    assert.equal(result['error'], 'slack_disabled');
    assert.equal(result['status'], 503);
});

test('slackSendHandler refuses when the bot token is missing', async () => {
    const result = await withSlack({ enabled: true, botToken: '' }, () =>
        slackSendHandler({ type: 'text', text: 'hi', target: slackTargetFromId('C1') }));
    assert.equal(result['error'], 'slack_bot_token_missing');
});

test('slackSendHandler rejects an unsupported outbound type', async () => {
    const result = await withSlack({ enabled: true, botToken: 'xoxb-t' }, () =>
        // justified: the invalid type is the point of this test
        slackSendHandler({ type: 'sticker' as never, target: slackTargetFromId('C1') }));
    assert.equal(result.ok, false);
    assert.equal(result['status'], 400);
    assert.match(String(result['error']), /unsupported_outbound_type/);
});

test('slackSendHandler degrades a keyboard request to text', async () => {
    // Slack's analogue is Block Kit, whose callbacks need interactive-envelope
    // routing that v1 excludes. Sending the text beats dropping the message.
    const result = await withSlack({ enabled: true, botToken: 'xoxb-t' }, () =>
        slackSendHandler({ type: 'keyboard', target: slackTargetFromId('C1') }));
    assert.equal(result['error'], 'empty_text', 'keyboard should route into the text branch');
});

test('slackSendHandler requires a target', async () => {
    const result = await withSlack({ enabled: true, botToken: 'xoxb-t' }, () =>
        slackSendHandler({ type: 'text', text: 'hi' }));
    assert.equal(result['error'], 'slack_target_missing');
});

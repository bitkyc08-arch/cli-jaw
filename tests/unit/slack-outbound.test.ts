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

test('redactSlackTokens masks presigned upload URLs', () => {
    // The upload URL is the capability: anyone holding it can upload.
    const out = redactSlackTokens('upload failed at https://files.slack.com/upload/v1/abc?X-Amz-Signature=SECRET');
    assert.ok(!out.includes('SECRET'), 'presigned signature leaked');
    assert.match(out, /files\.slack\.com\/\.\.\.redacted/);
});

test('redactSlackTokens masks path-only upload capabilities', () => {
    // Slack's documented upload_url is an OPAQUE PATH with no query string, so
    // redacting only query strings would leave the capability exposed.
    const out = redactSlackTokens('POST https://files.slack.com/upload/v1/OPAQUEPATHCAP');
    assert.ok(!out.includes('OPAQUEPATHCAP'), 'path-only upload capability leaked');
    assert.match(out, /files\.slack\.com\/\.\.\.redacted/);
});

test('redactSlackTokens leaves unrelated URLs readable', () => {
    assert.equal(redactSlackTokens('see https://example.dev/docs'), 'see https://example.dev/docs');
});

test('redactSlackTokens resists canonical-equivalent URL spellings', () => {
    // Each of these is a valid spelling of a Slack host. A raw-text regex let
    // them through; redaction now normalizes via the URL parser.
    const bypasses: Array<[string, string]> = [
        ['https://FILES.SLACK.COM/upload/v1/UPPERSECRET', 'UPPERSECRET'],
        ['https://files.slack.com:443/upload/v1/PORTSECRET', 'PORTSECRET'],
        ['https://files.slack.com./upload/v1/DOTSECRET', 'DOTSECRET'],
        ['https://user:PASS@files.slack.com/upload/v1/USERSECRET', 'USERSECRET'],
    ];
    for (const [input, secret] of bypasses) {
        const out = redactSlackTokens(input);
        assert.ok(!out.includes(secret), `bypass not masked: ${input} -> ${out}`);
    }
});

test('redactSlackTokens strips userinfo credentials along with the path', () => {
    const out = redactSlackTokens('https://user:PASS@files.slack.com/upload/v1/X');
    assert.ok(!out.includes('PASS'), `userinfo leaked: ${out}`);
});

test('redactSlackTokens does not mask lookalike hosts', () => {
    // Neither of these IS slack.com. Masking them would hide a genuinely
    // suspicious URL from the operator reading the log.
    for (const input of [
        'https://evil.slack.com.attacker.dev/x',
        'https://evilslack.com/upload/v1/UNRELATED',
    ]) {
        assert.equal(redactSlackTokens(input), input, `over-redacted ${input}`);
    }
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

test('chunkSlackMessage splits at a newline and KEEPS it', () => {
    // The newline stays with the preceding chunk so chunks concatenate back to
    // the input exactly. Dropping it silently reformatted multi-line output.
    const text = `${'a'.repeat(50)}\n${'b'.repeat(50)}`;
    const chunks = chunkSlackMessage(text, 60);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], `${'a'.repeat(50)}\n`);
    assert.equal(chunks[1], 'b'.repeat(50));
    assert.equal(chunks.join(''), text, 'chunks must reconstruct the input');
});

test('chunkSlackMessage reconstructs plain, CRLF, and emoji input exactly', () => {
    for (const text of [
        'aaaaa\nbbbbb',
        'aaaaa\r\nbbbbb',
        'aaaaa🙂tail',
        'one\ntwo\nthree\nfour\nfive',
    ]) {
        const chunks = chunkSlackMessage(text, 10);
        assert.equal(chunks.join(''), text, `content changed for ${JSON.stringify(text)}`);
    }
});

test('chunkSlackMessage never splits a surrogate pair', () => {
    const chunks = chunkSlackMessage('aaaaa🙂tail', 10);
    for (const chunk of chunks) {
        assert.ok(
            !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk),
            `chunk boundary split an emoji: ${JSON.stringify(chunk)}`,
        );
    }
});

test('chunkSlackMessage terminates on nested backtick fences at a small limit', () => {
    // Regression: '````\n```inside\n````' previously hung until the heap died.
    const chunks = chunkSlackMessage('````\n```inside\n````', 10);
    assert.ok(chunks.length > 0);
    assert.ok(chunks.join('').includes('inside'));
});

test('chunkSlackMessage keeps content and the limit across fenced input', () => {
    const text = '```\n' + 'x'.repeat(200) + '\n```';
    for (const limit of [24, 32, 40, 60, 100]) {
        const chunks = chunkSlackMessage(text, limit);
        const over = chunks.filter(c => c.length > limit);
        assert.equal(over.length, 0, `chunk exceeded limit ${limit}: ${JSON.stringify(over)}`);
        const xs = (chunks.join('').match(/x/g) || []).length;
        assert.equal(xs, 200, `content lost at limit ${limit}`);
    }
});

test('chunkSlackMessage preserves blank lines that follow a fence opener', () => {
    // Regression: an "empty block" suppression pass deleted the source's own
    // blank lines. Whitespace-only pieces are now merged forward, not dropped.
    const text = '```\n\n' + 'x'.repeat(5000);
    const chunks = chunkSlackMessage(text, 3900);
    // Compare non-fence content exactly, newlines included: dropping the blank
    // line was precisely a newline-count regression.
    const stripFences = (s: string) => s.split('```').join('');
    const rebuiltNewlines = (stripFences(chunks.join('')).match(/\n/g) || []).length;
    const sourceNewlines = (stripFences(text).match(/\n/g) || []).length;
    assert.ok(
        rebuiltNewlines >= sourceNewlines,
        `blank line lost: ${rebuiltNewlines} newlines vs ${sourceNewlines} in source`,
    );
    assert.equal((chunks.join('').match(/x/g) || []).length, 5000, 'content lost');
    assert.equal(chunks.filter(c => c.length > 3900).length, 0);
});

test('chunkSlackMessage never emits half of a surrogate pair, even at limit 1', () => {
    // A limit smaller than one astral character yields one slightly oversized
    // chunk — shipping half an emoji would be worse.
    for (const limit of [1, 2, 3]) {
        for (const chunk of chunkSlackMessage('🙂ab🙂', limit)) {
            assert.ok(
                !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk),
                `limit ${limit} split a surrogate pair: ${JSON.stringify(chunk)}`,
            );
        }
    }
});

test('chunkSlackMessage randomized: no overflow and no non-backtick content change', () => {
    // 15k pseudo-random messages over realistic limits. The contract is:
    //   1. no chunk exceeds the limit
    //   2. every non-backtick character survives with its exact count
    // Backticks are excluded because injected fences are the intended, and
    // only permitted, growth.
    const rnd = (seed: number) => {
        let x = seed;
        return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    };
    const alphabet = ['a', '\n', '\r\n', ' ', '```', '🙂', 'x', '한'];
    let overflow = 0;
    let changed = 0;
    let checked = 0;
    for (const seed of [42, 7, 99, 2026, 555]) {
        const r = rnd(seed);
        for (let i = 0; i < 3000; i++) {
            let text = '';
            const len = Math.floor(r() * 80);
            for (let j = 0; j < len; j++) text += alphabet[Math.floor(r() * alphabet.length)]!;
            const limit = 25 + Math.floor(r() * 200);
            const chunks = chunkSlackMessage(text, limit);
            checked++;
            if (chunks.some(c => c.length > limit)) overflow++;
            const census = (s: string) => {
                const m: Record<string, number> = {};
                for (const ch of s) {
                    if (ch === '`' || ch === '\n' || ch === '\r') continue;
                    m[ch] = (m[ch] || 0) + 1;
                }
                return m;
            };
            const before = census(text);
            const after = census(chunks.join(''));
            const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
            for (const k of keys) {
                if ((before[k] || 0) !== (after[k] || 0)) { changed++; break; }
            }
        }
    }
    assert.equal(checked, 15000);
    assert.equal(overflow, 0, `${overflow} chunks exceeded their limit`);
    assert.equal(changed, 0, `${changed} messages had non-backtick content altered`);
});

test('chunkSlackMessage respects the production limit on large fenced output', () => {
    const chunks = chunkSlackMessage('```\n' + 'x'.repeat(9000) + '\n```', 3900);
    assert.ok(chunks.every(c => c.length <= 3900), 'production-limit overflow');
    assert.equal((chunks.join('').match(/x/g) || []).length, 9000);
});

test('chunkSlackMessage stays within the limit across the fence-aware threshold', () => {
    // 24 is the cutoff below which fence-aware wrapping cannot fit and the
    // function falls back to a plain split. Both sides must respect the limit.
    const text = '```\n' + 'y'.repeat(400) + '\n```';
    for (const limit of [1, 5, 10, 23, 24, 25]) {
        const chunks = chunkSlackMessage(text, limit);
        const over = chunks.filter(c => c.length > limit);
        assert.equal(over.length, 0, `limit ${limit} exceeded by ${JSON.stringify(over.slice(0, 2))}`);
        assert.equal((chunks.join('').match(/y/g) || []).length, 400, `content lost at limit ${limit}`);
    }
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

test('sendSlackFile rejects an empty file locally', async () => {
    // Slack answers a zero-length reservation with `missing_argument`, which
    // reads as a client bug; fail with something the operator can act on.
    const { impl, calls } = makeFetch([{ ok: true }]);
    const result = await sendSlackFile('xoxb-t', slackTargetFromId('C1'), tempFile(''), { fetchImpl: impl });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /empty file/i);
    assert.equal(calls.length, 0, 'must not spend an API call on an empty file');
});

test('sendSlackFile does not leak the presigned URL on a transport error', async () => {
    const impl = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('getUploadURLExternal')) {
            return {
                ok: true, status: 200,
                text: async () => JSON.stringify({ ok: true, upload_url: 'https://files.slack.com/up/a?X-Amz-Signature=SECRETSIG', file_id: 'F1' }),
            } as unknown as Response;
        }
        throw new Error(`socket hang up while posting to ${u}`);
    // justified: the harness only implements the Response surface this module reads
    }) as unknown as typeof fetch;
    const result = await sendSlackFile('xoxb-t', slackTargetFromId('C1'), tempFile(), { fetchImpl: impl });
    assert.equal(result.ok, false);
    assert.ok(!String(result.error).includes('SECRETSIG'), `presigned signature leaked: ${result.error}`);
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

test('slackSendHandler opens a DM for a U-id then posts to the D-id', async () => {
    // The plan's end-to-end acceptance case: U123 -> conversations.open -> D... -> chat.postMessage.
    // Unit-testing resolveSlackDmChannel alone would not catch a broken handler route.
    const seen: string[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        seen.push(u);
        if (u.includes('conversations.open')) {
            return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, channel: { id: 'D777' } }) } as unknown as Response;
        }
        seen.push(`body:${String(init?.body)}`);
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) } as unknown as Response;
    // justified: the harness only implements the Response surface these modules read
    }) as unknown as typeof fetch;
    // The handler builds its own client from settings, so patch the fetch used
    // by the modules under test via the injected global.
    const priorFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
        const result = await withSlack({ enabled: true, botToken: 'xoxb-t' }, () =>
            slackSendHandler({ type: 'text', text: 'hello', target: slackTargetFromId('U123') }));
        assert.equal(result.ok, true, `handler failed: ${JSON.stringify(result)}`);
        assert.ok(seen.some(s => s.includes('conversations.open')), 'never opened the DM');
        assert.ok(seen.some(s => s.includes('chat.postMessage')), 'never posted');
        assert.ok(seen.some(s => s.includes('"channel":"D777"')), 'posted to the U-id instead of the opened D-id');
    } finally {
        globalThis.fetch = priorFetch;
    }
});

test('slackSendHandler posts the text of a keyboard request', async () => {
    // The degrade branch must actually send, not just avoid crashing.
    const seen: string[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push(`${String(url)}|${String(init?.body)}`);
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) } as unknown as Response;
    // justified: same minimal Response harness
    }) as unknown as typeof fetch;
    const priorFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
        const result = await withSlack({ enabled: true, botToken: 'xoxb-t' }, () =>
            slackSendHandler({ type: 'keyboard', text: 'pick one', target: slackTargetFromId('C1') }));
        assert.equal(result.ok, true);
        assert.ok(seen.some(s => s.includes('chat.postMessage') && s.includes('pick one')), 'keyboard text was not posted');
    } finally {
        globalThis.fetch = priorFetch;
    }
});

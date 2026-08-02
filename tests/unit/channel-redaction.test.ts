// Credential redaction contract, shared by Discord, Telegram and Slack.
//
// Behavior tests only. A source-text assertion ("the file mentions redact")
// passes against an implementation that masks nothing.
import test from 'node:test';
import assert from 'node:assert/strict';

import { redactChannelSecrets, userErrorText, logErrorText } from '../../src/messaging/redact.js';

// A realistic Telegram secret: 35 chars after the numeric bot id.
const TG_SECRET = 'AAHfoobarbazquxquux12345678901234567';
const TG_TOKEN = `123456789:${TG_SECRET}`;

/** The whole point: this substring must never survive. */
const leaks = (output: string, secret: string) => output.includes(secret);

// ─── Telegram: the token lives in the URL path ───────

test('a Telegram API URL keeps its host and loses its token', () => {
    const out = redactChannelSecrets(`POST https://api.telegram.org/bot${TG_TOKEN}/getFile`);
    assert.equal(leaks(out, TG_SECRET), false);
    assert.ok(out.includes('api.telegram.org'), 'the host stays diagnosable');
});

test('a Telegram file-download URL loses its token', () => {
    const out = redactChannelSecrets(`https://api.telegram.org/file/bot${TG_TOKEN}/photos/x.jpg`);
    assert.equal(leaks(out, TG_SECRET), false);
});

test('a bot-prefixed token outside a URL is masked', () => {
    // `\b` cannot anchor here: the character before the digits is the `t` of
    // "bot", so a word-boundary pattern matches nothing and the token survives.
    for (const input of [`token=bot${TG_TOKEN}`, `bot${TG_TOKEN}`]) {
        const out = redactChannelSecrets(input);
        assert.equal(leaks(out, TG_SECRET), false, `leaked from: ${input.slice(0, 20)}`);
    }
});

test('a standalone token is masked but keeps its bot id', () => {
    const out = redactChannelSecrets(`creds ${TG_TOKEN} end`);
    assert.equal(leaks(out, TG_SECRET), false);
    assert.ok(out.includes('123456789'), 'the bot id identifies which bot for operators');
});

test('a lookalike host stays visible but its credential does not', () => {
    // Hiding the host would conceal a suspicious destination; keeping the
    // token would hand it to whoever reads the log. Both must hold at once.
    const out = redactChannelSecrets(`https://evil.telegram.org.attacker.dev/bot${TG_TOKEN}`);
    assert.equal(leaks(out, TG_SECRET), false);
    assert.ok(out.includes('evil.telegram.org.attacker.dev'), 'the suspicious host stays readable');
});

// ─── Slack: unchanged contract ───────────────────────

test('Slack token families are still masked', () => {
    const out = redactChannelSecrets('bot=xoxb-123-abc app=xapp-1-A-2-b');
    assert.equal(out.includes('xoxb-123-abc'), false);
    assert.equal(out.includes('xapp-1-A-2-b'), false);
});

test('a Slack upload URL is masked path and all', () => {
    const out = redactChannelSecrets('https://files.slack.com/upload/v1/OPAQUECAP?X-Amz-Signature=SECRET');
    assert.equal(out.includes('OPAQUECAP'), false, 'the path IS the capability');
    assert.equal(out.includes('SECRET'), false);
});

// ─── Discord ─────────────────────────────────────────

/**
 * Build a Discord-shaped token at runtime.
 *
 * Written out as a literal, these fixtures look enough like the real thing
 * that GitHub's push protection blocks the branch — which is a fair call on a
 * scanner's part, and not a fight worth having in a test file. Assembling the
 * header from the id keeps the shape the matcher needs (base64url of a
 * snowflake, then two more segments) without leaving a token-looking string
 * anywhere in the source.
 */
function discordToken(
    id = '123456789012345678',
    middle = 'GhIjKl',
    signature = 'abcdefghijklmnopqrstuvwxyz01',
): string {
    return `${Buffer.from(id).toString('base64url')}.${middle}.${signature}`;
}

test('a Discord authorization header is masked', () => {
    const token = discordToken();
    const out = redactChannelSecrets(`Authorization: Bot ${token}`);
    assert.equal(out.includes(token), false);
});

test('a Discord webhook URL is masked', () => {
    const out = redactChannelSecrets('https://discord.com/api/webhooks/123/SECRETPART');
    assert.equal(out.includes('SECRETPART'), false);
});

// ─── False positives ─────────────────────────────────

test('an unrelated URL is left readable', () => {
    assert.equal(redactChannelSecrets('see https://example.dev/docs'), 'see https://example.dev/docs');
});

test('a diagnostic query keeps its keys while losing its values', () => {
    // Blanking the whole query string also erases the parameters an operator
    // needs to reproduce a failure. Keys stay, values go.
    const out = redactChannelSecrets('https://example.dev/docs?page=2&mode=debug');
    assert.ok(out.includes('page='), 'the key structure survives');
    assert.ok(out.includes('mode='));
    assert.equal(out.includes('debug'), false, 'a value could be a signature');
});

test('a short numeric pair is not mistaken for a token', () => {
    assert.equal(redactChannelSecrets('ratio 12345678:9'), 'ratio 12345678:9');
});

test('an ordinary diagnostic value is not mistaken for a secret', () => {
    // A run of 30+ characters is not by itself a credential. Blanking a build
    // id or a hash costs an operator the value they are chasing, and a real
    // Telegram secret always mixes case with digits.
    for (const input of [`job 123456:${'A'.repeat(35)}`, `build 123456:${'7'.repeat(35)}`]) {
        assert.equal(redactChannelSecrets(input), input, `over-masked: ${input.slice(0, 18)}`);
    }
});

test('an unusually shaped secret is still masked when provenance is certain', () => {
    // Telegram documents its token as opaque, so requiring a character mix was
    // an unwritten assumption — an all-uppercase token would have shipped in
    // full. Where the surrounding text already proves this is a credential
    // (a Bot API URL, a `bot` prefix, an Authorization header), shape is
    // irrelevant. The mix is only a tie-breaker for bare prose.
    const shapes: Array<[string, string]> = [
        ['uppercase only', 'ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHI'],
        ['lowercase only', 'abcdefghijklmnopqrstuvwxyzabcdefghi'],
        ['no digits', 'AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqR'],
    ];
    for (const [name, secret] of shapes) {
        for (const input of [
            `https://api.telegram.org/bot123456789:${secret}/sendMessage`,
            `bot123456789:${secret}`,
            `Authorization: Bot 123456789:${secret}`,
            // A `/bot<id>:<secret>` segment on an untrusted host. The host
            // stays readable, but the segment itself proves a credential.
            `https://relay.example.dev/bot123456789:${secret}/send`,
        ]) {
            assert.equal(leaks(redactChannelSecrets(input), secret), false,
                `${name} leaked from: ${input.slice(0, 32)}`);
        }
    }
});

test('a dotted diagnostic is not mistaken for a Discord token', () => {
    // Three dot-separated runs describe versions, checksums and artifact ids
    // as readily as a token. What distinguishes a real one is that its first
    // segment is a base64url snowflake id.
    for (const input of [
        `${'a'.repeat(20)}.${'b'.repeat(5)}.${'c'.repeat(25)}`,
        'v1.2.3-build.4567',
        `sha256.abcdef.${'0123456789'.repeat(3)}`,
    ]) {
        assert.equal(redactChannelSecrets(input).includes('redacted'), false,
            `over-masked: ${input.slice(0, 24)}`);
    }
});

test('the bot prefix is recognised however it is spelled', () => {
    // Chasing spellings one at a time did not converge: %62ot, then %2562ot,
    // then a word joiner between the letters, then a soft hyphen. Matching now
    // happens against a folded copy, so all of these are the same string.
    const variants: Array<[string, string]> = [
        ['zero-width space', `bot\u200B123456789:${'A'.repeat(35)}`],
        ['word joiner', `bot\u2060123456789:${'A'.repeat(35)}`],
        ['soft hyphen inside the prefix', `bo\u00ADt123456789:${'A'.repeat(35)}`],
        ['percent-encoded b', `https%3A%2F%2Fevil.invalid%2F%62ot123456789%3A${'A'.repeat(35)}`],
        ['double-encoded b', `https%3A%2F%2Fevil.invalid%2F%2562ot123456789%3A${'A'.repeat(35)}`],
    ];
    for (const [name, input] of variants) {
        assert.equal(leaks(redactChannelSecrets(input), 'A'.repeat(35)), false, `leaked via ${name}`);
    }
});

test('a bot prefix inside a longer word is not provenance', () => {
    // These are product and build identifiers, not credentials. Excluding only
    // a preceding letter was not enough — `my_` and `v2` slipped through.
    for (const input of [
        `robot123456789:${'A'.repeat(35)}`,
        `my_bot123456789:${'A'.repeat(35)}`,
        `v2bot123456789:${'A'.repeat(35)}`,
    ]) {
        assert.equal(redactChannelSecrets(input), input, `over-masked: ${input.slice(0, 16)}`);
    }
});

test('every escape form a downstream renderer would undo is folded first', () => {
    // Each of these becomes `bot<id>:<secret>` once something renders it: a
    // percent-encoded control byte, a percent-encoded UTF-8 zero-width space,
    // an HTML entity, a JS escape, and encoding nested past the old cap.
    const secret = 'A'.repeat(35);
    const variants: Array<[string, string]> = [
        ['percent-encoded LF', `bo%0At123456789:${secret}`],
        ['percent-encoded UTF-8 ZWSP', `bo%E2%80%8Bt123456789:${secret}`],
        ['HTML entity', `&#98;ot123456789:${secret}`],
        ['JS unicode escape', `\\u0062ot123456789:${secret}`],
    ];
    for (const [name, input] of variants) {
        assert.equal(leaks(redactChannelSecrets(input), secret), false, `leaked via ${name}`);
    }
});

test('a secret repeated in one message is masked at every occurrence', () => {
    // The raw matchers stop at the first prefixed token, so a second mention
    // of the same credential went out in the clear.
    const secret = 'A'.repeat(35);
    const out = redactChannelSecrets(`bot123456789:${secret} note=${secret}`);
    assert.equal(leaks(out, secret), false, 'the trailing occurrence survived');
});

test('an escape spliced inside the secret does not save it', () => {
    // Finding the secret in the folded copy and deleting that literal from the
    // original cannot work here: the literal is not in the original at all.
    // The match has to be carried back by source offsets.
    const tail = 'KLMNOPQRSTUVWXYZABCDEFGHI';
    const spliced = [
        `bot123456789:ABCDEFGHIJ\u200B${tail}`,
        `bot123456789:ABCDEFGHIJ%41${tail}`,
        `bot123456789:ABCDEFGHIJ&#65;${tail}`,
        `bot123456789:ABCDEFGHIJ\\u0041${tail}`,
    ];
    for (const input of spliced) {
        assert.equal(redactChannelSecrets(input).includes(tail), false,
            `credential characters survived: ${input.slice(0, 34)}`);
    }
});

test('a run proven to be a credential is masked wherever it reappears', () => {
    // Two rules pulled against each other here. Masking every substring copy
    // destroyed unrelated values; masking only standalone copies let a second
    // mention through once it was wrapped in other characters.
    //
    // Proof wins. Once THIS run has been shown to be a credential in THIS
    // message, a later copy being a coincidence is the wrong way to be wrong —
    // the cost is one mangled diagnostic, against publishing a live token.
    const secret = 'A'.repeat(35);
    const out = redactChannelSecrets(`bot123456789:${secret} checksum=X${secret}Y`);
    assert.equal(leaks(out, secret), false, 'a proven credential survived its repeat');
    assert.ok(out.startsWith('bot123456789:...redacted'), 'the first occurrence is masked in place');

    // A run that was never proven is left alone, which is what keeps ordinary
    // checksums readable in the common case.
    const untouched = `checksum=X${secret}Y`;
    assert.equal(redactChannelSecrets(untouched), untouched);
});

test('entity and width variants a renderer accepts are folded too', () => {
    // Browsers accept a numeric entity without its semicolon, and NFKC folds
    // fullwidth letters — both restore the prefix downstream.
    const secret = 'A'.repeat(35);
    for (const input of [
        `&#98ot123456789:${secret}`,
        `&#x62ot123456789:${secret}`,
        `\uFF42\uFF4F\uFF54123456789:${secret}`,
    ]) {
        assert.equal(leaks(redactChannelSecrets(input), secret), false,
            `leaked from: ${input.slice(0, 18)}`);
    }
});

test('deeply nested encoding is still unwrapped', () => {
    // The round cap only binds on inputs built to defeat it; each round stops
    // early once nothing changes.
    const secret = 'A'.repeat(35);
    let input = `bot123456789%3A${secret}`;
    for (let depth = 0; depth < 11; depth += 1) {
        input = input.replace(/%3A/, '%253A');
        assert.equal(leaks(redactChannelSecrets(input), secret), false,
            `leaked at nesting depth ${depth + 2}`);
    }
});

test('nesting one more layer never escapes the fold', () => {
    // Every cap on rounds was beaten by nesting one deeper: 16 fell at 17, and
    // 512 fell at 513. There is no round cap now — decoding strictly shrinks,
    // so the fold reaches a fixed point on its own, and CPU is bounded by a
    // work budget whose exhaustion is reported instead of assumed clean.
    //
    // Encoding here re-encodes EVERY percent each round, which is what makes
    // the nesting real — rewriting only the first `%3A` does not deepen it.
    const secret = 'A'.repeat(35);
    for (const depth of [16, 17, 60, 513, 600]) {
        let input = `bot123456789:${secret}`;
        for (let round = 0; round < depth; round += 1) {
            input = input.replace(/%/g, '%25').replace(/^bot/, '%62ot');
        }
        assert.equal(leaks(redactChannelSecrets(input), secret), false,
            `leaked at nesting depth ${depth}`);
    }
});

test('the repeat sweep covers every proven credential, not the first few', () => {
    // Bounding this by count was the same mistake as bounding decode rounds.
    //
    // The repeat has to be spelled differently for the test to mean anything:
    // an identical copy is caught by the ordinary matchers, so only a folded
    // match can catch one wearing a zero-width space. That makes the sweep the
    // single line of defence, and a count cap a real leak.
    // Same length for all of them, so the tracked set really holds 33 entries
    // rather than collapsing under de-duplication.
    const secretFor = (i: number) => `Ab1${'Cd2'.repeat(11)}${String(i).padStart(2, '0')}`;
    let message = '';
    for (let i = 0; i < 33; i += 1) {
        message += `bot1234567${String(i).padStart(2, '0')}:${secretFor(i)} `;
    }
    const thirtyThird = secretFor(32);
    const respelled = `${thirtyThird.slice(0, 10)}\u200B${thirtyThird.slice(10)}`;
    const out = redactChannelSecrets(`${message} repeat=${respelled}`);
    assert.equal(out.includes(thirtyThird.slice(10)), false,
        'the 33rd credential repeated in the clear');
});

test('deep nesting across many runs does not stall the sink', () => {
    // 40 runs nested 512 deep is 43 KB, and rebuilding the fold per round took
    // three quarters of a second — enough to matter in a logging path.
    let input = '';
    for (let run = 0; run < 40; run += 1) {
        let piece = `bot123456789:${'A'.repeat(35)}`;
        for (let round = 0; round < 512; round += 1) {
            piece = piece.replace(/%/g, '%25').replace(/^bot/, '%62ot');
        }
        input += `${piece} `;
    }
    const started = Date.now();
    redactChannelSecrets(input);
    assert.ok(Date.now() - started < 300, `took ${Date.now() - started}ms on ${input.length} chars`);
});

test('keyboard button labels and urls are masked', async () => {
    // Inline keyboards carry user-visible text outside the message body.
    const { redactOutboundPayload } = await import('../../src/messaging/redact.js');
    const markup = {
        inline_keyboard: [[
            { text: `open https://api.telegram.org/bot123456789:${TG_SECRET}/x`, url: `https://api.telegram.org/bot123456789:${TG_SECRET}/x` },
        ]],
    };
    assert.equal(leaks(JSON.stringify(redactOutboundPayload(markup)), TG_SECRET), false);
});

test('payload walking survives cycles and depth without leaking', async () => {
    // "Does not throw" is not the contract. A visited-set that returns the
    // ORIGINAL object on a second encounter sanitizes the first alias and
    // ships the second one intact, and a depth cutoff that returns the raw
    // subtree does the same.
    const { redactOutboundPayload } = await import('../../src/messaging/redact.js');
    const url = `https://api.telegram.org/bot123456789:${TG_SECRET}/x`;

    const cyclic: Record<string, unknown> = { text: url };
    cyclic['self'] = cyclic;
    const walkedCycle = redactOutboundPayload(cyclic);
    assert.equal(leaks(JSON.stringify(walkedCycle, cycleSafe()), TG_SECRET), false);

    // The same object referenced twice: both aliases must come back sanitized.
    const button = { text: url };
    const shared = redactOutboundPayload({ first: button, second: button });
    assert.equal(leaks(JSON.stringify(shared), TG_SECRET), false, 'the second alias kept its secret');

    let deep: unknown = { text: url };
    for (let i = 0; i < 5_000; i += 1) deep = { next: deep };
    const walkedDeep = redactOutboundPayload(deep);
    assert.equal(leaks(JSON.stringify(walkedDeep), TG_SECRET), false, 'the depth cutoff returned raw');
});

/** JSON.stringify replacer that tolerates the cycles this walker preserves. */
function cycleSafe() {
    const seen = new WeakSet<object>();
    return (_key: string, value: unknown) => {
        if (value !== null && typeof value === 'object') {
            if (seen.has(value)) return '[cycle]';
            seen.add(value);
        }
        return value;
    };
}

test('an exhausted fold blanks the secret half too', async () => {
    // The fold strips control characters, so an encoded prefix and its secret
    // can sit on either side of a newline. Blanking only the run that carries
    // an escape leaves the secret behind — and the bot id is public, so that
    // half is the credential.
    let prefix = 'bot123456789:';
    for (let round = 0; round < 2_000; round += 1) {
        prefix = prefix.replace(/%/g, '%25').replace(/^bot/, '%62ot');
    }
    const out = redactChannelSecrets(`${prefix}\n${TG_SECRET}`);
    assert.equal(leaks(out, TG_SECRET), false, 'the secret survived an exhausted fold');
});

test('secrets of many different lengths do not slow the sweep', () => {
    // Indexing by length assumed there were few distinct ones. An attacker
    // picks them, and the cost follows the number of distinct lengths sharing
    // a prefix — so the fixture has to actually produce 400 of them. Written
    // with a modulo it produced 50, and the assertion proved much less than
    // its comment claimed.
    const secrets: string[] = [];
    let input = '';
    for (let i = 0; i < 400; i += 1) {
        const secret = `Ab1${'Cd2'.repeat(11)}${'z'.repeat(i)}`;
        secrets.push(secret);
        input += `bot1234567${String(i % 100).padStart(2, '0')}:${secret} `;
    }
    assert.equal(new Set(secrets.map((s) => s.length)).size, 400, 'fixture must span 400 lengths');

    const started = Date.now();
    redactChannelSecrets(input);
    assert.ok(Date.now() - started < 500, `took ${Date.now() - started}ms on ${input.length} chars`);
});

test('an NFKC expansion does not shift the offset map', () => {
    // Compatibility folding can turn one character into an astral pair. The
    // map is walked in UTF-16 code units, so pushing one entry per CODE POINT
    // left every later offset short: the secret kept its first character and
    // the character after it was eaten instead.
    const out = redactChannelSecrets(`\uFA6Cbot123456789:${TG_SECRET} tail`);
    assert.equal(leaks(out, TG_SECRET), false);
    assert.equal(out.includes(`:${TG_SECRET[0]}`), false, 'the first character of the secret survived');
    assert.ok(out.endsWith(' tail'), `the trailing text was mangled: ${out.slice(-12)}`);
});

test('secrets sharing a prefix do not slow the sweep either', () => {
    // Bucketing by prefix alone lets an attacker pile hundreds of secrets into
    // one bucket, then follow it with a long run that keeps hitting the bucket
    // and never matching — every secret re-tested at every position.
    //
    // The tail must MISS: a matching run advances the cursor past itself, so a
    // tail of real repeats measures nothing.
    const prefix = 'Ab1Cd2Ef3Gh4Ij5K';
    let input = '';
    for (let i = 0; i < 400; i += 1) {
        input += `bot1234567${String(i % 100).padStart(2, '0')}:${prefix}${'z'.repeat(20 + (i % 30))}${i} `;
    }
    input += prefix.repeat(20_000);

    const started = Date.now();
    redactChannelSecrets(input);
    // Measured: ~155 ms indexed by prefix AND length, ~340 ms when the bucket
    // is scanned linearly. The threshold sits between them so a regression to
    // per-secret scanning fails here rather than passing quietly.
    assert.ok(Date.now() - started < 250, `took ${Date.now() - started}ms on ${input.length} chars`);
});

test('an exhausted fold spares identifiers that are merely long', () => {
    // Blanking every long alphanumeric run let an attacker strip diagnostics
    // by burying one deeply encoded string in the same message.
    let prefix = 'bot123456789:';
    for (let round = 0; round < 2_000; round += 1) {
        prefix = prefix.replace(/%/g, '%25').replace(/^bot/, '%62ot');
    }
    const out = redactChannelSecrets(`${prefix}\n${TG_SECRET} release-build-20260802-darwin-arm64`);
    assert.equal(leaks(out, TG_SECRET), false, 'the secret half survived');
    assert.ok(out.includes('release-build-20260802-darwin-arm64'),
        'an ordinary build identifier was destroyed');
});

test('an elicitation ack is masked before it is shown', async () => {
    // The ack is echoed into a chat toast and an HTTP body. Sanitizing the
    // keyboard payload does not help: the label is stored raw and rebuilt here.
    const { startPendingElicitation, handleElicitationCallback } =
        await import('../../src/telegram/elicitation-buttons.js');

    const label = `pick https://api.telegram.org/bot123456789:${TG_SECRET}/x`;
    const spec = JSON.stringify({
        questions: [{ question: 'which?', type: 'single_select', options: [label, 'other'] }],
    });
    const keyboards = startPendingElicitation('42', spec);
    assert.ok(keyboards && keyboards.length > 0, 'expected a keyboard');

    const data = (keyboards[0]!.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> })
        .inline_keyboard[0]![0]!.callback_data;
    const result = handleElicitationCallback('42', data);
    const ack = 'ack' in result ? String(result.ack) : '';
    assert.equal(leaks(ack, TG_SECRET), false, `the ack carried the token: ${ack.slice(0, 40)}`);
});

test('many distinct credentials do not make redaction quadratic', () => {
    // An attacker chooses how many token-shaped runs an error string holds.
    // Scanning the whole text once per distinct secret took nearly a second.
    let input = '';
    for (let i = 0; i < 4_000; i += 1) {
        input += `bot1234567${String(i).padStart(2, '0')}:${'Ab1'.repeat(12)}${i} `;
    }
    const started = Date.now();
    redactChannelSecrets(input);
    assert.ok(Date.now() - started < 500, `took ${Date.now() - started}ms on ${input.length} chars`);
});

test('a repeat wrapped in a different encoding is still caught', () => {
    // The repeat search runs over the folded text, so a second mention spelled
    // differently folds to the same run and is masked too.
    const secret = 'AbCdEfGhIj'.repeat(3) + 'AbCdE';
    const respelled = `${secret.slice(0, 10)}\u200B${secret.slice(10)}`;
    const out = redactChannelSecrets(`bot123456789:${secret} note=${respelled}`);
    assert.equal(out.includes(secret.slice(10)), false, 'the re-spelled repeat survived');
    assert.equal(out, 'bot123456789:...redacted note=...redacted');
});

// ─── The message body, not just its errors ───────────

test('an outbound Discord message body is masked', async () => {
    // Hardening error paths is not enough: a credential travels in ordinary
    // text too — an agent echoing a config value, a forwarder relaying tool
    // output — and that text goes to a room anyone in the channel can read.
    const { chunkDiscordMessage } = await import('../../src/discord/forwarder.js');
    const body = `see https://api.telegram.org/bot123456789:${TG_SECRET}/getFile`;
    assert.equal(leaks(chunkDiscordMessage(body).join(''), TG_SECRET), false);
});

test('an outbound Telegram message body is masked', async () => {
    const { sendTelegramMarkdown } = await import('../../src/telegram/rich-message.js');
    const sent: string[] = [];
    const api = {
        sendRichMessage: async (_c: unknown, p: { markdown: string }) => { sent.push(p.markdown); },
        sendMessage: async (_c: unknown, text: string) => { sent.push(text); },
    } as unknown as Parameters<typeof sendTelegramMarkdown>[0]; // justified: minimal Api surface for a send spy

    await sendTelegramMarkdown(api, 1, `see https://api.telegram.org/bot123456789:${TG_SECRET}/getFile`);
    assert.equal(leaks(sent.join(''), TG_SECRET), false);
});

test('an outbound Slack message body is masked', async () => {
    const { chunkSlackMessage } = await import('../../src/slack/format.js');
    const body = `see https://api.telegram.org/bot123456789:${TG_SECRET}/getFile`;
    assert.equal(leaks(chunkSlackMessage(body).join(''), TG_SECRET), false);
});

test('a file caption is masked on both channels', async () => {
    // A caption reaches the room exactly like a message body does.
    const { sendDiscordFile } = await import('../../src/discord/discord-file.js');
    const sent: string[] = [];
    const client = {
        channels: {
            fetch: async () => ({
                isTextBased: () => true,
                send: async (payload: { content?: string }) => { sent.push(payload.content ?? ''); },
            }),
        },
    } as unknown as Parameters<typeof sendDiscordFile>[0]; // justified: minimal client surface for a send spy

    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const file = join(mkdtempSync(join(tmpdir(), 'cxc-redact-')), 'note.txt');
    writeFileSync(file, 'x');

    await sendDiscordFile(client, { channel: 'discord', targetId: '1' } as never, file, {
        caption: `token https://api.telegram.org/bot123456789:${TG_SECRET}/x`,
    });
    assert.equal(leaks(sent.join(''), TG_SECRET), false, 'the caption carried the token');
});

test('folding stays linear on hostile escape sequences', () => {
    // Decoding runs in a loop, so a pathological input must not make it
    // quadratic — an error sink that burns CPU on a logged string is a DoS.
    const inputs = [
        '%41'.repeat(150_000),
        '&#98;'.repeat(120_000),
        '\\u0062'.repeat(100_000),
        '%25'.repeat(150_000),
        '%E2%80%8B'.repeat(60_000),
    ];
    for (const input of inputs) {
        const started = Date.now();
        redactChannelSecrets(input);
        assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started}ms on ${input.length} chars`);
    }
});

test('an ordinary path on an untrusted host is not a credential', () => {
    // Being a URL is not provenance. Reading it that way erased artifact paths.
    const input = `https://example.dev/build/123456789:${'A'.repeat(35)}/artifact`;
    assert.equal(redactChannelSecrets(input), input);
});

test('a padded base64 segment does not hide a Discord token', () => {
    // A log may render any segment with padding. Refusing to match `=` left
    // the token characters in the clear.
    const padded = [
        discordToken().replace('.', '==.'),
        discordToken('123456789012345678', 'GhIjKl=='),
        `${discordToken().replace('.', '==.')}==`,
    ];
    for (const token of padded) {
        assert.equal(redactChannelSecrets(token).includes('abcdefghijklmnopqrstuvwxyz01'), false,
            `leaked from: ${token.slice(0, 30)}`);
    }
});

test('a snowflake-shaped non-token is masked, and that is deliberate', () => {
    // Documented over-masking: nothing in the later segments tells a real token
    // apart from an artifact id whose header happens to decode to a snowflake.
    // A miss would publish a bot token; a false hit costs one diagnostic.
    const lookalike = discordToken('123456789012345678', 'aaaaaa', 'b'.repeat(27));
    assert.equal(redactChannelSecrets(lookalike), '...redacted',
        'if this ever stops matching, confirm real tokens are still caught');
});

test('a digit or invisible character in front does not hide a token', () => {
    // A lookbehind demanding a non-digit let a 13-digit run through, and a
    // zero-width space is invisible in a log yet disappears on paste.
    const variants: Array<[string, string]> = [
        ['digit before a 12-digit id', `9123456789012:${TG_SECRET}`],
        ['zero-width space', `123456789\u200B:${TG_SECRET}`],
    ];
    for (const [name, input] of variants) {
        assert.equal(leaks(redactChannelSecrets(input), TG_SECRET), false, `leaked via ${name}`);
    }
});

test('a Discord token is masked whatever abuts it', () => {
    // `\b` fails when a letter runs straight into the token, and pinning the
    // first segment to 23-28 characters missed tokens that follow other text.
    const token = discordToken();
    for (const input of [`abcdef${token}`, `token=${token}`, `{"t":"${token}"}`]) {
        assert.equal(redactChannelSecrets(input).includes(token), false, `leaked from ${input.slice(0, 12)}`);
    }
});

// ─── Notation variants that bypassed the first pass ──

test('a token survives no spelling of its prefix or delimiter', () => {
    // Every one of these leaked before: the pattern only knew lowercase "bot",
    // consumed the leading delimiter (so a second token in the same string was
    // skipped), and never considered percent-encoding.
    const variants: Array<[string, string]> = [
        ['capitalized prefix', `Bot${TG_TOKEN}`],
        ['uppercase prefix', `BOT${TG_TOKEN}`],
        ['slash delimited', `/${TG_TOKEN}`],
        ['plural bots path', `https://api.telegram.org/bots/${TG_TOKEN}/x`],
        ['url userinfo', `https://user:${TG_TOKEN}@example.dev/x`],
        ['encoded colon', `https://evil.telegram.org.attacker.dev/bot123456789%3A${TG_SECRET}`],
        ['fully encoded url', `https%3A%2F%2Fapi.telegram.org%2Fbot123456789%3A${TG_SECRET}%2FgetFile`],
        ['inside json', `{"url":"Bot${TG_TOKEN}"}`],
        ['adjacent tokens', `${TG_TOKEN},${TG_TOKEN}`],
    ];
    for (const [name, input] of variants) {
        assert.equal(leaks(redactChannelSecrets(input), TG_SECRET), false, `leaked via ${name}`);
    }
});

test('redaction stays linear on pathological input', () => {
    // A catastrophically backtracking pattern in an error sink turns any
    // logged string into a denial of service.
    const inputs = [
        `https://${'a'.repeat(50_000)}`,
        `${'1'.repeat(20_000)}:${'A'.repeat(20_000)}`,
        `${'bot'.repeat(10_000)}123456789:${'A'.repeat(40)}`,
        '%3A'.repeat(20_000),
        // A query with a long run and no '=' made the value-masking regex
        // backtrack quadratically: 100 KB took four seconds.
        `http://h?${'a'.repeat(100_000)}`,
        `http://h?${'a=b&'.repeat(20_000)}`,
    ];
    for (const input of inputs) {
        const started = Date.now();
        redactChannelSecrets(input);
        assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started}ms on ${input.length} chars`);
    }
});

test('encoding depth, unicode and line breaks do not hide a token', () => {
    // Anchoring on what PRECEDES the token failed against every one of these.
    // Detection is anchored on the secret's own shape instead.
    const variants: Array<[string, string]> = [
        ['nested encoded colon', `https://api.telegram.org/bot123456789%253A${TG_SECRET}`],
        ['double-encoded url', `https%253A%252F%252Fapi.telegram.org%252Fbot123456789%253A${TG_SECRET}`],
        ['literal scheme, encoded slashes', `https:%2F%2Fapi.telegram.org%2Fbot123456789:${TG_SECRET}`],
        ['ordinary letter in front', `x${TG_TOKEN}`],
        ['inside a path segment', `https://example.dev/x${TG_TOKEN}`],
        ['inside json with a letter', `{"k":"x${TG_TOKEN}"}`],
        ['in a fragment', `https://example.dev/#bot123456789%253A${TG_SECRET}`],
        ['fullwidth colon', `123456789\uFF1A${TG_SECRET}`],
        ['wrapped across lines', `123456789:\n${TG_SECRET}`],
    ];
    for (const [name, input] of variants) {
        assert.equal(leaks(redactChannelSecrets(input), TG_SECRET), false, `leaked via ${name}`);
    }
});

test('named entities and default-ignorable marks are folded too', () => {
    // `&colon;` is expanded by any HTML renderer, and U+034F renders as
    // nothing while sitting outside Cc/Cf — a token split by one is still a
    // token once it is pasted.
    const tail = 'KLMNOPQRSTUVWXYZABCDEFGHI';
    const variants: Array<[string, string, string]> = [
        ['named colon entity', `bot123456789&colon;${TG_SECRET}`, TG_SECRET],
        ['combining grapheme joiner', `bot123456789:ABCDEFGHIJ\u034F${tail}`, tail],
        ['variation selector', `bot123456789:ABCDEFGHIJ\uFE0F${tail}`, tail],
    ];
    for (const [name, input, secret] of variants) {
        assert.equal(leaks(redactChannelSecrets(input), secret), false, `leaked via ${name}`);
    }
});

// ─── The helpers must never throw ────────────────────

test('stringification survives values JSON cannot serialize', () => {
    // Each of these throws somewhere in the naive implementation: BigInt and
    // circular refs break JSON.stringify, and a Symbol breaks String().
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    for (const value of [Object(1n), circular, Symbol('x'), undefined, null]) {
        assert.doesNotThrow(() => userErrorText(value));
        assert.doesNotThrow(() => logErrorText(value));
    }
});

test('a thrown non-Error still gets masked', () => {
    const out = userErrorText({ url: `https://api.telegram.org/bot${TG_TOKEN}/x` });
    assert.equal(leaks(out, TG_SECRET), false);
});

// ─── User-facing text must not carry a stack ─────────

test('userErrorText omits the stack, logErrorText keeps it', () => {
    const error = new Error('boom');
    const forUser = userErrorText(error);
    assert.equal(forUser, 'boom');
    assert.equal(/\bat\s|\.ts:|\/Users\//.test(forUser), false,
        'a stack frame publishes the operator source layout to a chat room');
    assert.ok(/\bat\s/.test(logErrorText(error)), 'logs keep the stack');
});

test('a stack that contains a token is still masked in logs', () => {
    const error = new Error(`fetch failed: https://api.telegram.org/bot${TG_TOKEN}/sendMessage`);
    assert.equal(leaks(logErrorText(error), TG_SECRET), false);
});

// ─── The send boundary, not just the call sites ──────

test('a transport failure is masked before it can become an HTTP body', async () => {
    // sendChannelOutput is the single choke point every outbound send passes
    // through, and its result goes out verbatim via res.json(result). Masking
    // at individual call sites was tried first and missed several.
    const { registerSendTransport, sendChannelOutput } = await import('../../src/messaging/send.js');
    registerSendTransport('telegram', async () => ({
        ok: false,
        error: `request failed: https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
    }));

    const { settings } = await import('../../src/core/config.js');
    const telegram = settings['telegram'] as Record<string, unknown>;
    const savedAllowlist = telegram['allowedChatIds'];
    telegram['allowedChatIds'] = [4242];
    try {
        const result = await sendChannelOutput({
            channel: 'telegram',
            type: 'text',
            text: 'hi',
            target: { channel: 'telegram', targetId: '4242' },
        } as never);

        // Guard against the request being rejected before it reaches the
        // transport: an early return would make this pass without ever
        // exercising the sink under test.
        assert.ok(String(result['error'] ?? '').includes('request failed'),
            `expected the transport failure, got: ${JSON.stringify(result)}`);
        assert.equal(leaks(String(result['error']), TG_SECRET), false,
            'the failure result reaches an API response unchanged');
    } finally {
        telegram['allowedChatIds'] = savedAllowlist;
    }
});

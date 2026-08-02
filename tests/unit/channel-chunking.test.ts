// Shared chunker contract — one suite for every channel.
//
// These are BEHAVIOR tests: they call the real chunkers and inspect output.
// Source-text assertions (`assert.match(src, /safeCut/)`) pass against a
// broken implementation and were rejected during the Slack audit.
//
// Every test here was mutation-verified: the original defect was re-injected
// and the test observed to fail before the fix was restored.
import test from 'node:test';
import assert from 'node:assert/strict';

import { chunkDiscordMessage } from '../../src/discord/forwarder.js';
import { chunkTelegramMessage } from '../../src/telegram/forwarder.js';
import { chunkSlackMessage } from '../../src/slack/format.js';
import { chunkRichMarkdown } from '../../src/telegram/rich-message.js';
import { chunkFenceAware, safeCut, trailingFenceLang, fenceReserve, scanOpenFence } from '../../src/messaging/chunk.js';
import { sendTelegramMarkdown } from '../../src/telegram/rich-message.js';

type Chunker = (text: string, limit?: number) => string[];

const CHANNELS: Array<{ name: string; fn: Chunker; limit: number }> = [
    { name: 'discord', fn: chunkDiscordMessage, limit: 2000 },
    { name: 'slack', fn: chunkSlackMessage, limit: 3900 },
    { name: 'telegram-rich', fn: chunkRichMarkdown, limit: 32000 },
];

/** Any lone surrogate means half an emoji reached the wire. */
function hasLoneSurrogate(chunks: string[]): boolean {
    for (const chunk of chunks) {
        for (let i = 0; i < chunk.length; i += 1) {
            const code = chunk.charCodeAt(i);
            if (code >= 0xD800 && code <= 0xDBFF) {
                const next = chunk.charCodeAt(i + 1);
                if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
                i += 1;
            } else if (code >= 0xDC00 && code <= 0xDFFF) {
                return true;
            }
        }
    }
    return false;
}

const oddFence = (chunks: string[]) =>
    chunks.some((c) => ((c.match(/```/g) ?? []).length) % 2 === 1);

/** Compare ignoring injected fence markers and whitespace. */
const bare = (s: string) => s.replace(/```[A-Za-z0-9_+#.-]*\n?/g, '').replace(/\s/g, '');

// ─── D-1: content preservation ───────────────────────

test('every chunker preserves content exactly when no fence is involved', () => {
    const text = 'aaa\nbbb\nccc';
    for (const { name, fn } of CHANNELS) {
        assert.equal(fn(text, 5).join(''), text, `${name} lost content`);
    }
});

test('discord keeps the newline it splits on', () => {
    // The old implementation ran .replace(/^\n/, '') on the remainder, so
    // "aaa\nbbb\nccc" came back as "aaabbbccc".
    assert.deepEqual(chunkDiscordMessage('aaa\nbbb\nccc', 5), ['aaa\n', 'bbb\n', 'ccc']);
});

test('newline-heavy payloads survive a realistic limit', () => {
    const text = 'a\n'.repeat(3000);
    assert.equal(chunkDiscordMessage(text, 2000).join(''), text);
    assert.equal(chunkSlackMessage(text, 3900).join(''), text);
});

// ─── D-2: fence balance ──────────────────────────────

test('a fence split across chunks stays balanced in every chunk', () => {
    const fenced = `intro\n\`\`\`ts\n${'const x = 1;\n'.repeat(400)}\`\`\`\ntail`;
    for (const { name, fn, limit } of CHANNELS) {
        const chunks = fn(fenced, limit === 32000 ? 2000 : limit);
        assert.equal(oddFence(chunks), false, `${name} left a fence open`);
        assert.equal(bare(chunks.join('')), bare(fenced), `${name} lost fenced content`);
    }
});

test('a single oversized code block is closed and reopened', () => {
    const body = '```\n' + 'x'.repeat(40000) + '\n```';
    const chunks = chunkRichMarkdown(body);
    assert.ok(chunks.length > 1, 'expected the body to split');
    assert.equal(oddFence(chunks), false, 'chunks must not leave a fence open');
});

// ─── Language tag preservation ───────────────────────

test('a continuation chunk reopens with the original language tag', () => {
    const fenced = `intro\n\`\`\`ts\n${'const x = 1;\n'.repeat(50)}\`\`\`\ntail`;
    const chunks = chunkFenceAware(fenced, 300);
    const continuations = chunks.slice(1).filter((c) => c.startsWith('```'));
    assert.ok(continuations.length > 0, 'expected at least one continuation');
    for (const chunk of continuations) {
        assert.ok(chunk.startsWith('```ts'), `continuation dropped the tag: ${chunk.slice(0, 12)}`);
    }
});

test('a long language tag never pushes a chunk past the limit', () => {
    // fenceReserve('typescript') is 18, well over the 8 a bare fence needs.
    const body = `\`\`\`typescript\n${'y'.repeat(4000)}\n\`\`\``;
    for (const limit of [200, 2000]) {
        const chunks = chunkFenceAware(body, limit);
        for (const chunk of chunks) {
            assert.ok(chunk.length <= limit, `chunk of ${chunk.length} exceeds ${limit}`);
        }
    }
});

test('a pathological language tag still terminates and stays in budget', () => {
    const absurd = 'z'.repeat(100);
    const body = `\`\`\`${absurd}\n${'y'.repeat(2000)}\n\`\`\``;
    const chunks = chunkFenceAware(body, 60);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.length < 500, 'suspiciously many chunks — possible non-termination');
    // Falls back to bare fences rather than emitting zero-payload chunks.
    assert.equal(bare(chunks.join('')).includes('y'.repeat(50)), true);
});

test('slack never invents a language tag it was not given', () => {
    // toMrkdwn strips tags upstream because mrkdwn cannot render them; the
    // chunker must not add one back.
    const fenced = '```\n' + 'q'.repeat(9000) + '\n```';
    const chunks = chunkSlackMessage(fenced, 3900);
    for (const chunk of chunks) {
        assert.equal(/```[A-Za-z]/.test(chunk), false, 'a bare fence gained a tag');
    }
});

// ─── D-3: surrogate safety ───────────────────────────

test('odd limits never split a surrogate pair', () => {
    const emoji = '\u{1F44D}'.repeat(200);
    for (const limit of [51, 101]) {
        assert.equal(hasLoneSurrogate(chunkDiscordMessage(emoji, limit)), false, `discord @${limit}`);
        assert.equal(hasLoneSurrogate(chunkTelegramMessage(emoji, limit)), false, `telegram @${limit}`);
        assert.equal(hasLoneSurrogate(chunkSlackMessage(emoji, limit)), false, `slack @${limit}`);
        assert.equal(hasLoneSurrogate(chunkRichMarkdown(emoji, limit)), false, `rich @${limit}`);
    }
});

test('safeCut backs off a low surrogate and advances when it cannot', () => {
    const pair = '\u{1F44D}';
    assert.equal(safeCut(pair, 1), 2, 'index 1 is the low half; must not cut there');
    assert.equal(safeCut(`a${pair}`, 2), 1, 'backs off to before the pair');
    assert.equal(safeCut('abc', 2), 2, 'BMP text is untouched');
});

// ─── Existing contracts that must not regress ────────

test('empty input returns a single empty chunk', () => {
    for (const { name, fn } of CHANNELS) {
        assert.deepEqual(fn(''), [''], `${name} broke the empty contract`);
    }
});

test('text at exactly the limit is one chunk', () => {
    assert.equal(chunkDiscordMessage('b'.repeat(2000)).length, 1);
    assert.equal(chunkSlackMessage('b'.repeat(3900)).length, 1);
});

test('fence-free text uses the full budget rather than reserving for fences', () => {
    // Reserving 8 bytes for fences that cannot exist cost Discord a third
    // outbound message for a 4,000-character plain reply.
    assert.equal(chunkDiscordMessage('a'.repeat(4000)).length, 2);
});

test('splitting always terminates on input with no boundaries', () => {
    const chunks = chunkDiscordMessage('x'.repeat(50), 10);
    assert.equal(chunks.length, 5);
    assert.equal(chunks.join(''), 'x'.repeat(50));
});

// ─── Helper contracts ────────────────────────────────

test('trailingFenceLang reports only an unclosed fence', () => {
    assert.equal(trailingFenceLang('a\n```ts\ncode'), 'ts');
    assert.equal(trailingFenceLang('```ts\ncode\n```\nafter'), '');
    assert.equal(trailingFenceLang('no fence here'), '');
});

test('fenceReserve grows with the language tag', () => {
    assert.equal(fenceReserve(''), 8);
    assert.equal(fenceReserve('ts'), 10);
    assert.equal(fenceReserve('typescript'), 18);
});

// ─── Randomized properties ───────────────────────────
// The Slack unit is guarded by randomized property tests as well as cases;
// these are the same shape, run against both older channels. Deterministic
// cases only prove the inputs someone thought of, and every defect in this
// unit was found by generating one nobody had.

/** Deterministic PRNG so a failure reproduces from its seed alone. */
function seeded(seed: number) {
    let state = seed;
    return () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/** Fragments chosen to collide with every boundary this splitter cares about. */
const FUZZ_ALPHABET = [
    'a', '\n', '\r\n', ' ', '```', '````', '~~~', '```ts\n', '```typescript\n',
    '\u{1F44D}', '\u{1F469}\u200D\u{1F4BB}', 'x', '한', '`', '.', '```\n',
];

function randomMessage(next: () => number): string {
    let text = '';
    const pieces = Math.floor(next() * 40);
    for (let i = 0; i < pieces; i += 1) {
        text += FUZZ_ALPHABET[Math.floor(next() * FUZZ_ALPHABET.length)]!;
    }
    return text;
}

/**
 * Everything a chunk sequence must satisfy, whatever the input.
 *
 * Content comparison ignores fence markers and their language tags, because
 * those are the one thing the splitter is allowed to add. It also ignores
 * whitespace: a reopener carries a newline the source did not have.
 */
function assertChunkProperties(
    chunks: string[],
    text: string,
    limit: number,
    label: string,
): void {
    assert.ok(chunks.length > 0, `${label}: produced no chunks`);
    assert.ok(chunks.length < text.length + 8, `${label}: suspiciously many chunks — possible non-termination`);

    for (const [i, chunk] of chunks.entries()) {
        assert.ok(chunk.length <= limit, `${label}: chunk ${i} is ${chunk.length} > ${limit}`);
    }
    assert.equal(hasLoneSurrogate(chunks), false, `${label}: split a surrogate pair`);

    // Content is checked by CONSUMPTION, not by normalizing both sides. A
    // normalizer has to guess which markers were injected, and every guess
    // either erases the source's own delimiters or leaves an injected one
    // behind — both produce false failures on input made of delimiters.
    //
    // Walking instead: each chunk must consume a prefix of what is left, and
    // the walk must reach the end. Whatever a chunk holds beyond that prefix
    // is markup the splitter added.
    let cursor = 0;
    for (const chunk of chunks) {
        let matched = 0;
        for (let take = Math.min(chunk.length, text.length - cursor); take > 0; take -= 1) {
            if (chunk.includes(text.slice(cursor, cursor + take))) { matched = take; break; }
        }
        cursor += matched;
    }
    assert.equal(cursor, text.length, `${label}: content lost — consumed ${cursor} of ${text.length}`);

    // Fence balance is checked only where it is promised.
    //
    // Two carve-outs, both documented in chunk.ts rather than discovered here:
    // a source that ends mid-block legitimately yields chunks that end
    // mid-block — inventing a closer the author omitted is not the splitter's
    // job — and a delimiter wider than the chunk budget is left unrepaired,
    // because reopening it would breach the size limit. Delivery beats
    // formatting, and the size contract is the one that cannot bend.
    // The widest opener in the SOURCE understates what the splitter may meet:
    // pieces are cut from a reduced budget, and a run that was not an opener
    // in the whole text can become one once isolated. Measuring the widest run
    // of delimiter characters anywhere covers that.
    const widestRun = Math.max(
        3,
        ...[...text.matchAll(/`{3,}|~{3,}/g)].map((m) => m[0].length),
    );
    const repairable = widestRun * 2 + 2 <= limit;
    if (scanOpenFence(text) === null && repairable) {
        for (const [i, chunk] of chunks.entries()) {
            assert.equal(scanOpenFence(chunk), null,
                `${label}: chunk ${i} opened a fence the source did not leave open`);
        }
    }
}

test('chunkDiscordMessage randomized: terminates, fits, and changes nothing', () => {
    for (const seed of [1, 42, 99, 2026, 31337]) {
        const next = seeded(seed);
        for (let i = 0; i < 400; i += 1) {
            // Draw the limit unconditionally: skipping the draw for an empty
            // message desynchronizes the generator from the case index, and a
            // reported failure then points at the wrong input.
            const text = randomMessage(next);
            const limit = 25 + Math.floor(next() * 200);
            if (!text) continue;
            assertChunkProperties(
                chunkDiscordMessage(text, limit), text, limit,
                `discord seed ${seed} case ${i} limit ${limit}`,
            );
        }
    }
});

test('chunkRichMarkdown randomized: terminates, fits, and changes nothing', () => {
    // The Telegram default path. Its own splitter, so it needs its own fuzz —
    // the fence and prefix defects here were separate from Discord's.
    for (const seed of [7, 555, 2026, 8080]) {
        const next = seeded(seed);
        for (let i = 0; i < 400; i += 1) {
            const text = randomMessage(next);
            const limit = 25 + Math.floor(next() * 200);
            if (!text) continue;
            assertChunkProperties(
                chunkRichMarkdown(text, limit), text, limit,
                `rich seed ${seed} case ${i} limit ${limit}`,
            );
        }
    }
});

// ─── Fence lexing: line constructs, not backtick counting ────

test('a backtick run inside a code block is not a closing fence', () => {
    // Ordinary agent output. Counting every ``` treated the string literal as
    // a closer and shipped the rest of the message as prose.
    const text = '```ts\nconst marker = "```";\n' + 'z'.repeat(4000) + '\n```';
    const chunks = chunkFenceAware(text, 2000);
    assert.ok(chunks.length > 1, 'expected a split');
    for (const chunk of chunks.slice(1)) {
        assert.ok(chunk.startsWith('```ts'), `continuation lost the fence: ${chunk.slice(0, 16)}`);
    }
});

test('a four-backtick fence reopens with four backticks', () => {
    const text = '````\n' + 'q'.repeat(3000) + '\n````';
    const chunks = chunkFenceAware(text, 2000);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks.slice(1)) {
        assert.ok(chunk.startsWith('````'), `wrong delimiter length: ${chunk.slice(0, 8)}`);
    }
});

test('scanOpenFence follows CommonMark line rules', () => {
    assert.equal(scanOpenFence('```ts\ncode')?.lang, 'ts');
    assert.equal(scanOpenFence('```ts\ncode\n```'), null, 'closed fence');
    assert.equal(scanOpenFence('```ts\nx = "```"\n')?.lang, 'ts', 'inline run is not a closer');
    assert.equal(scanOpenFence('a `inline` b'), null, 'inline code opens nothing');
    assert.equal(scanOpenFence('~~~\ncode')?.marker, '~~~', 'tilde fences are fences');
    assert.equal(scanOpenFence('````\nx\n```')?.marker, '````', 'a shorter run cannot close a longer one');
    // CommonMark forbids an info string on a closing fence, so "``` js" does
    // NOT close the block — it is content, and the fence stays open.
    assert.deepEqual(scanOpenFence('```\nx\n``` js'), { marker: '```', lang: '' });
});

// ─── Prefix budget on the real send path ─────────────

test('a prefixed fenced message keeps the fence open across messages', async () => {
    const sent: string[] = [];
    const api = {
        sendRichMessage: async (_chat: unknown, payload: { markdown: string }) => { sent.push(payload.markdown); },
        sendMessage: async () => { throw new Error('should not fall back'); },
    } as unknown as Parameters<typeof sendTelegramMarkdown>[0]; // justified: minimal Api surface for a send spy

    await sendTelegramMarkdown(api, 1, '```ts\n' + 'x'.repeat(40000) + '\n```', { prefix: '\u{1F4E1} ' });

    assert.ok(sent.length > 1, 'expected the body to split');
    for (const [i, message] of sent.entries()) {
        assert.ok(message.length <= 32000, `message ${i} is ${message.length} chars`);
    }
    assert.ok(sent[1]!.startsWith('```ts'), 'the second message must resume the code block');
});

test('a prefix at least as long as the limit does not produce an oversized send', async () => {
    const sent: string[] = [];
    const api = {
        sendRichMessage: async (_chat: unknown, payload: { markdown: string }) => { sent.push(payload.markdown); },
        sendMessage: async () => {},
    } as unknown as Parameters<typeof sendTelegramMarkdown>[0]; // justified: minimal Api surface for a send spy

    await sendTelegramMarkdown(api, 1, 'body', { prefix: 'p'.repeat(32000) });
    // The prefix alone fills the budget, so it is dropped rather than shipped
    // with a payload that guarantees rejection. The body must still arrive.
    assert.ok(sent.length >= 1);
    assert.equal(sent.join(''), 'body', 'the body must be sent without the oversized prefix');
    for (const [i, message] of sent.entries()) {
        assert.ok(message.length <= 32000, `send ${i} was ${message.length}`);
    }
});

// ─── Fence lexing: line state and delimiter variety ──

test('a tilde fence goes down the fence-aware path, not the plain one', () => {
    const text = '~~~ts\n' + 'q'.repeat(3000) + '\n~~~';
    const chunks = chunkFenceAware(text, 2000);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks.slice(1)) {
        assert.ok(chunk.startsWith('~~~'), `tilde block not resumed: ${chunk.slice(0, 8)}`);
    }
});

test('a mid-line delimiter does not become a fence at a split boundary', () => {
    // The ``` here sits inside a line, so it opens nothing. A splitter that
    // lexes each piece from scratch sees it at the start of a piece, invents a
    // code block, and injects markers that overshoot the limit.
    const text = 'a'.repeat(22) + '```ts\n' + 'b'.repeat(100);
    const chunks = chunkFenceAware(text, 30);
    for (const chunk of chunks) {
        assert.ok(chunk.length <= 30, `chunk of ${chunk.length} exceeds 30`);
    }
    assert.equal(chunks.join(''), text, 'no markers should have been injected');
});

test('a mid-line delimiter inside a block does not close it at a seam', () => {
    // A reopener ends with a newline, so the next piece starts at column zero.
    // A delimiter that sat mid-line in the source became a real closing fence
    // there, ending the block a message early and leaving a stray opener.
    for (const [limit, bodyLength] of [[25, 31], [30, 80], [30, 4000]] as const) {
        const text = '```ts\n' + 'x'.repeat(bodyLength) + '```\n' + 'y'.repeat(20);
        const chunks = chunkFenceAware(text, limit);
        for (const [i, chunk] of chunks.entries()) {
            assert.equal(scanOpenFence(chunk), null,
                `limit ${limit}: chunk ${i} left a fence open: ${chunk.slice(0, 16)}`);
        }
    }
});

test('a delimiter run wider than the budget is left alone rather than overflowing', () => {
    // A split can isolate a backtick run that was NOT a fence in the source.
    // Reopening with that run would exceed the caller's limit, so the chunker
    // declines to repair it — the size contract outranks the cosmetic one.
    const text = '`'.repeat(21) + ' x 한한````\r\na~~~` `x```\r\n';
    const chunks = chunkFenceAware(text, 31);
    for (const chunk of chunks) {
        assert.ok(chunk.length <= 31, `chunk of ${chunk.length} exceeds 31`);
    }
});

test('the seam adjustment never pushes a later chunk past the limit', () => {
    // Moving a code point across the seam grows the receiving piece, which was
    // usually already full. The overflow has to travel down the line instead of
    // riding out on the wire.
    for (const limit of [30, 31, 40, 120]) {
        for (let pad = 1; pad <= limit * 3; pad += 1) {
            const text = '```ts\n' + 'x'.repeat(pad) + '```' + 'y'.repeat(60);
            for (const [name, chunks] of [
                ['core', chunkFenceAware(text, limit)],
                ['rich', chunkRichMarkdown(text, limit)],
            ] as const) {
                for (const chunk of chunks) {
                    assert.ok(chunk.length <= limit,
                        `${name} limit ${limit} pad ${pad}: chunk of ${chunk.length}`);
                }
            }
        }
    }
});

test('content survives the seam adjustment exactly', () => {
    // Strip the markers this run injected, then require the remainder to equal
    // the source byte for byte.
    //
    // A `chunk.includes(candidate)` walk is NOT enough: it accepts a match
    // found inside an injected reopener, so a repeated string or a language
    // tag could mask a real loss. Peeling the reopener and closer off each
    // chunk by position leaves exactly the payload.
    const payloadOf = (chunk: string, isFirst: boolean) => {
        let body = chunk;
        if (!isFirst) {
            // A reopener is a delimiter run, an optional info string, and a
            // newline — always the first line of a continuation chunk.
            body = body.replace(/^ {0,3}(?:`{3,}|~{3,})[A-Za-z0-9_+#.-]*\n/, '');
        }
        // A closer is a delimiter run on the final line. It is only injected
        // when something precedes it: stripping the newline of a chunk that is
        // just an opener would eat the source's own line break.
        return body.replace(/(?<=.)\n(?:`{3,}|~{3,})$/s, '');
    };

    for (const limit of [30, 120, 300]) {
        for (const pad of [14, 20, 34, 40, 54, 60]) {
            const text = '```ts\n' + 'x'.repeat(pad) + '```' + 'y'.repeat(60);
            for (const [name, chunks] of [
                ['core', chunkFenceAware(text, limit)],
                ['rich', chunkRichMarkdown(text, limit)],
            ] as const) {
                const rebuilt = chunks.map((c, i) => payloadOf(c, i === 0)).join('');
                assert.equal(rebuilt, text, `${name} limit ${limit} pad ${pad} did not round-trip`);
            }
        }
    }
});

test('an oversized delimiter run keeps the hard guarantees but not the formatting', () => {
    // A genuine fence wider than the budget cannot be reopened without
    // breaking the limit, so its block is not carried across chunks. The
    // guarantees that survive are the ones that matter for delivery.
    const text = '`'.repeat(21) + '\n' + 'payload line\n'.repeat(12) + '`'.repeat(21);
    const chunks = chunkFenceAware(text, 40);
    assert.ok(chunks.length > 1, 'expected a split');
    for (const chunk of chunks) {
        assert.ok(chunk.length <= 40, `chunk of ${chunk.length} exceeds 40`);
    }
    assert.equal(hasLoneSurrogate(chunks), false);
    assert.equal(chunks.join(''), text, 'content must survive even when the fence cannot');
});

test('scanOpenFence respects a mid-line start', () => {
    assert.equal(scanOpenFence('```ts\nbody', null, true)?.lang, 'ts');
    assert.equal(scanOpenFence('```ts\nbody', null, false), null, 'continues a line: not a fence');
});

test('a wider fence opened after an inherited one stays inside the limit', () => {
    const inherited = scanOpenFence('```\n');
    const rest = 'a'.repeat(30) + '\n```\n`````js\n' + 'b'.repeat(60) + '\n`````';
    const chunks = chunkRichMarkdown(rest, 40, inherited);
    for (const chunk of chunks) {
        assert.ok(chunk.length <= 40, `chunk of ${chunk.length} exceeds 40`);
    }
});

// ─── Prefix handoff boundaries ───────────────────────

/** Collect what a send path actually put on the wire. */
function sendSpy(withRich: boolean) {
    const sent: string[] = [];
    const api = {
        ...(withRich
            ? { sendRichMessage: async (_c: unknown, p: { markdown: string }) => { sent.push(p.markdown); } }
            : {}),
        sendMessage: async (_c: unknown, text: string) => { sent.push(text); },
    } as unknown as Parameters<typeof sendTelegramMarkdown>[0]; // justified: minimal Api surface for a send spy
    return { api, sent };
}

test('a mid-line delimiter does not become a fence in the handed-off message', async () => {
    // The ``` sits inside a line of the source. If the split lands right before
    // it, the next message starts with it and Telegram reads it as a fence,
    // rendering everything after it as prose.
    const markdown = 'a'.repeat(32000 - 3) + '```ts\n' + 'b'.repeat(100);
    const { api, sent } = sendSpy(true);
    await sendTelegramMarkdown(api, 1, markdown, { prefix: '\u{1F4E1} ' });

    assert.ok(sent.length > 1, 'expected a split');
    assert.equal(/^ {0,3}(?:`{3,}|~{3,})/.test(sent[1]!), false,
        `handoff turned a mid-line delimiter into a fence: ${sent[1]!.slice(0, 10)}`);
});

test('a prefix one under the limit does not overflow on an astral first character', async () => {
    // Budget of 1 code unit: safeCut refuses to split the emoji and emits both
    // halves, so prefix + payload lands one character over.
    for (const withRich of [true, false]) {
        const limit = withRich ? 32000 : 4096;
        const { api, sent } = sendSpy(withRich);
        await sendTelegramMarkdown(api, 1, '\u{1F44D}'.repeat(10), { prefix: 'p'.repeat(limit - 1) });
        for (const [i, message] of sent.entries()) {
            assert.ok(message.length <= limit, `${withRich ? 'rich' : 'html'} send ${i} was ${message.length}`);
        }
    }
});

test('the handoff never splits an emoji that sits before the delimiter', async () => {
    // Moving one UTF-16 unit across the seam cut the surrogate pair in half.
    for (const gap of [3, 4, 5]) {
        const markdown = 'a'.repeat(32000 - gap - 2) + '\u{1F44D}' + '```ts\n' + 'b'.repeat(20);
        const { api, sent } = sendSpy(true);
        await sendTelegramMarkdown(api, 1, markdown, { prefix: '\u{1F4E1} ' });
        assert.equal(hasLoneSurrogate(sent), false, `gap ${gap} split a surrogate pair`);
    }
});

test('every handed-off message closes the fence it opened', async () => {
    // Re-chunking the adjusted head dropped the closer the first pass added,
    // and an inline prefix pushed the opening fence off column zero so
    // Telegram stopped seeing it as a fence at all.
    for (const gap of [3, 6, 10]) {
        const markdown = '```js\n' + 'a'.repeat(32000 - gap) + '```ts\n' + 'b'.repeat(20);
        const { api, sent } = sendSpy(true);
        await sendTelegramMarkdown(api, 1, markdown, { prefix: '\u{1F4E1} ' });
        for (const [i, message] of sent.entries()) {
            assert.equal(scanOpenFence(message), null, `gap ${gap}: message ${i} left a fence open`);
            assert.ok(message.length <= 32000, `gap ${gap}: message ${i} was ${message.length}`);
        }
    }
});

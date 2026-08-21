#!/usr/bin/env node
/**
 * Fail when a channel sink reaches a user or a log without masking.
 *
 * Written because the audits kept finding the same class of miss: masking was
 * added at call sites, a new call site appeared, and every green test suite
 * still said the channels were covered. A grep proves nothing on its own, but
 * it is a good alarm for "somebody added a reply that skips the masker", which
 * is precisely what kept happening.
 *
 * The allowlist is the honest part. An exception has to name the line and the
 * reason; an entry without one is a bug waiting to be found again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Directories and single files whose outbound and logging surfaces must be masked.
 *
 * The channel folders are the obvious part. `src/messaging` is the shared layer
 * every channel routes through, and `src/routes/messaging.ts` holds a Telegram
 * `api.sendMessage` that lives outside the channel folders — the first version
 * of this gate did not watch it, so a future edit there could have dropped the
 * mask with no gate to notice.
 */
const SCANNED = [
    'src/telegram',
    'src/discord',
    'src/slack',
    'src/manager/telegram-hub',
    'src/messaging',
    'src/routes/messaging.ts',
];

/** Calls that put text in front of a user, or into a log file. */
const SINK_PATTERNS = [
    { name: 'chat reply', re: /\b(?:ctx\.reply|msg\.reply|channel\.send|editReply|answerCallbackQuery)\s*\(/ },
    { name: 'vendor send', re: /\bapi\.(?:sendMessage|editMessageText)\s*\(/ },
    { name: 'logger', re: /\b(?:log|appLog|console)\.(?:error|warn|info)\s*\(/ },
];

/** A line counts as handled when it routes through one of these. */
const MASKERS = /\b(?:redactOutboundText|redactOutboundPayload|redactChannelSecrets|userErrorText|logErrorText)\s*\(/;

/**
 * Lines that are safe without a masker, each with its reason.
 *
 * Matched on a distinctive substring rather than a line number, so ordinary
 * edits above do not silently shift an exception onto a different line.
 */
const ALLOWLIST = [
    // Fixed operator strings. The variable in them is a count, a limit or an
    // id, none of which a credential travels in.
    { contains: 'Disabling Discord for this session', why: 'fixed string' },
    { contains: 'agent busy, queued', why: 'a pending count' },
    { contains: 'Max retries', why: 'a retry limit constant' },
    { contains: 'exceeds cap, giving up', why: 'elapsed milliseconds' },
    { contains: 'max reconnect attempts', why: 'an attempt limit constant' },
    { contains: 'the bot identity could not be read', why: 'fixed string' },
    { contains: 'channel not sendable', why: 'a channel id' },
    { contains: 'attempt ${attempt}/${MAX_RETRIES} failed', why: 'an attempt count and a vendor error code' },
    // Vendor status text: a documented enum value such as invalid_auth or
    // channel_not_found, not a message body.
    { contains: "auth.test failed:", why: 'a Slack error code' },
    { contains: 'apps.connections.open failed:', why: 'a Slack error code' },
    { contains: 'ack failed', why: 'a Slack error code' },
    // Already masked by the channel-local helper that predates the shared one.
    { contains: 'redactSlackTokens(', why: 'masked by the Slack alias of the shared redactor' },
    // Chunks and previews built from text the caller already masked.
    { contains: 'channel.send(chunk)', why: 'chunks come from chunkDiscordMessage, which masks' },
    { contains: '[discord:forward] → ${channelId}', why: 'preview is built from the masked text' },
    { contains: '[tg:forward] → chat ${chatId}', why: 'preview is built from the masked text' },
    // Refusal notices whose reason is one of our own constants.
    { contains: '❌ ${result.reason}', why: 'reason is a fixed refusal string from the gateway' },
    { contains: 'msg.reply(warning)', why: 'warning is assembled from fixed attachment-failure strings' },
    // Hub notices with no interpolation, and acks masked at their source.
    { contains: 'Topic not connected', why: 'fixed string' },
    { contains: 'Instance error', why: 'fixed string' },
    { contains: 'This topic is not connected', why: 'fixed string' },
    { contains: '이 토픽은 인스턴스에 연결되지', why: 'fixed string' },
    { contains: 'ctx.answerCallbackQuery(ack', why: 'ack is masked where it is built' },
    { contains: 'ctx.reply(syncText)', why: 'syncText is masked where it is built' },
    { contains: "persist failed:", why: "a Node.js Error.message from fs write, not a credential" },
    { contains: 'await ctx.reply(syncText)', why: 'syncText is masked where it is built' },
    { contains: 'Chat ID: <code>', why: 'a chat id the user just asked for' },
    // Queue-notice lifecycle (#412). Both carry text this repo built, not text
    // that passed through a credential-bearing surface.
    { contains: "t('tg.queued'", why: 'a locale string plus a pending count' },
    { contains: 'const posted = await msg.reply(', why: 'the queue notice: a locale string plus a pending count' },
    { contains: 'api.editMessageText(chatId, messageId, text', why: 'text is the notice expiry constant supplied at createQueueNotice' },
];

/**
 * Variables assigned from a masker earlier in the same file.
 *
 * `const out = redactOutboundText(...)` then `ctx.reply(out)` is correct, and
 * flagging it teaches people to ignore the gate. This is a file-scoped
 * approximation, not dataflow — it will miss a variable reassigned to
 * something unsafe, which is a trade for a gate that stays believable.
 */
function maskedLocals(source) {
    const names = new Set();
    const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:redactOutboundText|redactOutboundPayload|redactChannelSecrets|userErrorText|logErrorText)\s*\(/g;
    let m;
    while ((m = re.exec(source)) !== null) names.add(m[1]);
    return names;
}

function listSources(dir) {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) return [];
    if (fs.statSync(abs).isFile()) return [dir];
    return fs.readdirSync(abs)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
        .map((f) => path.join(dir, f));
}

/**
 * Whether the line carries a value that could hold a credential.
 *
 * The first version flagged 62 lines, nearly all of them chat ids, counts and
 * i18n lookups. A gate that cries wolf gets ignored, which is worse than not
 * having one, so this asks the narrower question: does the line move text that
 * came from an agent, a vendor, or a user?
 *
 * Those are the three sources a token has ever arrived from in this codebase.
 * Structural values — ids, counts, filenames, translated strings — are not
 * flagged, and a real leak through one of them would be a new class worth
 * finding by other means.
 */
function carriesUntrustedText(line) {
    return /\b(?:text|caption|content|message|body|result|output|reply|answer|prompt|preview|transcript|err|error|e)\b/.test(line)
        // A translated string is built from a catalogue, not from input.
        && !/\bt\(['"]/.test(line);
}

export function findUnmaskedSinks() {
    const findings = [];
    for (const dir of SCANNED) {
        for (const rel of listSources(dir)) {
            const source = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
            const masked = maskedLocals(source);
            const lines = source.split('\n');
            lines.forEach((line, i) => {
                const trimmed = line.trim();
                if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
                const sink = SINK_PATTERNS.find((p) => p.re.test(line));
                if (!sink) return;
                if (MASKERS.test(line)) return;
                if ([...masked].some((name) => new RegExp(`\\b${name}\\b`).test(line))) return;
                if (!carriesUntrustedText(line)) return;
                if (ALLOWLIST.some((a) => line.includes(a.contains))) return;
                findings.push({ file: rel, line: i + 1, kind: sink.name, text: trimmed.slice(0, 100) });
            });
        }
    }
    return findings;
}

/**
 * Functions every outbound text of a channel must pass through, and which
 * therefore have to keep calling a masker.
 *
 * Most call sites are allowlisted on the grounds that "the chunker masks", and
 * for a while nothing checked that the chunker still did. Deleting the
 * `redactOutboundText(...)` inside `chunkDiscordMessage` unmasked every Discord
 * send in the codebase and the gate stayed green, because each individual call
 * site still looked exactly as approved.
 *
 * These are the funnels. If one stops masking, the allowlist entries that lean
 * on it become false, so the funnel is checked directly.
 */
const REQUIRED_MASKING_FUNNELS = [
    { file: 'src/discord/forwarder.ts', fn: 'chunkDiscordMessage', why: 'every outbound Discord text is chunked here' },
    { file: 'src/slack/format.ts', fn: 'chunkSlackMessage', why: 'every outbound Slack text is chunked here' },
    { file: 'src/telegram/rich-message.ts', fn: 'sendTelegramMarkdown', why: 'the single entry point for Telegram rich sends' },
    // `sendTelegramFile` masks two independent things: the caption on the way
    // out, and the vendor error on the way back. Checking only that the body
    // mentions SOME masker lets the caption mask be deleted while the error
    // mask keeps the gate green, so this one names the expression.
    {
        file: 'src/telegram/telegram-file.ts',
        fn: 'sendTelegramFile',
        expect: /caption\s*=\s*opts\?\.caption\s*===\s*undefined\s*\?\s*undefined\s*:\s*redactOutboundText\(/,
        why: 'a caption reaches the room like a message body',
    },
];

/**
 * Body of a top-level function declaration, by brace balance.
 *
 * Finding the body is the fiddly part: the first `{` after the name belongs to
 * an inline parameter type (`opts?: { caption?: string }`), and the second to a
 * return type (`Promise<{ ok: boolean }>`). So the parameter list is skipped by
 * paren depth, and the return annotation by angle depth, leaving the real body
 * brace. A parser would be more correct and would also make this gate something
 * people stop reading.
 */
function functionBody(source, fn) {
    const start = source.search(new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${fn}\\s*[(<]`));
    if (start === -1) return null;
    // Step 1: walk the parameter list to its closing paren.
    const paren = source.indexOf('(', start);
    if (paren === -1) return null;
    let parenDepth = 0;
    let afterParams = -1;
    for (let i = paren; i < source.length; i += 1) {
        if (source[i] === '(') parenDepth += 1;
        else if (source[i] === ')') {
            parenDepth -= 1;
            if (parenDepth === 0) { afterParams = i + 1; break; }
        }
    }
    if (afterParams === -1) return null;
    // Step 2: the body brace is the first `{` outside any return-type generic.
    let angle = 0;
    let open = -1;
    for (let i = afterParams; i < source.length; i += 1) {
        const c = source[i];
        if (c === '<') angle += 1;
        else if (c === '>') angle = Math.max(0, angle - 1);
        else if (c === '{' && angle === 0) { open = i; break; }
    }
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(open, i + 1);
        }
    }
    return null;
}

export function findUnmaskedFunnels() {
    const findings = [];
    for (const funnel of REQUIRED_MASKING_FUNNELS) {
        const abs = path.join(repoRoot, funnel.file);
        if (!fs.existsSync(abs)) {
            findings.push({ ...funnel, detail: 'file is gone — the funnel moved and this gate was not updated' });
            continue;
        }
        const body = functionBody(fs.readFileSync(abs, 'utf8'), funnel.fn);
        if (body === null) {
            findings.push({ ...funnel, detail: 'function not found — it was renamed or removed' });
            continue;
        }
        const required = funnel.expect ?? MASKERS;
        if (!required.test(body)) {
            findings.push({
                ...funnel,
                detail: funnel.expect ? 'the specific masking expression is gone' : 'body no longer calls a masker',
            });
        }
    }
    return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const findings = findUnmaskedSinks();
    const funnels = findUnmaskedFunnels();
    if (findings.length === 0 && funnels.length === 0) {
        console.log('✅ redaction sinks — every channel reply, send and logger routes through a masker');
        process.exit(0);
    }
    if (findings.length > 0) {
        console.error(`❌ redaction sinks — ${findings.length} unmasked:`);
        for (const f of findings) console.error(`   ${f.file}:${f.line} (${f.kind})  ${f.text}`);
        console.error('\nEither route it through a masker, or add an allowlist entry WITH a reason.');
    }
    if (funnels.length > 0) {
        console.error(`❌ masking funnels — ${funnels.length} broken:`);
        for (const f of funnels) console.error(`   ${f.file} ${f.fn}(): ${f.detail}\n      ${f.why}`);
        console.error('\nAllowlist entries below assume these funnels mask. Restore the mask, or');
        console.error('move the funnel and update REQUIRED_MASKING_FUNNELS to match.');
    }
    process.exit(1);
}

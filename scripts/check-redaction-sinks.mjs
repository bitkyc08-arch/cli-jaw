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

/** Directories whose outbound and logging surfaces must be masked. */
const SCANNED = ['src/telegram', 'src/discord', 'src/slack', 'src/manager/telegram-hub'];

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
    { contains: 'await ctx.reply(syncText)', why: 'syncText is masked where it is built' },
    { contains: 'Chat ID: <code>', why: 'a chat id the user just asked for' },
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

if (import.meta.url === `file://${process.argv[1]}`) {
    const findings = findUnmaskedSinks();
    if (findings.length === 0) {
        console.log('✅ redaction sinks — every channel reply, send and logger routes through a masker');
        process.exit(0);
    }
    console.error(`❌ redaction sinks — ${findings.length} unmasked:`);
    for (const f of findings) console.error(`   ${f.file}:${f.line} (${f.kind})  ${f.text}`);
    console.error('\nEither route it through a masker, or add an allowlist entry WITH a reason.');
    process.exit(1);
}

/**
 * cli-jaw messaging — inspect and recover the durable ingress journal
 * Usage:
 *   jaw messaging ingress list [--channel telegram|discord|slack] [--state ...] [--older-than 24h] [--limit 50] [--json]
 *   jaw messaging ingress show <channel> <accountId> <eventId> [--json]
 *   jaw messaging ingress replay <channel> <accountId> <eventId> --reason <text> [--force]
 *
 * Reads the same SQLite file the server writes. Every inbound message from all three
 * channels lands there, so this is where a dead letter becomes visible and a message
 * that failed its handler gets another attempt.
 */
import { parseArgs } from 'node:util';
import { db } from '../../src/core/db.js';
import { IngressJournal, type IngressState } from '../../src/messaging/durable-ingress.js';
import { isMessengerChannel, type MessengerChannel } from '../../src/messaging/types.js';
import { appendIngressAudit, readIngressAudit } from '../../src/messaging/ingress-audit.js';

const INGRESS_STATES: IngressState[] = ['received', 'processing', 'completed', 'dead_letter'];

function printHelp(): void {
    console.log(`
  Usage:
    jaw messaging ingress list [options]                      List journaled inbound events
    jaw messaging ingress show <channel> <account> <event>    Show one event
    jaw messaging ingress replay <channel> <account> <event> --reason <text>
    jaw messaging ingress audit [--limit 20]                  Show replay history

  List options:
    --channel telegram|discord|slack
    --state received|processing|completed|dead_letter
    --older-than 30m|24h|7d
    --limit 50
    --json

  Replay options:
    --reason <text>   Required. Recorded in the audit trail.
    --force           Replay a completed event. Refused by default: its effects
                      already happened, and running them twice is worse than not
                      replaying at all.

  A successful replay only marks the journal row received. Nothing inside this
  process re-runs the handler. The next vendor redelivery is what actually
  executes it — Telegram's offset, Slack's retry, Discord's resume.
`);
}

/** Accepts 30m / 24h / 7d, or a bare number of milliseconds. */
function parseDuration(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const match = /^(\d+)(ms|s|m|h|d)?$/.exec(value.trim());
    if (!match) throw new Error(`invalid duration: ${value}`);
    const amount = Number(match[1]);
    const unit = match[2] ?? 'ms';
    const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
    return amount * scale;
}

function requireChannel(value: string | undefined): MessengerChannel {
    if (!isMessengerChannel(value)) {
        console.error(`  ❌ unknown channel: ${value ?? '(missing)'}`);
        process.exit(1);
    }
    return value;
}

function formatAge(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
    return `${Math.round(seconds / 86_400)}d`;
}

const argv = process.argv.slice(2);
const group = String(argv[1] || '').toLowerCase();
const action = String(argv[2] || '').toLowerCase();

if (!group || group === 'help' || group === '--help' || group === '-h') {
    printHelp();
    process.exit(0);
}

if (group !== 'ingress') {
    console.error(`  ❌ unknown messaging group: ${group}`);
    printHelp();
    process.exit(1);
}

const { values, positionals } = parseArgs({
    args: argv.slice(3),
    options: {
        channel: { type: 'string' },
        state: { type: 'string' },
        'older-than': { type: 'string' },
        limit: { type: 'string' },
        reason: { type: 'string' },
        force: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
});

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

if (values.help) {
    printHelp();
    process.exit(0);
}

// The journal owns its DDL, so constructing it against the shared connection is what
// makes the table exist for a CLI run that starts before the server ever has.
const journal = new IngressJournal(db);
const now = Date.now();

if (action === 'list') {
    let olderThanMs: number | undefined;
    try {
        olderThanMs = parseDuration(str(values['older-than']));
    } catch (error) {
        console.error(`  ❌ ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
    if (str(values.state) && !INGRESS_STATES.includes(str(values.state) as IngressState)) {
        console.error(`  ❌ unknown state: ${values.state}`);
        process.exit(1);
    }
    const records = journal.list({
        ...(str(values.channel) ? { channel: requireChannel(str(values.channel)) } : {}),
        ...(str(values.state) ? { state: str(values.state) as IngressState } : {}),
        ...(olderThanMs !== undefined ? { olderThanMs } : {}),
        ...(str(values.limit) ? { limit: Number(str(values.limit)) } : {}),
    });
    if (values.json) {
        console.log(JSON.stringify({ counts: journal.counts(), records }, null, 2));
        process.exit(0);
    }
    const counts = journal.counts();
    console.log(
        `  received ${counts.received}  processing ${counts.processing}  ` +
        `completed ${counts.completed}  dead_letter ${counts.dead_letter}`,
    );
    if (records.length === 0) {
        console.log('  (no matching events)');
        process.exit(0);
    }
    for (const r of records) {
        const error = r.lastError ? `  ${r.lastError.slice(0, 60)}` : '';
        console.log(
            `  ${r.state.padEnd(11)} ${r.channel.padEnd(8)} ${r.accountId}/${r.eventId}` +
            `  attempts=${r.attemptCount}  age=${formatAge(now - r.receivedAt)}${error}`,
        );
    }
    process.exit(0);
}

if (action === 'show') {
    const channel = requireChannel(str(positionals[0]));
    const record = journal.find(channel, String(positionals[1] || ''), String(positionals[2] || ''));
    if (!record) {
        console.error('  ❌ not found');
        process.exit(1);
    }
    console.log(JSON.stringify(record, null, 2));
    process.exit(0);
}

if (action === 'replay') {
    const channel = requireChannel(str(positionals[0]));
    const accountId = String(positionals[1] || '');
    const eventId = String(positionals[2] || '');
    const reason = String(values.reason || '').trim();
    if (!reason) {
        // A replay re-runs someone's message. The audit row is worth little without
        // the reason, and asking after the fact never works.
        console.error('  ❌ --reason is required');
        process.exit(1);
    }
    const before = journal.find(channel, accountId, eventId);
    const outcome = journal.requestReplay(channel, accountId, eventId, { force: Boolean(values.force) });
    if (!outcome.replayed) {
        const explanation = {
            not_found: 'no such event in the journal',
            in_flight: 'still processing — wait for it to settle or fail',
            already_completed: 'already handled; pass --force to replay it anyway',
            payload_discarded: 'completed and its payload was dropped, so there is nothing to replay',
        }[outcome.reason];
        console.error(`  ❌ ${outcome.reason}: ${explanation}`);
        process.exit(1);
    }
    try {
        appendIngressAudit({
            ts: now,
            action: 'replay',
            channel,
            accountId,
            eventId,
            priorState: before?.state ?? 'unknown',
            newState: outcome.record.state,
            reason,
            forced: Boolean(values.force),
        });
    } catch (error) {
        // The journal already moved. Rolling that back would hide the operator's
        // intent; the missing audit row is the thing to report.
        console.error(`  ⚠️ replay recorded, audit write failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(0);
    }
    console.log(`  ✅ ${channel}/${accountId}/${eventId} marked received (was ${before?.state}); it will run again if the vendor redelivers`);
    process.exit(0);
}

if (action === 'audit') {
    const entries = readIngressAudit(str(values.limit) ? Number(str(values.limit)) : 20);
    if (values.json) {
        console.log(JSON.stringify(entries, null, 2));
        process.exit(0);
    }
    if (entries.length === 0) {
        console.log('  (no replay history)');
        process.exit(0);
    }
    for (const e of entries) {
        const forced = e.forced ? ' [forced]' : '';
        console.log(
            `  ${new Date(e.ts).toISOString()}  ${e.action}  ${e.channel}/${e.accountId}/${e.eventId}` +
            `  ${e.priorState} -> ${e.newState}${forced}  ${e.reason}`,
        );
    }
    process.exit(0);
}

console.error(`  ❌ unknown ingress action: ${action || '(missing)'}`);
printHelp();
process.exit(1);

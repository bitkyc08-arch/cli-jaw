// ─── Outbound attempt outbox ──────────────────────────────────
// Reserve-before-send: the row exists before the vendor call, so a crash between
// dispatch and receipt leaves a record instead of a gap. "ambiguous" is how we
// spell "the network timed out and nobody knows whether the user saw it."
//
// ambiguous is terminal for the automatic path. Nothing in-process retries an
// ambiguous attempt — that would be exactly the duplicate the state exists to
// prevent. An operator or an explicit replay may create a *new* attempt.

import type { Database as SqliteDatabase } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { registerChildRetentionPredicate } from './durable-ingress.js';
import type { MessengerChannel } from './types.js';

export const OUTBOUND_ATTEMPTS_TABLE = 'outbound_attempts';

export const CREATE_OUTBOUND_ATTEMPTS_SQL = `
CREATE TABLE IF NOT EXISTS outbound_attempts (
    id               TEXT PRIMARY KEY,
    channel          TEXT NOT NULL CHECK(channel IN ('telegram', 'slack', 'discord')),
    account_id       TEXT NOT NULL,
    event_id         TEXT NOT NULL,
    effect_name      TEXT NOT NULL,
    target_key       TEXT NOT NULL,
    idempotency_key  TEXT NOT NULL UNIQUE,
    payload_digest   TEXT NOT NULL,
    state            TEXT NOT NULL DEFAULT 'pending'
                     CHECK(state IN ('pending', 'sending', 'sent', 'definitive_failed', 'ambiguous')),
    attempt_count    INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    platform_receipt TEXT,
    last_error       TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    sent_at          INTEGER,
    FOREIGN KEY (channel, account_id, event_id)
        REFERENCES ingress_events(channel, account_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_outbound_attempts_state
    ON outbound_attempts (state, updated_at);
`;

export type OutboundAttemptState = 'pending' | 'sending' | 'sent' | 'definitive_failed' | 'ambiguous';

export type OutboundAttemptRecord = {
    id: string;
    channel: MessengerChannel;
    accountId: string;
    eventId: string;
    effectName: string;
    targetKey: string;
    idempotencyKey: string;
    payloadDigest: string;
    state: OutboundAttemptState;
    attemptCount: number;
    platformReceipt: string | null;
    lastError: string | null;
    createdAt: number;
    updatedAt: number;
    sentAt: number | null;
};

export type ReserveOutcome =
    | { reserved: true; record: OutboundAttemptRecord }
    | { reserved: false; reason: 'idempotency_hit'; record: OutboundAttemptRecord };

const STATES = new Set<OutboundAttemptState>([
    'pending', 'sending', 'sent', 'definitive_failed', 'ambiguous',
]);

function rowToRecord(row: Record<string, unknown>): OutboundAttemptRecord {
    const state = String(row['state']);
    if (!STATES.has(state as OutboundAttemptState)) {
        throw new Error(`outbound outbox: unrecognised state ${JSON.stringify(state)}`);
    }
    return {
        id: String(row['id']),
        channel: String(row['channel']) as MessengerChannel,
        accountId: String(row['account_id']),
        eventId: String(row['event_id']),
        effectName: String(row['effect_name']),
        targetKey: String(row['target_key']),
        idempotencyKey: String(row['idempotency_key']),
        payloadDigest: String(row['payload_digest']),
        state: state as OutboundAttemptState,
        attemptCount: Number(row['attempt_count']),
        platformReceipt: (row['platform_receipt'] as string | null) ?? null,
        lastError: (row['last_error'] as string | null) ?? null,
        createdAt: Number(row['created_at']),
        updatedAt: Number(row['updated_at']),
        sentAt: (row['sent_at'] as number | null) ?? null,
    };
}

export type OutboundOutboxOptions = {
    now?: () => number;
};

export class OutboundOutbox {
    private readonly now: () => number;

    constructor(
        private readonly database: SqliteDatabase,
        options: OutboundOutboxOptions = {},
    ) {
        this.now = options.now ?? (() => Date.now());
        this.database.exec(CREATE_OUTBOUND_ATTEMPTS_SQL);
        registerChildRetentionPredicate({
            table: OUTBOUND_ATTEMPTS_TABLE,
            // A non-terminal or ambiguous attempt is exactly the row an operator still
            // needs. Sweeping its parent would erase the only evidence that a message
            // may have been sent.
            blockingExistsSql:
                "SELECT 1 FROM outbound_attempts o WHERE o.channel = e.channel "
                + "AND o.account_id = e.account_id AND o.event_id = e.event_id "
                + "AND o.state NOT IN ('sent', 'definitive_failed')",
            deleteTerminalSql:
                "DELETE FROM outbound_attempts WHERE channel = ? AND account_id = ? "
                + "AND event_id = ? AND state IN ('sent', 'definitive_failed')",
        });
    }

    find(id: string): OutboundAttemptRecord | null {
        const row = this.database.prepare(
            'SELECT * FROM outbound_attempts WHERE id = ?',
        ).get(id) as Record<string, unknown> | undefined;
        return row ? rowToRecord(row) : null;
    }

    findByIdempotencyKey(key: string): OutboundAttemptRecord | null {
        const row = this.database.prepare(
            'SELECT * FROM outbound_attempts WHERE idempotency_key = ?',
        ).get(key) as Record<string, unknown> | undefined;
        return row ? rowToRecord(row) : null;
    }

    /**
     * Create the row BEFORE the vendor call. A replay that reserves the same
     * idempotency key returns the existing row — that is how "reserve before send"
     * prevents a second attempt for the same logical delivery.
     */
    reserve(fields: {
        channel: MessengerChannel;
        accountId: string;
        eventId: string;
        effectName: string;
        targetKey: string;
        idempotencyKey: string;
        payloadDigest: string;
    }): ReserveOutcome {
        const existing = this.findByIdempotencyKey(fields.idempotencyKey);
        if (existing) return { reserved: false, reason: 'idempotency_hit', record: existing };

        const id = randomUUID();
        const now = this.now();
        try {
            this.database.prepare(`
                INSERT INTO outbound_attempts (
                    id, channel, account_id, event_id, effect_name,
                    target_key, idempotency_key, payload_digest,
                    state, attempt_count, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
            `).run(
                id, fields.channel, fields.accountId, fields.eventId,
                fields.effectName, fields.targetKey, fields.idempotencyKey,
                fields.payloadDigest, now, now,
            );
        } catch (error) {
            // UNIQUE on idempotency_key can race just like journal append.
            const raced = this.findByIdempotencyKey(fields.idempotencyKey);
            if (raced) return { reserved: false, reason: 'idempotency_hit', record: raced };
            throw error;
        }
        const record = this.find(id);
        if (!record) throw new Error('outbound outbox: reserve did not persist');
        return { reserved: true, record };
    }

    /** Mark that the vendor call is in flight. Only from pending. */
    markSending(id: string): boolean {
        const now = this.now();
        return this.database.prepare(`
            UPDATE outbound_attempts
            SET state = 'sending', attempt_count = attempt_count + 1, updated_at = ?
            WHERE id = ? AND state = 'pending'
        `).run(now, id).changes === 1;
    }

    /** Platform confirmed receipt. Only from sending. */
    markSent(id: string, platformReceipt?: string): boolean {
        const now = this.now();
        return this.database.prepare(`
            UPDATE outbound_attempts
            SET state = 'sent', platform_receipt = ?, sent_at = ?, updated_at = ?, last_error = NULL
            WHERE id = ? AND state = 'sending'
        `).run(platformReceipt ?? null, now, now, id).changes === 1;
    }

    /** Known failure before dispatch or a confirmed vendor rejection. From pending or sending. */
    markDefinitiveFailed(id: string, lastError: string): boolean {
        const now = this.now();
        return this.database.prepare(`
            UPDATE outbound_attempts
            SET state = 'definitive_failed', last_error = ?, updated_at = ?
            WHERE id = ? AND state IN ('pending', 'sending')
        `).run(lastError, now, id).changes === 1;
    }

    /**
     * The send left the process and nobody can confirm whether it arrived.
     * Only from sending — pending never left, so its outcome is definitive.
     */
    markAmbiguous(id: string, lastError: string): boolean {
        const now = this.now();
        return this.database.prepare(`
            UPDATE outbound_attempts
            SET state = 'ambiguous', last_error = ?, updated_at = ?
            WHERE id = ? AND state = 'sending'
        `).run(lastError, now, id).changes === 1;
    }

    list(filter: { state?: OutboundAttemptState; limit?: number } = {}): OutboundAttemptRecord[] {
        const where = filter.state ? 'WHERE state = ?' : '';
        const params: Array<string | number> = filter.state ? [filter.state] : [];
        params.push(filter.limit ?? 50);
        const rows = this.database.prepare(
            `SELECT * FROM outbound_attempts ${where} ORDER BY created_at DESC LIMIT ?`,
        ).all(...params) as Array<Record<string, unknown>>;
        return rows.map(rowToRecord);
    }

    countAmbiguous(): number {
        const row = this.database.prepare(
            "SELECT COUNT(*) AS n FROM outbound_attempts WHERE state = 'ambiguous'",
        ).get() as { n: number } | undefined;
        return row?.n ?? 0;
    }
}

let outbox: OutboundOutbox | null = null;

export function initOutboundOutbox(
    database: SqliteDatabase,
    options: OutboundOutboxOptions = {},
): OutboundOutbox {
    outbox = new OutboundOutbox(database, options);
    return outbox;
}

export function getOutboundOutbox(): OutboundOutbox | null {
    return outbox;
}

/** Test seam. */
export function __resetOutboundOutboxForTests(): void {
    outbox = null;
}

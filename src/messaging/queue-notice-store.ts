// ─── Durable queue-notice records ────────────────────
// The "added to queue" notice is closed out by a process-local handle
// (`QueueNoticeHandle`, queue-notice.ts). A restart destroys that handle, and the
// boot drain (#407) then runs exactly the messages whose notices are now
// unreachable — so the answer arrives and the notice stays, claiming forever that
// the agent is still working.
//
// This store keeps the one thing a restart cannot reconstruct: WHICH message to
// close. Reactions are deliberately not covered (#416 chose that trade): a
// reaction needs its anchor, state and transition mode to restore, while a notice
// needs a single platform message id.
//
// Not the queue payload. That row is deleted when the item starts running
// (queue.ts `deleteQueuedMessage`, before `orchestrate`), so a crash mid-turn —
// the exact case this exists for — would leave nothing behind. This table is keyed
// on the request and outlives the queue row.
//
// The connection is injected for the same reason as durable-ingress: `core/db.ts`
// opens the real database at import time, so a module that reaches for that
// singleton cannot be tested against a temporary one.

import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { MessengerChannel, RemoteTarget } from './types.js';

export const QUEUE_NOTICES_TABLE = 'queue_notices';

export const CREATE_QUEUE_NOTICES_SQL = `
CREATE TABLE IF NOT EXISTS queue_notices (
    request_id  TEXT PRIMARY KEY,
    channel     TEXT NOT NULL CHECK(channel IN ('telegram', 'slack', 'discord')),
    target_json TEXT NOT NULL,
    message_id  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_notices_restorable
    ON queue_notices (channel, message_id);
`;

export type QueueNoticeRecord = {
    requestId: string;
    channel: MessengerChannel;
    target: RemoteTarget;
    /** Slack ts / Telegram message_id / Discord message id. Null until the post lands. */
    messageId: string | null;
    createdAt: number;
    updatedAt: number;
};

export type QueueNoticeStoreOptions = {
    now?: () => number;
};

function rowToRecord(row: Record<string, unknown>): QueueNoticeRecord {
    return {
        requestId: String(row['request_id']),
        channel: String(row['channel']) as MessengerChannel,
        target: JSON.parse(String(row['target_json'])) as RemoteTarget,
        messageId: (row['message_id'] as string | null) ?? null,
        createdAt: Number(row['created_at']),
        updatedAt: Number(row['updated_at']),
    };
}

export class QueueNoticeStore {
    private readonly now: () => number;

    constructor(
        private readonly database: SqliteDatabase,
        options: QueueNoticeStoreOptions = {},
    ) {
        this.now = options.now ?? (() => Date.now());
        this.database.exec(CREATE_QUEUE_NOTICES_SQL);
    }

    /**
     * Claim the row BEFORE the notice is posted.
     *
     * Reserving first is what makes the crash window recoverable in the harmless
     * direction: a row with no message id restores to nothing, while a posted
     * message with no row is unreachable forever.
     *
     * A repeat reserve for the same request is a no-op rather than a rewrite —
     * the id attached by the first one is the only thing that can close it.
     */
    reserve(fields: {
        requestId: string;
        channel: MessengerChannel;
        target: RemoteTarget;
    }): void {
        const now = this.now();
        this.database.prepare(`
            INSERT INTO queue_notices (request_id, channel, target_json, message_id, created_at, updated_at)
            VALUES (?, ?, ?, NULL, ?, ?)
            ON CONFLICT(request_id) DO NOTHING
        `).run(fields.requestId, fields.channel, JSON.stringify(fields.target), now, now);
    }

    /** Bind the posted message to its reservation. False when nothing was reserved. */
    attachMessageId(requestId: string, messageId: string): boolean {
        return this.database.prepare(`
            UPDATE queue_notices SET message_id = ?, updated_at = ? WHERE request_id = ?
        `).run(messageId, this.now(), requestId).changes === 1;
    }

    findByRequestId(requestId: string): QueueNoticeRecord | null {
        const row = this.database.prepare(
            'SELECT * FROM queue_notices WHERE request_id = ?',
        ).get(requestId) as Record<string, unknown> | undefined;
        return row ? rowToRecord(row) : null;
    }

    /**
     * Records a restart can actually act on.
     *
     * A reservation with no message id is skipped rather than reported: the post
     * never landed, so there is nothing in the channel to delete or rewrite.
     */
    listRestorable(channel?: MessengerChannel): QueueNoticeRecord[] {
        const where = channel
            ? 'WHERE message_id IS NOT NULL AND channel = ?'
            : 'WHERE message_id IS NOT NULL';
        const params = channel ? [channel] : [];
        const rows = this.database.prepare(
            `SELECT * FROM queue_notices ${where} ORDER BY created_at ASC`,
        ).all(...params) as Array<Record<string, unknown>>;
        return rows.map(rowToRecord);
    }

    /** Drop the record. Returns false when it was already gone, which is not an error. */
    close(requestId: string): boolean {
        return this.database.prepare(
            'DELETE FROM queue_notices WHERE request_id = ?',
        ).run(requestId).changes === 1;
    }
}

let store: QueueNoticeStore | null = null;

export function initQueueNoticeStore(
    database: SqliteDatabase,
    options: QueueNoticeStoreOptions = {},
): QueueNoticeStore {
    store = new QueueNoticeStore(database, options);
    return store;
}

export function getQueueNoticeStore(): QueueNoticeStore | null {
    return store;
}

/** Test seam. */
export function __resetQueueNoticeStoreForTests(): void {
    store = null;
}


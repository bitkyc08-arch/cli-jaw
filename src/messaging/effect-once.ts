// ─── Effect-once claims ──────────────────────────────────
// At-least-once ingress means a protected effect can be reached twice. This table is
// how the second arrival learns the first one already happened.
//
// A lease that has run out does NOT mean the effect failed. The owning process may
// have died a millisecond before or a millisecond after the external write. Expiry
// therefore permits a new CLAIM and nothing else; deciding what actually happened is
// a per-effect reconciler's job, and until it decides, `manual` is the honest state.
//
// The connection is injected for the same reason the journal injects it: reaching for
// the db singleton makes the table exist as a side effect of whoever imported first.

import type { Database as SqliteDatabase } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { registerChildRetentionPredicate } from './durable-ingress.js';
import type { MessengerChannel } from './types.js';

export const EFFECT_CLAIMS_TABLE = 'effect_claims';

/** Local DB writes: a process that holds one this long is not coming back. */
export const LOCAL_EFFECT_LEASE_MS = 30_000;
/** Process spawn and remote tool calls legitimately take longer. */
export const REMOTE_EFFECT_LEASE_MS = 120_000;

export const CREATE_EFFECT_CLAIMS_SQL = `
CREATE TABLE IF NOT EXISTS effect_claims (
    channel          TEXT NOT NULL CHECK(channel IN ('telegram', 'slack', 'discord')),
    account_id       TEXT NOT NULL,
    event_id         TEXT NOT NULL,
    effect_name      TEXT NOT NULL,
    claim_token      TEXT NOT NULL UNIQUE,
    state            TEXT NOT NULL DEFAULT 'claimed'
                     CHECK(state IN ('claimed', 'completed', 'failed', 'manual')),
    owner_id         TEXT,
    lease_expires_at INTEGER,
    result_digest    TEXT,
    claimed_at       INTEGER NOT NULL,
    completed_at     INTEGER,
    last_error       TEXT,
    PRIMARY KEY (channel, account_id, event_id, effect_name),
    FOREIGN KEY (channel, account_id, event_id)
        REFERENCES ingress_events(channel, account_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_effect_claims_state
    ON effect_claims (state, claimed_at);
`;

export type EffectClaimState = 'claimed' | 'completed' | 'failed' | 'manual';

export type EffectClaimKey = {
    channel: MessengerChannel;
    accountId: string;
    eventId: string;
    effectName: string;
};

export type EffectClaimRecord = EffectClaimKey & {
    claimToken: string;
    state: EffectClaimState;
    ownerId: string | null;
    leaseExpiresAt: number | null;
    resultDigest: string | null;
    claimedAt: number;
    completedAt: number | null;
    lastError: string | null;
};

export type ClaimOutcome =
    | { acquired: true; claimToken: string; record: EffectClaimRecord }
    | { acquired: false; reason: 'lease_held' | 'terminal'; record: EffectClaimRecord };

const STATES = new Set<EffectClaimState>(['claimed', 'completed', 'failed', 'manual']);

function rowToRecord(row: Record<string, unknown>): EffectClaimRecord {
    const state = String(row['state']);
    if (!STATES.has(state as EffectClaimState)) {
        // Refused on read rather than guessed at: an unknown state here would otherwise
        // be treated as "not terminal" and re-claimed.
        throw new Error(`effect claims: unrecognised state ${JSON.stringify(state)}`);
    }
    return {
        channel: String(row['channel']) as MessengerChannel,
        accountId: String(row['account_id']),
        eventId: String(row['event_id']),
        effectName: String(row['effect_name']),
        claimToken: String(row['claim_token']),
        state: state as EffectClaimState,
        ownerId: (row['owner_id'] as string | null) ?? null,
        leaseExpiresAt: (row['lease_expires_at'] as number | null) ?? null,
        resultDigest: (row['result_digest'] as string | null) ?? null,
        claimedAt: Number(row['claimed_at']),
        completedAt: (row['completed_at'] as number | null) ?? null,
        lastError: (row['last_error'] as string | null) ?? null,
    };
}

export type EffectClaimStoreOptions = {
    now?: () => number;
    /** `<boot UUID>:<worker UUID>` in production. */
    ownerId?: string;
};

export class EffectClaimStore {
    private readonly now: () => number;
    private readonly ownerId: string;

    constructor(
        private readonly database: SqliteDatabase,
        options: EffectClaimStoreOptions = {},
    ) {
        this.now = options.now ?? (() => Date.now());
        this.ownerId = options.ownerId ?? `${randomUUID()}:${randomUUID()}`;
        this.database.exec(CREATE_EFFECT_CLAIMS_SQL);
        registerChildRetentionPredicate({
            table: EFFECT_CLAIMS_TABLE,
            // A claim that has not reached a terminal state still describes work whose
            // outcome nobody knows. Sweeping its parent would erase the only record.
            blockingExistsSql:
                "SELECT 1 FROM effect_claims c WHERE c.channel = e.channel "
                + "AND c.account_id = e.account_id AND c.event_id = e.event_id "
                + "AND c.state NOT IN ('completed', 'failed')",
            deleteTerminalSql:
                "DELETE FROM effect_claims WHERE channel = ? AND account_id = ? "
                + "AND event_id = ? AND state IN ('completed', 'failed')",
        });
    }

    get owner(): string { return this.ownerId; }

    find(key: EffectClaimKey): EffectClaimRecord | null {
        const row = this.database.prepare(`
            SELECT * FROM effect_claims
            WHERE channel = ? AND account_id = ? AND event_id = ? AND effect_name = ?
        `).get(key.channel, key.accountId, key.eventId, key.effectName) as Record<string, unknown> | undefined;
        return row ? rowToRecord(row) : null;
    }

    /**
     * Take ownership of one effect, or report why not.
     *
     * BEGIN IMMEDIATE plus an observed-token CAS is what makes two live workers safe:
     * both can read the same expired row, only one can write it, and the loser sees
     * `lease_held` rather than running the effect body a second time.
     */
    claim(key: EffectClaimKey, leaseMs = LOCAL_EFFECT_LEASE_MS): ClaimOutcome {
        const run = this.database.transaction((): ClaimOutcome => {
            const now = this.now();
            const existing = this.find(key);
            if (!existing) {
                const claimToken = randomUUID();
                this.database.prepare(`
                    INSERT INTO effect_claims (
                        channel, account_id, event_id, effect_name, claim_token,
                        state, owner_id, lease_expires_at, claimed_at
                    ) VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?)
                `).run(
                    key.channel, key.accountId, key.eventId, key.effectName,
                    claimToken, this.ownerId, now + leaseMs, now,
                );
                const record = this.find(key);
                if (!record) throw new Error('effect claims: claim did not persist');
                return { acquired: true, claimToken, record };
            }
            if (existing.state !== 'claimed') {
                // completed/failed/manual are all answers. Only an operator or a replay
                // may reopen one, and neither goes through this path.
                return { acquired: false, reason: 'terminal', record: existing };
            }
            if (existing.leaseExpiresAt !== null && existing.leaseExpiresAt > now) {
                return { acquired: false, reason: 'lease_held', record: existing };
            }
            const claimToken = randomUUID();
            const changes = this.database.prepare(`
                UPDATE effect_claims
                SET owner_id = ?, claim_token = ?, claimed_at = ?, lease_expires_at = ?, last_error = NULL
                WHERE channel = ? AND account_id = ? AND event_id = ? AND effect_name = ?
                  AND state = 'claimed' AND claim_token = ?
            `).run(
                this.ownerId, claimToken, now, now + leaseMs,
                key.channel, key.accountId, key.eventId, key.effectName,
                existing.claimToken,
            ).changes;
            if (changes !== 1) {
                const latest = this.find(key);
                return { acquired: false, reason: 'lease_held', record: latest ?? existing };
            }
            const record = this.find(key);
            if (!record) throw new Error('effect claims: re-claim did not persist');
            return { acquired: true, claimToken, record };
        });
        return run.immediate();
    }

    /** Extend a lease this worker still owns. Long effects heartbeat rather than
     *  taking a lease long enough to hide a dead process. */
    heartbeat(key: EffectClaimKey, claimToken: string, leaseMs = LOCAL_EFFECT_LEASE_MS): boolean {
        return this.database.prepare(`
            UPDATE effect_claims SET lease_expires_at = ?
            WHERE channel = ? AND account_id = ? AND event_id = ? AND effect_name = ?
              AND state = 'claimed' AND owner_id = ? AND claim_token = ?
        `).run(
            this.now() + leaseMs,
            key.channel, key.accountId, key.eventId, key.effectName,
            this.ownerId, claimToken,
        ).changes === 1;
    }

    private settle(
        key: EffectClaimKey,
        claimToken: string,
        state: Exclude<EffectClaimState, 'claimed'>,
        extra: { resultDigest?: string; lastError?: string } = {},
    ): boolean {
        const run = this.database.transaction(() => this.database.prepare(`
            UPDATE effect_claims
            SET state = ?, completed_at = ?, lease_expires_at = NULL,
                result_digest = COALESCE(?, result_digest),
                last_error = ?
            WHERE channel = ? AND account_id = ? AND event_id = ? AND effect_name = ?
              AND state = 'claimed' AND owner_id = ? AND claim_token = ?
        `).run(
            state, this.now(),
            extra.resultDigest ?? null,
            extra.lastError ?? null,
            key.channel, key.accountId, key.eventId, key.effectName,
            this.ownerId, claimToken,
        ).changes === 1);
        return run.immediate();
    }

    /** The external effect is known to have happened. */
    complete(key: EffectClaimKey, claimToken: string, resultDigest?: string): boolean {
        return this.settle(key, claimToken, 'completed',
            resultDigest === undefined ? {} : { resultDigest });
    }

    /** Known NOT to have happened, so a later replay may legitimately retry it. */
    fail(key: EffectClaimKey, claimToken: string, lastError: string): boolean {
        return this.settle(key, claimToken, 'failed', { lastError });
    }

    /** Cannot be decided automatically. Terminal until an operator says otherwise;
     *  guessing here is how a payment sends twice or a reset silently does not. */
    holdForManual(key: EffectClaimKey, claimToken: string, lastError: string): boolean {
        return this.settle(key, claimToken, 'manual', { lastError });
    }

    list(filter: { state?: EffectClaimState; limit?: number } = {}): EffectClaimRecord[] {
        const where = filter.state ? 'WHERE state = ?' : '';
        const params: Array<string | number> = filter.state ? [filter.state] : [];
        params.push(filter.limit ?? 50);
        const rows = this.database.prepare(
            `SELECT * FROM effect_claims ${where} ORDER BY claimed_at DESC LIMIT ?`,
        ).all(...params) as Array<Record<string, unknown>>;
        return rows.map(rowToRecord);
    }

    /** Rows whose lease has run out. Candidates for a reconciler, not for a re-run. */
    listExpired(now = this.now(), limit = 50): EffectClaimRecord[] {
        const rows = this.database.prepare(`
            SELECT * FROM effect_claims
            WHERE state = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
            ORDER BY lease_expires_at, claimed_at LIMIT ?
        `).all(now, limit) as Array<Record<string, unknown>>;
        return rows.map(rowToRecord);
    }
}

let store: EffectClaimStore | null = null;

export function initEffectClaimStore(
    database: SqliteDatabase,
    options: EffectClaimStoreOptions = {},
): EffectClaimStore {
    store = new EffectClaimStore(database, options);
    return store;
}

export function getEffectClaimStore(): EffectClaimStore | null {
    return store;
}

/** Test seam: the module-level handle outlives a single test otherwise. */
export function __resetEffectClaimStoreForTests(): void {
    store = null;
}

import type Database from 'better-sqlite3';
import type { Api } from 'grammy';
import type { Update } from 'grammy/types';

const CREATE_OFFSET_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS telegram_update_offset (
        key        TEXT PRIMARY KEY,
        offset     INTEGER NOT NULL CHECK(offset >= 0),
        updated_at TEXT NOT NULL
    )
`;

export interface TelegramOffsetAdvance {
    previousOffset: number | null;
    nextOffset: number;
    advancedBy: number;
    updatedAt: string;
}

export interface TelegramOffsetDiagnostics {
    offset: number;
    updatedAt: string;
}

/**
 * Home-scoped SQLite frontier for Telegram long polling.
 *
 * The frontier is also the durable replay guard: updates below it have already
 * completed their required delivery and are not dispatched again after a
 * restart. This is at-least-once processing, not exactly-once. A crash after
 * Telegram accepts the final response but before this store advances can still
 * repeat that response, which is the unavoidable remote/local commit window.
 */
export class TelegramUpdateOffsetStore {
    constructor(
        private readonly database: Database.Database,
        private readonly now: () => string = () => new Date().toISOString(),
    ) {
        this.database.exec(CREATE_OFFSET_TABLE_SQL);
    }

    read(key: string): number | null {
        const row = this.database.prepare(
            'SELECT offset FROM telegram_update_offset WHERE key = ?',
        ).get(key) as { offset: number } | undefined;
        return row?.offset ?? null;
    }

    bootstrap(key: string, offset: number): TelegramOffsetAdvance {
        return this.advance(key, offset);
    }

    advance(key: string, offset: number): TelegramOffsetAdvance {
        assertOffset(offset);
        const previousOffset = this.read(key);
        const nextOffset = Math.max(previousOffset ?? 0, offset);
        const updatedAt = this.now();
        this.database.prepare(`
            INSERT INTO telegram_update_offset (key, offset, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                offset = MAX(telegram_update_offset.offset, excluded.offset),
                updated_at = CASE
                    WHEN excluded.offset > telegram_update_offset.offset THEN excluded.updated_at
                    ELSE telegram_update_offset.updated_at
                END
        `).run(key, nextOffset, updatedAt);
        const persisted = this.diagnostics(key);
        if (!persisted) throw new Error('telegram_offset_persist_failed');
        return {
            previousOffset,
            nextOffset: persisted.offset,
            advancedBy: persisted.offset - (previousOffset ?? 0),
            updatedAt: persisted.updatedAt,
        };
    }

    diagnostics(key: string): TelegramOffsetDiagnostics | null {
        const row = this.database.prepare(
            'SELECT offset, updated_at FROM telegram_update_offset WHERE key = ?',
        ).get(key) as { offset: number; updated_at: string } | undefined;
        return row ? { offset: row.offset, updatedAt: row.updated_at } : null;
    }
}

export interface TelegramPollingApi {
    getUpdates(
        args: { offset: number; limit: number; timeout: number },
        signal?: TelegramPollingSignal,
    ): Promise<Update[]>;
    deleteWebhook(args: { drop_pending_updates: false }, signal?: TelegramPollingSignal): Promise<unknown>;
}

export type TelegramPollingSignal = Parameters<Api['getUpdates']>[1];

export interface TelegramBootstrapResult {
    nextOffset: number;
    bootstrapped: boolean;
    skippedThroughUpdateId: number | null;
}

export interface TelegramPollResult {
    received: number;
    committed: number;
    duplicates: number;
    nextOffset: number;
}

export interface TelegramDurablePollerOptions {
    api: TelegramPollingApi;
    key: string;
    store: TelegramUpdateOffsetStore;
    handleUpdateThroughFinalDelivery(update: Update): Promise<void>;
    onStart?(result: TelegramBootstrapResult): void | Promise<void>;
}

/** Public-API poller used because grammY's Bot.start has no initial-offset option. */
export class TelegramDurablePoller {
    private controller: AbortController | null = null;
    private running: Promise<void> | null = null;
    private nextOffset: number | null = null;

    constructor(private readonly options: TelegramDurablePollerOptions) {}

    bootstrap(signal: AbortSignal = new AbortController().signal): Promise<TelegramBootstrapResult> {
        return this.bootstrapInner(signal);
    }

    start(): Promise<void> {
        if (this.running) return this.running;
        const controller = new AbortController();
        this.controller = controller;
        const running = this.run(controller.signal).finally(() => {
            if (this.running === running) this.running = null;
            if (this.controller === controller) this.controller = null;
        });
        this.running = running;
        return running;
    }

    async stop(): Promise<void> {
        this.controller?.abort();
        await this.running;
    }

    async pollOnce(signal: AbortSignal = new AbortController().signal): Promise<TelegramPollResult> {
        const offset = this.nextOffset ?? this.options.store.read(this.options.key);
        if (offset === null) throw new Error('telegram_offset_not_bootstrapped');
        const updates = await this.options.api.getUpdates(
            { offset, limit: 100, timeout: 30 },
            grammySignal(signal),
        );
        let committed = 0;
        let duplicates = 0;
        let nextOffset = offset;
        const ordered = [...updates].sort((a, b) => a.update_id - b.update_id);
        for (const update of ordered) {
            if (update.update_id < nextOffset) {
                duplicates++;
                continue;
            }
            await this.options.handleUpdateThroughFinalDelivery(update);
            nextOffset = update.update_id + 1;
            this.options.store.advance(this.options.key, nextOffset);
            this.nextOffset = nextOffset;
            committed++;
        }
        return { received: updates.length, committed, duplicates, nextOffset };
    }

    private async bootstrapInner(signal: AbortSignal): Promise<TelegramBootstrapResult> {
        await this.options.api.deleteWebhook({ drop_pending_updates: false }, grammySignal(signal));
        const stored = this.options.store.read(this.options.key);
        if (stored !== null) {
            this.nextOffset = stored;
            return { nextOffset: stored, bootstrapped: false, skippedThroughUpdateId: null };
        }

        const latest = await this.options.api.getUpdates(
            { offset: -1, limit: 1, timeout: 0 },
            grammySignal(signal),
        );
        const newest = latest.reduce<number | null>(
            (highest, item) => highest === null ? item.update_id : Math.max(highest, item.update_id),
            null,
        );
        const nextOffset = newest === null ? 0 : newest + 1;
        this.options.store.bootstrap(this.options.key, nextOffset);
        this.nextOffset = nextOffset;
        return { nextOffset, bootstrapped: true, skippedThroughUpdateId: newest };
    }

    private async run(signal: AbortSignal): Promise<void> {
        try {
            const result = await this.bootstrapInner(signal);
            await this.options.onStart?.(result);
            while (!signal.aborted) await this.pollOnce(signal);
        } catch (error) {
            if (!signal.aborted) throw error;
        }
    }
}

function assertOffset(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError('invalid_telegram_offset');
    }
}

function grammySignal(signal: AbortSignal): TelegramPollingSignal {
    // grammY declares the same runtime AbortSignal protocol through its
    // abort-controller shim, whose EventTarget type is not assignable to the
    // DOM declaration even though both expose the methods its client uses.
    return signal as unknown as TelegramPollingSignal;
}

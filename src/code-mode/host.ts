import Database, { type Database as SqliteDatabase } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { publish } from '../core/event-bus.js';
import { CodeSessionManager } from './manager.js';
import { createCodeProviders } from './providers/catalog.js';
import { CodeStore } from './store.js';
import type { CodeProviders } from './provider.js';

export interface CodeHostOptions {
    home: string;
    role: 'worker' | 'manager';
    port: number | (() => number);
    maxConcurrentSessions?: number;
    idleReapMs?: number;
    providers?: CodeProviders;
}

/** No database, recovery or native runtime is opened until the service is used. */
export function createCodeHost(options: CodeHostOptions): { get(): CodeSessionManager; dispose(): Promise<void> } {
    let database: SqliteDatabase | undefined;
    let manager: CodeSessionManager | undefined;
    let disposal: Promise<void> | undefined;
    let closed = false;
    return {
        get() {
            if (closed) throw Object.assign(new Error('Code host is closed'), { code: 'code_host_closed', statusCode: 503 });
            if (manager) return manager;
            const port = typeof options.port === 'function' ? options.port() : options.port;
            if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Code host port');
            mkdirSync(options.home, { recursive: true, mode: 0o700 });
            const candidate = new Database(join(options.home, `code-${options.role}-${port}.sqlite`));
            try {
                candidate.pragma('journal_mode = WAL');
                candidate.pragma('busy_timeout = 5000');
                candidate.pragma('foreign_keys = ON');
                const service = new CodeSessionManager({
                    store: new CodeStore(candidate),
                    providers: options.providers ?? createCodeProviders(),
                    publish: event => { publish('code', event.event, { ...event }); },
                    ...(options.maxConcurrentSessions === undefined ? {} : { maxConcurrentSessions: options.maxConcurrentSessions }),
                    ...(options.idleReapMs === undefined ? {} : { idleReapMs: options.idleReapMs }),
                });
                service.recover();
                database = candidate;
                manager = service;
                return service;
            } catch (error) {
                candidate.close();
                throw error;
            }
        },
        dispose() {
            closed = true;
            return disposal ??= (async () => {
                // Keep the database alive until owned runtimes finish their last callbacks.
                await manager?.dispose();
                database?.close();
                database = undefined;
                manager = undefined;
            })();
        },
    };
}

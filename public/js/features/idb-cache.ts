// ── IndexedDB Offline Cache ──
// Caches conversation messages for offline viewing
// Auto-syncs when server reconnects

const DB_NAME = 'clijaw';
const DB_VERSION = 3;
const STORE = 'messages';
const SCOPE_KEY = 'clijaw_scope';

let currentScope: string = localStorage.getItem(SCOPE_KEY) || 'default';

export function setMessageScope(scope: string): void {
    currentScope = scope || 'default';
    localStorage.setItem(SCOPE_KEY, currentScope);
}

export function getMessageScope(): string {
    return currentScope;
}

export interface CachedMessage {
    id?: number;
    message_id?: number | string;
    role: string;
    content: string;
    timestamp: number;
    cli?: string | null;
    tool_log?: string | null;
    trace_run_id?: string | null;
    scope?: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (event) => {
            const db = req.result;
            const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
            if (oldVersion < 2) {
                // Fresh install or v1→v3: recreate store with all fields
                if (db.objectStoreNames.contains(STORE)) {
                    db.deleteObjectStore(STORE);
                }
                const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
                store.createIndex('timestamp', 'timestamp');
                store.createIndex('scope', 'scope');
            } else if (oldVersion === 2) {
                // v2→v3: only add scope index, preserve existing data
                const store = req.transaction!.objectStore(STORE);
                if (!store.indexNames.contains('scope')) {
                    store.createIndex('scope', 'scope');
                }
            }
        };
        req.onsuccess = () => {
            const db = req.result;
            // Handle version upgrades from other tabs — close and invalidate singleton
            db.onversionchange = () => {
                db.close();
                dbPromise = null;
            };
            db.onclose = () => {
                dbPromise = null;
            };
            resolve(db);
        };
        req.onblocked = () => {
            console.warn('[idb-cache] DB upgrade blocked by another tab');
        };
        req.onerror = () => {
            dbPromise = null;
            reject(req.error);
        };
    });
    return dbPromise;
}

// Scopes key on origin+path::workingDir — every past instance/workingDir
// leaves rows that nothing deletes (260613 06 finding). Sweep non-current
// scopes older than 30 days, once per page session.
const STALE_SCOPE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
let staleScopeSweepDone = false;

async function evictStaleScopes(db: IDBDatabase): Promise<void> {
    if (staleScopeSweepDone) return;
    staleScopeSweepDone = true;
    try {
        const cutoff = Date.now() - STALE_SCOPE_MAX_AGE_MS;
        const tx = db.transaction(STORE, 'readwrite');
        // Legacy v2 stores may predate the timestamp index — skip rather
        // than throw into the catch every session (adversarial review #9).
        if (!tx.objectStore(STORE).indexNames.contains('timestamp')) return;
        const cursorReq = tx.objectStore(STORE).index('timestamp').openCursor(IDBKeyRange.upperBound(cutoff));
        cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) return;
            const row = cursor.value as CachedMessage;
            if ((row.scope || 'default') !== currentScope) cursor.delete();
            cursor.continue();
        };
    } catch (e) {
        console.warn('[idb-cache] stale-scope sweep failed:', e);
    }
}

export async function cacheMessages(messages: CachedMessage[]): Promise<void> {
    try {
        // Guard: never wipe the cache with an empty array — only a deliberate
        // clearCache() call should empty the store. This prevents data loss when
        // the server briefly returns [] during restarts or scope mismatches.
        if (messages.length === 0) return;

        const db = await openDB();
        void evictStaleScopes(db);
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        // devlog 260609 79/82: replace only the current scope — a global clear
        // here erased every other scope's offline fallback on each load, while
        // reads stay scoped via getScopedMessages(). Delete-then-add runs in
        // one transaction, so the scope swap stays atomic.
        const targetScope = currentScope || 'default';
        const cursorReq = store.index('scope').openCursor(IDBKeyRange.only(targetScope));
        cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) {
                cursor.delete();
                cursor.continue();
                return;
            }
            for (const msg of messages) {
                store.add({
                    message_id: msg.message_id ?? msg.id,
                    role: msg.role,
                    content: msg.content,
                    cli: msg.cli ?? null,
                    tool_log: msg.tool_log ?? null,
                    trace_run_id: msg.trace_run_id ?? null,
                    timestamp: msg.timestamp || Date.now(),
                    scope: targetScope,
                });
            }
        };
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('[idb-cache] cacheMessages failed:', e);
    }
}

export async function getCachedMessages(): Promise<CachedMessage[]> {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        console.warn('[idb-cache] getCachedMessages failed:', e);
        return [];
    }
}

export async function appendCachedMessage(role: string, content: string): Promise<void> {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).add({ role, content, timestamp: Date.now(), scope: currentScope });
    } catch (e) {
        console.warn('[idb-cache] appendCachedMessage failed:', e);
    }
}

export async function upsertMessage(msg: CachedMessage): Promise<void> {
    const scope = msg.scope ?? currentScope;
    try {
        const db = await openDB();
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).add({
            message_id: msg.message_id ?? msg.id,
            role: msg.role,
            content: msg.content,
            cli: msg.cli ?? null,
            tool_log: msg.tool_log ?? null,
            trace_run_id: msg.trace_run_id ?? null,
            timestamp: msg.timestamp || Date.now(),
            scope,
        });
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('[idb-cache] upsertMessage failed:', e);
    }
}

/** Correct an existing answer in its captured cache scope; never append a duplicate. */
export async function replaceCachedAnswer(runId: string, content: string, scope: string): Promise<void> {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE, 'readwrite');
        const request = tx.objectStore(STORE).index('scope').openCursor(IDBKeyRange.only(scope));
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            const row = cursor.value as CachedMessage;
            if (row.scope === scope && row.role === 'assistant' && row.trace_run_id === runId) {
                cursor.update({ ...row, content });
            }
            cursor.continue();
        };
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (error) { console.warn('[idb-cache] replaceCachedAnswer failed:', error); }
}

export async function getScopedMessages(scope?: string): Promise<CachedMessage[]> {
    try {
        const db = await openDB();
        const targetScope = scope || currentScope;
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const idx = tx.objectStore(STORE).index('scope');
            const req = idx.getAll(targetScope);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        console.warn('[idb-cache] getScopedMessages failed:', e);
        return [];
    }
}

export async function clearCache(): Promise<void> {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
    } catch (e) {
        console.warn('[idb-cache] clearCache failed:', e);
    }
}

// Clearing one session's screen must not erase another session's offline fallback:
// with several tabs open, a global wipe makes every other tab re-fetch its whole
// history for a clear it did not ask for (072 §1.3a).
//
// It takes no scope on purpose. This store is keyed by location and working directory
// (message-history.ts), which is a different namespace from the execution scopes the
// server puts on events, and a caller passing one of those would name a key that was
// never written and silently delete nothing.
export async function clearScopedCache(): Promise<void> {
    const targetScope = currentScope;
    if (!targetScope) {
        await clearCache();
        return;
    }
    try {
        const db = await openDB();
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const cursorReq = store.index('scope').openCursor(IDBKeyRange.only(targetScope));
        cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) return;
            cursor.delete();
            cursor.continue();
        };
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('[idb-cache] clearScopedCache failed:', e);
    }
}

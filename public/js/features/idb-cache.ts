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

export interface CachedMessage {
    id?: number;
    role: string;
    content: string;
    timestamp: number;
    cli?: string | null;
    tool_log?: string | null;
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

export async function cacheMessages(messages: CachedMessage[]): Promise<void> {
    try {
        // Guard: never wipe the cache with an empty array — only a deliberate
        // clearCache() call should empty the store. This prevents data loss when
        // the server briefly returns [] during restarts or scope mismatches.
        if (messages.length === 0) return;

        const db = await openDB();
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        store.clear();
        for (const msg of messages) {
            store.add({ role: msg.role, content: msg.content, cli: msg.cli ?? null, tool_log: msg.tool_log ?? null, timestamp: msg.timestamp || Date.now(), scope: currentScope });
        }
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
        tx.objectStore(STORE).add({ role, content, timestamp: Date.now() });
    } catch (e) {
        console.warn('[idb-cache] appendCachedMessage failed:', e);
    }
}

export async function upsertMessage(msg: CachedMessage): Promise<void> {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).add({
            role: msg.role,
            content: msg.content,
            cli: msg.cli ?? null,
            tool_log: msg.tool_log ?? null,
            timestamp: msg.timestamp || Date.now(),
            scope: currentScope,
        });
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('[idb-cache] upsertMessage failed:', e);
    }
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

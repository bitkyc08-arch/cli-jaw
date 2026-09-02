export const BROWSER_HISTORY_STORAGE_KEY = 'jaw.browserHistory';
export const BROWSER_HISTORY_MAX = 20;

export type BrowserHistoryEntry = {
    url: string;
    title: string;
    at: number;
};

function isHistoryEntry(value: unknown): value is BrowserHistoryEntry {
    if (value === null || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return typeof record['url'] === 'string'
        && typeof record['title'] === 'string'
        && typeof record['at'] === 'number'
        && Number.isFinite(record['at']);
}

export function parseBrowserHistory(raw: string | null): BrowserHistoryEntry[] {
    if (raw == null || raw.trim() === '') return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const entries: BrowserHistoryEntry[] = [];
        for (const item of parsed) {
            if (!isHistoryEntry(item)) continue;
            const url = item.url.trim();
            if (!url) continue;
            entries.push({
                url,
                title: item.title.trim().slice(0, 512),
                at: item.at,
            });
            if (entries.length >= BROWSER_HISTORY_MAX) break;
        }
        return entries;
    } catch {
        return [];
    }
}

export function upsertBrowserHistory(entries: BrowserHistoryEntry[], next: BrowserHistoryEntry): BrowserHistoryEntry[] {
    const url = next.url.trim();
    if (!url) return entries;
    const without = entries.filter(item => item.url !== url);
    return [{
        url,
        title: next.title.trim().slice(0, 512),
        at: next.at,
    }, ...without].slice(0, BROWSER_HISTORY_MAX);
}

function storage(): Storage | null {
    try {
        if (typeof globalThis.localStorage === 'undefined') return null;
        return globalThis.localStorage;
    } catch {
        return null;
    }
}

export function loadBrowserHistory(): BrowserHistoryEntry[] {
    const store = storage();
    if (!store) return [];
    try {
        return parseBrowserHistory(store.getItem(BROWSER_HISTORY_STORAGE_KEY));
    } catch {
        return [];
    }
}

export function saveBrowserHistory(entries: BrowserHistoryEntry[]): void {
    const store = storage();
    if (!store) return;
    try {
        store.setItem(BROWSER_HISTORY_STORAGE_KEY, JSON.stringify(entries.slice(0, BROWSER_HISTORY_MAX)));
    } catch {
        // Storage may be disabled (private mode); fall through silently.
    }
}

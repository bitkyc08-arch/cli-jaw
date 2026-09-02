import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BROWSER_HISTORY_MAX,
    BROWSER_HISTORY_STORAGE_KEY,
    loadBrowserHistory,
    parseBrowserHistory,
    saveBrowserHistory,
    upsertBrowserHistory,
    type BrowserHistoryEntry,
} from '../../public/manager/src/browser-panel/browser-history-store.js';

type MemoryStorage = {
    store: Map<string, string>;
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    clear(): void;
    key(index: number): string | null;
    readonly length: number;
};

function createMemoryStorage(): MemoryStorage {
    const store = new Map<string, string>();
    return {
        store,
        getItem(key: string): string | null {
            return store.get(key) ?? null;
        },
        setItem(key: string, value: string): void {
            store.set(key, value);
        },
        removeItem(key: string): void {
            store.delete(key);
        },
        clear(): void {
            store.clear();
        },
        key(index: number): string | null {
            return [...store.keys()][index] ?? null;
        },
        get length(): number {
            return store.size;
        },
    };
}

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const memory = createMemoryStorage();
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    enumerable: true,
    get() {
        return memory;
    },
});

test.after(() => {
    if (originalLocalStorage) {
        Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
        return;
    }
    Reflect.deleteProperty(globalThis, 'localStorage');
});

function entry(url: string, title: string, at: number): BrowserHistoryEntry {
    return { url, title, at };
}

test('upserting the same url moves it forward and updates the title', () => {
    const first = upsertBrowserHistory([], entry('https://a.example/', 'A', 1));
    const second = upsertBrowserHistory(first, entry('https://b.example/', 'B', 2));
    const updated = upsertBrowserHistory(second, entry('https://a.example/', 'A updated', 3));
    assert.deepEqual(updated, [
        entry('https://a.example/', 'A updated', 3),
        entry('https://b.example/', 'B', 2),
    ]);
});

test('upsert keeps at most 20 entries', () => {
    let entries: BrowserHistoryEntry[] = [];
    for (let index = 0; index < BROWSER_HISTORY_MAX + 1; index += 1) {
        entries = upsertBrowserHistory(entries, entry(`https://n${index}.example/`, `N${index}`, index));
    }
    assert.equal(entries.length, 20);
    assert.equal(entries[0]?.url, 'https://n20.example/');
    assert.equal(entries[19]?.url, 'https://n1.example/');
});

test('broken JSON parses as an empty list', () => {
    assert.deepEqual(parseBrowserHistory('{not json'), []);
    assert.deepEqual(parseBrowserHistory('{"url":"https://a.example/"}'), []);
    assert.deepEqual(parseBrowserHistory(null), []);
});

test('blank urls are skipped', () => {
    const kept = upsertBrowserHistory(
        [entry('https://kept.example/', 'Kept', 1)],
        entry('   ', 'Blank', 2),
    );
    assert.deepEqual(kept, [entry('https://kept.example/', 'Kept', 1)]);
    assert.deepEqual(parseBrowserHistory(JSON.stringify([
        { url: '  ', title: 'Blank', at: 1 },
        { url: 'https://ok.example/', title: 'Ok', at: 2 },
        { url: 1, title: 'Bad', at: 3 },
    ])), [entry('https://ok.example/', 'Ok', 2)]);
});

test('load and save round-trip through the stubbed localStorage key', () => {
    memory.clear();
    saveBrowserHistory([entry('https://saved.example/', 'Saved', 9)]);
    assert.equal(memory.getItem(BROWSER_HISTORY_STORAGE_KEY), JSON.stringify([
        entry('https://saved.example/', 'Saved', 9),
    ]));
    assert.deepEqual(loadBrowserHistory(), [entry('https://saved.example/', 'Saved', 9)]);
    memory.setItem(BROWSER_HISTORY_STORAGE_KEY, 'not-json');
    assert.deepEqual(loadBrowserHistory(), []);
});

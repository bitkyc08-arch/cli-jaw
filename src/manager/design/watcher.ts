import { existsSync, watch, type FSWatcher } from 'node:fs';
import { dashboardPath } from '../dashboard-home.js';

/**
 * Design store watcher (Notes pattern: fs.watch + debounced version bump).
 * The frontend polls the version and reloads; `rescan` stays the
 * authoritative recovery path when watching is unavailable.
 */

const DEBOUNCE_MS = 300;

let watcher: FSWatcher | null = null;
let version = 0;
let debounceTimer: NodeJS.Timeout | null = null;

export function designStoreVersion(): number {
    return version;
}

export function bumpDesignStoreVersion(): void {
    version += 1;
}

export function startDesignWatcher(): boolean {
    if (watcher) return true;
    const root = dashboardPath('design');
    if (!existsSync(root)) return false;
    try {
        watcher = watch(root, { recursive: true }, () => {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => { version += 1; }, DEBOUNCE_MS);
            debounceTimer.unref?.();
        });
        watcher.on('error', () => stopDesignWatcher());
        // Never keep a process alive just for the watcher (tests, CLI).
        watcher.unref?.();
        return true;
    } catch {
        watcher = null;
        return false;
    }
}

export function stopDesignWatcher(): void {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    watcher?.close();
    watcher = null;
}

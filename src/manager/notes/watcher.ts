import { watch, type FSWatcher } from 'node:fs';
import { existsSync } from 'node:fs';

export type NotesWatcher = {
    version: () => number;
    close: () => void;
};

export function createNotesWatcher(rootPath: string): NotesWatcher {
    let version = 0;
    let watcher: FSWatcher | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    if (existsSync(rootPath)) {
        try {
            watcher = watch(rootPath, { recursive: true }, () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => { version++; }, 200);
            });
            watcher.on('error', () => {});
        } catch {
            // fs.watch may fail on some systems; version stays at 0
        }
    }

    return {
        version: () => version,
        close: () => {
            clearTimeout(debounceTimer);
            watcher?.close();
        },
    };
}

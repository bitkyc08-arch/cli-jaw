import { presentationMode, type PresentationMode } from '../../../src/shared/presentation.js';
import { api } from '../api.js';

let generation = 0;
let requested = 0;
let refresh: Promise<void> | null = null;

/** Initial settings reads and event refreshes share this ordering fence. */
export function beginPresentationRead(): number {
    return ++generation;
}

export function applyPresentationSettings(snapshot: unknown, token = beginPresentationRead()): void {
    if (token !== generation) return;
    document.documentElement.dataset['presentationMode'] = presentationMode(snapshot);
}

export function getPresentationMode(): PresentationMode {
    return presentationMode({ presentation: { mode: document.documentElement.dataset['presentationMode'] } });
}

/** Coalesce bursts, but fetch again when a change arrives during the current GET. */
export function refreshPresentationSettings(): Promise<void> {
    requested = beginPresentationRead();
    if (refresh) return refresh;
    refresh = (async () => {
        let token: number;
        do {
            token = requested;
            const snapshot = await api<unknown>('/api/settings');
            if (!snapshot) {
                if (token !== requested) continue;
                throw new Error('presentation_settings_unavailable');
            }
            applyPresentationSettings(snapshot, token);
        } while (token !== requested);
    })().finally(() => { refresh = null; });
    return refresh;
}

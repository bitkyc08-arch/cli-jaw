import { presentationMode, type PresentationMode } from '../../../src/shared/presentation.js';
import { requestBoundedJson } from '../bounded-api.js';

let generation = 0;
let requested = 0;
let refresh: Promise<void> | null = null;
const SETTINGS_BYTES = 4 * 1024 * 1024;

/** Initial settings reads and event refreshes share this ordering fence. */
export function beginPresentationRead(): number { return ++generation; }

export function applyPresentationSettings(snapshot: unknown, token = beginPresentationRead()): void {
    if (token !== generation) return;
    document.documentElement.dataset['presentationMode'] = presentationMode(snapshot);
}

export function getPresentationMode(): PresentationMode {
    return presentationMode({ presentation: { mode: document.documentElement.dataset['presentationMode'] } });
}

function settingsObject(raw: unknown): object {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('presentation_settings_unavailable');
    const envelope = raw as Record<string, unknown>;
    if (!Object.hasOwn(envelope, 'ok')) return raw;
    const data = envelope['data'];
    if (envelope['ok'] !== true || !data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('presentation_settings_unavailable');
    }
    return data;
}

/** Coalesce bursts, but fetch again when a change arrives during the current GET. */
export function refreshPresentationSettings(): Promise<void> {
    requested = beginPresentationRead();
    if (refresh) return refresh;
    refresh = (async () => {
        let token: number;
        do {
            token = requested;
            let snapshot: object;
            try {
                snapshot = settingsObject(await requestBoundedJson('/api/settings', { method: 'GET' },
                    new AbortController().signal, SETTINGS_BYTES));
            } catch (error) {
                if (token !== requested) continue;
                throw new Error('presentation_settings_unavailable', { cause: error });
            }
            applyPresentationSettings(snapshot, token);
        } while (token !== requested);
    })().finally(() => { refresh = null; });
    return refresh;
}

// Phase 9 — single-source error normalizer.
//
// Turns a `SettingsRequestError` (or any thrown value) into a human sentence
// the SaveBar / Toast can display. Surfaces method/path/status when present.

import { SettingsRequestError } from '../settings-client';

export function describeError(err: unknown): string {
    if (err instanceof SettingsRequestError) {
        const detail = err.detail.trim();
        const head = `${err.method} ${err.path} → ${err.status}`;
        if (err.status === 401 || err.status === 403) {
            return `${head}: instance requires auth.`;
        }
        if (err.status >= 500 || err.status === 0) {
            return `${head}: instance unreachable.`;
        }
        return detail ? `${head}: ${detail}` : head;
    }
    if (err instanceof Error) return err.message || 'Unknown error';
    return String(err);
}

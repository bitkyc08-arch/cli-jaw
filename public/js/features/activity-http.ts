import { API_BASE, getAuthToken } from '../api.js';

export class ActivityReadError extends Error {
    constructor(readonly status: number) {
        super(status === 404 ? 'Activity is unavailable for this conversation.'
            : 'Activity could not be loaded. Retry when the connection is available.');
    }
}

/** Unlike the general API helper, replay must preserve aborts and failed reads. */
export async function readActivityHttp(path: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const token = await getAuthToken();
    signal.throwIfAborted();
    const response = await fetch(API_BASE + path, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        headers: token ? { Authorization: 'Bearer ' + token } : {},
    });
    if (!response.ok) throw new ActivityReadError(response.status);
    if (!response.headers.get('content-type')?.includes('json') || !response.body) throw new ActivityReadError(0);
    const reader = response.body.getReader();
    const parts: Uint8Array[] = []; let size = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 270_000) { await reader.cancel(); throw new Error('activity_page_limit'); }
            parts.push(next.value);
        }
    } finally { reader.releaseLock(); }
    signal.throwIfAborted();
    const data = new Uint8Array(size); let offset = 0;
    for (const part of parts) { data.set(part, offset); offset += part.length; }
    return JSON.parse(new TextDecoder().decode(data)) as unknown;
}

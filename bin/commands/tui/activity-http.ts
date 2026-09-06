import { authHeaders } from '../../../src/cli/api-auth.js';
import { MAX_SAVED_ACTIVITY_ANSWER_BYTES, type ActivityReader } from '../../../src/shared/activity-read.js';
import type { TuiContext } from './types.js';

const PAGE_BYTES = 270_000;
const READ_TIMEOUT_MS = 15_000;

/** Only the existing read-only Activity routes can carry CLI authentication. */
function responseLimit(path: string): number {
    if (!path.startsWith('/api/') || /[\\#\r\n]/.test(path)) throw new Error('invalid_activity_path');
    const url = new URL(path, 'http://activity.invalid');
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length) throw new Error('invalid_activity_query');
    let allowed: string[];
    let limit = PAGE_BYTES;
    if (url.pathname === '/api/orchestrate/snapshot') {
        allowed = ['session']; limit = MAX_SAVED_ACTIVITY_ANSWER_BYTES;
    } else if (/^\/api\/messages\/by-trace\/[^/]+$/.test(url.pathname)) {
        allowed = ['session']; limit = MAX_SAVED_ACTIVITY_ANSWER_BYTES;
    } else if (/^\/api\/traces\/[^/]+\/activity$/.test(url.pathname)) {
        allowed = ['session', 'after', 'limit', 'through'];
    } else if (url.pathname === '/api/traces/activity-runs') {
        allowed = ['session', 'after'];
    } else throw new Error('invalid_activity_path');
    if (keys.some(key => !allowed.includes(key))) throw new Error('invalid_activity_query');
    return limit;
}

export function activityHttpRead(ctx: Pick<TuiContext, 'apiUrl'>): ActivityReader {
    return async (path, callerSignal) => {
        const limit = responseLimit(path);
        const base = new URL(ctx.apiUrl);
        if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
            || base.search || base.hash) throw new Error('invalid_activity_base');
        const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(READ_TIMEOUT_MS)]);
        signal.throwIfAborted();
        const response = await fetch(`${ctx.apiUrl.replace(/\/$/, '')}${path}`, {
            method: 'GET', headers: authHeaders(), redirect: 'error', signal,
        });
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
            signal.throwIfAborted();
            if (!response.ok) throw new Error(`activity_http_${response.status}`);
            const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
            if (!contentType || !/^application\/(?:[\w.-]+\+)?json$/i.test(contentType)) throw new Error('activity_content_type');
            const declared = response.headers.get('content-length');
            if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new Error('activity_response_limit');
            if (!response.body) throw new Error('activity_body_missing');
            reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let bytes = 0;
            while (true) {
                signal.throwIfAborted();
                const part = await reader.read();
                signal.throwIfAborted();
                if (part.done) break;
                bytes += part.value.byteLength;
                if (bytes > limit) throw new Error('activity_response_limit');
                chunks.push(part.value);
            }
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))) as unknown;
        } catch (error) {
            if (reader) await reader.cancel().catch(() => {});
            else await response.body?.cancel().catch(() => {});
            throw error;
        } finally { reader?.releaseLock(); }
    };
}

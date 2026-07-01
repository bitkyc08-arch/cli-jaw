const STREAMING_FETCH_BODY_TYPES = new Set(['FormData', 'Blob', 'Readable', 'ReadableStream']);

export function requiresStreamingFetchBody(body: unknown): boolean {
    if (!body || typeof body !== 'object') return false;
    return STREAMING_FETCH_BODY_TYPES.has(body.constructor?.name || '');
}

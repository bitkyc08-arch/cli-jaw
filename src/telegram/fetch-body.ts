export function requiresStreamingFetchBody(body: unknown): boolean {
    if (!body || typeof body !== 'object') return false;
    if (body instanceof FormData || body instanceof Blob) return true;
    // grammY multipart uploads are Node streams. Duck-typing keeps custom
    // Readable subclasses on the node-fetch path without routing WHATWG
    // ReadableStream, which node-fetch v3 does not accept as RequestInit.body.
    return typeof (body as { pipe?: unknown }).pipe === 'function';
}

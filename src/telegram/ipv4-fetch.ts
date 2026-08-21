// ─── Telegram IPv4 fetch ─────────────────────────────
// grammY's client fetch is replaced to force IPv4 (some hosts resolve AAAA and
// then hang). Two things that replacement must not lose:
//
//   1. init.signal — grammY passes a per-call AbortSignal, and dropping it makes
//      every "bounded" call a lie: the promise settles while the socket keeps
//      running, so a shutdown drain returns with work still in flight. grammY's
//      own default API timeout is 500 seconds.
//   2. streaming bodies — file uploads need the real fetch, not this one.
//
// Exported as a factory so production and tests drive the SAME implementation.

import https from 'https';

/** The subset of node's https/http used here, injectable for tests. */
export type RequestFactory = (
    options: Record<string, unknown>,
    callback: (res: NodeJS.ReadableStream & { statusCode?: number }) => void,
) => {
    on(event: string, handler: (err?: unknown) => void): unknown;
    write(chunk: string): unknown;
    end(): unknown;
    destroy(error?: Error): unknown;
};

export type Ipv4FetchDeps = {
    /** Defaults to https.request; a test supplies http.request against a local server. */
    request?: RequestFactory;
    /** Pass null to opt out; omit to get the IPv4 https agent. */
    agent?: unknown;
    /** Used for streaming bodies, which cannot go through the raw request path. */
    streamingFetch?: (url: string, init: Record<string, unknown>) => Promise<unknown>;
    isStreamingBody?: (body: unknown) => boolean;
};

/**
 * Build the IPv4 fetch grammY will call.
 *
 * The abort wiring is the load-bearing part: on abort the request is DESTROYED,
 * not merely rejected. Rejecting stops the waiting; destroying stops the work.
 */
export function createIpv4Fetch(deps: Ipv4FetchDeps = {}) {
    const request = deps.request ?? (https.request as unknown as RequestFactory);
    // An https.Agent cannot serve an injected http.request, so a caller that
    // supplies its own request factory may also pass `agent: null` to opt out
    // rather than inherit one that rejects its protocol.
    const agent = 'agent' in deps ? deps.agent : new https.Agent({ family: 4 });
    return (url: string, init: Record<string, unknown> = {}): Promise<unknown> => {
        const body = init['body'];
        if (deps.isStreamingBody?.(body) && deps.streamingFetch) {
            return deps.streamingFetch(url, { ...init, agent });
        }
        return new Promise((resolve, reject) => {
            const u = new URL(url);
            const signal = init['signal'] as AbortSignal | undefined;
            if (signal?.aborted) {
                reject(new Error('telegram_request_aborted'));
                return;
            }
            const headersInit = init['headers'];
            const opts = {
                hostname: u.hostname,
                port: u.port || 443,
                path: u.pathname + u.search,
                method: (init['method'] as string) || 'GET',
                agent,
                headers: headersInit instanceof Headers
                    ? Object.fromEntries(headersInit)
                    : ((headersInit as Record<string, string>) || {}),
            };
            const req = request(opts, (res) => {
                // Collect BYTES and decode once at the end. Concatenating
                // per-chunk strings decodes each chunk in isolation, so a
                // multi-byte UTF-8 character split across a chunk boundary is
                // corrupted into replacement characters — and JSON.parse still
                // SUCCEEDS on the result, so the damage travels silently into
                // message text. Telegram payloads are routinely non-ASCII.
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer | string) => {
                    chunks.push(typeof c === 'string' ? Buffer.from(c, 'utf8') : c);
                });
                res.on('end', () => {
                    const data = Buffer.concat(chunks).toString('utf8');
                    resolve({
                        ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
                        status: res.statusCode,
                        json: () => Promise.resolve(JSON.parse(data)),
                        text: () => Promise.resolve(data),
                    });
                });
            });
            req.on('error', reject);
            if (signal) {
                const onAbort = () => {
                    // destroy(), not just reject: the point is to stop the work,
                    // not merely to stop waiting for it.
                    req.destroy(new Error('telegram_request_aborted'));
                };
                signal.addEventListener('abort', onAbort, { once: true });
                req.on('close', () => signal.removeEventListener('abort', onAbort));
            }
            if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
            req.end();
        });
    };
}

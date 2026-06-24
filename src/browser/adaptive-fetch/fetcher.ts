// Mirrored from agbrowse adaptive-fetch v2; keep runtime behavior aligned while cli-jaw mirror remains experimental.

import { DEFAULT_MAX_BYTES, DEFAULT_REDIRECT_LIMIT, DEFAULT_TIMEOUT_MS, redactHeaders, validateFetchUrl } from './safety.js';
import { isTextualContentType } from './transforms.js';

import type { FetchTextCandidateOptions } from './types.js';

function resolveProxy(options: FetchTextCandidateOptions): string | undefined {
    return options.proxy || process.env['HTTPS_PROXY'] || process.env['HTTP_PROXY'] || undefined;
}

async function createDispatcher(proxy: string | undefined): Promise<unknown> {
    if (!proxy) return undefined;
    try {
        const { ProxyAgent } = await import('undici');
        return new ProxyAgent(proxy);
    } catch {
        return undefined;
    }
}

export async function fetchTextCandidate(rawUrl: string, options: FetchTextCandidateOptions = {}) {
    const maxBytes = Number(options.maxBytes || DEFAULT_MAX_BYTES);
    const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
    const redirectLimit = Number(options.redirectLimit ?? DEFAULT_REDIRECT_LIMIT);
    const fetchImpl = options.fetchImpl || fetch;
    const proxy = resolveProxy(options);
    const dispatcher = await createDispatcher(proxy);
    const safetyOpts = options.allowPrivateNetwork != null ? { allowPrivateNetwork: options.allowPrivateNetwork } : {};
    let current = validateFetchUrl(rawUrl, safetyOpts).href;
    for (let redirects = 0; redirects <= redirectLimit; redirects += 1) {
        await options.beforeFetch?.(current);
        const response = await fetchImpl(current, {
            redirect: 'manual',
            headers: { accept: 'text/html,application/json,application/xml,text/plain,*/*;q=0.8' },
            signal: AbortSignal.timeout(timeoutMs),
            ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit);
        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
            const next = new URL(response.headers.get('location') || '', current);
            current = validateFetchUrl(next.href, safetyOpts).href;
            continue;
        }
        const contentType = response.headers.get('content-type') || '';
        const contentLength = Number(response.headers.get('content-length') || 0);
        const headers = Object.fromEntries(response.headers.entries());
        if (!isTextualContentType(contentType)) {
            return blockedResult(current, response.status, contentType, headers, 'unsupported-content-type');
        }
        if (contentLength > maxBytes) {
            return blockedResult(current, response.status, contentType, headers, 'content-length-exceeds-max-bytes');
        }
        const body = await readTextWithLimit(response, maxBytes);
        if (!body.ok) {
            return blockedResult(current, response.status, contentType, headers, 'body-exceeds-max-bytes');
        }
        const text = body.text;
        return {
            ok: response.ok,
            status: response.status,
            finalUrl: current,
            contentType,
            text,
            headers: redactHeaders(headers),
            evidence: [`http-${response.status}`, contentType || 'unknown-content-type', body.streamed ? 'stream-limited' : null].filter((v): v is string => v != null),
            warnings: body.warning ? [body.warning] : [],
        };
    }
    return blockedResult(current, 0, '', {}, 'redirect-limit-exceeded');
}

async function readTextWithLimit(response: Response, maxBytes: number) {
    const body = response.body;
    if (!body || typeof body.getReader !== 'function') {
        const text = await response.text();
        return {
            ok: Buffer.byteLength(text, 'utf8') <= maxBytes,
            text,
            streamed: false,
            warning: 'body-read-without-stream-limit' as string | null,
        };
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let bytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value?.byteLength || 0;
        if (bytes > maxBytes) {
            await reader.cancel().catch(() => undefined);
            return { ok: false, text: '', streamed: true, warning: null as string | null };
        }
        chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return { ok: true, text: chunks.join(''), streamed: true, warning: null as string | null };
}

function blockedResult(finalUrl: string, status: number, contentType: string, headers: Record<string, string>, reason: string) {
    return {
        ok: false,
        status,
        finalUrl,
        contentType,
        text: '',
        headers: redactHeaders(headers),
        evidence: [reason],
        warnings: [reason],
    };
}

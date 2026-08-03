import type { Express, NextFunction, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { fetchTextCandidate } from '../browser/adaptive-fetch/fetcher.js';
import { extractMetadataFromHtml } from '../browser/adaptive-fetch/metadata.js';
import { AdaptiveFetchInputError, isPrivateHostname, validateThirdPartyReaderTarget } from '../browser/adaptive-fetch/safety.js';
import { fail, ok } from '../http/response.js';

const PREVIEW_TIMEOUT_MS = 3000;
const PREVIEW_MAX_HTML_BYTES = 512 * 1024;
const PREVIEW_REDIRECT_LIMIT = 2;
const IMAGE_TIMEOUT_MS = 3000;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;

type CacheEntry<T> = {
    expiresAt: number;
    value: T | null;
};

type PreviewData = {
    url: string;
    finalUrl: string;
    canonicalUrl: string;
    domain: string;
    title: string;
    description: string;
    siteName: string;
    type: string;
    image: string;
    favicon: string;
    cache: 'miss' | 'hit';
};

type RateWindow = {
    count: number;
    start: number;
};

type ResolvedAddress = {
    address: string;
    family: number;
};

type LinkPreviewRouteOptions = {
    resolveHost?: (hostname: string) => Promise<ResolvedAddress[]>;
};

const previewCache = new Map<string, CacheEntry<PreviewData>>();
const rateLimitMap = new Map<string, RateWindow>();

// Windows are reset in place but were never deleted, so the map grew by one
// entry per unique client IP forever. The dashboard binds loopback, so real
// cardinality is 1-2 — this only bites behind a proxy that forwards client
// IPs. Same sweep the main server already runs (server.ts:299-304).
const RATE_LIMIT_SWEEP_INTERVAL_MS = 600_000;
const RATE_LIMIT_STALE_MS = 120_000;
const rateLimitSweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, window] of rateLimitMap) {
        if (now - window.start > RATE_LIMIT_STALE_MS) rateLimitMap.delete(ip);
    }
}, RATE_LIMIT_SWEEP_INTERVAL_MS);
rateLimitSweepInterval.unref();

function trimCache<T>(cache: Map<string, CacheEntry<T>>): void {
    while (cache.size > CACHE_MAX_ENTRIES) {
        const firstKey = cache.keys().next().value as string | undefined;
        if (!firstKey) return;
        cache.delete(firstKey);
    }
}

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
        cache.delete(key);
        return undefined;
    }
    return entry.value;
}

function setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T | null, ttlMs: number): void {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    trimCache(cache);
}

function getRequestIp(req: Request): string {
    return String(req.ip || req.socket.remoteAddress || 'unknown');
}

function routeRateLimit(req: Request, res: ExpressResponse, next: NextFunction): void {
    const ip = getRequestIp(req);
    const now = Date.now();
    const window = rateLimitMap.get(ip) || { count: 0, start: now };
    if (now - window.start > RATE_LIMIT_WINDOW_MS) {
        window.count = 0;
        window.start = now;
    }
    window.count += 1;
    rateLimitMap.set(ip, window);
    if (window.count > RATE_LIMIT_MAX) {
        fail(res, 429, 'rate_limit');
        return;
    }
    next();
}

function readQueryUrl(req: Request): string {
    const value = req.query['url'];
    return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function isHtmlLike(contentType: string, text: string): boolean {
    const type = contentType.toLowerCase();
    if (type.includes('text/html') || type.includes('application/xhtml+xml')) return true;
    return /^\s*<!doctype\s+html\b/i.test(text) || /^\s*<html[\s>]/i.test(text);
}

function getTagAttr(tag: string, attr: string): string {
    const re = new RegExp(`\\b${attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=["']([^"']*)["']`, 'i');
    const match = tag.match(re);
    return match ? String(match[1] || '').trim() : '';
}

function pickFavicon(html: string, baseUrl: string): string {
    const re = /<link\b[^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html))) {
        const tag = match[0];
        const rel = getTagAttr(tag, 'rel').toLowerCase();
        if (!/\b(?:icon|shortcut icon|apple-touch-icon)\b/.test(rel)) continue;
        const href = getTagAttr(tag, 'href');
        const safe = resolveSafeUrl(href, baseUrl);
        if (safe) return safe;
    }
    return '';
}

function resolveSafeUrl(raw: unknown, baseUrl: string): string {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return '';
    try {
        const resolved = new URL(text, baseUrl).href;
        return validateThirdPartyReaderTarget(resolved).href;
    } catch {
        return '';
    }
}

async function defaultResolveHost(hostname: string): Promise<ResolvedAddress[]> {
    const literal = isIP(hostname);
    if (literal) return [{ address: hostname, family: literal }];
    return await lookup(hostname, { all: true, verbatim: true });
}

async function assertPublicResolvedHost(url: string | URL, resolveHost: LinkPreviewRouteOptions['resolveHost'] = defaultResolveHost): Promise<void> {
    const parsed = validateThirdPartyReaderTarget(url);
    const addresses = await resolveHost(parsed.hostname);
    if (addresses.length === 0) {
        throw new AdaptiveFetchInputError('target host could not be resolved', {
            code: 'unresolved-host',
            url: parsed.href,
        });
    }
    for (const entry of addresses) {
        if (isPrivateHostname(entry.address)) {
            throw new AdaptiveFetchInputError('resolved target address is private or local', {
                code: 'private-network',
                url: parsed.href,
            });
        }
    }
}

function normalizePreview(rawUrl: string, html: string, finalUrl: string): PreviewData | null {
    const safeFinalUrl = validateThirdPartyReaderTarget(finalUrl).href;
    const parsedFinal = new URL(safeFinalUrl);
    const extracted = extractMetadataFromHtml(html, safeFinalUrl);
    const openGraph = extracted.metadata.openGraph || {};
    const image = resolveSafeUrl(openGraph['image'] || openGraph['image:url'], safeFinalUrl);
    const favicon = pickFavicon(html, safeFinalUrl);
    const title = String(extracted.title || '').trim();
    const description = String(extracted.metadata.description || '').trim();
    const canonicalUrl = resolveSafeUrl(extracted.metadata.canonicalUrl, safeFinalUrl) || safeFinalUrl;
    const siteName = String(openGraph['site_name'] || '').trim() || parsedFinal.hostname;
    const type = String(openGraph['type'] || '').trim() || 'website';
    if (!title && !description && !image && !favicon) return null;
    return {
        url: validateThirdPartyReaderTarget(rawUrl).href,
        finalUrl: safeFinalUrl,
        canonicalUrl,
        domain: parsedFinal.hostname,
        title,
        description,
        siteName,
        type,
        image,
        favicon,
        cache: 'miss',
    };
}

function sendInputError(res: ExpressResponse, error: unknown): void {
    if (error instanceof AdaptiveFetchInputError) {
        fail(res, 400, error.code || 'invalid_url');
        return;
    }
    fail(res, 500, 'link_preview_failed');
}

async function handlePreview(req: Request, res: ExpressResponse, options: LinkPreviewRouteOptions): Promise<void> {
    const rawUrl = readQueryUrl(req);
    try {
        const target = validateThirdPartyReaderTarget(rawUrl);
        await assertPublicResolvedHost(target, options.resolveHost);
        const cacheKey = target.href;
        const cached = getCached(previewCache, cacheKey);
        if (cached !== undefined) {
            if (!cached) {
                res.sendStatus(204);
                return;
            }
            ok(res, { ...cached, cache: 'hit' });
            return;
        }
        const fetched = await fetchTextCandidate(target.href, {
            timeoutMs: PREVIEW_TIMEOUT_MS,
            maxBytes: PREVIEW_MAX_HTML_BYTES,
            redirectLimit: PREVIEW_REDIRECT_LIMIT,
            allowPrivateNetwork: false,
            beforeFetch: url => assertPublicResolvedHost(url, options.resolveHost),
        });
        if (!fetched.ok || !isHtmlLike(fetched.contentType, fetched.text)) {
            setCached(previewCache, cacheKey, null, NEGATIVE_CACHE_TTL_MS);
            res.sendStatus(204);
            return;
        }
        const preview = normalizePreview(target.href, fetched.text, fetched.finalUrl);
        setCached(previewCache, cacheKey, preview, preview ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS);
        if (!preview) {
            res.sendStatus(204);
            return;
        }
        ok(res, preview);
    } catch (error) {
        sendInputError(res, error);
    }
}

async function readImageBody(response: globalThis.Response, maxBytes: number): Promise<Buffer | null> {
    const body = response.body;
    if (!body || typeof body.getReader !== 'function') {
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > maxBytes) return null;
        return Buffer.from(arrayBuffer);
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
}

async function handleImageProxy(req: Request, res: ExpressResponse, options: LinkPreviewRouteOptions): Promise<void> {
    const rawUrl = readQueryUrl(req);
    try {
        let current = validateThirdPartyReaderTarget(rawUrl).href;
        for (let redirects = 0; redirects <= PREVIEW_REDIRECT_LIMIT; redirects += 1) {
            await assertPublicResolvedHost(current, options.resolveHost);
            const response = await fetch(current, {
                redirect: 'manual',
                credentials: 'omit',
                headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8' },
                signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
            });
            if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
                const next = new URL(response.headers.get('location') || '', current);
                current = validateThirdPartyReaderTarget(next.href).href;
                continue;
            }
            const contentType = (response.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase();
            const contentLength = Number(response.headers.get('content-length') || 0);
            if (!response.ok || !contentType.startsWith('image/') || contentType === 'image/svg+xml') {
                fail(res, 415, 'unsupported_image_type');
                return;
            }
            if (contentLength > IMAGE_MAX_BYTES) {
                fail(res, 413, 'image_too_large');
                return;
            }
            validateThirdPartyReaderTarget(current);
            const body = await readImageBody(response, IMAGE_MAX_BYTES);
            if (!body) {
                fail(res, 413, 'image_too_large');
                return;
            }
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'private, max-age=86400');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.send(body);
            return;
        }
        fail(res, 508, 'redirect_limit_exceeded');
    } catch (error) {
        sendInputError(res, error);
    }
}

export function registerLinkPreviewRoutes(app: Express, requireAuth: RequestHandler, options: LinkPreviewRouteOptions = {}): void {
    app.get('/api/link-preview', requireAuth, routeRateLimit, (req, res) => {
        void handlePreview(req, res, options);
    });
    app.get('/api/link-preview/image', requireAuth, routeRateLimit, (req, res) => {
        void handleImageProxy(req, res, options);
    });
}

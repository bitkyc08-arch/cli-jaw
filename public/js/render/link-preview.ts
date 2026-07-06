import { API_BASE } from '../api.js';
import { escapeHtml } from './html.js';

type LinkPreviewData = {
    title?: string;
    description?: string;
    siteName?: string;
    domain?: string;
    finalUrl?: string;
    canonicalUrl?: string;
    image?: string;
    favicon?: string;
};

const PREVIEW_CLASS = 'link-preview-card';
const MAX_IN_FLIGHT_PREVIEWS = 4;
// LRU-capped: one entry per unique URL would grow for the tab's lifetime in
// link-heavy sessions (260613 06 finding). Map iteration order = insertion
// order; re-set on hit keeps hot URLs resident.
const MAX_PREVIEW_CACHE = 200;
const previewCache = new Map<string, Promise<LinkPreviewData | null>>();
const previewQueue: Array<() => void> = [];
let inFlight = 0;

function escapeAttr(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isPrivateHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost'
        || host.endsWith('.localhost')
        || host.endsWith('.local')
        || /^0\./.test(host)
        || /^10\./.test(host)
        || /^127\./.test(host)
        || /^169\.254\./.test(host)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
        || /^192\.168\./.test(host)
        || /^::1$/.test(host);
}

function normalizeExternalUrl(rawHref: string): string {
    try {
        const url = new URL(rawHref, window.location.href);
        if (!['http:', 'https:'].includes(url.protocol)) return '';
        if (url.origin === window.location.origin) return '';
        if (url.username || url.password || isPrivateHost(url.hostname)) return '';
        if (/\.(?:png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|zip|tar|gz|pdf)(?:$|\?)/i.test(url.pathname)) return '';
        return url.href;
    } catch {
        return '';
    }
}

function shouldPreviewLink(anchor: HTMLAnchorElement): boolean {
    if (anchor.closest(`.${PREVIEW_CLASS}, .search-results-block, .elicitation-block, .code-block`)) return false;
    if (anchor.dataset['linkPreviewAttached'] === 'true') return false;
    return Boolean(normalizeExternalUrl(anchor.href));
}

async function withPreviewSlot<T>(work: () => Promise<T>): Promise<T> {
    if (inFlight >= MAX_IN_FLIGHT_PREVIEWS) {
        await new Promise<void>(resolve => previewQueue.push(resolve));
    }
    inFlight += 1;
    try {
        return await work();
    } finally {
        inFlight -= 1;
        previewQueue.shift()?.();
    }
}

function fetchPreview(url: string): Promise<LinkPreviewData | null> {
    const cached = previewCache.get(url);
    if (cached) {
        previewCache.delete(url);
        previewCache.set(url, cached); // LRU touch
        return cached;
    }
    const promise = withPreviewSlot(async () => {
        try {
            const response = await fetch(`${API_BASE}/api/link-preview?url=${encodeURIComponent(url)}`);
            if (response.status === 204) return null;
            if (!response.ok) return null;
            const json = await response.json() as { ok?: boolean; data?: LinkPreviewData };
            return json.ok && json.data ? json.data : null;
        } catch {
            return null;
        }
    });
    previewCache.set(url, promise);
    while (previewCache.size > MAX_PREVIEW_CACHE) {
        const oldest = previewCache.keys().next().value;
        if (!oldest) break;
        previewCache.delete(oldest);
    }
    return promise;
}

function proxiedImageUrl(raw: string): string {
    return `${API_BASE}/api/link-preview/image?url=${encodeURIComponent(raw)}`;
}

function renderPreview(data: LinkPreviewData, sourceUrl: string): HTMLElement | null {
    const title = String(data.title || '').trim();
    const description = String(data.description || '').trim();
    const siteName = String(data.siteName || data.domain || '').trim();
    const finalUrl = String(data.canonicalUrl || data.finalUrl || sourceUrl).trim();
    const displayUrl = new URL(finalUrl || sourceUrl).hostname;
    const metaLabel = siteName && siteName.toLowerCase() !== displayUrl.toLowerCase() ? siteName : '';
    const image = String(data.image || '').trim();
    const favicon = String(data.favicon || '').trim();
    if (!title && !description && !image && !favicon) return null;
    const media = image
        ? `<img class="link-preview-image" src="${escapeAttr(proxiedImageUrl(image))}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : `<div class="link-preview-image link-preview-image-empty" aria-hidden="true"></div>`;
    const icon = favicon
        ? `<img class="link-preview-favicon" src="${escapeAttr(proxiedImageUrl(favicon))}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : '';
    const card = document.createElement('a');
    card.className = PREVIEW_CLASS;
    card.href = finalUrl || sourceUrl;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.setAttribute('aria-label', title ? `Link preview: ${title}` : 'Link preview');
    card.innerHTML = `
        ${media}
        <span class="link-preview-body">
            <span class="link-preview-meta">${icon}${metaLabel ? `<span>${escapeHtml(metaLabel)}</span><span class="link-preview-separator">-</span>` : ''}<span class="link-preview-url">${escapeHtml(displayUrl)}</span></span>
            ${title ? `<span class="link-preview-title">${escapeHtml(title)}</span>` : ''}
            ${description ? `<span class="link-preview-description">${escapeHtml(description)}</span>` : ''}
        </span>`;
    card.href = finalUrl || sourceUrl;
    return card;
}

async function attachPreview(anchor: HTMLAnchorElement): Promise<void> {
    const url = normalizeExternalUrl(anchor.href);
    if (!url || anchor.dataset['linkPreviewAttached'] === 'true') return;
    anchor.dataset['linkPreviewAttached'] = 'true';
    const data = await fetchPreview(url);
    if (!data || !anchor.isConnected) return;
    const card = renderPreview(data, url);
    if (!card) return;
    anchor.insertAdjacentElement('afterend', card);
}

function observeAnchor(anchor: HTMLAnchorElement): void {
    if (!('IntersectionObserver' in window)) {
        void attachPreview(anchor);
        return;
    }
    const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            // disconnect, not just unobserve — a per-anchor observer kept
            // alive pins its closure until the anchor is GC'd (260613 06).
            observer.disconnect();
            void attachPreview(anchor);
        }
    }, { rootMargin: '160px' });
    observer.observe(anchor);
}

export function hydrateLinkPreviewCards(root: ParentNode = document): void {
    const anchors: HTMLAnchorElement[] = [];
    if (root instanceof HTMLAnchorElement && shouldPreviewLink(root)) anchors.push(root);
    anchors.push(...Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')).filter(shouldPreviewLink));
    for (const anchor of anchors) observeAnchor(anchor);
}

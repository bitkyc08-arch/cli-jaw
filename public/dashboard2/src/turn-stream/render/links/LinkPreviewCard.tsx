import { useEffect, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { RenderIdentity } from '../parse-coalescer.ts';
import { invalidateHeights } from '../render-cache.ts';

interface PreviewMetadata { title?: string; description?: string; siteName?: string; domain?: string; finalUrl?: string; canonicalUrl?: string; image?: string; favicon?: string }
const MAX_CACHE = 200;
const cache = new Map<string, PreviewMetadata | null>();
function privateHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^(?:0|10|127)\./.test(host) || /^169\.254\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host) || /^192\.168\./.test(host) || host === '::' || host === '::1' || /^fe[89ab][0-9a-f]:/i.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host);
}
export function normalizePreviewUrl(raw: string): string {
    try {
        const url = new URL(raw, window.location.href);
        if (!['http:', 'https:'].includes(url.protocol) || url.origin === window.location.origin || url.username || url.password || privateHost(url.hostname)) return '';
        if (/\.(?:png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|zip|tar|gz|pdf)(?:$|\?)/i.test(url.pathname)) return '';
        return url.href;
    } catch { return ''; }
}
function imageUrl(url: string): string { return `/api/link-preview/image?url=${encodeURIComponent(url)}`; }
export function LinkPreviewCard({ data, sourceUrl, identity }: { data: PreviewMetadata; sourceUrl: string; identity: RenderIdentity }): ReactElement {
    const href = data.canonicalUrl || data.finalUrl || sourceUrl;
    const host = (() => { try { return new URL(href).hostname; } catch { return ''; } })();
    const invalidate = () => invalidateHeights({ scopeKey: identity.scopeKey, turnId: identity.turnId });
    return <a className="d2-link-preview" href={href} target="_blank" rel="noopener noreferrer">
        {data.image ? <img src={imageUrl(data.image)} alt="" loading="lazy" referrerPolicy="no-referrer" onLoad={invalidate} onError={invalidate} /> : null}
        <span><small>{data.siteName || data.domain || host}</small>{data.title ? <strong>{data.title}</strong> : null}{data.description ? <span>{data.description}</span> : null}</span>
    </a>;
}
export function LinkPreviewLayer({ enabled, host, revision, identity }: { enabled: boolean; host: HTMLElement | null; revision: string; identity: RenderIdentity }): ReactElement | null {
    const [cards, setCards] = useState<Array<{ anchor: HTMLAnchorElement; url: string; data: PreviewMetadata }>>([]);
    useEffect(() => {
        if (!enabled || !host) return;
        const controllers = new Set<AbortController>();
        const anchors = Array.from(host.querySelectorAll<HTMLAnchorElement>('a[href]')).map(anchor => ({ anchor, url: normalizePreviewUrl(anchor.href) })).filter(item => item.url && !item.anchor.closest('.search-results-block,.code-block'));
        const load = async ({ anchor, url }: { anchor: HTMLAnchorElement; url: string }) => {
            const cached = cache.get(url); if (cached !== undefined) { if (cached) setCards(current => current.some(x => x.anchor === anchor) ? current : [...current, { anchor, url, data: cached }]); return; }
            const controller = new AbortController(); controllers.add(controller);
            try { const response = await fetch(`/api/link-preview?url=${encodeURIComponent(url)}`, { signal: controller.signal }); const json = response.ok && response.status !== 204 ? await response.json() as { ok?: boolean; data?: PreviewMetadata } : null; const data = json?.ok && json.data ? json.data : null; cache.set(url, data); while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!); if (data && anchor.isConnected) setCards(current => [...current, { anchor, url, data }]); } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) cache.set(url, null); } finally { controllers.delete(controller); }
        };
        const observer = new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); const found = anchors.find(item => item.anchor === entry.target); if (found) void load(found); } }, { root: host.closest('.d2-turn-scroll'), rootMargin: '160px' });
        anchors.forEach(item => observer.observe(item.anchor));
        return () => { observer.disconnect(); controllers.forEach(controller => controller.abort()); setCards([]); };
    }, [enabled, host, revision]);
    if (!enabled) return null;
    return <>{cards.map(({ anchor, url, data }) => anchor.isConnected ? <LinkPreviewPortal key={url} anchor={anchor} card={<LinkPreviewCard data={data} sourceUrl={url} identity={identity} />} /> : null)}</>;
}
function LinkPreviewPortal({ anchor, card }: { anchor: HTMLAnchorElement; card: ReactElement }): ReactElement | null {
    const [target] = useState(() => { const node = document.createElement('span'); node.className = 'd2-link-preview-host'; anchor.insertAdjacentElement('afterend', node); return node; });
    useEffect(() => () => target.remove(), [target]);
    return createPortal(card, target);
}

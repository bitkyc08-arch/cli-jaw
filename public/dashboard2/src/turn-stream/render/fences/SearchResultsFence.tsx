// @ts-nocheck -- normalized untrusted JSON is narrowed at runtime below.
import type { KeyboardEvent, ReactElement } from 'react';
import { useRenderActionPorts } from '../../../providers/render-action-ports.tsx';

export interface SearchResult { title: string; url: string; snippet: string; source: string }
export interface SearchResultsSpec { schemaVersion: 'search-results-v1'; query: string; results: SearchResult[] }

function text(value: unknown, max: number): string {
    const out = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
    return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

export function isSafeExternalUrl(value: unknown): value is string {
    if (typeof value !== 'string' || !value.trim()) return false;
    try {
        const url = new URL(value.trim());
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return false;
        const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
        if (/^(0|10|127)\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^192\.168\./.test(host)) return false;
        if (host === '::' || host === '::1' || /^fe[89ab][0-9a-f]:/i.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host)) return false;
        return true;
    } catch { return false; }
}

export function normalizeSearchResultsSpec(raw: unknown): SearchResultsSpec | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (obj.schemaVersion !== 'search-results-v1') return null;
    const results: SearchResult[] = []; const seen = new Set<string>();
    for (const item of Array.isArray(obj.results) ? obj.results : []) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>; const candidate = row.url || row.link;
        if (!isSafeExternalUrl(candidate)) continue;
        const url = new URL(candidate.trim()).href;
        if (seen.has(url)) continue; seen.add(url);
        results.push({ title: text(row.title, 160) || new URL(url).hostname, url, snippet: text(row.snippet || row.description, 240), source: text(row.source, 80) || new URL(url).hostname });
        if (results.length === 10) break;
    }
    const query = text(obj.query, 160);
    return !query && results.length === 0 ? null : { schemaVersion: 'search-results-v1', query, results };
}

export function SearchResultsFence({ spec }: { spec: SearchResultsSpec }): ReactElement {
    const { openExternal } = useRenderActionPorts();
    const activate = (url: string) => openExternal(url);
    const key = (event: KeyboardEvent<HTMLAnchorElement>, url: string) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(url); } };
    return <section className="search-results-block" aria-label="Search results"><header>{spec.query || 'Search Results'}</header>{spec.results.map((result, index) => <a key={result.url} href={result.url} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); activate(result.url); }} onKeyDown={event => key(event, result.url)}><span>{index + 1}</span><strong>{result.title}</strong>{result.snippet && <span>{result.snippet}</span>}<small>{result.source}</small></a>)}</section>;
}

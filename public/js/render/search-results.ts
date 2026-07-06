import { escapeHtml } from './html.js';

type RawSearchResult = {
    title?: unknown;
    url?: unknown;
    link?: unknown;
    snippet?: unknown;
    description?: unknown;
    source?: unknown;
};

type SearchResult = {
    title: string;
    url: string;
    snippet: string;
    source: string;
};

type SearchResultsSpec = {
    schemaVersion: 'search-results-v1';
    query: string;
    results: SearchResult[];
};

const PENDING_SELECTOR = '.search-results-pending';
const MAX_RESULTS = 10;
const MAX_TEXT = 240;

function escapeAttr(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clampText(value: unknown, max = MAX_TEXT): string {
    const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isUnsafeHostname(hostname: string): boolean {
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

function normalizeUrl(value: unknown): string {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return '';
    try {
        const parsed = new URL(text);
        if (!['http:', 'https:'].includes(parsed.protocol)) return '';
        if (parsed.username || parsed.password) return '';
        if (isUnsafeHostname(parsed.hostname)) return '';
        return parsed.href;
    } catch {
        return '';
    }
}

function parseSpec(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export function normalizeSearchResultsSpec(raw: unknown): SearchResultsSpec | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (obj['schemaVersion'] !== 'search-results-v1') return null;
    const query = clampText(obj['query'], 160);
    const rawResults = Array.isArray(obj['results']) ? obj['results'] : [];
    const seen = new Set<string>();
    const results: SearchResult[] = [];
    for (const item of rawResults) {
        if (!item || typeof item !== 'object') continue;
        const result = item as RawSearchResult;
        const url = normalizeUrl(result.url || result.link);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const title = clampText(result.title, 160) || new URL(url).hostname;
        results.push({
            title,
            url,
            snippet: clampText(result.snippet || result.description),
            source: clampText(result.source, 80) || new URL(url).hostname,
        });
        if (results.length >= MAX_RESULTS) break;
    }
    if (!query && results.length === 0) return null;
    return { schemaVersion: 'search-results-v1', query, results };
}

export function renderSearchResultsPlaceholder(raw: string): string {
    const encoded = encodeURIComponent(raw);
    return `<div class="search-results-pending" data-search-results-kind="search-results" data-search-results-spec="${escapeAttr(encoded)}" role="status" aria-label="Search results loading">
        <div class="search-results-loading">검색 결과를 준비하는 중...</div>
    </div>`;
}

function getAllPendingBlocks(root: ParentNode): HTMLElement[] {
    const blocks: HTMLElement[] = [];
    if (root instanceof HTMLElement && root.matches(PENDING_SELECTOR)) blocks.push(root);
    blocks.push(...Array.from(root.querySelectorAll<HTMLElement>(PENDING_SELECTOR)));
    return blocks;
}

function renderResults(spec: SearchResultsSpec): string {
    const empty = spec.results.length === 0
        ? '<div class="search-results-empty">표시할 검색 결과가 없습니다.</div>'
        : '';
    const rows = spec.results.map((result, index) => `
        <a class="search-result-card" href="${escapeAttr(result.url)}" target="_blank" rel="noopener noreferrer">
            <span class="search-result-index">${index + 1}</span>
            <span class="search-result-body">
                <span class="search-result-title">${escapeHtml(result.title)}</span>
                ${result.snippet ? `<span class="search-result-snippet">${escapeHtml(result.snippet)}</span>` : ''}
                <span class="search-result-source">${escapeHtml(result.source)}</span>
            </span>
        </a>`).join('');
    return `
        <div class="search-results-header">
            <div class="search-results-title">Search Results</div>
            ${spec.query ? `<div class="search-results-query">${escapeHtml(spec.query)}</div>` : ''}
        </div>
        <div class="search-results-list">${rows}${empty}</div>`;
}

export function hydrateSearchResultsBlocks(root: ParentNode = document): void {
    for (const block of getAllPendingBlocks(root)) {
        if (block.dataset['searchResultsHydrated'] === 'true') continue;
        block.dataset['searchResultsHydrated'] = 'true';
        const encoded = block.dataset['searchResultsSpec'] || '';
        let decoded = '';
        try {
            decoded = decodeURIComponent(encoded);
        } catch {
            decoded = '';
        }
        delete block.dataset['searchResultsSpec'];
        const spec = normalizeSearchResultsSpec(parseSpec(decoded));
        if (!spec) {
            console.warn('[search-results] invalid search result spec', { decodedChars: decoded.length });
            block.className = 'search-results-block search-results-error';
            block.innerHTML = '<div class="search-results-error-text">검색 결과 형식을 읽을 수 없습니다.</div>';
            continue;
        }
        block.className = 'search-results-block';
        block.innerHTML = renderResults(spec);
    }
}

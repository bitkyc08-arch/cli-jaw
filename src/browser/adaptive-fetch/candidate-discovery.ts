import { validateFetchUrl } from './safety.js';

export type CandidateDiscoveryLane = 'official' | 'community' | 'realtime' | 'academic' | 'package' | 'archive' | 'fetch';

export interface CandidateDiscoveryInput {
    url: string;
    title?: string;
    snippet?: string;
    source?: string;
    lane?: CandidateDiscoveryLane;
}

export interface RankedDiscoveryCandidate extends Required<CandidateDiscoveryInput> {
    normalizedUrl: string;
    hostname: string;
    score: number;
    reasons: string[];
}

export interface CandidateDiscoveryOptions {
    officialDomains?: string[];
    maxCandidates?: number;
}

export interface CandidateDiscoveryResult {
    candidates: RankedDiscoveryCandidate[];
    lanes: Record<CandidateDiscoveryLane, RankedDiscoveryCandidate[]>;
    rejected: { url: string; reason: string }[];
}

const LANE_ORDER: CandidateDiscoveryLane[] = ['official', 'package', 'academic', 'community', 'realtime', 'archive', 'fetch'];
const LANE_BASE_SCORE: Record<CandidateDiscoveryLane, number> = {
    official: 80,
    package: 72,
    academic: 70,
    community: 58,
    realtime: 54,
    archive: 45,
    fetch: 40,
};

export function extractCandidateUrlsFromText(text: string): string[] {
    const urls = [...text.matchAll(/\bhttps?:\/\/[^\s<>"')\]]+/gi)]
        .map(match => match[0].replace(/[.,;:!?]+$/g, ''));
    return [...new Set(urls)];
}

export function rankDiscoveredCandidates(
    inputs: CandidateDiscoveryInput[],
    options: CandidateDiscoveryOptions = {},
): CandidateDiscoveryResult {
    const rejected: { url: string; reason: string }[] = [];
    const byUrl = new Map<string, RankedDiscoveryCandidate>();
    for (const input of inputs) {
        const parsed = parsePublicUrl(input.url, rejected);
        if (!parsed) continue;
        const normalizedUrl = normalizeCandidateUrl(parsed);
        const lane = input.lane || classifyCandidateLane(parsed, input, options);
        const reasons = scoreReasons(parsed, lane, input, options);
        const candidate: RankedDiscoveryCandidate = {
            url: parsed.href,
            normalizedUrl,
            hostname: parsed.hostname,
            title: input.title || '',
            snippet: input.snippet || '',
            source: input.source || 'native_search',
            lane,
            score: LANE_BASE_SCORE[lane] + reasons.length * 3 + (parsed.protocol === 'https:' ? 2 : 0),
            reasons,
        };
        const existing = byUrl.get(normalizedUrl);
        if (!existing || candidate.score > existing.score) byUrl.set(normalizedUrl, candidate);
    }

    const candidates = [...byUrl.values()]
        .sort((a, b) => b.score - a.score || LANE_ORDER.indexOf(a.lane) - LANE_ORDER.indexOf(b.lane))
        .slice(0, options.maxCandidates || 12);
    return { candidates, lanes: groupByLane(candidates), rejected };
}

function parsePublicUrl(url: string, rejected: { url: string; reason: string }[]): URL | null {
    try {
        return validateFetchUrl(url, { allowPrivateNetwork: false });
    } catch (error: unknown) {
        rejected.push({ url, reason: (error as Error).message || 'invalid-url' });
        return null;
    }
}

function classifyCandidateLane(url: URL, input: CandidateDiscoveryInput, options: CandidateDiscoveryOptions): CandidateDiscoveryLane {
    const host = url.hostname.replace(/^www\./, '');
    const haystack = `${input.title || ''}\n${input.snippet || ''}\n${host}`.toLowerCase();
    if ((options.officialDomains || []).some(domain => domainMatch(host, domain))) return 'official';
    if (/^(docs?|developer|dev|api)\./i.test(host) || /\bofficial\b|\bdocs?\b|\bapi reference\b/.test(haystack)) return 'official';
    if (/github\.com|npmjs\.com|pypi\.org|crates\.io|pkg\.go\.dev|packagist\.org|rubygems\.org$/i.test(host)) return 'package';
    if (/arxiv\.org|doi\.org|crossref\.org|pubmed\.ncbi\.nlm\.nih\.gov|semanticscholar\.org|scholar\.google\./i.test(host)) return 'academic';
    if (/reddit\.com|stackoverflow\.com|stackexchange\.com|news\.ycombinator\.com|lobste\.rs|dev\.to|v2ex\.com/i.test(host)) return 'community';
    if (/x\.com|twitter\.com|bsky\.app|mastodon\.social|threads\.net/i.test(host)) return 'realtime';
    if (/webcache|archive\.org|web\.archive\.org/i.test(host)) return 'archive';
    return 'fetch';
}

function scoreReasons(url: URL, lane: CandidateDiscoveryLane, input: CandidateDiscoveryInput, options: CandidateDiscoveryOptions): string[] {
    const reasons: string[] = [lane];
    const host = url.hostname.replace(/^www\./, '');
    if ((options.officialDomains || []).some(domain => domainMatch(host, domain))) reasons.push('official-domain-match');
    if (input.title) reasons.push('title-present');
    if (input.snippet) reasons.push('snippet-present');
    if (!hasTrackingParams(url)) reasons.push('clean-url');
    if (url.pathname && url.pathname !== '/') reasons.push('deep-link');
    return reasons;
}

function normalizeCandidateUrl(url: URL): string {
    const copy = new URL(url.href);
    copy.hash = '';
    for (const key of [...copy.searchParams.keys()]) {
        if (/^(utm_|fbclid|gclid|mc_cid|mc_eid)/i.test(key)) copy.searchParams.delete(key);
    }
    copy.hostname = copy.hostname.replace(/^www\./, '');
    return copy.href.replace(/\/$/, '');
}

function hasTrackingParams(url: URL): boolean {
    return [...url.searchParams.keys()].some(key => /^(utm_|fbclid|gclid|mc_cid|mc_eid)/i.test(key));
}

function groupByLane(candidates: RankedDiscoveryCandidate[]): Record<CandidateDiscoveryLane, RankedDiscoveryCandidate[]> {
    const lanes = LANE_ORDER.reduce((acc, lane) => {
        acc[lane] = [];
        return acc;
    }, {} as Record<CandidateDiscoveryLane, RankedDiscoveryCandidate[]>);
    for (const candidate of candidates) lanes[candidate.lane].push(candidate);
    return lanes;
}

function domainMatch(host: string, domain: string): boolean {
    const clean = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] || domain;
    return host === clean || host.endsWith(`.${clean}`);
}

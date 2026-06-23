// Mirrored from agbrowse adaptive-fetch v2; keep runtime behavior aligned while cli-jaw mirror remains experimental.

import type { CandidateUrl } from './types.js';

export function resolvePublicEndpointCandidates(rawUrl: string | URL): CandidateUrl[] {
    const url = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl));
    return [
        ...githubCandidates(url),
        ...redditCandidates(url),
        ...hackerNewsCandidates(url),
        ...wikipediaCandidates(url),
        ...registryCandidates(url),
        ...arxivCandidates(url),
        ...blueskyCandidates(url),
        ...mastodonCandidates(url),
        ...stackExchangeCandidates(url),
        ...devToCandidates(url),
        ...crossRefCandidates(url),
        ...openLibraryCandidates(url),
        ...waybackCandidates(url),
        ...youtubeCandidates(url),
        ...xTwitterCandidates(url),
        ...v2exCandidates(url),
        ...lobstersCandidates(url),
        ...naverBlogCandidates(url),
        ...naverNewsCandidates(url),
        ...naverFinanceCandidates(url),
        ...mediumCandidates(url),
        ...substackCandidates(url),
        ...linkedinCandidates(url),
    ];
}

function githubCandidates(url: URL): CandidateUrl[] {
    if (url.hostname !== 'github.com') return [];
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 5 && parts[2] === 'blob') {
        const [owner, repo, , branch, ...pathParts] = parts;
        return [{
            label: 'github-raw',
            url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${pathParts.join('/')}`,
            source: 'public_endpoint',
        }];
    }
    if (parts.length >= 2) {
        return [{
            label: 'github-repo-api',
            url: `https://api.github.com/repos/${parts[0]}/${parts[1]}`,
            source: 'public_endpoint',
        }];
    }
    return [];
}

function redditCandidates(url: URL): CandidateUrl[] {
    if (!/(^|\.)reddit\.com$/i.test(url.hostname)) return [];
    if (url.pathname.endsWith('.json')) return [];
    const clone = new URL(url.href);
    clone.pathname = clone.pathname.replace(/\/?$/, '.json');
    return [{ label: 'reddit-json', url: clone.href, source: 'public_endpoint' }];
}

function hackerNewsCandidates(url: URL): CandidateUrl[] {
    if (url.hostname !== 'news.ycombinator.com') return [];
    const id = url.searchParams.get('id');
    if (!id || !/^\d+$/.test(id)) return [];
    return [
        {
            label: 'hacker-news-item-api',
            url: `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
            source: 'public_endpoint',
        },
        {
            label: 'hacker-news-algolia-item-api',
            url: `https://hn.algolia.com/api/v1/items/${id}`,
            source: 'public_endpoint',
        },
    ];
}

function wikipediaCandidates(url: URL): CandidateUrl[] {
    const match = url.hostname.match(/^([a-z-]+)\.wikipedia\.org$/i);
    if (!match) return [];
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'wiki' || !parts[1]) return [];
    return [{
        label: 'wikipedia-summary-api',
        url: `https://${match[1]}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(parts.slice(1).join('/'))}`,
        source: 'public_endpoint',
    }];
}

function registryCandidates(url: URL): CandidateUrl[] {
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.hostname === 'www.npmjs.com' && parts[0] === 'package' && parts[1]) {
        const decodedParts = decodeURIComponent(parts.slice(1).join('/')).split('/').filter(Boolean);
        const packageName = decodedParts[0]?.startsWith('@') && decodedParts[1]
            ? `${decodedParts[0]}/${decodedParts[1]}`
            : decodedParts[0];
        if (!packageName) return [];
        const version = packageName.startsWith('@') && decodedParts[2] === 'v'
            ? decodedParts[3]
            : (!packageName.startsWith('@') && decodedParts[1] === 'v' ? decodedParts[2] : '');
        const encodedPackageName = encodeURIComponent(packageName);
        const candidates: CandidateUrl[] = [];
        if (version) {
            candidates.push({
                label: 'npm-registry-version',
                url: `https://registry.npmjs.org/${encodedPackageName}/${encodeURIComponent(version)}`,
                source: 'public_endpoint',
            });
        }
        candidates.push({
            label: 'npm-registry-latest',
            url: `https://registry.npmjs.org/${encodedPackageName}/latest`,
            source: 'public_endpoint',
        });
        candidates.push({
            label: 'npm-registry',
            url: `https://registry.npmjs.org/${encodedPackageName}`,
            source: 'public_endpoint',
        });
        return candidates;
    }
    if (url.hostname === 'pypi.org' && parts[0] === 'project' && parts[1]) {
        return [{ label: 'pypi-json', url: `https://pypi.org/pypi/${encodeURIComponent(decodeURIComponent(parts[1]))}/json`, source: 'public_endpoint' }];
    }
    return [];
}

function arxivCandidates(url: URL): CandidateUrl[] {
    if (url.hostname !== 'arxiv.org') return [];
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'abs' || !parts[1]) return [];
    return [{ label: 'arxiv-api', url: `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(parts[1])}`, source: 'public_endpoint' }];
}

function blueskyCandidates(url: URL): CandidateUrl[] {
    if (url.hostname !== 'bsky.app') return [];
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'profile' || !parts[1]) return [];
    const actor = decodeURIComponent(parts[1]);
    if (parts[2] === 'post' && parts[3]) {
        const uri = `at://${actor}/app.bsky.feed.post/${decodeURIComponent(parts[3])}`;
        return [{
            label: 'bluesky-post-thread',
            url: `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}`,
            source: 'public_endpoint',
        }];
    }
    return [{
        label: 'bluesky-profile',
        url: `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`,
        source: 'public_endpoint',
    }];
}

function mastodonCandidates(url: URL): CandidateUrl[] {
    const parts = url.pathname.split('/').filter(Boolean);
    const statusMatch = parts.length >= 2 && parts[0]!.startsWith('@') && /^\d+$/.test(parts[1]!);
    if (statusMatch) {
        return [{
            label: 'mastodon-status-api',
            url: `https://${url.hostname}/api/v1/statuses/${parts[1]}`,
            source: 'public_endpoint',
        }];
    }
    if (parts.length === 1 && parts[0]!.startsWith('@') && parts[0]!.length > 1) {
        return [{
            label: 'mastodon-account-lookup',
            url: `https://${url.hostname}/api/v1/accounts/lookup?acct=${encodeURIComponent(parts[0]!.slice(1))}`,
            source: 'public_endpoint',
        }];
    }
    return [];
}

function stackExchangeCandidates(url: URL): CandidateUrl[] {
    const site = stackExchangeSite(url.hostname);
    if (!site) return [];
    const match = url.pathname.match(/\/questions\/(\d+)(?:\/|$)/);
    if (!match) return [];
    return [{
        label: 'stackexchange-question-api',
        url: `https://api.stackexchange.com/2.3/questions/${match[1]}?site=${encodeURIComponent(site)}&filter=withbody`,
        source: 'public_endpoint',
    }];
}

function stackExchangeSite(hostname: string): string {
    if (hostname === 'stackoverflow.com' || hostname === 'www.stackoverflow.com') return 'stackoverflow';
    if (hostname === 'superuser.com' || hostname === 'www.superuser.com') return 'superuser';
    if (hostname === 'serverfault.com' || hostname === 'www.serverfault.com') return 'serverfault';
    if (hostname === 'askubuntu.com' || hostname === 'www.askubuntu.com') return 'askubuntu';
    const match = hostname.match(/^([a-z0-9-]+)\.stackexchange\.com$/i);
    return match ? match[1]! : '';
}

function devToCandidates(url: URL): CandidateUrl[] {
    if (!['dev.to', 'www.dev.to'].includes(url.hostname)) return [];
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || parts[0] === 't') return [];
    return [{
        label: 'devto-article-api',
        url: `https://dev.to/api/articles/${encodeURIComponent(parts[0]!)}/${encodeURIComponent(parts[1]!)}`,
        source: 'public_endpoint',
    }];
}

function crossRefCandidates(url: URL): CandidateUrl[] {
    const doi = doiFromUrl(url);
    if (!doi) return [];
    return [{
        label: 'crossref-work-api',
        url: `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
        source: 'public_endpoint',
    }];
}

function doiFromUrl(url: URL): string {
    if (!['doi.org', 'www.doi.org', 'dx.doi.org'].includes(url.hostname)) return '';
    const doi = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    return /^10\.\d{4,9}\//i.test(doi) ? doi : '';
}

function openLibraryCandidates(url: URL): CandidateUrl[] {
    if (url.hostname !== 'openlibrary.org') return [];
    const parts = url.pathname.split('/').filter(Boolean);
    if ((parts[0] === 'works' || parts[0] === 'books') && parts[1]) {
        return [{
            label: `openlibrary-${parts[0]}-json`,
            url: `https://openlibrary.org/${parts[0]}/${encodeURIComponent(parts[1])}.json`,
            source: 'public_endpoint',
        }];
    }
    return [];
}

function waybackCandidates(url: URL): CandidateUrl[] {
    if (url.hostname !== 'web.archive.org') return [];
    const hrefWithoutFragment = url.href.slice(0, url.href.length - (url.hash || '').length);
    const match = hrefWithoutFragment.match(/^https?:\/\/web\.archive\.org\/web\/[^/]+\/(.+)$/i);
    if (!match) return [];
    let archivedUrl = match[1]!;
    if (!/^https?:\/\//i.test(archivedUrl)) archivedUrl = decodeURIComponent(archivedUrl);
    if (!/^https?:\/\//i.test(archivedUrl)) return [];
    return [{
        label: 'wayback-cdx-api',
        url: `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(archivedUrl)}&output=json&fl=timestamp,original,statuscode,mimetype,digest&filter=statuscode:200&limit=5`,
        source: 'public_endpoint',
    }];
}

function youtubeCandidates(url: URL): CandidateUrl[] {
    const videoUrl = youtubeVideoUrl(url);
    if (!videoUrl) return [];
    return [{
        label: 'youtube-oembed',
        url: `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`,
        source: 'public_endpoint',
    }];
}

function youtubeVideoUrl(url: URL): string {
    if (url.hostname === 'youtu.be') {
        const id = url.pathname.split('/').filter(Boolean)[0];
        return id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : '';
    }
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return '';
    const id = url.searchParams.get('v');
    return id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : '';
}

function xTwitterCandidates(url: URL): CandidateUrl[] {
    const hostname = url.hostname.replace(/^www\./, '');
    if (!['x.com', 'twitter.com'].includes(hostname)) return [];
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 3 || parts[1] !== 'status' || !/^\d+$/.test(parts[2]!)) return [];
    return [{
        label: 'x-twitter-oembed',
        url: `https://publish.twitter.com/oembed?url=${encodeURIComponent(url.href)}`,
        source: 'public_endpoint',
    }];
}

function v2exCandidates(url: URL): CandidateUrl[] {
    if (!['v2ex.com', 'www.v2ex.com'].includes(url.hostname)) return [];
    const match = url.pathname.match(/^\/t\/(\d+)/);
    if (!match) return [];
    return [{
        label: 'v2ex-topic-api',
        url: `https://www.v2ex.com/api/topics/show.json?id=${match[1]}`,
        source: 'public_endpoint',
    }];
}

function lobstersCandidates(url: URL): CandidateUrl[] {
    if (!['lobste.rs', 'www.lobste.rs'].includes(url.hostname)) return [];
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 's' || !parts[1]) return [];
    const clone = new URL(url.href);
    clone.hostname = 'lobste.rs';
    clone.pathname = `/${parts.join('/')}.json`;
    clone.search = '';
    clone.hash = '';
    return [{
        label: 'lobsters-story-json',
        url: clone.href,
        source: 'public_endpoint',
    }];
}

function naverBlogCandidates(url: URL): CandidateUrl[] {
    if (!/(^|\.)blog\.naver\.com$/i.test(url.hostname)) return [];
    const mobile = new URL(url.href);
    mobile.hostname = 'm.blog.naver.com';
    return [{ label: 'naver-blog-mobile', url: mobile.href, source: 'public_endpoint' }];
}

function naverNewsCandidates(url: URL): CandidateUrl[] {
    if (!/(^|\.)news\.naver\.com$/i.test(url.hostname)
        && url.hostname !== 'n.news.naver.com') return [];
    const mobile = new URL(url.href);
    mobile.hostname = 'n.news.naver.com';
    return [{ label: 'naver-news-mobile', url: mobile.href, source: 'public_endpoint' }];
}

function naverFinanceCandidates(url: URL): CandidateUrl[] {
    if (url.hostname !== 'finance.naver.com') return [];
    const code = url.searchParams.get('code');
    if (!code || !/^[A-Z0-9]{4,12}$/i.test(code)) return [];
    return [{
        label: 'naver-finance-json',
        url: `https://api.finance.naver.com/siseJson.naver?symbol=${encodeURIComponent(code)}&requestType=1&startTime=20240101&endTime=20261231&timeframe=day`,
        source: 'public_endpoint',
    }];
}

function mediumCandidates(url: URL): CandidateUrl[] {
    if (!/(^|\.)medium\.com$/i.test(url.hostname)) return [];
    return [{
        label: 'medium-oembed',
        url: `https://medium.com/oembed?url=${encodeURIComponent(url.href)}`,
        source: 'public_endpoint',
    }];
}

function substackCandidates(url: URL): CandidateUrl[] {
    if (!/(^|\.)substack\.com$/i.test(url.hostname)) return [];
    return [{
        label: 'substack-oembed',
        url: `https://substack.com/oembed?url=${encodeURIComponent(url.href)}`,
        source: 'public_endpoint',
    }];
}

function linkedinCandidates(url: URL): CandidateUrl[] {
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return [];
    if (!url.pathname.startsWith('/posts/') && !url.pathname.startsWith('/pulse/')) return [];
    return [{
        label: 'linkedin-oembed',
        url: `https://www.linkedin.com/oembed?url=${encodeURIComponent(url.href)}&format=json`,
        source: 'public_endpoint',
    }];
}

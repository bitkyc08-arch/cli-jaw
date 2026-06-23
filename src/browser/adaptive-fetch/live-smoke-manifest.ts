export interface LiveSmokeManifestEntry {
    id: string;
    url: string;
    expectedLabels: string[];
    expectedEvidence: string[];
    browserMode: 'auto' | 'never' | 'required';
    reason: string;
}

export const LIVE_SMOKE_MANIFEST_VERSION = 1;

export const LIVE_SMOKE_MANIFEST: LiveSmokeManifestEntry[] = [
    {
        id: 'npm-public-endpoint',
        url: 'https://www.npmjs.com/package/cli-jaw',
        expectedLabels: ['npm-registry', 'direct-fetch'],
        expectedEvidence: ['public-endpoint:npm-registry'],
        browserMode: 'auto',
        reason: 'package registry public endpoint drift check',
    },
    {
        id: 'github-public-endpoint',
        url: 'https://github.com/fivetaku/insane-search',
        expectedLabels: ['github-repo-api', 'direct-fetch'],
        expectedEvidence: ['public-endpoint:github-repo-api'],
        browserMode: 'auto',
        reason: 'GitHub repo API reader drift check',
    },
    {
        id: 'hacker-news-public-api',
        url: 'https://news.ycombinator.com/item?id=8863',
        expectedLabels: ['hacker-news-item-api', 'hacker-news-algolia-item-api', 'direct-fetch'],
        expectedEvidence: ['public-endpoint:hacker-news-item-api'],
        browserMode: 'auto',
        reason: 'community public API and fallback reader drift check',
    },
    {
        id: 'metadata-browser-ladder',
        url: 'https://example.com/',
        expectedLabels: ['browser-render', 'browser-metadata'],
        expectedEvidence: ['browser-render', 'browser-dom-metadata'],
        browserMode: 'required',
        reason: 'rendered DOM metadata/browser ladder contract check',
    },
    {
        id: 'reddit-json-endpoint',
        url: 'https://www.reddit.com/r/programming/comments/1a2b3c/test/',
        expectedLabels: ['reddit-json', 'direct-fetch'],
        expectedEvidence: ['public-endpoint:reddit-json'],
        browserMode: 'auto',
        reason: 'Reddit .json public endpoint drift check',
    },
    {
        id: 'arxiv-public-api',
        url: 'https://arxiv.org/abs/2301.00001',
        expectedLabels: ['arxiv-oai-xml', 'direct-fetch'],
        expectedEvidence: ['public-endpoint:arxiv-oai-xml'],
        browserMode: 'auto',
        reason: 'arXiv OAI API reader drift check',
    },
    {
        id: 'stackoverflow-public-api',
        url: 'https://stackoverflow.com/questions/1',
        expectedLabels: ['stackexchange-api', 'direct-fetch'],
        expectedEvidence: ['public-endpoint:stackexchange-api'],
        browserMode: 'auto',
        reason: 'StackExchange API reader drift check',
    },
    {
        id: 'wikipedia-public-api',
        url: 'https://en.wikipedia.org/wiki/Node.js',
        expectedLabels: ['wikipedia-rest-api', 'direct-fetch'],
        expectedEvidence: ['public-endpoint:wikipedia-rest-api'],
        browserMode: 'auto',
        reason: 'Wikipedia REST API reader drift check',
    },
    {
        id: 'medium-oembed',
        url: 'https://medium.com/@user/test-post-abc123',
        expectedLabels: ['medium-oembed', 'direct-fetch'],
        expectedEvidence: ['public-endpoint:medium-oembed'],
        browserMode: 'auto',
        reason: 'Medium oembed public endpoint drift check',
    },
    {
        id: 'youtube-oembed',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        expectedLabels: ['youtube-oembed', 'youtube-ytdlp', 'direct-fetch'],
        expectedEvidence: ['public-endpoint:youtube-oembed'],
        browserMode: 'auto',
        reason: 'YouTube oembed + optional yt-dlp reader drift check',
    },
    {
        id: 'jina-reader-fallback',
        url: 'https://example.org/',
        expectedLabels: ['direct-fetch', 'jina-reader'],
        expectedEvidence: ['third-party-reader:jina'],
        browserMode: 'never',
        reason: 'Jina Reader r.jina.ai default-on fallback drift check',
    },
];

export function getLiveSmokeManifest(): LiveSmokeManifestEntry[] {
    return LIVE_SMOKE_MANIFEST.map(entry => ({
        ...entry,
        expectedLabels: [...entry.expectedLabels],
        expectedEvidence: [...entry.expectedEvidence],
    }));
}

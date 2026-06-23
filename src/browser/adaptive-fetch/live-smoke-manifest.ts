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
];

export function getLiveSmokeManifest(): LiveSmokeManifestEntry[] {
    return LIVE_SMOKE_MANIFEST.map(entry => ({
        ...entry,
        expectedLabels: [...entry.expectedLabels],
        expectedEvidence: [...entry.expectedEvidence],
    }));
}

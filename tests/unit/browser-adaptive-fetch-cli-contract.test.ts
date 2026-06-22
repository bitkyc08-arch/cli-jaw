import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliSrc = fs.readFileSync(join(root, 'bin/commands/browser.ts'), 'utf8');
const routesSrc = fs.readFileSync(join(root, 'src/routes/browser.ts'), 'utf8');
const indexSrc = fs.readFileSync(join(root, 'src/browser/index.ts'), 'utf8');

test('browser fetch CLI and API surfaces are wired', () => {
    assert.match(cliSrc, /case 'fetch'/);
    assert.match(cliSrc, /cli-jaw browser fetch <url>/);
    assert.match(routesSrc, /\/api\/browser\/fetch', requireAuth/);
    assert.match(indexSrc, /adaptiveFetch/);
});

test('browser fetch help keeps URL-reader and search boundary language', () => {
    assert.match(cliSrc, /Read one URL\/search-result URL/);
    assert.match(cliSrc, /Not generic search/);
    assert.match(cliSrc, /--allow-third-party-reader/);
    assert.match(cliSrc, /known public endpoints, direct fetch,\s+optional public reader services, and browser rendering/);
});

test('browser fetch public endpoint reader adapter is wired', () => {
    const adapterSrc = fs.readFileSync(join(root, 'src/browser/adaptive-fetch/reader-adapters.ts'), 'utf8');
    const normalizerSrc = fs.readFileSync(join(root, 'src/browser/adaptive-fetch/public-endpoint-normalizers.ts'), 'utf8');
    assert.match(adapterSrc, /normalizePublicEndpointResult/);
    assert.match(normalizerSrc, /github-repo-api/);
    assert.match(normalizerSrc, /npm-registry/);
    assert.match(normalizerSrc, /arxiv-api/);
    assert.match(normalizerSrc, /wayback-cdx-api/);
    assert.match(normalizerSrc, /youtube-oembed/);
});

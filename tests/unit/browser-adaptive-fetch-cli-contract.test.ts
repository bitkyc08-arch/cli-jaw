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

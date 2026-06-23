import test from 'node:test';
import assert from 'node:assert/strict';
import { runAdaptiveFetch } from '../../src/browser/adaptive-fetch/index.js';

test('adaptive fetch runtime selects normalized npm public endpoint fixture', async () => {
    const seen: string[] = [];
    const result = await runAdaptiveFetch({
        url: 'https://www.npmjs.com/package/cli-jaw',
        browserMode: 'never',
        trace: true,
    }, {
        fetch: async (input: URL | RequestInfo) => {
            const url = String(input);
            seen.push(url);
            if (url === 'https://registry.npmjs.org/cli-jaw/latest') {
                return jsonResponse({
                    name: 'cli-jaw',
                    version: '2.2.0',
                    description: 'Agent orchestration runtime',
                    license: 'MIT',
                    'dist-tags': { latest: '2.2.0' },
                });
            }
            throw new Error(`unexpected live fetch: ${url}`);
        },
    });

    assert.equal(result.ok, true);
    assert.equal(result.source, 'public_endpoint');
    assert.match(String(result.content), /Package: cli-jaw@2\.2\.0/);
    assert.match(String(result.summary), /npm-registry-latest selected/);
    assert.equal(seen.includes('https://registry.npmjs.org/cli-jaw/latest'), true);
    assert.equal((result.attempts as Array<{ url?: string }>).some(attempt => attempt.url === 'https://registry.npmjs.org/cli-jaw/latest'), true);
});

test('adaptive fetch runtime discovers RSS fixture and selects bounded feed evidence', async () => {
    const seen: string[] = [];
    const result = await runAdaptiveFetch({
        url: 'https://example.com/article',
        browserMode: 'never',
        publicEndpoints: true,
        trace: true,
    }, {
        fetch: async (input: URL | RequestInfo) => {
            const url = String(input);
            seen.push(url);
            if (url === 'https://example.com/article') {
                return htmlResponse(`
                    <html><head>
                      <title>Weak article</title>
                      <link rel="alternate" type="application/rss+xml" href="/feed.xml">
                    </head><body><p>short</p></body></html>
                `);
            }
            if (url === 'https://example.com/feed.xml') {
                return xmlResponse(`
                    <rss><channel>
                      <title>Runtime Feed</title>
                      <link>https://example.com</link>
                      <item><title>Runtime item one</title><pubDate>Tue, 23 Jun 2026 00:00:00 GMT</pubDate><link>https://example.com/one</link><description>${'Readable feed summary one '.repeat(8)}</description></item>
                      <item><title>Runtime item two</title><pubDate>Mon, 22 Jun 2026 00:00:00 GMT</pubDate><link>https://example.com/two</link><description>${'Readable feed summary two '.repeat(8)}</description></item>
                    </channel></rss>
                `);
            }
            throw new Error(`unexpected live fetch: ${url}`);
        },
    });

    assert.equal(result.ok, true);
    assert.equal(result.source, 'public_endpoint');
    assert.match(String(result.content), /Feed: Runtime Feed/);
    assert.match(String(result.content), /Item 1: Runtime item one/);
    assert.match(String(result.content), /Item 2: Runtime item two/);
    assert.equal(seen.includes('https://example.com/feed.xml'), true);
    assert.equal((result.attempts as Array<{ url?: string }>).some(attempt => attempt.url === 'https://example.com/feed.xml'), true);
});

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

function htmlResponse(body: string): Response {
    return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/html' },
    });
}

function xmlResponse(body: string): Response {
    return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
    });
}

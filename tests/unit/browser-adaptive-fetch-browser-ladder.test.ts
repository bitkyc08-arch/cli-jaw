import test from 'node:test';
import assert from 'node:assert/strict';
import {
    collectBrowserCandidate,
    collectBrowserMetadataCandidate,
    collectBrowserMetadataFromHtml,
    collectBrowserStructuredResultCandidates,
} from '../../src/browser/adaptive-fetch/browser-escalation.js';
import { runAdaptiveFetch } from '../../src/browser/adaptive-fetch/index.js';

test('browser metadata collector preserves rendered DOM metadata and JSON-LD as candidate evidence', () => {
    const candidate = collectBrowserMetadataFromHtml(`
        <html><head>
          <title>Fallback page</title>
          <meta name="description" content="Rendered description">
          <meta property="og:image" content="https://cdn.example.test/og.jpg">
          <script type="application/ld+json">{"@type":"Article","headline":"Structured headline"}</script>
        </head><body><article>Rendered body</article></body></html>
    `, { finalUrl: 'https://example.test/article', status: 200, ok: true });

    assert.ok(candidate);
    assert.equal(candidate?.['label'], 'browser-metadata');
    assert.deepEqual(candidate?.['evidence'], ['browser-dom-metadata', 'title', 'description', 'media-metadata', 'json-ld']);
    assert.match(String(candidate?.['text']), /Rendered body/);
    assert.deepEqual((candidate?.['metadata'] as Record<string, unknown>)['jsonLd'], [{ '@type': 'Article', headline: 'Structured headline' }]);
});

test('browser escalation returns metadata and structured table/list candidates', async () => {
    const page = fakePage();
    const result = await collectBrowserCandidate('https://example.test/page', {
        browserDeps: {
            createIsolatedPage: async () => ({ page, cleanup: async () => undefined, isolated: true }),
        },
    });

    assert.equal(result['label'], 'browser-render');
    assert.ok(collectBrowserMetadataCandidate(result));
    const structured = collectBrowserStructuredResultCandidates(result);
    assert.equal(structured.length, 2);
    assert.equal(structured[0]?.['label'], 'browser-table');
    assert.match(String(structured[0]?.['text']), /Name \| Value/);
    assert.equal(structured[1]?.['label'], 'browser-list');
    assert.match(String(structured[1]?.['text']), /- First item/);
});

test('adaptive fetch scores browser metadata and structured candidates when direct fetch is weak', async () => {
    const page = fakePage();
    const result = await runAdaptiveFetch({
        url: 'https://example.test/page',
        browser: 'required',
        json: true,
        trace: true,
    }, {
        createIsolatedPage: async () => ({ page, cleanup: async () => undefined, isolated: true }),
    });

    const attempts = result['attempts'] as Record<string, unknown>[];
    assert.ok(attempts.some(attempt => attempt['label'] === 'browser-metadata'));
    assert.ok(attempts.some(attempt => attempt['label'] === 'browser-table'));
    assert.ok(attempts.some(attempt => attempt['label'] === 'browser-list'));
});

function fakePage() {
    return {
        on: () => undefined,
        off: () => undefined,
        goto: async () => ({
            status: () => 200,
            ok: () => true,
            headers: () => ({ 'content-type': 'text/html' }),
        }),
        waitForTimeout: async () => undefined,
        url: () => 'https://example.test/page',
        title: async () => 'Fallback page',
        content: async () => `
            <html><head>
              <title>Fallback page</title>
              <meta name="description" content="Rendered description">
            </head><body>
              <main>
                <table><tr><th>Name</th><th>Value</th></tr><tr><td>Alpha</td><td>42</td></tr></table>
                <ul><li>First item</li><li>Second item</li></ul>
              </main>
            </body></html>
        `,
        evaluate: async (fn: unknown) => {
            const source = String(fn);
            if (source.includes('document.body?.innerText')) return 'Fallback page\nName Value\nAlpha 42\nFirst item\nSecond item';
            if (source.includes('querySelectorAll')) {
                return {
                    tables: [{ kind: 'table', index: 1, rows: [['Name', 'Value'], ['Alpha', '42']] }],
                    lists: [{ kind: 'list', index: 1, items: ['First item', 'Second item'] }],
                };
            }
            return false;
        },
    };
}

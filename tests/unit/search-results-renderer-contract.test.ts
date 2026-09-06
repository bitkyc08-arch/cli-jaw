import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

function read(path: string): string {
    return readFileSync(join(import.meta.dirname, '../..', path), 'utf8');
}

const markdownSrc = read('public/js/render/markdown.ts');
const sanitizeSrc = read('public/js/render/sanitize.ts');
const postRenderSrc = read('public/js/render/post-render.ts');

test.afterEach(() => {
    resetWebUiDom();
});

test('renderer maps search-results fences to sanitizer-safe placeholders', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');

    const spec = JSON.stringify({
        schemaVersion: 'search-results-v1',
        query: 'cli-jaw structured cards',
        results: [{ title: 'Result A', url: 'https://example.com/a', snippet: 'alpha' }],
    });
    const html = renderMarkdown(`\`\`\`search-results\n${spec}\n\`\`\``);

    assert.match(html, /class="search-results-pending"/);
    assert.match(html, /data-search-results-kind="search-results"/);
    assert.match(html, /data-search-results-spec="/);
    assert.doesNotMatch(html, /<pre><code/);
    assert.doesNotMatch(html, /"schemaVersion"/);
});

test('streaming render keeps search-results fence inert until final render', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const spec = JSON.stringify({
        schemaVersion: 'search-results-v1',
        results: [{ title: 'A', url: 'https://example.com/a' }],
    });

    const streamingHtml = renderMarkdown(`\`\`\`search-results\n${spec}\n\`\`\``, true);
    const finalHtml = renderMarkdown(`\`\`\`search-results\n${spec}\n\`\`\``);

    assert.doesNotMatch(streamingHtml, /class="search-results-pending"/);
    assert.match(streamingHtml, /<pre><code/);
    assert.match(finalHtml, /class="search-results-pending"/);
});

test('hydration renders safe search result cards and drops unsafe URLs', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateSearchResultsBlocks } = await import('../../public/js/render/search-results.ts');
    const wrapper = document.createElement('div');
    const spec = {
        schemaVersion: 'search-results-v1',
        query: 'security',
        results: [
            { title: 'Safe', url: 'https://example.com/safe', snippet: 'visible' },
            { title: 'Local', url: 'http://127.0.0.1/private', snippet: 'hidden' },
        ],
    };
    wrapper.innerHTML = renderMarkdown(`\`\`\`search-results\n${JSON.stringify(spec)}\n\`\`\``);
    document.body.appendChild(wrapper);

    hydrateSearchResultsBlocks(wrapper);

    assert.ok(wrapper.querySelector('.search-results-block'));
    assert.equal(wrapper.querySelectorAll('.search-result-card').length, 1);
    assert.match(wrapper.textContent || '', /Safe/);
    assert.doesNotMatch(wrapper.textContent || '', /Local/);
});

test('hydration fails malformed search-results JSON closed with safe local error', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateSearchResultsBlocks } = await import('../../public/js/render/search-results.ts');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMarkdown('```search-results\nnot-json\n```');
    document.body.appendChild(wrapper);

    hydrateSearchResultsBlocks(wrapper);

    assert.ok(wrapper.querySelector('.search-results-error'));
    assert.match(wrapper.textContent || '', /검색 결과 형식을 읽을 수 없습니다/);
    assert.doesNotMatch(wrapper.innerHTML, /not-json/);
});

test('hydration caps search results at ten and dedupes normalized URLs', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateSearchResultsBlocks } = await import('../../public/js/render/search-results.ts');
    const results = Array.from({ length: 14 }, (_value, index) => ({
        title: `Result ${index + 1}`,
        url: index === 1 ? 'https://example.com/item-1' : `https://example.com/item-${index + 1}`,
    }));
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMarkdown(`\`\`\`search-results\n${JSON.stringify({
        schemaVersion: 'search-results-v1',
        query: 'cap dedupe',
        results,
    })}\n\`\`\``);
    document.body.appendChild(wrapper);

    hydrateSearchResultsBlocks(wrapper);

    const cards = wrapper.querySelectorAll('.search-result-card');
    assert.equal(cards.length, 10);
    assert.match(wrapper.textContent || '', /Result 1/);
    assert.doesNotMatch(wrapper.textContent || '', /Result 2/);
    assert.doesNotMatch(wrapper.textContent || '', /Result 12/);
});

// Live/fresh-VS and lazy history hydration, scoped counts and recycling are exercised
// through real entrypoints in web-structured-hydration.test.ts.
test('search results parser, sanitizer and scheduled-finalization contracts remain', () => {
    assert.match(markdownSrc, /renderSearchResultsPlaceholder/);
    assert.match(sanitizeSrc, /'data-search-results-kind'/);
    assert.match(sanitizeSrc, /'data-search-results-spec'/);
    assert.match(sanitizeSrc, /'data-search-results-hydrated'/);
    assert.match(postRenderSrc, /hydrateSearchResultsBlocks\(msgContainer\)/);
});

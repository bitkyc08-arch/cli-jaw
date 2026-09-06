import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

function read(path: string): string {
    return readFileSync(join(import.meta.dirname, '../..', path), 'utf8');
}

const markdownSrc = read('public/js/render/markdown.ts');
const postRenderSrc = read('public/js/render/post-render.ts');
const structuredFenceSrc = read('src/shared/structured-fence.ts');

test.afterEach(() => {
    resetWebUiDom();
});

function chartSpec(type = 'bar') {
    return {
        schemaVersion: 'chart-json-v1',
        type,
        title: 'Revenue',
        description: 'Quarterly revenue',
        labels: ['Q1', 'Q2', 'Q3'],
        data: [10, 30, 20],
    };
}

test('chart-json final fence maps to placeholder and hides raw JSON', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const html = renderMarkdown(`\`\`\`chart-json\n${JSON.stringify(chartSpec())}\n\`\`\``);

    assert.match(html, /class="chart-json-pending"/);
    assert.match(html, /data-chart-json-spec="/);
    assert.doesNotMatch(html, /"schemaVersion"/);
});

test('chart-json streaming fence remains inert', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const markdown = `\`\`\`chart-json\n${JSON.stringify(chartSpec())}\n\`\`\``;

    assert.match(renderMarkdown(markdown, true), /<pre><code/);
    assert.match(renderMarkdown(markdown), /class="chart-json-pending"/);
});

test('chart-json hydration renders bar line and pie SVG cards', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateChartJsonBlocks } = await import('../../public/js/render/chart-json.ts');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = ['bar', 'line', 'pie'].map(type => renderMarkdown(`\`\`\`chart-json\n${JSON.stringify(chartSpec(type))}\n\`\`\``)).join('');
    document.body.appendChild(wrapper);

    hydrateChartJsonBlocks(wrapper);

    assert.equal(wrapper.querySelectorAll('.chart-json-block').length, 3);
    assert.equal(wrapper.querySelectorAll('svg.chart-json-svg').length, 3);
    assert.match(wrapper.textContent || '', /Revenue/);
});

test('chart-json malformed JSON fails closed', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateChartJsonBlocks } = await import('../../public/js/render/chart-json.ts');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMarkdown('```chart-json\nnot-json\n```');

    hydrateChartJsonBlocks(wrapper);

    assert.ok(wrapper.querySelector('.chart-json-error'));
    assert.doesNotMatch(wrapper.innerHTML, /not-json/);
});

// Live/fresh-VS and lazy history hydration, scoped counts and recycling are exercised
// through real entrypoints in web-structured-hydration.test.ts.
test('chart-json parser, scheduled finalization and structured-fence contracts remain', () => {
    assert.match(markdownSrc, /renderChartJsonPlaceholder/);
    assert.match(postRenderSrc, /hydrateChartJsonBlocks\(msgContainer\)/);
    assert.match(structuredFenceSrc, /'chart-json'/);
});


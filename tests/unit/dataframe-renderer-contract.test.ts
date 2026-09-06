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
const delegationsSrc = read('public/js/render/delegations.ts');
const structuredFenceSrc = read('src/shared/structured-fence.ts');

test.afterEach(() => {
    resetWebUiDom();
});

function dataframeSpec() {
    return {
        schemaVersion: 'dataframe-v1',
        title: 'Sales',
        columns: ['Month', 'Revenue'],
        types: ['string', 'number'],
        rows: [['Jan', 10], ['Feb', 30], ['Mar', 20], ['Apr', 40], ['May', 50], ['Jun', 60]],
        pageSize: 5,
    };
}

test('dataframe final fence maps to placeholder and hides raw JSON', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const html = renderMarkdown(`\`\`\`dataframe\n${JSON.stringify(dataframeSpec())}\n\`\`\``);

    assert.match(html, /class="dataframe-pending"/);
    assert.match(html, /data-dataframe-spec="/);
    assert.doesNotMatch(html, /"schemaVersion"/);
});

test('dataframe streaming fence remains inert', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const markdown = `\`\`\`dataframe\n${JSON.stringify(dataframeSpec())}\n\`\`\``;

    assert.match(renderMarkdown(markdown, true), /<pre><code/);
    assert.match(renderMarkdown(markdown), /class="dataframe-pending"/);
});

test('dataframe hydration renders table and supports filter sort pagination copy', async () => {
    setupWebUiDom();
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { copied = text; } },
    });
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateDataframeBlocks } = await import('../../public/js/render/dataframe.ts');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMarkdown(`\`\`\`dataframe\n${JSON.stringify(dataframeSpec())}\n\`\`\``);
    document.body.appendChild(wrapper);

    hydrateDataframeBlocks(wrapper);

    assert.equal(wrapper.querySelectorAll('tbody tr').length, 5);
    wrapper.querySelector<HTMLInputElement>('.dataframe-filter')!.value = 'Mar';
    wrapper.querySelector<HTMLInputElement>('.dataframe-filter')!.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.match(wrapper.textContent || '', /Mar/);
    assert.doesNotMatch(wrapper.textContent || '', /Jan/);
    wrapper.querySelector<HTMLInputElement>('.dataframe-filter')!.value = '';
    wrapper.querySelector<HTMLInputElement>('.dataframe-filter')!.dispatchEvent(new window.Event('input', { bubbles: true }));
    wrapper.querySelector<HTMLButtonElement>('[data-column-index="1"]')?.click();
    assert.match(wrapper.querySelector('tbody tr')?.textContent || '', /Jan/);
    wrapper.querySelector<HTMLButtonElement>('[data-dataframe-action="next"]')?.click();
    assert.match(wrapper.textContent || '', /Jun/);
    wrapper.querySelector<HTMLButtonElement>('.dataframe-cell')?.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(copied.length > 0);
});

test('dataframe restores table state after virtual-scroll HTML remount', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateDataframeBlocks } = await import('../../public/js/render/dataframe.ts');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMarkdown(`\`\`\`dataframe\n${JSON.stringify(dataframeSpec())}\n\`\`\``);
    document.body.appendChild(wrapper);
    hydrateDataframeBlocks(wrapper);

    const serialized = wrapper.innerHTML;
    wrapper.innerHTML = serialized;
    hydrateDataframeBlocks(wrapper);

    wrapper.querySelector<HTMLInputElement>('.dataframe-filter')!.value = 'Jun';
    wrapper.querySelector<HTMLInputElement>('.dataframe-filter')!.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.match(wrapper.textContent || '', /Jun/);
    assert.doesNotMatch(wrapper.textContent || '', /Jan/);
    wrapper.querySelector<HTMLInputElement>('.dataframe-filter')!.value = '';
    wrapper.querySelector<HTMLInputElement>('.dataframe-filter')!.dispatchEvent(new window.Event('input', { bubbles: true }));
    wrapper.querySelector<HTMLButtonElement>('[data-column-index="1"]')?.click();
    assert.match(wrapper.querySelector('tbody tr')?.textContent || '', /Jan/);
});

test('dataframe malformed JSON fails closed', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateDataframeBlocks } = await import('../../public/js/render/dataframe.ts');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMarkdown('```dataframe\nnot-json\n```');

    hydrateDataframeBlocks(wrapper);

    assert.ok(wrapper.querySelector('.dataframe-error'));
    assert.doesNotMatch(wrapper.innerHTML, /not-json/);
});

// Live/fresh-VS and lazy history hydration, scoped counts and recycling are exercised
// through real entrypoints in web-structured-hydration.test.ts.
test('dataframe parser, delegation and scheduled-finalization contracts remain', () => {
    assert.match(markdownSrc, /renderDataframePlaceholder/);
    assert.match(postRenderSrc, /hydrateDataframeBlocks\(msgContainer\)/);
    assert.match(delegationsSrc, /ensureDataframeDelegation\(\)/);
    assert.match(structuredFenceSrc, /'dataframe'/);
});

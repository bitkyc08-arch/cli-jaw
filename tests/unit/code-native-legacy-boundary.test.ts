import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type { ReactNode } from 'react';
import type { CodeTranscriptVirtualRows } from '../../public/manager/src/code/useCodeTranscriptVirtualRows';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true, React: await import('react') };
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) globals[key] = value;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useCodeTranscriptVirtualRows } = await import('../../public/manager/src/code/useCodeTranscriptVirtualRows');
const { MarkdownPreview } = await import('../../public/manager/src/notes/MarkdownPreview');

after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globals[key];
    }
});

async function surface(t: TestContext) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    t.mock.method(globalThis, 'fetch', async () => { throw Error('Unexpected view network request'); });
    t.after(async () => { await act(async () => root.unmount()); container.remove(); });
    return { container, render: async (node: ReactNode) => { await act(async () => root.render(node)); } };
}

test('session and endpoint changes discard measured heights even when item IDs are reused', { timeout: 10_000 }, async t => {
    const h = await surface(t);
    const scroll = document.createElement('div');
    Object.defineProperties(scroll, { offsetWidth: { value: 1000 }, offsetHeight: { value: 600 } });
    document.body.append(scroll);
    t.after(() => scroll.remove());
    const row = document.createElement('div');
    row.setAttribute('data-code-transcript-idx', '0');
    let rowHeight = 300;
    Object.defineProperty(row, 'offsetHeight', { get: () => rowHeight });
    scroll.append(row);
    const scrollElementRef = { current: scroll };
    const getItemKey = (index: number) => `item-${index}`;
    const estimateSize = () => 92;
    let current: CodeTranscriptVirtualRows | undefined;
    function Probe({ identity }: { identity: string }) {
        current = useCodeTranscriptVirtualRows({ count: 2, resetKey: identity, scrollElementRef, getItemKey, estimateSize });
        return createElement('output', null, current.totalSize);
    }
    const total = () => h.container.querySelector('output')?.textContent;
    await h.render(createElement(Probe, { identity: '43225:session-a' }));
    assert.equal(total(), '184');
    await act(async () => { assert.ok(current); current.measureElement(row); });
    assert.equal(total(), '392');

    await h.render(createElement(Probe, { identity: '43225:session-b' }));
    assert.equal(total(), '184');
    rowHeight = 500;
    await act(async () => { assert.ok(current); current.measureElement(row); });
    assert.equal(total(), '592');

    await h.render(createElement(Probe, { identity: '43226:session-b' }));
    assert.equal(total(), '184');
});

test('Notes preview retains semantic tables and does not opt into Code local-file actions', { timeout: 10_000 }, async t => {
    const h = await surface(t);
    await h.render(createElement(MarkdownPreview, {
        markdown: '| Name | Value |\n| --- | --- |\n| alpha | 42 |\n\nOpen /tmp/report.md.',
    }));
    assert.ok(h.container.querySelector('table'));
    assert.deepEqual([...h.container.querySelectorAll('th')].map(node => node.textContent), ['Name', 'Value']);
    assert.deepEqual([...h.container.querySelectorAll('td')].map(node => node.textContent), ['alpha', '42']);
    assert.equal(h.container.querySelector('.markdown-linear-table'), null);
    assert.equal(h.container.querySelector('.markdown-local-file-link'), null);
    assert.ok(h.container.textContent?.includes('/tmp/report.md'));
});

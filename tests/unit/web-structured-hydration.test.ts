import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import type { MessageItem } from '../../public/js/features/process-log-adapter.ts';

// Replaces six renderer call-location checks. No callback registration or hydrator
// is invoked by this test: real first-user/live and loadMessages history entrypoints
// must install the shared callbacks before real TanStack/VirtualScroll activation.
const fence = (kind: string, value: unknown) => `\`\`\`${kind}\n${JSON.stringify(value)}\n\`\`\``;
const fixtures = [
    { name: 'chart-json', selector: '.chart-json-block', pending: '.chart-json-pending',
        markdown: fence('chart-json', { schemaVersion: 'chart-json-v1', type: 'bar', title: 'Revenue', labels: ['Q1', 'Q2'], data: [10, 20] }),
        check: (row: HTMLElement) => { assert.equal(row.querySelectorAll('svg.chart-json-svg').length, 1); assert.match(row.textContent!, /Revenue/); } },
    { name: 'compose-block', selector: '.compose-block', pending: '.compose-block-pending',
        markdown: fence('compose-block', { schemaVersion: 'compose-block-v1', kind: 'email', title: 'Follow up',
            variants: [{ id: 'polite', label: 'Polite', subject: 'Polite subject', body: 'Polite body' }] }),
        check: (row: HTMLElement) => { assert.equal(row.querySelector<HTMLInputElement>('.compose-subject-input')?.value, 'Polite subject');
            assert.equal(row.querySelector<HTMLTextAreaElement>('.compose-body')?.value, 'Polite body'); } },
    { name: 'dataframe', selector: '.dataframe-block', pending: '.dataframe-pending',
        markdown: fence('dataframe', { schemaVersion: 'dataframe-v1', title: 'Sales', columns: ['Month', 'Revenue'],
            types: ['string', 'number'], rows: [['Jan', 10], ['Feb', 20]], pageSize: 5 }),
        check: (row: HTMLElement) => { assert.equal(row.querySelectorAll('tbody tr').length, 2); assert.match(row.textContent!, /Jan/); } },
    { name: 'elicitation', selector: '.elicitation-block', pending: '.elicitation-pending',
        markdown: fence('elicitation', { questions: [{ id: 'scope', question: 'Choose scope', type: 'single_select',
            options: [{ id: 'mvp', label: 'MVP', value: 'MVP' }] }] }),
        check: (row: HTMLElement) => { assert.equal(row.querySelectorAll('button.elicitation-option').length, 1); assert.match(row.textContent!, /MVP/); } },
    { name: 'search-results', selector: '.search-results-block', pending: '.search-results-pending',
        markdown: fence('search-results', { schemaVersion: 'search-results-v1', query: 'fixture',
            results: [{ title: 'Fixture result', url: 'https://example.com/result', snippet: 'Visible result' }] }),
        check: (row: HTMLElement) => { assert.equal(row.querySelectorAll('.search-result-card').length, 1); assert.match(row.textContent!, /Fixture result/); } },
    { name: 'link-preview', selector: '.link-preview-card', pending: 'a:not([data-link-preview-attached])',
        markdown: '[Preview fixture](https://example.com/structured-fixture)',
        check: (row: HTMLElement) => { assert.match(row.querySelector('.link-preview-card')?.textContent ?? '', /Fixture preview/);
            assert.match(row.querySelector('.link-preview-card')?.innerHTML ?? '', /\/api\/link-preview\/image\?url=/); } },
];
let ui: typeof import('../../public/js/ui.ts');
let virtual: typeof import('../../public/js/virtual-scroll.ts');
let rendering: typeof import('../../public/js/render.ts');
let state: typeof import('../../public/js/state.ts')['state'];
let chat: HTMLElement, outside: HTMLElement;
let messages: MessageItem[] = [], serial = 0, messageReads = 0;
const unexpected: string[] = [], previewUrls: string[] = [];
const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
function drainFrames() {
    for (let i = 0; i < 12 && frames.size; i++) {
        const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(i * 16));
    }
    assert.equal(frames.size, 0);
}
function waitForCard(row: HTMLElement, selector: string): Promise<void> {
    if (row.querySelector(selector)) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => { if (row.querySelector(selector)) { cleanup(); resolve(); } });
        const deadline = setTimeout(() => { cleanup(); reject(new Error(`Hydration did not produce ${selector}`)); }, 1500);
        const cleanup = () => { clearTimeout(deadline); observer.disconnect(); };
        observer.observe(row, { childList: true, subtree: true });
    });
}
test.before(async () => {
    setupWebUiDom(); chat = document.getElementById('chatMessages')!;
    const raf = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; };
    const cancel = (id: number) => { frames.delete(id); };
    mock.method(globalThis, 'requestAnimationFrame', raf); mock.method(window, 'requestAnimationFrame', raf);
    mock.method(globalThis, 'cancelAnimationFrame', cancel); mock.method(window, 'cancelAnimationFrame', cancel);
    for (const [key, value] of Object.entries({ offsetWidth: 800, offsetHeight: 600, clientWidth: 800, clientHeight: 600 })) {
        Object.defineProperty(chat, key, { configurable: true, get: () => value });
    }
    Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', { configurable: true,
        get() { return this.classList.contains('msg') ? 80 : 0; } });
    Object.defineProperty(chat, 'scrollHeight', { configurable: true,
        get: () => Math.max(600, parseFloat(chat.querySelector<HTMLElement>('.vs-inner')?.style.height ?? '0') || 0) });
    chat.scrollTo = ((options: ScrollToOptions) => { chat.scrollTop = options.top ?? 0;
        chat.dispatchEvent(new window.Event('scroll')); }) as typeof chat.scrollTo;
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const url = new URL(String(input), 'http://127.0.0.1');
        if (url.pathname === '/api/auth/token') return Response.json({ token: 'fixture' });
        if (url.pathname === '/api/link-preview') {
            previewUrls.push(url.searchParams.get('url')!);
            return Response.json({ ok: true, data: { title: 'Fixture preview', description: 'Fixture description',
                siteName: 'Example', domain: 'example.com', finalUrl: url.searchParams.get('url'),
                image: 'https://example.com/preview.jpg', favicon: 'https://example.com/favicon.ico' } });
        }
        if (url.pathname === '/api/settings') return Response.json({ workingDir: '/fixture/structured-hydration' });
        if (url.pathname === '/api/messages') { messageReads++; return Response.json(messages); }
        if (url.pathname === '/api/messages/count') return Response.json({ count: messages.length });
        unexpected.push(url.pathname); throw new Error(`Unexpected fixture HTTP: ${url.pathname}`);
    });
    const warn = console.warn.bind(console);
    mock.method(console, 'warn', (...args: unknown[]) => { if (!String(args[0]).startsWith('[idb-cache]')) warn(...args); });
    ui = await import('../../public/js/ui.ts'); virtual = await import('../../public/js/virtual-scroll.ts');
    rendering = await import('../../public/js/render.ts'); ({ state } = await import('../../public/js/state.ts'));
});
test.beforeEach(() => {
    rendering.cancelPostRender(); virtual.getVirtualScroll().clear(); ui.cleanupToolActivity(); frames.clear(); chat.replaceChildren();
    outside = document.createElement('aside'); document.body.append(outside);
    messages = []; messageReads = 0; unexpected.length = 0; previewUrls.length = 0; serial++;
});
test.afterEach(() => {
    rendering.cancelPostRender(); virtual.getVirtualScroll().clear(); ui.cleanupToolActivity(); frames.clear(); outside.remove();
    assert.deepEqual(unexpected, []);
});
test.after(() => { resetWebUiDom(); mock.restoreAll(); });

for (const fixture of fixtures) for (const route of ['first-user', 'history'] as const) {
    test(`${fixture.name}: actual ${route} callbacks hydrate once in scope and survive real VS recycling`, async () => {
        const markdown = fixture.markdown.replace('structured-fixture', `structured-fixture-${serial}`);
        outside.innerHTML = rendering.renderMarkdown(markdown.replace('https://example.com/', 'https://outside.example.com/'));
        rendering.cancelPostRender(); const untouched = outside.outerHTML;
        assert.ok(outside.querySelector(fixture.pending), 'outside scope must contain an unhydrated candidate');
        if (route === 'first-user') {
            ui.addMessage('user', 'Request structured answer'); drainFrames(); rendering.cancelPostRender();
            assert.equal(virtual.getVirtualScroll().active, true);
            state.currentAgentDiv = ui.addMessage('agent', '');
            ui.finalizeAgent(markdown, [], 'present');
        } else {
            messages = [{ id: serial * 10, role: 'user', content: 'Request structured history' },
                { id: serial * 10 + 1, role: 'assistant', content: markdown }];
            await ui.loadMessages(); assert.equal(messageReads, 1, 'real history fetch/bootstrap executed');
        }
        rendering.cancelPostRender(); drainFrames();
        const vs = virtual.getVirtualScroll(), row = chat.querySelector<HTMLElement>('.msg-agent')!;
        assert.ok(row); assert.equal(vs.count, 2); assert.equal(vs.active, true);
        await waitForCard(row, fixture.selector);
        assert.equal(row.querySelectorAll(fixture.selector).length, 1); fixture.check(row);
        assert.equal(outside.outerHTML, untouched);
        const index = Number(row.dataset['vsIdx']); assert.ok(Number.isInteger(index));
        for (let i = 0; i < 24; i++) ui.addMessage('user', `Filler ${i}`);
        rendering.cancelPostRender(); vs.scrollToIndex(vs.count - 1); drainFrames();
        assert.equal(row.isConnected, false, 'original hydrated row was truly recycled');
        assert.equal(chat.querySelector('.msg-agent'), null);
        vs.scrollToIndex(index); drainFrames(); rendering.cancelPostRender();
        const replacement = chat.querySelector<HTMLElement>('.msg-agent')!;
        assert.ok(replacement); assert.notEqual(replacement, row);
        await waitForCard(replacement, fixture.selector);
        assert.equal(replacement.querySelectorAll(fixture.selector).length, 1); fixture.check(replacement);
        window.dispatchEvent(new window.Event('resize')); drainFrames(); rendering.cancelPostRender();
        assert.equal(replacement.querySelectorAll(fixture.selector).length, 1, 'repeat viewport hydration stays idempotent');
        assert.equal(outside.outerHTML, untouched);
        assert.ok(previewUrls.every(url => !url.includes('outside.example.com')), 'outside link must never fetch metadata');
        if (fixture.name === 'link-preview') assert.ok(previewUrls.some(url => url.endsWith(`structured-fixture-${serial}`)));
    });
}

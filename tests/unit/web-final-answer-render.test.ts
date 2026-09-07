import '../setup/isolated-home.ts';
import { rmSync, existsSync } from 'node:fs';
import { setImmediate as nextTick } from 'node:timers/promises';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { atob, btoa } from 'node:buffer';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

type Boundary = {
    kind: 'markdown' | 'widgets' | 'mermaid' | 'release';
    root?: Element;
    html: string;
    raw?: string | null;
    options?: unknown;
};
const isolatedHome = process.env.CLI_JAW_HOME!;
const globalNames = ['window', 'document', 'HTMLElement', 'HTMLAnchorElement', 'Element', 'Node',
    'NodeFilter', 'navigator', 'localStorage', 'MutationObserver', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver', 'ResizeObserver',
    'atob', 'btoa', 'indexedDB'] as const;
const globals = new Map(globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const unexpected: string[] = [];
const calls: Boundary[] = [];
let target: HTMLElement | null = null;
let ui: typeof import('../../public/js/ui.ts');
let state: typeof import('../../public/js/state.ts')['state'];
let rendering: typeof import('../../public/js/render.ts');
let virtual: typeof import('../../public/js/virtual-scroll.ts');
const answer = '## Final answer\n\n**Ready**\n\n```mermaid\ngraph TD; A-->B\n```\n\n'
    + '```diagram-html\n<div>Widget content</div>\n```';

function observe(kind: Boundary['kind'], root?: Element, options?: unknown): void {
    calls.push({ kind, ...(root ? { root } : {}), html: root?.innerHTML ?? '',
        raw: root?.getAttribute('data-raw'), options });
}

test.before(async () => {
    setupWebUiDom();
    // JSDOM's bound base64 globals recurse when installed back onto globalThis.
    mock.method(globalThis, 'btoa', btoa); mock.method(globalThis, 'atob', atob);
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), 'http://127.0.0.1');
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (url.origin === 'http://127.0.0.1' && method === 'GET' && !url.search) {
            if (url.pathname === '/api/auth/token') return Response.json({ token: 'wp37-webfs-fixture' });
            if (url.pathname === '/api/messages/count') return Response.json({ ok: true, data: { count: 0 } });
        }
        unexpected.push(`${method} ${url.href}`);
        throw new Error(`Unexpected fixture HTTP: ${method} ${url.href}`);
    });
    const warn = console.warn.bind(console);
    mock.method(console, 'warn', (...args: unknown[]) => {
        if (String(args[0]).startsWith('[idb-cache]')) return; // Deliberately unavailable in this DOM harness.
        warn(...args);
    });
    // Keep all real facade exports and the real Markdown parser/sanitizer. The only
    // substituted renderer work is entry dispatch: no Mermaid SVG engine or iframe execution.
    rendering = await import('../../public/js/render.ts');
    const widgets = await import('../../public/js/diagram/iframe-renderer.ts');
    mock.module('../../public/js/render.js', { namedExports: {
        ...rendering,
        renderMarkdown(text: string, streaming?: boolean) {
            observe('markdown', target ?? undefined);
            return rendering.renderMarkdown(text, streaming);
        },
        renderMermaidBlocks(root?: HTMLElement, options?: unknown) {
            observe('mermaid', root, options);
            return Promise.resolve();
        },
        releaseMermaidNodes(root: Element) {
            observe('release', root);
            rendering.releaseMermaidNodes(root);
        },
    } });
    mock.module('../../public/js/diagram/iframe-renderer.js', { namedExports: {
        ...widgets,
        activateWidgets(root?: HTMLElement) { observe('widgets', root); },
    } });
    ui = await import('../../public/js/ui.ts');
    ({ state } = await import('../../public/js/state.ts'));
    virtual = await import('../../public/js/virtual-scroll.ts');
});

test.beforeEach(() => {
    rendering.cancelPostRender(); virtual.getVirtualScroll().clear(); ui.cleanupToolActivity();
    document.getElementById('chatMessages')!.replaceChildren(); calls.length = 0; target = null;
});
test.afterEach(async () => {
    // Cancel real Markdown's deferred scheduler explicitly; this oracle observes
    // synchronous finalizer dispatch and never waits for the 100ms debounce.
    rendering.cancelPostRender(); ui.cleanupToolActivity(); target = null;
    await nextTick();
    assert.deepEqual(unexpected, [], 'unknown HTTP must fail even when a production boundary catches it');
});
test.after(() => {
    try {
        rendering?.cancelPostRender(); virtual?.getVirtualScroll().clear(); ui?.cleanupToolActivity();
        resetWebUiDom(); mock.restoreAll();
        for (const [name, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        assert.deepEqual(unexpected, []);
    } finally {
        rmSync(isolatedHome, { recursive: true, force: true });
        assert.equal(existsSync(isolatedHome), false);
    }
});

function prepareHost(): HTMLElement {
    const host = ui.addMessage('agent', ''); // A live placeholder keeps the real VS adapter inactive.
    state.currentAgentDiv = host;
    target = host.querySelector<HTMLElement>('.msg-content')!;
    target.innerHTML = '<span data-old-answer>Old answer</span>';
    target.setAttribute('data-raw', 'Old answer');
    rendering.cancelPostRender(); calls.length = 0;
    assert.equal(virtual.getVirtualScroll().active, false);
    return host;
}

function assertRenderedBeforeDispatch(content: HTMLElement, stages: Boundary['kind'][]): void {
    assert.deepEqual(calls.map(call => call.kind), stages);
    const before = calls.find(call => call.kind === 'markdown')!;
    assert.match(before.html, /data-old-answer/);
    for (const kind of ['widgets', 'mermaid'] as const) {
        const call = calls.find(entry => entry.kind === kind)!;
        assert.equal(call.root, content, `${kind} must receive the answer content, not document or message root`);
        assert.equal(call.raw, answer, `${kind} sees the final raw answer`);
        const captured = document.createElement('div'); captured.innerHTML = call.html;
        assert.equal(captured.querySelector('h2')?.textContent, 'Final answer');
        assert.equal(captured.querySelector('strong')?.textContent, 'Ready');
        assert.equal(captured.querySelector('[data-old-answer]'), null);
        const mermaid = captured.querySelector<HTMLElement>('.mermaid-pending');
        assert.ok(mermaid, `${kind} must run after real Markdown creates the Mermaid placeholder`);
        assert.equal(decodeURIComponent(mermaid.dataset['mermaidCodeRaw']!), 'graph TD; A-->B');
        assert.ok(captured.querySelector('.diagram-widget-pending'), `${kind} sees the widget placeholder`);
    }
    assert.deepEqual(calls.find(call => call.kind === 'mermaid')!.options, { immediate: true });
}

test('F5/import behavior: non-VS finalizeAgent installs real markup before scoped widget and immediate Mermaid dispatch', () => {
    const host = prepareHost(); const content = target!;
    const outside = document.createElement('div'); outside.innerHTML = '<div class="mermaid-pending">outside scope</div>';
    host.after(outside); const outsideBefore = outside.outerHTML;
    ui.finalizeAgent(answer, [], 'present');
    rendering.cancelPostRender();
    assertRenderedBeforeDispatch(content, ['markdown', 'widgets', 'mermaid']);
    assert.equal(host.querySelector('.msg-content'), content);
    assert.equal(content.getAttribute('data-raw'), answer);
    assert.equal(outside.outerHTML, outsideBefore);
    assert.equal(state.currentAgentDiv, null);
});

test('owned answer replacement releases old diagrams then renders and dispatches within that same content', () => {
    const host = prepareHost(); const content = target!;
    const foreground = ui.addMessage('agent', '');
    foreground.querySelector('.msg-content')!.textContent = 'B is still running';
    state.currentAgentDiv = foreground; ui.setStatus('running');
    rendering.cancelPostRender(); calls.length = 0;
    const foregroundBefore = foreground.outerHTML;
    ui.replaceAgentAnswer(host, answer);
    rendering.cancelPostRender();
    assertRenderedBeforeDispatch(content, ['release', 'markdown', 'widgets', 'mermaid']);
    assert.equal(host.querySelector('.msg-content'), content);
    assert.equal(calls[0]!.root, content); assert.match(calls[0]!.html, /data-old-answer/);
    assert.equal(state.currentAgentDiv, foreground); assert.equal(state.agentBusy, true);
    assert.equal(foreground.outerHTML, foregroundBefore);
    calls.length = 0;
    ui.replaceAgentAnswer(host, answer);
    assert.deepEqual(calls, [], 'same owned answer is idempotent and never dispatches another render');
});

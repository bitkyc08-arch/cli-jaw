import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atob, btoa } from 'node:buffer';
import { setImmediate as nextTick } from 'node:timers/promises';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

// Phase 127 (#127) mermaid render latency — source-string contract for ui.ts.

const uiSrc = readFileSync(
    join(import.meta.dirname, '../../public/js/ui.ts'),
    'utf8',
);
const mainSrc = readFileSync(
    join(import.meta.dirname, '../../public/js/main.ts'),
    'utf8',
);

// F5/import behavior is owned by web-final-answer-render.test.ts: both the
// non-VS finalizer and owned-answer replacement execute the real Markdown
// parser, then dispatch scoped widgets/Mermaid with immediate:true. Import-line
// formatting and a fixed byte window are not behavior contracts.

const globalNames = ['window', 'document', 'HTMLElement', 'HTMLAnchorElement', 'Element', 'Node',
    'NodeFilter', 'navigator', 'localStorage', 'MutationObserver', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver', 'ResizeObserver',
    'atob', 'btoa', 'indexedDB'] as const;
const globals = new Map(globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const unexpected: string[] = [];
const dispatches: { root: HTMLElement | undefined; html: string; options: unknown }[] = [];
let rendering: typeof import('../../public/js/render.ts');
let history: typeof import('../../public/js/features/message-history.ts');
let vs: ReturnType<typeof import('../../public/js/virtual-scroll.ts')['getVirtualScroll']>;

test.before(async () => {
    setupWebUiDom();
    mock.method(globalThis, 'atob', atob); mock.method(globalThis, 'btoa', btoa);
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), 'http://127.0.0.1');
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (method === 'GET' && url.href === 'http://127.0.0.1/api/auth/token')
            return Response.json({ token: 'wp37-mermaid' });
        unexpected.push(`${method} ${url.href}`);
        throw new Error(`Unexpected fixture HTTP: ${method} ${url.href}`);
    });
    rendering = await import('../../public/js/render.ts');
    mock.module('../../public/js/render.js', { namedExports: {
        ...rendering,
        renderMermaidBlocks(root?: HTMLElement, options?: unknown) {
            dispatches.push({ root, html: root?.innerHTML ?? '', options });
            return Promise.resolve();
        },
    } });
    history = await import('../../public/js/features/message-history.ts');
    vs = (await import('../../public/js/virtual-scroll.ts')).getVirtualScroll();
});
test.afterEach(async () => {
    rendering.cancelPostRender(); vs.clear(); dispatches.length = 0;
    document.getElementById('chatMessages')!.replaceChildren();
    await nextTick();
    assert.deepEqual(unexpected, [], 'caught unexpected HTTP must still fail the test');
});
test.after(() => {
    try { rendering?.cancelPostRender(); vs?.clear(); resetWebUiDom(); }
    finally {
        mock.restoreAll();
        for (const [name, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    }
});

// F9 promotion is driven through the real finalizer/VS snapshot boundary in
// web-replay-behavior.test.ts. A fixed byte window cannot prove call ordering.

test('F9: finalizeAgent skips immediate Mermaid queue for DOM promoted to VS', () => {
    const idx = uiSrc.indexOf('export function finalizeAgent');
    assert.ok(idx >= 0, 'finalizeAgent must exist');
    const block = uiSrc.slice(idx, idx + 4200);
    assert.ok(block.includes('willPromoteToVirtualScroll'),
        'finalizeAgent must compute the VS promotion condition before Mermaid rendering');
    assert.ok(/if\s*\(\s*content\s*&&\s*!willPromoteToVirtualScroll\s*\)/.test(block),
        'immediate Mermaid render must be skipped for DOM that will be promoted to VS');
});

test('F7a: VS onLazyRender triggers immediate mermaid render', () => {
    history.registerVirtualScrollCallbacks(vs);
    assert.ok(vs.onLazyRender);
    const content = document.createElement('div'); content.className = 'msg-content lazy-pending';
    content.setAttribute('data-raw', '**Fresh**\n\n```mermaid\ngraph TD; A-->B\n```');
    content.innerHTML = '<span>stale markup</span>';
    document.getElementById('chatMessages')!.append(content);
    const outside = document.createElement('div'); outside.className = 'lazy-pending';
    outside.textContent = 'outside scope'; content.after(outside);
    const untouched = outside.outerHTML;
    vs.onLazyRender([content]);
    // No timer advancement: this dispatch must bypass Markdown's debounce.
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0]!.root, content);
    assert.deepEqual(dispatches[0]!.options, { immediate: true });
    const captured = document.createElement('div'); captured.innerHTML = dispatches[0]!.html;
    assert.equal(captured.querySelector('strong')?.textContent, 'Fresh');
    assert.equal(decodeURIComponent(captured.querySelector<HTMLElement>('.mermaid-pending')!.dataset['mermaidCodeRaw']!), 'graph TD; A-->B');
    assert.equal(content.classList.contains('lazy-pending'), false);
    assert.equal(outside.outerHTML, untouched);
    vs.onLazyRender([content]);
    assert.equal(dispatches.length, 1, 'already-rendered content must not dispatch again');
});

test('F7b: VS onPostRender triggers immediate mermaid render for mounted scope', () => {
    history.registerVirtualScrollCallbacks(vs);
    assert.ok(vs.onPostRender);
    const viewport = document.createElement('div');
    viewport.innerHTML = rendering.renderMarkdown('```mermaid\ngraph TD; C-->D\n```');
    rendering.cancelPostRender();
    document.getElementById('chatMessages')!.append(viewport);
    const outside = document.createElement('div'); outside.innerHTML = '<div class="mermaid-pending">outside</div>';
    viewport.after(outside); const untouched = outside.outerHTML;
    vs.onPostRender(viewport);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0]!.root, viewport);
    assert.deepEqual(dispatches[0]!.options, { immediate: true });
    assert.ok(viewport.querySelector('.mermaid-pending'), 'pre-rendered Mermaid input remains available at dispatch');
    assert.equal(outside.outerHTML, untouched);
});

test('F2: main.ts imports prewarmMermaid and calls it in bootstrap', () => {
    assert.ok(
        mainSrc.includes("import { prewarmMermaid } from './render.js';"),
        'main.ts must import prewarmMermaid from ./render.js',
    );
    const bootstrapIdx = mainSrc.indexOf('async function bootstrap()');
    assert.ok(bootstrapIdx >= 0, 'bootstrap function must exist');
    // Extract the bootstrap body by brace matching rather than a byte window:
    // the old fixed 2500-byte slice measured how much code precedes the call
    // (phase 071 pushed it to 2618), while slicing to EOF would let an
    // unrelated later call satisfy this guard.
    const bodyStart = mainSrc.indexOf('{', bootstrapIdx);
    assert.ok(bodyStart > 0, 'bootstrap body must exist');
    let depth = 0;
    let bodyEnd = bodyStart;
    for (let i = bodyStart; i < mainSrc.length; i += 1) {
        if (mainSrc[i] === '{') depth += 1;
        else if (mainSrc[i] === '}') {
            depth -= 1;
            if (depth === 0) { bodyEnd = i; break; }
        }
    }
    assert.ok(bodyEnd > bodyStart, 'bootstrap body must be balanced');
    const bootstrapBlock = mainSrc.slice(bodyStart, bodyEnd);
    assert.ok(bootstrapBlock.includes('prewarmMermaid();'),
        'bootstrap must call prewarmMermaid()');
});

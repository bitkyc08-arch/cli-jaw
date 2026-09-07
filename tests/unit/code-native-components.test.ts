import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type { ReactNode } from 'react';
import type { CodeControllerModel } from '../../public/manager/src/code/code-controller-types';
import type { CodeItem, CodePermissionRequest, CodeSessionInfo } from '../../src/code-mode/wire';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost:43225' });
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true, React: await import('react') };
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) globals[key] = value;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { CodeComposer } = await import('../../public/manager/src/code/CodeComposer');
const { ComposerFooter } = await import('../../public/manager/src/code/ComposerFooter');
const { CodePermissionQueue } = await import('../../public/manager/src/code/CodePermissionQueue');
const { CodeSessionList } = await import('../../public/manager/src/code/CodeSessionList');
const { CodeTranscriptItem, CodeTranscript } = await import('../../public/manager/src/code/CodeTranscript');
const { CodeWorkbench } = await import('../../public/manager/src/code/CodeWorkbench');
const { useThrottledMarkdown } = await import('../../public/manager/src/code/use-throttled-markdown');
after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key];
    }
});
const bounded = { timeout: 10_000 };
async function surface(t: TestContext) {
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    t.mock.method(globalThis, 'fetch', async () => { throw Error('Unexpected view network request'); });
    t.after(async () => { await act(async () => root.unmount()); container.remove(); });
    return { container, render: async (node: ReactNode) => { await act(async () => root.render(node)); } };
}
function session(patch: Partial<CodeSessionInfo> = {}): CodeSessionInfo {
    return { sessionId: 's-a', provider: 'codex-app', cwd: '/work/alpha', title: 'Alpha', model: 'native-model', effort: null,
        permissionMode: 'ask', status: 'idle', turnId: null, archivedAt: null, error: null, resume: { available: true, reason: null },
        capabilities: { resume: true, interrupt: true, permissions: true, setModelMidSession: false, efforts: ['low', 'high'], permissionModes: ['ask', 'auto'] },
        epoch: 2, sequence: 10, revision: 4, createdAt: 1, lastUsedAt: 2, ...patch };
}
function model(patch: Partial<CodeControllerModel> = {}): CodeControllerModel {
    const s = session();
    return { catalog: { defaultProvider: 'codex-app', providers: ['codex-app', 'claude', 'cursor', 'grok'].map(id => ({
        id: id as CodeSessionInfo['provider'], label: id, available: true, reason: null, models: ['native-model'], defaultModel: 'native-model',
        defaultEffort: null, capabilities: s.capabilities, modelSource: 'native' as const,
    })) }, sessions: [s], session: s, selectedId: s.sessionId, items: [], permissions: [], input: 'draft text',
    selection: { provider: s.provider, cwd: s.cwd, model: s.model, effort: null, permissionMode: s.permissionMode },
    gitInfo: null, loading: false, pending: false, busy: false, synced: true, error: null, transport: 'connected',
    operation: { kind: 'idle', error: null }, retryText: null, canRetrySameSend: false, permissionOperations: {},
    hasMoreSessions: false, hasOlderHistory: false, filter: { scope: 'all', archived: false },
    creationUnknown: false, startAnotherSession() {}, newSession() {}, async selectSession() {}, setInput() {}, async setSelection() {}, async pickWorkspace() {},
    async send() {}, async stop() {}, async resume() {}, async rename() {}, async archive() {}, async answer() {},
    async refresh() {}, async loadMoreSessions() {}, async loadOlderHistory() {}, setFilter() {}, clearError() {}, async retrySameSend() {}, ...patch };
}
function button(container: ParentNode, name: string) {
    const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name);
    assert.ok(found, `button ${name} must exist`); return found;
}
async function key(node: Element, value: string, options: KeyboardEventInit = {}) {
    await act(async () => { node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options })); });
}
async function click(node: HTMLButtonElement) { await act(async () => node.click()); }

// These exercise actual rendered controls; requests are supplied through the frozen view port.
test('composer sends literal slash text once, preserves IME Enter and Shift+Enter', bounded, async t => {
    const h = await surface(t); const gate = Promise.withResolvers<void>(); let sends = 0;
    t.after(() => gate.resolve());
    await h.render(createElement(CodeComposer, { inputText: '/model is literal input', canSend: true, busy: false, canStop: false,
        stopping: false, pending: false, readOnly: false, onInputChange() {}, async onSubmit() { sends++; await gate.promise; }, async onStop() {} }));
    const input = h.container.querySelector('textarea'); assert.ok(input);
    assert.equal(input.value, '/model is literal input');
    await key(input, 'Enter', { isComposing: true }); await key(input, 'Enter', { shiftKey: true }); assert.equal(sends, 0);
    await key(input, 'Enter'); await key(input, 'Enter'); assert.equal(sends, 1);
    await act(async () => gate.resolve());
});

test('streaming keeps draft editable and exposes keyboard Stop with duplicate guard', bounded, async t => {
    const h = await surface(t); const gate = Promise.withResolvers<void>(); let stops = 0;
    t.after(() => gate.resolve());
    const props = { inputText: 'follow-up draft', canSend: false, busy: true, canStop: true, stopping: false, pending: false,
        readOnly: false, onInputChange() {}, async onSubmit() { assert.fail('busy send'); }, async onStop() { stops++; await gate.promise; } };
    await h.render(createElement(CodeComposer, props));
    const input = h.container.querySelector('textarea'); assert.ok(input); assert.equal(input.disabled, false); assert.equal(input.readOnly, false);
    const stop = button(h.container, 'Stop current turn'); stop.focus(); assert.equal(document.activeElement, stop);
    await click(stop); await click(stop); assert.equal(stops, 1);
    await h.render(createElement(CodeComposer, { ...props, stopping: true, canStop: false }));
    assert.equal(button(h.container, 'Stop current turn').disabled, true); assert.match(h.container.textContent ?? '', /Stopping/);
    await act(async () => gate.resolve());
});

test('footer arrows explore without committing, native default is null, and runtime change creates an explicit new target', bounded, async t => {
    const h = await surface(t); const patches: unknown[] = [];
    const c = model({ async setSelection(patch) { patches.push(patch); } });
    await h.render(createElement(ComposerFooter, { controller: c }));
    await key(button(h.container, 'Effort'), 'ArrowDown');
    assert.deepEqual(patches, []); assert.equal(document.activeElement?.textContent, 'Native default');
    await key(document.activeElement!, 'ArrowDown'); assert.deepEqual(patches, []); assert.equal(document.activeElement?.textContent, 'low');
    await click(document.activeElement as HTMLButtonElement); assert.deepEqual(patches, [{ effort: 'low' }]);
    assert.equal(document.activeElement, button(h.container, 'Effort'));
    await click(button(h.container, 'Runtime')); await click(button(document, 'New Claude session'));
    assert.deepEqual(patches[1], { provider: 'claude' });
});

test('idle model and effort updates work without hot-switch capability and stay gated during non-idle states', bounded, async t => {
    const h = await surface(t); const patches: unknown[] = [];
    const c = model({ async setSelection(patch) { patches.push(patch); } });
    assert.equal(c.session?.capabilities.setModelMidSession, false);
    await h.render(createElement(ComposerFooter, { controller: c }));
    const input = h.container.querySelector<HTMLInputElement>('[aria-label="Native model ID"]'); assert.ok(input);
    assert.equal(input.disabled, false); assert.equal(button(h.container, 'Effort').disabled, false);
    await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'another-native-model');
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await click(button(h.container, 'Apply'));
    await click(button(h.container, 'Effort')); await click(button(document, 'high'));
    await click(button(h.container, 'Effort')); await click(button(document, 'Native default'));
    assert.deepEqual(patches, [{ model: 'another-native-model' }, { effort: 'high' }, { effort: null }]);
    const unavailable: Partial<CodeControllerModel>[] = [
        { session: session({ status: 'starting', turnId: 't-a' }), busy: true },
        { session: session({ status: 'streaming', turnId: 't-a' }), busy: true },
        { session: session({ status: 'stopping', turnId: 't-a' }), busy: true },
        { session: session({ status: 'suspended' }) },
        { session: session({ status: 'failed' }) },
        { session: session({ archivedAt: 123 }) },
        { synced: false },
        { pending: true, operation: { kind: 'patching', error: null } },
    ];
    for (const state of unavailable) {
        await h.render(createElement(ComposerFooter, { controller: { ...c, ...state } }));
        assert.equal(h.container.querySelector<HTMLInputElement>('[aria-label="Native model ID"]')?.disabled, true);
        assert.equal(button(h.container, 'Effort').disabled, true);
    }
    assert.equal(patches.length, 3, 'disabled states must not dispatch settings mutations');
});

test('creation freezes runtime/model/policy and Auto YOLO remains explicit', bounded, async t => {
    const h = await surface(t);
    const c = model({ selectedId: null, session: null, pending: true, operation: { kind: 'creating', error: null },
        selection: { provider: 'grok', cwd: '/work/beta', model: 'native-model', effort: null, permissionMode: 'auto' } });
    await h.render(createElement(ComposerFooter, { controller: c }));
    assert.equal(button(h.container, 'Runtime').disabled, true); assert.equal(button(h.container, 'Permission').disabled, true);
    assert.equal(h.container.querySelector<HTMLInputElement>('input')?.disabled, true);
    assert.match(h.container.textContent ?? '', /Auto \(YOLO\)/);
});

function permission(id: string): CodePermissionRequest {
    return { permissionId: id, sessionId: 's-a', turnId: 't-a', epoch: 2, title: `Request ${id}`, detail: 'Read a selected file', requestedAt: 1,
        options: [{ optionId: `opaque/${id}:37`, label: 'Read this file', kind: 'allow_once' }, { optionId: `opaque/${id}:94`, label: 'Do not read', kind: 'reject_once' }] };
}
test('permissions preserve opaque choices and isolate each request pending/error state', bounded, async t => {
    const h = await surface(t); const calls: unknown[] = []; const a = permission('a'), b = permission('b');
    await h.render(createElement(CodePermissionQueue, { permissions: [a, b], session: session({ status: 'streaming', turnId: 't-a' }), synced: true,
        operations: { a: { pending: true, error: 'Decision acknowledgement pending' } },
        async onAnswer(p, id) { calls.push([p.permissionId, id]); throw Error('Second decision failed'); } }));
    const cards = h.container.querySelectorAll('section'); assert.equal(cards.length, 2);
    assert.equal(button(cards[0]!, 'Read this file').disabled, true); assert.equal(button(cards[1]!, 'Read this file').disabled, false);
    await click(button(cards[1]!, 'Read this file'));
    assert.deepEqual(calls, [['b', 'opaque/b:37']]); assert.match(cards[1]!.textContent ?? '', /Second decision failed/);
    assert.equal(h.container.querySelectorAll('button').length, 4, 'only supplied actions exist');
});

test('stale permission ownership renders choices disabled without answering', bounded, async t => {
    const h = await surface(t); let answers = 0;
    await h.render(createElement(CodePermissionQueue, { permissions: [permission('a')], session: session({ status: 'streaming', turnId: 'new-turn' }),
        synced: true, operations: {}, async onAnswer() { answers++; } }));
    await click(button(h.container, 'Read this file')); assert.equal(answers, 0); assert.equal(button(h.container, 'Read this file').disabled, true);
});

test('list reports unknown attention, preserves row on failed archive, and supports Escape rename', bounded, async t => {
    const h = await surface(t); const calls: unknown[] = [];
    const c = model({ synced: false, async archive(id, archived) { calls.push([id, archived]); throw Error('Revision changed. Refresh session.'); } });
    await h.render(createElement(CodeSessionList, { controller: c }));
    assert.match(h.container.textContent ?? '', /Approval status unknown/);
    await click(button(h.container, 'Rename'));
    const title = h.container.querySelector('input[aria-label="Session title"]'); assert.ok(title);
    await key(title, 'Escape'); assert.equal(h.container.querySelector('input[aria-label="Session title"]'), null);
    await click(button(h.container, 'Archive')); assert.deepEqual(calls, [['s-a', true]]);
    assert.match(h.container.textContent ?? '', /Revision changed/); assert.match(h.container.textContent ?? '', /Alpha/);
});

test('workbench sibling identities stay unique through rerenders and selected-session changes', bounded, async t => {
    const h = await surface(t);
    const diagnostics: string[] = [];
    const report = console.error;
    t.mock.method(console, 'error', (...args: unknown[]) => {
        diagnostics.push(args.map(String).join(' '));
        report.apply(console, args);
    });
    const render = async (id: string | null, input: string) => {
        const selected = id === null ? null : session({ sessionId: id });
        await h.render(createElement(CodeWorkbench, {
            controller: model({ selectedId: id, session: selected, input }), endpointKey: '43225',
        }));
        assert.equal(h.container.querySelectorAll('textarea[aria-label="Code prompt"]').length, 1);
        assert.equal(h.container.querySelectorAll('input[aria-label="Native model ID"]').length, 1);
        assert.equal(h.container.querySelectorAll('.code-composer-footer').length, 1);
        assert.equal(h.container.querySelector('textarea')?.value, input);
    };
    await render('s-a', 'draft A');
    const firstInput = h.container.querySelector('textarea');
    const firstModel = h.container.querySelector<HTMLInputElement>('[aria-label="Native model ID"]');
    assert.ok(firstModel);
    await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(firstModel, 'unsaved model edit');
        firstModel.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await render('s-a', 'draft A extended');
    assert.equal(h.container.querySelector('textarea'), firstInput, 'same-session input retains DOM identity');
    assert.equal(h.container.querySelector('[aria-label="Native model ID"]'), firstModel);
    assert.equal(firstModel.value, 'unsaved model edit', 'same-session rerender preserves local model edit');
    for (const id of ['s-b', null, 's-a', null]) {
        await render(id, id === null ? 'preserved new draft' : `draft ${id}`);
        assert.equal(h.container.querySelector<HTMLInputElement>('[aria-label="Native model ID"]')?.value, 'native-model',
            'different-session controls reset to the accepted model');
    }
    assert.deepEqual(diagnostics.filter(message => /same key|unique.*key/i.test(message)), [],
        'React must report no sibling-key collisions');
});

test('unknown-send retry previews original text and never submits the edited draft', bounded, async t => {
    const h = await surface(t); let retries = 0, sends = 0;
    const c = model({ input: 'edited follow-up', operation: { kind: 'unknown-send', error: null }, retryText: 'original request', canRetrySameSend: true,
        async retrySameSend() { retries++; }, async send() { sends++; } });
    await h.render(createElement(CodeWorkbench, { controller: c, endpointKey: '43225' }));
    assert.equal(h.container.querySelector('[aria-label="Original prompt"]')?.textContent, 'original request');
    assert.equal(h.container.querySelector('textarea')?.value, 'edited follow-up'); assert.equal(button(h.container, 'Send prompt').disabled, true);
    await click(button(h.container, 'Retry same send')); assert.equal(retries, 1); assert.equal(sends, 0);
});

function item(patch: Partial<CodeItem>): CodeItem { return { itemId: 'item-a', turnId: 't-a', kind: 'user_message', status: 'done', createdAt: 1, updatedAt: 1, ...patch }; }
test('timeline retains stable item ID, escaped tool output, truncation and distinct stopped/failed states', bounded, async t => {
    const h = await surface(t);
    const render = (value: CodeItem) => h.render(createElement(CodeTranscriptItem, { item: value, provider: 'cursor', sessionKey: '43225:s-a' }));
    await render(item({ kind: 'tool_call', status: 'cancelled', tool: { name: 'read', output: '<script>bad()</script>partial' },
        truncation: { storedChars: 12, sourceChars: 500, reason: 'field_limit' } }));
    assert.equal(h.container.querySelector('article')?.getAttribute('data-code-item-id'), 'item-a');
    assert.equal(h.container.querySelector('script'), null); assert.match(h.container.textContent ?? '', /Stopped/);
    assert.match(h.container.textContent ?? '', /12 of 500 characters retained/);
    assert.equal(h.container.querySelector('pre')?.textContent, '<script>bad()</script>partial');
    await render(item({ kind: 'turn_failed', status: 'error', text: 'Runtime closed unexpectedly' }));
    assert.match(h.container.textContent ?? '', /Failed/); assert.doesNotMatch(h.container.textContent ?? '', /Stopped/);
});

test('throttled text flushes empty, whitespace and final replacements immediately across identities', bounded, async t => {
    const h = await surface(t);
    function Probe({ text, final, identity }: { text: string; final: boolean; identity: string }) {
        return createElement('span', null, useThrottledMarkdown(text, final, identity));
    }
    await h.render(createElement(Probe, { text: 'streaming prefix', final: false, identity: 'a' }));
    for (const text of ['', '   ', 'exact final']) {
        await h.render(createElement(Probe, { text, final: true, identity: 'a' })); assert.equal(h.container.textContent, text);
    }
    await h.render(createElement(Probe, { text: 'new session', final: false, identity: 'b' })); assert.equal(h.container.textContent, 'new session');
});

test('failed rename keeps the edited title and inline error until explicit cancel', bounded, async t => {
    const h = await surface(t); const calls: unknown[] = [];
    await h.render(createElement(CodeSessionList, { controller: model({ async rename(id, title) {
        calls.push([id, title]); throw Error('Title update rejected');
    } }) }));
    await click(button(h.container, 'Rename'));
    const input = h.container.querySelector<HTMLInputElement>('[aria-label="Session title"]'); assert.ok(input);
    await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'My edited title');
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await act(async () => input.closest('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    assert.deepEqual(calls, [['s-a', 'My edited title']]);
    assert.equal(h.container.querySelector<HTMLInputElement>('[aria-label="Session title"]')?.value, 'My edited title');
    assert.match(h.container.textContent ?? '', /Title update rejected/);
    await key(input, 'Escape'); assert.equal(h.container.querySelector('[aria-label="Session title"]'), null);
});

test('terminal append bypasses an active Markdown throttle interval in its first render', bounded, async t => {
    const h = await surface(t); const renders: string[] = [];
    t.mock.method(Date, 'now', () => 1000);
    function Probe({ text, final }: { text: string; final: boolean }) {
        const shown = useThrottledMarkdown(text, final, 'same-item');
        renders.push(shown); return createElement('span', null, shown);
    }
    await h.render(createElement(Probe, { text: 'start', final: false }));
    await h.render(createElement(Probe, { text: 'start streaming', final: false }));
    renders.length = 0;
    await h.render(createElement(Probe, { text: 'start streaming final', final: true }));
    assert.equal(renders[0], 'start streaming final');
    assert.equal(h.container.textContent, 'start streaming final');
});

test('assistant uses sanitized Markdown, math and linear tables; local file opens only on explicit click', bounded, async t => {
    const h = await surface(t); const opened: string[] = [];
    await import('../../public/manager/src/notes/rendering/MarkdownRenderer');
    const text = '**Result**\n\n$x^2$\n\n| Name | Value |\n| --- | --- |\n| alpha | 42 |\n\nOpen /tmp/report.md.\n\n[Unsafe](javascript:alert%281%29)\n\n<script>bad()</script>\n\n![private](/Users/example/secret.png)';
    await h.render(createElement(CodeTranscriptItem, { item: item({ kind: 'assistant_message', phase: 'final', status: 'done', text }),
        provider: 'claude', sessionKey: 'markdown-session', onOpenLocalFile: path => opened.push(path) }));
    assert.equal(h.container.querySelector('strong')?.textContent, 'Result');
    assert.ok(h.container.querySelector('.katex'), 'math must pass through the established math renderer');
    assert.ok(h.container.querySelector('.markdown-linear-table'));
    assert.equal(h.container.querySelector('.markdown-linear-table-td')?.textContent, 'alpha');
    assert.equal(h.container.querySelector('script'), null);
    assert.equal(h.container.querySelector('a[href^="javascript:"]'), null);
    assert.equal(h.container.querySelector('img[src^="/Users/"]'), null);
    assert.deepEqual(opened, []);
    await click(button(h.container, 'report.md')); assert.deepEqual(opened, ['/tmp/report.md']);
});

function virtualGeometry(t: TestContext) {
    const prototype = dom.window.HTMLElement.prototype;
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    const offsets = new WeakMap<HTMLElement, number>();
    const properties: Record<string, PropertyDescriptor> = {
        offsetWidth: { get() { return 1000; } },
        offsetHeight: { get(this: HTMLElement) { return this.classList.contains('code-transcript') ? 600 : 92; } },
        clientHeight: { get() { return 600; } },
        scrollHeight: { get(this: HTMLElement) { return Math.max(600, Number.parseFloat(this.querySelector<HTMLElement>('.code-transcript-virtual-spacer')?.style.height ?? '0') || 0); } },
        scrollTop: {
            get(this: HTMLElement) { return offsets.get(this) ?? 0; },
            set(this: HTMLElement, value: number) { offsets.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))); },
        },
    };
    for (const [key, value] of Object.entries(properties)) {
        descriptors.set(key, Object.getOwnPropertyDescriptor(prototype, key));
        Object.defineProperty(prototype, key, { configurable: true, ...value });
    }
    t.after(() => {
        for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(prototype, key, descriptor);
            else Reflect.deleteProperty(prototype, key);
        }
    });
}

test('real virtualizer keeps item DOM identity through equal text, updates and prepend, while bounding rendered rows', bounded, async t => {
    const h = await surface(t); virtualGeometry(t);
    const a = item({ itemId: 'a', firstSequence: 1, text: 'same text' });
    const b = item({ itemId: 'b', firstSequence: 2, text: 'same text' });
    const render = (items: CodeItem[]) => h.render(createElement(CodeTranscript, {
        items, provider: 'codex-app', sessionKey: 'virtual-session', workingDir: '/tmp/work', loading: false,
        hasOlderHistory: false, async loadOlderHistory() {}, permissionCount: 0,
    }));
    await render([a, b]);
    const before = h.container.querySelector('[data-code-item-id="a"]'); assert.ok(before);
    assert.equal(h.container.querySelectorAll('[data-code-item-id]').length, 2, 'equal text is two real items');
    await render([{ ...a, text: 'same text updated' }, b]);
    assert.equal(h.container.querySelector('[data-code-item-id="a"]'), before);
    await render([item({ itemId: 'older', firstSequence: 0, text: 'older text' }), { ...a, text: 'same text updated' }, b]);
    assert.equal(h.container.querySelector('[data-code-item-id="a"]'), before);
    const many = Array.from({ length: 200 }, (_, index) => item({ itemId: `row-${index}`, firstSequence: index + 1, text: `Message ${index}` }));
    await render(many);
    const rows = h.container.querySelectorAll('[data-code-item-id]');
    assert.ok(rows.length > 0 && rows.length < 40, `virtualized DOM must stay bounded, got ${rows.length}`);
});

test('CodeCanvas uses the sidebar portal and forwards workspace and explicit file-open callbacks', bounded, async t => {
    const h = await surface(t); virtualGeometry(t);
    await import('../../public/manager/src/notes/rendering/MarkdownRenderer');
    const { CodeCanvas } = await import('../../public/manager/src/code/CodeCanvas');
    const host = document.createElement('div'); host.id = 'code-session-sidebar-host'; document.body.append(host);
    const oldSource = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
    const sources: Array<{ closed: boolean }> = [];
    class FixtureEventSource {
        static CLOSED = 2;
        readyState = 0;
        onopen: (() => void) | null = null;
        onmessage: ((event: MessageEvent<string>) => void) | null = null;
        onerror: (() => void) | null = null;
        closed = false;
        constructor(_url: string) { sources.push(this); }
        close() { this.closed = true; }
    }
    globals['EventSource'] = FixtureEventSource;
    t.after(() => {
        host.remove();
        if (oldSource) Object.defineProperty(globalThis, 'EventSource', oldSource); else delete globals['EventSource'];
    });
    const calls: Array<[string, string]> = [], picked: Array<string | null> = [], files: string[] = [];
    const s = session(); const catalog = model().catalog!;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
        const method = options?.method ?? 'GET'; calls.push([method, path]);
        let data: object;
        if (path === '/api/code/models') data = catalog;
        else if (path === '/api/code/sessions') data = { sessions: [s], limit: 100, offset: 0, hasMore: false };
        else if (path === '/api/code/git-info') data = { isRepo: false, branch: null, worktrees: [] };
        else if (path === '/api/code/workspace/pick') data = { path: '/tmp/chosen' };
        else if (path === '/api/code/sessions/s-a') data = { session: s, sequence: s.sequence, truncated: false, pendingPermissions: [],
            items: [item({ firstSequence: 1, kind: 'assistant_message', phase: 'final', text: 'Open /tmp/report.md.' })] };
        else if (path === '/api/code/sessions/s-a/events') data = { events: [], nextSequence: s.sequence, throughSequence: s.sequence, hasMore: false };
        else throw Error(`Unexpected fixture request ${method} ${path}`);
        return new Response(JSON.stringify({ ok: true, ...data }), { headers: { 'content-type': 'application/json' } });
    });
    await h.render(createElement(CodeCanvas, { port: 43227, workingDir: '/tmp/work', onWorkingDirChange: path => picked.push(path), onOpenLocalFile: path => files.push(path) }));
    assert.ok(host.querySelector('nav[aria-label="Code sessions"]'));
    assert.equal(h.container.querySelector('.code-canvas-sidebar'), null);
    await click(button(h.container, 'Choose Code workspace')); assert.deepEqual(picked, ['/tmp/chosen']);
    const alpha = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.querySelector('.code-session-cwd')?.textContent === 'Alpha'); assert.ok(alpha);
    await click(alpha);
    assert.deepEqual(files, []); await click(button(h.container, 'report.md')); assert.deepEqual(files, ['/tmp/report.md']);
    assert.deepEqual(calls.filter(([method]) => method !== 'GET'), [['POST', '/api/code/workspace/pick']], 'navigation and file preview must not start or prompt a runtime');
    await h.render(null);
    assert.ok(sources.length > 0 && sources.every(source => source.closed));
    assert.equal(host.querySelector('nav'), null);
});

test('unknown creation recovery warns, preserves the draft and choices, and requires a separate Send', bounded, async t => {
    const h = await surface(t); let recoveries = 0, sends = 0, normalNew = 0;
    const selection = { provider: 'claude' as const, cwd: '/tmp/selected-workspace', model: 'native-model', effort: 'low', permissionMode: 'ask' as const };
    let c = model({ selectedId: null, session: null, creationUnknown: true, input: 'unsent text after lost create response', selection,
        operation: { kind: 'creating', error: 'Creation could not be confirmed' },
        startAnotherSession() {
            recoveries++;
            c = { ...c, creationUnknown: false, operation: { kind: 'idle', error: null } };
        },
        newSession() { normalNew++; }, async send() { sends++; },
    });
    const render = () => h.render(createElement(CodeWorkbench, { controller: c, endpointKey: '43225' }));
    await render();
    const recovery = h.container.querySelector('[aria-label="Unconfirmed session creation"]'); assert.ok(recovery);
    assert.match(recovery.textContent ?? '', /The original session may still exist/);
    assert.match(recovery.textContent ?? '', /Press Send/);
    assert.equal(button(h.container, 'Send prompt').disabled, true);
    assert.equal(button(h.container, 'Runtime').disabled, true);
    assert.equal(h.container.querySelector('textarea')?.readOnly, false, 'uncertain creation does not discard or lock the text');
    await click(button(h.container, 'Start another session'));
    assert.equal(recoveries, 1); assert.equal(normalNew, 0); assert.equal(sends, 0);
    await render();
    assert.equal(h.container.querySelector('[aria-label="Unconfirmed session creation"]'), null);
    assert.equal(h.container.querySelector('textarea')?.value, 'unsent text after lost create response');
    assert.deepEqual(c.selection, selection);
    assert.equal(button(h.container, 'Send prompt').disabled, false);
    assert.equal(button(h.container, 'Runtime').disabled, false);
    assert.equal(h.container.querySelector<HTMLInputElement>('[aria-label="Native model ID"]')?.value, 'native-model');
    assert.match(button(h.container, 'Effort').textContent ?? '', /low/);
    assert.equal(sends, 0, 'recovery and rerender must not send automatically');
    await click(button(h.container, 'Send prompt')); assert.equal(sends, 1);
});

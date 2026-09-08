import assert from 'node:assert/strict';
import { after, mock, test, type TestContext } from 'node:test';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import type { ReactNode } from 'react';
import type { ITerminalOptions } from '@xterm/xterm';
import type { TerminalBridgeApi, TerminalSessionSnapshot } from '../../public/manager/src/panels/desktop-bridge';

// No shell, HTTP listener, native module or real home is used by this fixture.
// Only these two CSS imports are replaced; all other loaders keep their owner.
const cssURLs = new Set([
    new URL('../../public/manager/src/terminal/terminal.css', import.meta.url).href,
    import.meta.resolve('@xterm/xterm/css/xterm.css'),
]);
const cssLoads = new Set<string>();
const hooks = registerHooks({ load(url, context, nextLoad) {
    if (!cssURLs.has(url)) return nextLoad(url, context);
    cssLoads.add(url);
    return { format: 'module', source: 'export {};', shortCircuit: true };
} });
const dom = new JSDOM('<!doctype html><html data-theme="dark"><body></body></html>', { url: 'https://terminal.test/' });
const timeouts = new Map<number, () => void>();
const intervals = new Map<number, () => void>();
let timerId = 0;
dom.window.setTimeout = (handler: TimerHandler) => {
    assert.equal(typeof handler, 'function');
    const id = ++timerId;
    timeouts.set(id, handler as () => void);
    return id;
};
dom.window.clearTimeout = id => { if (id !== undefined) timeouts.delete(id); };
dom.window.setInterval = (handler: TimerHandler) => {
    assert.equal(typeof handler, 'function');
    const id = ++timerId;
    intervals.set(id, handler as () => void);
    return id;
};
dom.window.clearInterval = id => { if (id !== undefined) intervals.delete(id); };
const mediaListeners = new Set<EventListenerOrEventListenerObject>();
let prefersLight = false;
const media = {
    get matches() { return prefersLight; }, media: '(prefers-color-scheme: light)', onchange: null,
    addEventListener: (_type: string, callback: EventListenerOrEventListenerObject) => mediaListeners.add(callback),
    removeEventListener: (_type: string, callback: EventListenerOrEventListenerObject) => mediaListeners.delete(callback),
    addListener() {}, removeListener() {}, dispatchEvent: () => true,
} as MediaQueryList;
dom.window.matchMedia = () => media;
const resizeObservers = new Set<FakeResizeObserver>();
class FakeResizeObserver {
    constructor(readonly callback: ResizeObserverCallback) {}
    observe() { resizeObservers.add(this); }
    unobserve() {}
    disconnect() { resizeObservers.delete(this); }
}
const mutationObservers = new Set<TrackedMutationObserver>();
class TrackedMutationObserver extends dom.window.MutationObserver {
    override observe(target: Node, options?: MutationObserverInit) { mutationObservers.add(this); super.observe(target, options); }
    override disconnect() { mutationObservers.delete(this); super.disconnect(); }
}
const replacements = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    CustomEvent: dom.window.CustomEvent, MutationObserver: TrackedMutationObserver,
    ResizeObserver: FakeResizeObserver, IS_REACT_ACT_ENVIRONMENT: true,
    React: await import('react'),
};
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { act, createElement, useState, StrictMode } = await import('react');
const { createRoot } = await import('react-dom/client');
let currentBridge: TerminalBridgeApi | null = null;
const terminals: FakeTerminal[] = [];
const eventDisposables = new Set<object>();
class FakeTerminal {
    options: ITerminalOptions;
    cols = 80;
    rows = 24;
    element: HTMLDivElement | null = null;
    input: HTMLTextAreaElement | null = null;
    writes: string[] = [];
    focused = 0;
    refreshed = 0;
    disposed = false;
    data?: (value: string) => void;
    resize?: (size: { cols: number; rows: number }) => void;
    constructor(options: ITerminalOptions) { this.options = options; terminals.push(this); }
    loadAddon() {}
    open(node: HTMLDivElement) {
        this.element = node;
        this.input = dom.window.document.createElement('textarea');
        this.input.className = 'fake-xterm-input';
        node.append(this.input);
    }
    write(value: string) { this.writes.push(value); }
    writeln(value: string) { this.write(value); }
    focus() { this.focused += 1; this.input?.focus(); }
    clear() { this.writes = []; }
    refresh() { this.refreshed += 1; }
    dispose() { this.disposed = true; this.input?.remove(); }
    onData(fn: (value: string) => void) { this.data = fn; return this.disposable(); }
    onResize(fn: (size: { cols: number; rows: number }) => void) { this.resize = fn; return this.disposable(); }
    private disposable() {
        const entry = { dispose: () => { eventDisposables.delete(entry); } };
        eventDisposables.add(entry);
        return entry;
    }
}
const fitAddons: FakeFitAddon[] = [];
class FakeFitAddon {
    fail = false;
    constructor() { fitAddons.push(this); }
    fit() { if (this.fail) throw new Error('fixture fit failed'); }
}
mock.module('@xterm/xterm', { namedExports: { Terminal: FakeTerminal } });
mock.module('@xterm/addon-fit', { namedExports: { FitAddon: FakeFitAddon } });
mock.module('../../public/manager/src/terminal/terminal-bridge.ts', { namedExports: { getTerminalBridge: () => currentBridge } });

after(() => {
    hooks.deregister();
    mock.reset();
    for (const observer of mutationObservers) observer.disconnect();
    for (const observer of resizeObservers) observer.disconnect();
    timeouts.clear(); intervals.clear();
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});
const { TerminalPanel } = await import('../../public/manager/src/terminal/TerminalPanel');
const { resolveTerminalTheme } = await import('../../public/manager/src/terminal/terminal-theme');
const { TERMINAL_QUEUE_OVERFLOW, takeTerminalShortcutQueue } = await import('../../public/manager/src/terminal/terminal-shortcut-queue');
const { PanelLayoutProvider } = await import('../../public/manager/src/panels/PanelLayoutProvider');
const { BottomPanel } = await import('../../public/manager/src/panels/BottomPanel');
const { DesktopPanelControls } = await import('../../public/manager/src/components/DesktopPanelControls');
const { panelShortcutBus } = await import('../../public/manager/src/panels/panel-shortcut-bus');

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
type ListResult = Awaited<ReturnType<TerminalBridgeApi['list']>>;
type CreateResult = Awaited<ReturnType<TerminalBridgeApi['create']>>;
function bridgeFixture() {
    const lists: ReturnType<typeof deferred<ListResult>>[] = [];
    const creates: ReturnType<typeof deferred<CreateResult>>[] = [];
    const kills: string[] = [];
    const writes: Array<[string, string]> = [];
    const resizes: Array<[string, number, number]> = [];
    const data = new Set<(id: string, data: string) => void>();
    const exit = new Set<(id: string, code: number | null) => void>();
    let outstanding = 0;
    let maxOutstanding = 0;
    const bridge: TerminalBridgeApi = {
        list: () => { const value = deferred<ListResult>(); lists.push(value); return value.promise; },
        create: () => {
            const value = deferred<CreateResult>(); creates.push(value);
            maxOutstanding = Math.max(maxOutstanding, ++outstanding);
            return value.promise.finally(() => { outstanding -= 1; });
        },
        kill: async id => { kills.push(id); },
        write: async (id, text) => { writes.push([id, text]); },
        resize: async (id, cols, rows) => { resizes.push([id, cols, rows]); },
        onData: fn => { data.add(fn); return () => { data.delete(fn); }; },
        onExit: fn => { exit.add(fn); return () => { exit.delete(fn); }; },
    };
    return { bridge, lists, creates, kills, writes, resizes, data, exit, get maxOutstanding() { return maxOutstanding; } };
}
function snapshot(id: string, shell = '/bin/zsh'): TerminalSessionSnapshot {
    return { id, shell, cwd: `/fixture/${id}`, cols: 80, rows: 24, buffer: `saved-${id}` };
}
async function settle<T>(pending: ReturnType<typeof deferred<T>> | undefined, result: T) {
    assert.ok(pending, 'Expected an admitted bridge operation');
    await act(async () => { pending.resolve(result); });
}
async function flushTimers() {
    // These are component-owned timers only. No sleeps and no real clocks.
    for (let round = 0; timeouts.size > 0; round += 1) {
        assert.ok(round < 20, 'Unexpected timer loop');
        const batch = [...timeouts.entries()];
        await act(async () => {
            for (const [id, callback] of batch) if (timeouts.delete(id)) callback();
        });
    }
}
async function shortcut(detail: string, count = 1) {
    await act(async () => {
        for (let i = 0; i < count; i++) document.dispatchEvent(new dom.window.CustomEvent('jaw:shortcut-action', { detail }));
    });
}
async function emitExit(f: ReturnType<typeof bridgeFixture>, id: string) {
    await act(async () => { for (const callback of f.exit) callback(id, 0); });
}
async function mount(t: TestContext, options: { fixture?: ReturnType<typeof bridgeFixture>; element?: ReactNode; strict?: boolean } = {}) {
    const f = options.fixture ?? bridgeFixture();
    currentBridge = f.bridge;
    terminals.length = 0;
    fitAddons.length = 0;
    const container = document.createElement('div');
    container.className = 'bottom-panel';
    container.setAttribute('aria-hidden', 'false');
    document.body.append(container);
    const empty = t.mock.fn();
    const collapse = t.mock.fn(() => container.setAttribute('aria-hidden', 'true'));
    const root = createRoot(container);
    let mounted = true;
    // JSDOM has no CSS layout. This geometry substitute exercises focus guards;
    // it does not certify rendered layout, overflow or real xterm measurement.
    const geometry = dom.window.HTMLElement.prototype.getClientRects;
    dom.window.HTMLElement.prototype.getClientRects = function () {
        const shown = this.isConnected && this.classList.contains('is-active') && !this.closest('[aria-hidden="true"], [hidden], [inert]');
        return (shown ? [{ x: 0, y: 0, width: 600, height: 180 }] : []) as unknown as DOMRectList;
    };
    const unmount = async () => {
        if (!mounted) return;
        await act(async () => root.unmount()); mounted = false;
    };
    t.after(async () => {
        await unmount();
        container.remove();
        dom.window.HTMLElement.prototype.getClientRects = geometry;
        takeTerminalShortcutQueue(window);
        assert.equal(f.data.size, 0); assert.equal(f.exit.size, 0);
        assert.equal(eventDisposables.size, 0); assert.equal(intervals.size, 0);
        assert.equal(resizeObservers.size, 0); assert.equal(mutationObservers.size, 0);
        assert.equal(mediaListeners.size, 0); assert.equal(timeouts.size, 0);
        assert.ok(terminals.every(term => term.disposed));
        document.documentElement.dataset['theme'] = 'dark';
        delete document.documentElement.dataset['cliJawDesktop'];
        prefersLight = false;
    });
    const element = options.element ?? createElement(TerminalPanel, { onCollapse: collapse, onEmptySessions: empty });
    await act(async () => root.render(options.strict ? createElement(StrictMode, null, element) : element));
    const get = <T extends HTMLElement = HTMLElement>(selector: string) => {
        const node = container.querySelector<T>(selector); assert.ok(node, selector); return node;
    };
    const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const click = async (selector: string) => { await act(async () => get(selector).click()); };
    return { f, container, empty, collapse, unmount, get, tabs, click };
}

test('CSS load hook is exact and theme resolver returns usable fixed palettes', () => {
    assert.deepEqual(cssLoads, cssURLs);
    const dark = resolveTerminalTheme('dark', true);
    const light = resolveTerminalTheme('light', false);
    assert.equal(dark.background, '#0a0a0a'); assert.equal(dark.foreground, '#f1f3f7');
    assert.equal(light.background, '#fcfcfc'); assert.equal(light.foreground, '#27272a');
    assert.deepEqual(resolveTerminalTheme('auto', true), light);
    assert.deepEqual(resolveTerminalTheme('auto', false), dark);
    assert.deepEqual(resolveTerminalTheme(null, true), dark);
    for (const palette of [dark, light]) for (const color of Object.values(palette)) assert.match(color, /^#[0-9a-f]{6}$/i);
});

test('both New buttons and shortcuts queue behind hydration and serialize exactly requested creates', async t => {
    const view = await mount(t);
    await view.click('.terminal-new-tab');
    await view.click('.terminal-empty button');
    await shortcut('terminalNewTab');
    assert.equal(view.f.creates.length, 0);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    assert.equal(view.tabs()[0]?.textContent, '1: zsh');
    assert.equal(view.f.creates.length, 1);
    assert.equal(view.get<HTMLButtonElement>('.terminal-new-tab').disabled, true);
    for (const [index, id] of ['b', 'c', 'd'].entries()) {
        await settle(view.f.creates[index], { ok: true, id, shell: '/bin/zsh', cwd: `/fixture/${id}` });
        assert.equal(view.f.creates.length, Math.min(index + 2, 3));
    }
    assert.deepEqual(view.tabs().map(tab => tab.textContent), ['1: zsh', '2: zsh', '3: zsh', '4: zsh']);
    assert.equal(view.f.maxOutstanding, 1);
    await flushTimers();
    assert.equal(view.empty.mock.callCount(), 0);
});

test('rejected creation discards pending continuation, preserves tabs and permits explicit retry', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    await shortcut('newTerminalSession', 4);
    await act(async () => view.f.creates[0]!.reject(new Error('fixture denied')));
    await flushTimers();
    assert.equal(view.f.creates.length, 1);
    assert.match(view.get('[role="status"]').textContent!, /fixture denied/);
    assert.equal(view.tabs().length, 1);
    assert.equal(view.get<HTMLButtonElement>('.terminal-new-tab').disabled, false);
    await view.click('.terminal-new-tab');
    await settle(view.f.creates[1], { ok: true, id: 'b' });
    assert.equal(view.container.querySelector('[role="status"]'), null);
    assert.equal(view.f.lists.length, 1);
    assert.equal(view.tabs().length, 2);
    assert.deepEqual(view.f.kills, []);
});

test('failed list never creates from unknown state and recovery explicitly re-lists without replay', async t => {
    const view = await mount(t);
    await shortcut('newTerminalSession', 3);
    await settle(view.f.lists[0], { ok: false, error: 'list unavailable' });
    await flushTimers();
    assert.equal(view.f.creates.length, 0);
    assert.equal(view.f.lists.length, 1);
    assert.match(view.get('[role="status"]').textContent!, /New terminal to retry/);
    await view.click('.terminal-empty button');
    assert.equal(view.f.lists.length, 2);
    await settle(view.f.lists[1], { ok: true, sessions: [snapshot('restored')] });
    await settle(view.f.creates[0], { ok: true, id: 'new' });
    assert.equal(view.f.creates.length, 1);
    assert.deepEqual(view.f.writes, []);
    assert.deepEqual(view.f.kills, []);
});

test('rejected list also requires explicit recovery', async t => {
    const view = await mount(t);
    await act(async () => view.f.lists[0]!.reject(new Error('offline')));
    await shortcut('focusTerminal');
    await flushTimers();
    assert.equal(view.f.lists.length, 1); assert.equal(view.f.creates.length, 0);
    assert.equal(view.empty.mock.callCount(), 0);
    await view.click('.terminal-new-tab');
    await settle(view.f.lists[1], { ok: true, sessions: [] });
    await settle(view.f.creates[0], { ok: false, error: 'shell unavailable' });
    assert.match(view.get('[role="status"]').textContent!, /shell unavailable/);
    assert.equal(view.empty.mock.callCount(), 0);
});

test('pending limit includes the in-flight create; backend live-session rejection remains authoritative', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    await shortcut('newTerminalSession', 25);
    assert.equal(view.f.creates.length, 1);
    assert.match(view.get('[role="status"]').textContent!, /limit 16/);
    // Fake backend permits seven more, then enforces its unchanged limit of 8.
    for (let i = 0; i < 7; i++) await settle(view.f.creates[i], { ok: true, id: `new-${i}` });
    await settle(view.f.creates[7], { ok: false, error: 'Max sessions reached' });
    await flushTimers();
    assert.equal(view.f.creates.length, 8); assert.equal(view.tabs().length, 8);
    assert.equal(view.f.maxOutstanding, 1);
    assert.match(view.get('[role="status"]').textContent!, /Max sessions reached/);
    assert.deepEqual(view.f.kills, []);
});

test('manual roving handles only actual tab targets; activation and nearest close preserve stable ordinals', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a'), snapshot('b'), snapshot('c')] });
    await flushTimers();
    const [a, b, c] = view.tabs(); assert.ok(a && b && c);
    const key = async (target: HTMLElement, name: string) => {
        target.focus();
        const event = new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
        await act(async () => { target.dispatchEvent(event); });
        return event;
    };
    const focusCount = terminals.reduce((sum, term) => sum + term.focused, 0);
    for (const [from, name, to] of [[c, 'Home', a], [a, 'ArrowRight', b], [b, 'End', c], [c, 'ArrowLeft', b]] as const) {
        assert.equal((await key(from, name)).defaultPrevented, true);
        await flushTimers(); assert.equal(document.activeElement, to);
        assert.equal(to.tabIndex, 0);
        assert.equal(view.tabs().filter(tab => tab.tabIndex === 0).length, 1);
        assert.equal(c.getAttribute('aria-selected'), 'true');
    }
    assert.equal(terminals.reduce((sum, term) => sum + term.focused, 0), focusCount);
    for (const name of ['Enter', ' ']) {
        const event = await key(b, name);
        assert.equal(event.defaultPrevented, false);
        // JSDOM does not synthesize a native keyboard click.
        if (!event.defaultPrevented) await act(async () => b.click());
        await flushTimers(); assert.equal(b.getAttribute('aria-selected'), 'true');
        assert.equal(document.activeElement, terminals[1]?.input);
    }
    const close = view.get<HTMLButtonElement>('[aria-label="Close 1: zsh session"]');
    assert.equal(close.parentElement, a.parentElement); assert.equal(a.contains(close), false);
    for (const name of ['ArrowLeft', 'Home', 'End', 'Enter', ' ']) assert.equal((await key(close, name)).defaultPrevented, false);
    await act(async () => close.click());
    assert.equal(b.getAttribute('aria-selected'), 'true');
    await view.click('[aria-label="Close 2: zsh session"]');
    assert.deepEqual(view.tabs().map(tab => tab.textContent), ['3: zsh']);
    assert.equal(c.getAttribute('aria-selected'), 'true');
    assert.equal(c.title, '3: zsh — /fixture/c');
    assert.equal(view.get(`#${c.getAttribute('aria-controls')}`).getAttribute('aria-labelledby'), c.id);
    assert.deepEqual(view.f.kills, ['a', 'b']);
});

test('theme attribute and OS changes refresh existing xterm and CSS without list/create/kill', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    await flushTimers();
    const runtime = terminals[0]!;
    const mediaChange = async (light: boolean) => {
        prefersLight = light;
        await act(async () => {
            for (const listener of mediaListeners) {
                const event = new dom.window.Event('change');
                if (typeof listener === 'function') listener(event); else listener.handleEvent(event);
            }
        });
    };
    for (const [attribute, osLight, expected] of [['light', false, '#fcfcfc'], ['dark', true, '#0a0a0a'], ['auto', true, '#fcfcfc'], ['auto', false, '#0a0a0a']] as const) {
        await act(async () => { document.documentElement.dataset['theme'] = attribute; });
        await mediaChange(osLight);
        assert.equal(runtime.options.theme?.background, expected);
        assert.equal(view.get('.terminal-panel').style.getPropertyValue('--terminal-background'), expected);
    }
    assert.ok(runtime.refreshed > 0);
    assert.equal(terminals.length, 1); assert.equal(view.f.lists.length, 1);
    assert.equal(view.f.creates.length, 0); assert.deepEqual(view.f.kills, []);
});

test('empty initial snapshot auto-creates once, natural last exit closes, and unknown exits stay inert', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [] });
    await settle(view.f.creates[0], { ok: true, id: 'initial' });
    await emitExit(view.f, 'initial');
    await flushTimers();
    assert.equal(view.empty.mock.callCount(), 1);
    assert.equal(view.tabs().length, 0);
    assert.equal(view.f.creates.length, 1);
    for (let i = 0; i < 300; i++) await emitExit(view.f, `unknown-${i}`);
    await act(async () => { for (const fn of view.f.data) fn('unknown', 'ignored'); });
    assert.equal(view.container.querySelector('[role="status"]'), null);
    assert.equal(view.empty.mock.callCount(), 1);
    assert.deepEqual(view.f.kills, []);
});

test('closing last session defers empty notification across successful create and never closes a new tab', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    await view.click('.terminal-new-tab');
    await view.click('[aria-label="Close 1: zsh session"]');
    await flushTimers();
    assert.equal(view.empty.mock.callCount(), 0);
    await settle(view.f.creates[0], { ok: true, id: 'b' });
    await flushTimers();
    assert.equal(view.empty.mock.callCount(), 0);
    assert.equal(view.tabs()[0]?.textContent, '2: sh');
    await view.click('[aria-label="Close 2: sh session"]');
    // New intent arrives after last-close schedules its callback, before it fires.
    await shortcut('newTerminalSession');
    await settle(view.f.creates[1], { ok: true, id: 'c' });
    await flushTimers();
    assert.equal(view.empty.mock.callCount(), 0);
    assert.deepEqual(view.f.kills, ['a', 'b']);
});

test('failed create after last close leaves recovery controls visible and no empty callback', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    await view.click('.terminal-new-tab');
    await view.click('[aria-label="Close 1: zsh session"]');
    await settle(view.f.creates[0], { ok: false, error: 'spawn denied' });
    await flushTimers();
    assert.equal(view.empty.mock.callCount(), 0);
    assert.equal(view.container.getAttribute('aria-hidden'), 'false');
    assert.match(view.get('[role="status"]').textContent!, /spawn denied/);
    assert.equal(view.get<HTMLButtonElement>('.terminal-empty button').disabled, false);
});

test('list/create exit tombstones prevent resurrection, including an all-exited initial snapshot', async t => {
    const view = await mount(t);
    await emitExit(view.f, 'dead');
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('dead')] });
    await flushTimers();
    assert.equal(view.tabs().length, 0);
    assert.equal(view.f.creates.length, 0);
    assert.equal(view.empty.mock.callCount(), 1);
    await view.click('.terminal-new-tab');
    await emitExit(view.f, 'brief');
    await settle(view.f.creates[0], { ok: true, id: 'brief' });
    await flushTimers();
    assert.equal(view.tabs().length, 0);
    assert.equal(terminals.length, 0);
    assert.deepEqual(view.f.kills, []);
});

test('bounded tombstone overflow invalidates delayed list and requires explicit resync', async t => {
    const view = await mount(t);
    await shortcut('newTerminalSession');
    await act(async () => {
        for (let i = 0; i < 129; i++) for (const callback of view.f.exit) callback(`exit-${i}`, 0);
    });
    assert.match(view.get('[role="status"]').textContent!, /resync/);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('exit-0'), snapshot('possibly-alive')] });
    await flushTimers();
    assert.equal(terminals.length, 0); assert.equal(view.f.creates.length, 0);
    assert.equal(view.empty.mock.callCount(), 0);
    await view.click('.terminal-new-tab');
    await settle(view.f.lists[1], { ok: true, sessions: [snapshot('confirmed')] });
    await settle(view.f.creates[0], { ok: true, id: 'new' });
    assert.equal(view.tabs().length, 2);
    assert.deepEqual(view.f.kills, []);
});

test('create tombstone overflow discards its result and queued continuation without implicit kill', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    await shortcut('newTerminalSession', 3);
    await act(async () => {
        for (let i = 0; i < 129; i++) for (const callback of view.f.exit) callback(`unknown-${i}`, 0);
    });
    await settle(view.f.creates[0], { ok: true, id: 'possibly-exited' });
    await flushTimers();
    assert.equal(view.tabs().length, 1); assert.equal(view.f.creates.length, 1);
    assert.equal(view.get<HTMLButtonElement>('.terminal-new-tab').disabled, false);
    await view.click('.terminal-new-tab');
    assert.equal(view.f.lists.length, 2); assert.equal(view.f.creates.length, 1);
    await settle(view.f.lists[1], { ok: true, sessions: [snapshot('a'), snapshot('confirmed')] });
    await settle(view.f.creates[1], { ok: true, id: 'new' });
    assert.equal(view.tabs().length, 3); assert.deepEqual(view.f.kills, []);
});

test('unknown output is bounded by ID count and per-ID size; loss cannot admit an uncertain snapshot', async t => {
    const view = await mount(t);
    await act(async () => {
        for (let i = 0; i < 17; i++) for (const callback of view.f.data) callback(`output-${i}`, 'partial');
    });
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('output-0')] });
    assert.equal(view.tabs().length, 0); assert.match(view.get('[role="status"]').textContent!, /resync/);
    await view.click('.terminal-new-tab');
    await act(async () => { for (const callback of view.f.data) callback('large', 'x'.repeat(32_769)); });
    await settle(view.f.lists[1], { ok: true, sessions: [snapshot('large')] });
    assert.equal(view.tabs().length, 0); assert.equal(view.f.creates.length, 0);
    assert.equal(view.empty.mock.callCount(), 0); assert.deepEqual(view.f.kills, []);
});

test('old hydration finally cannot release a newer StrictMode mount operation', async t => {
    const view = await mount(t, { strict: true });
    assert.equal(view.f.lists.length, 2);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('stale')] });
    await shortcut('newTerminalSession');
    assert.equal(view.f.creates.length, 0); assert.equal(view.tabs().length, 0);
    await settle(view.f.lists[1], { ok: true, sessions: [snapshot('current')] });
    assert.equal(view.f.creates.length, 1);
    await settle(view.f.creates[0], { ok: true, id: 'new' });
    assert.equal(view.tabs().length, 2);
    assert.equal(view.f.maxOutstanding, 1);
});

test('unmount during create preserves backend ownership and ignores late results/finally/focus', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    await view.click('.terminal-new-tab');
    await view.unmount();
    const count = terminals.length;
    await settle(view.f.creates[0], { ok: true, id: 'backend-owned' });
    await flushTimers();
    assert.equal(terminals.length, count); assert.deepEqual(view.f.kills, []);
    assert.equal(view.empty.mock.callCount(), 0);
});

test('unmount during list ignores late inventory and never auto-creates', async t => {
    const view = await mount(t);
    await view.unmount();
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('late')] });
    assert.equal(terminals.length, 0); assert.equal(view.f.creates.length, 0);
    assert.deepEqual(view.f.kills, []);
});

test('keyboard tab focus, collapse and detached surfaces invalidate deferred xterm focus', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a'), snapshot('b')] });
    await act(async () => view.tabs()[0]!.focus());
    await flushTimers();
    assert.equal(document.activeElement, view.tabs()[0]);
    assert.ok(terminals.every(term => term.focused === 0));
    await view.click('.terminal-new-tab');
    await view.click('.terminal-collapse-button');
    await settle(view.f.creates[0], { ok: true, id: 'hidden' });
    await flushTimers();
    assert.ok(terminals.every(term => term.focused === 0));
    view.container.setAttribute('aria-hidden', 'false');
    await shortcut('focusTerminal');
    view.container.remove();
    await flushTimers();
    assert.ok(terminals.every(term => term.focused === 0));
    document.body.append(view.container);
    await shortcut('focusTerminal');
    await flushTimers();
    assert.equal(view.get('[role="tab"][aria-selected="true"]').textContent, '2: zsh');
    assert.equal(terminals[1]?.focused, 1);
    assert.equal(terminals[2]?.focused, 0, 'hidden creation cannot replace the existing selection');
});

function WorkspaceFixture({ lazy = false, active = 'terminal' }: { lazy?: boolean; active?: 'terminal' | 'browser' }) {
    const [ready, setReady] = useState(!lazy);
    return createElement(PanelLayoutProvider, {
        initialPanelState: { bottomPanel: { open: true, height: 260, tabs: [active], activeTab: active } },
        children: createElement('div', null,
            createElement(DesktopPanelControls),
            createElement('button', { className: 'load-terminal', onClick: () => setReady(true) }, 'Load terminal'),
            createElement(BottomPanel, { renderTab: (tab, controls) => tab === 'terminal' && ready
                ? createElement(TerminalPanel, { onCollapse: controls.onCollapse, onEmptySessions: controls.onCloseTab })
                : createElement('span', { className: 'other-content' }, tab) }),
        ),
    });
}

test('desktop toggle selects terminal specifically; hide restores stable reveal button, reveal preserves PTYs', async t => {
    document.documentElement.dataset['cliJawDesktop'] = 'true';
    const view = await mount(t, { element: createElement(WorkspaceFixture, { active: 'browser' }) });
    const toggle = view.get<HTMLButtonElement>('#desktop-terminal-toggle');
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(view.f.lists.length, 0);
    await act(async () => toggle.click());
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    await flushTimers();
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(view.get('[role="separator"]').getAttribute('aria-valuenow'), '260');
    assert.equal(view.get('[role="separator"]').getAttribute('aria-label'), 'Resize bottom panel height');
    const runtime = terminals[0]!;
    assert.equal(document.activeElement, runtime.input);
    await view.click('.terminal-collapse-button');
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(document.activeElement, toggle);
    assert.equal(runtime.disposed, false);
    await act(async () => toggle.click());
    await flushTimers();
    assert.equal(document.activeElement, runtime.input);
    assert.equal(view.f.lists.length, 1); assert.equal(view.f.creates.length, 0); assert.deepEqual(view.f.kills, []);
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(view.f.creates.length, 0); assert.deepEqual(view.f.kills, []);
});

test('provider coalesces focus and caps deferred new intents, transfers once and surfaces overflow', async t => {
    document.documentElement.dataset['cliJawDesktop'] = 'true';
    const view = await mount(t, { element: createElement(WorkspaceFixture, { lazy: true }) });
    await act(async () => {
        for (let i = 0; i < 25; i++) { panelShortcutBus.dispatch('newTerminalSession'); panelShortcutBus.dispatch('focusTerminal'); }
    });
    assert.equal(view.f.lists.length, 0);
    const pending = window as Window & { __cliJawPendingTerminalActions?: string[] };
    assert.equal(pending.__cliJawPendingTerminalActions?.filter(value => value === 'newTerminalSession').length, 16);
    assert.equal(pending.__cliJawPendingTerminalActions?.filter(value => value === 'focusTerminal').length, 1);
    assert.equal(timeouts.size, 1, 'one provider flush, not one timer per shortcut');
    await view.click('.load-terminal');
    assert.deepEqual(pending.__cliJawPendingTerminalActions, []);
    assert.equal(view.get('[role="status"]').textContent, TERMINAL_QUEUE_OVERFLOW);
    await flushTimers();
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    // This permissive fake tests pending admission, not the real backend cap 8.
    for (let i = 0; i < 16; i++) await settle(view.f.creates[i], { ok: true, id: `created-${i}` });
    await shortcut('flushTerminalShortcutQueue');
    await flushTimers();
    assert.equal(view.f.creates.length, 16); assert.equal(view.f.maxOutstanding, 1);
    assert.equal(view.f.lists.length, 1); assert.deepEqual(view.f.kills, []);
});

test('provider handoff to an already busy receiver counts in-flight work and discards overflow without replay', async t => {
    document.documentElement.dataset['cliJawDesktop'] = 'true';
    const view = await mount(t, { element: createElement(WorkspaceFixture) });
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    await shortcut('newTerminalSession', 2);
    await act(async () => { for (let i = 0; i < 16; i++) panelShortcutBus.dispatch('newTerminalSession'); });
    await flushTimers();
    assert.match(view.get('[role="status"]').textContent!, /limit 16/);
    for (let i = 0; i < 16; i++) await settle(view.f.creates[i], { ok: true, id: `accepted-${i}` });
    await shortcut('flushTerminalShortcutQueue');
    await flushTimers();
    assert.equal(view.f.creates.length, 16); assert.equal(view.f.maxOutstanding, 1);
});

test('provider teardown cancels its single pending flush and clears compatibility backlog', async t => {
    const view = await mount(t, { element: createElement(WorkspaceFixture, { lazy: true }) });
    await act(async () => { panelShortcutBus.dispatch('newTerminalSession'); panelShortcutBus.dispatch('focusTerminal'); });
    assert.equal(timeouts.size, 1);
    await view.unmount();
    assert.equal(timeouts.size, 0);
    assert.deepEqual(takeTerminalShortcutQueue(window), { actions: [], notice: undefined });
    assert.equal(view.f.creates.length, 0); assert.equal(view.f.lists.length, 0);
    assert.equal(panelShortcutBus.dispatch('newTerminalSession'), false);
});

test('malicious-looking shell/cwd remain text and titles, never markup', async t => {
    const view = await mount(t);
    const value = snapshot('a', '<img src=x onerror=alert(1)>');
    value.cwd = '<script>not executable</script>';
    await settle(view.f.lists[0], { ok: true, sessions: [value] });
    assert.equal(view.tabs()[0]?.textContent, '1: <img src=x onerror=alert(1)>');
    assert.equal(view.container.querySelector('img, script'), null);
    assert.match(view.tabs()[0]!.title, /<script>/);
});

test('late rejection after event loss retains resync requirement instead of automatic retry', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    await view.click('.terminal-new-tab');
    await act(async () => { for (const callback of view.f.exit) callback('x'.repeat(257), 0); });
    await act(async () => view.f.creates[0]!.reject(new Error('late failure')));
    assert.match(view.get('[role="status"]').textContent!, /resync sessions before creating/);
    await shortcut('focusTerminal'); await flushTimers();
    assert.equal(view.f.creates.length, 1); assert.equal(view.f.lists.length, 1);
    await view.click('.terminal-new-tab');
    assert.equal(view.f.lists.length, 2); assert.equal(view.f.creates.length, 1);
});

test('normal xterm input and dedicated IME input keep their independent bridge paths and dispose timers', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    const runtime = terminals[0]!;
    runtime.data?.('normal'); runtime.resize?.({ cols: 100, rows: 30 });
    assert.deepEqual(view.f.writes, [['a', 'normal']]);
    assert.ok(view.f.resizes.some(([id, cols, rows]) => id === 'a' && cols === 100 && rows === 30));
    const input = view.get<HTMLTextAreaElement>('.terminal-a11y-input');
    input.dispatchEvent(new dom.window.CompositionEvent('compositionstart'));
    input.value = '한글\n';
    input.dispatchEvent(new dom.window.Event('input'));
    for (const callback of intervals.values()) callback();
    assert.equal(view.f.writes.length, 1);
    input.dispatchEvent(new dom.window.CompositionEvent('compositionend'));
    await flushTimers();
    assert.deepEqual(view.f.writes, [['a', 'normal'], ['a', '한글\r']]);
    assert.equal(input.value, '');
    input.dispatchEvent(new dom.window.CompositionEvent('compositionend'));
    await view.unmount();
    assert.equal(timeouts.size, 0); assert.equal(intervals.size, 0);
});

test('create admitted before newer selection/input appends without replacing active tab, roving tab or input focus', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a'), snapshot('b')] });
    await flushTimers();
    await view.click('.terminal-new-tab');
    await act(async () => view.tabs()[0]!.click());
    await flushTimers();
    const input = terminals[0]!.input!;
    input.value = 'unfinished input';
    await act(async () => input.dispatchEvent(new dom.window.Event('input', { bubbles: true })));
    await settle(view.f.creates[0], { ok: true, id: 'c' });
    await flushTimers();
    assert.equal(view.tabs().length, 3);
    assert.equal(view.tabs()[0]!.getAttribute('aria-selected'), 'true');
    assert.equal(view.tabs()[0]!.tabIndex, 0);
    assert.equal(view.tabs()[2]!.tabIndex, -1);
    assert.equal(document.activeElement, input);
    assert.equal(input.value, 'unfinished input');
    assert.equal(terminals[2]!.focused, 0);
});

test('two queued creates retain their admission tokens after keyboard revocation; only a later explicit request can select', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a'), snapshot('b')] });
    await flushTimers();
    await shortcut('newTerminalSession', 2);
    const [a, b] = view.tabs(); assert.ok(a && b);
    await act(async () => {
        b.focus();
        b.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    });
    for (const [index, id] of ['c', 'd'].entries()) {
        await settle(view.f.creates[index], { ok: true, id });
        await flushTimers();
        assert.equal(document.activeElement, a);
        assert.equal(a.tabIndex, 0);
        assert.equal(b.getAttribute('aria-selected'), 'true');
        assert.equal(view.tabs().filter(tab => tab.tabIndex === 0).length, 1);
        assert.ok(terminals.slice(2).every(term => term.focused === 0));
    }
    assert.equal(view.f.creates.length, 2);
    await shortcut('newTerminalSession');
    await settle(view.f.creates[2], { ok: true, id: 'explicit-new' });
    await flushTimers();
    assert.equal(view.tabs()[4]!.getAttribute('aria-selected'), 'true');
    assert.equal(document.activeElement, terminals[4]!.input);
});

test('event-driven resize failure then matching success clears presentation error and last natural exit still closes', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    await flushTimers();
    const calls: Array<{ id: string; cols: number; rows: number; result: ReturnType<typeof deferred<void>> }> = [];
    view.f.bridge.resize = (id, cols, rows) => {
        const result = deferred<void>(); calls.push({ id, cols, rows, result }); return result.promise;
    };
    await act(async () => terminals[0]!.resize!({ cols: 100, rows: 30 }));
    assert.deepEqual({ id: calls[0]!.id, cols: calls[0]!.cols, rows: calls[0]!.rows }, { id: 'a', cols: 100, rows: 30 });
    await act(async () => calls[0]!.result.reject(new Error('resize failed')));
    assert.match(view.get('[role="status"]').textContent!, /Unable to resize/);
    await act(async () => terminals[0]!.resize!({ cols: 110, rows: 35 }));
    await settle(calls[1]!.result, undefined);
    assert.equal(view.container.querySelector('[role="status"]'), null);
    await emitExit(view.f, 'a'); await flushTimers();
    assert.equal(view.empty.mock.callCount(), 1);
});

test('older resize success cannot clear a newer failure, and presentation success preserves admission error', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    await flushTimers();
    await view.click('.terminal-new-tab');
    await settle(view.f.creates[0], { ok: false, error: 'admission denied' });
    const calls: ReturnType<typeof deferred<void>>[] = [];
    view.f.bridge.resize = () => { const result = deferred<void>(); calls.push(result); return result.promise; };
    await act(async () => {
        terminals[0]!.resize!({ cols: 100, rows: 30 });
        terminals[0]!.resize!({ cols: 101, rows: 31 });
    });
    await act(async () => calls[1]!.reject(new Error('newer resize failed')));
    await settle(calls[0], undefined);
    assert.match(view.get('[role="status"]').textContent!, /admission denied/);
    assert.match(view.get('[role="status"]').textContent!, /Unable to resize/);
    await act(async () => terminals[0]!.resize!({ cols: 102, rows: 32 }));
    await settle(calls[2], undefined);
    assert.match(view.get('[role="status"]').textContent!, /admission denied/);
    assert.doesNotMatch(view.get('[role="status"]').textContent!, /Unable to resize/);
    await emitExit(view.f, 'a'); await flushTimers();
    assert.equal(view.empty.mock.callCount(), 0, 'admission recovery remains visible');
});

test('fit failure retires an older resize and clears only after a matching presentation success', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    await flushTimers();
    const calls: ReturnType<typeof deferred<void>>[] = [];
    view.f.bridge.resize = () => { const result = deferred<void>(); calls.push(result); return result.promise; };
    await act(async () => terminals[0]!.resize!({ cols: 100, rows: 30 }));
    fitAddons[0]!.fail = true;
    const resizePanel = async () => {
        await act(async () => {
            for (const observer of resizeObservers) observer.callback([], observer as unknown as ResizeObserver);
        });
    };
    await resizePanel();
    assert.match(view.get('[role="status"]').textContent!, /Unable to fit/);
    await settle(calls[0], undefined);
    assert.match(view.get('[role="status"]').textContent!, /Unable to fit/);
    fitAddons[0]!.fail = false;
    await resizePanel(); await settle(calls[1], undefined);
    assert.equal(view.container.querySelector('[role="status"]'), null);
    await emitExit(view.f, 'a'); await flushTimers();
    assert.equal(view.empty.mock.callCount(), 1);
});

test('delayed kill rejection keeps last-session recovery mounted and explicit retry re-lists', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    await flushTimers();
    const ack = deferred<void>();
    view.f.bridge.kill = id => { view.f.kills.push(id); return ack.promise; };
    await view.click('[aria-label="Close 1: zsh session"]');
    await flushTimers();
    assert.equal(view.tabs().length, 0); assert.equal(view.empty.mock.callCount(), 0);
    await act(async () => ack.reject(new Error('kill failed'))); await flushTimers();
    assert.equal(view.empty.mock.callCount(), 0);
    assert.match(view.get('[role="status"]').textContent!, /Unable to close.*resync/);
    assert.equal(view.container.getAttribute('aria-hidden'), 'false');
    await view.click('.terminal-empty button');
    assert.equal(view.f.lists.length, 2); assert.equal(view.f.creates.length, 0);
    assert.deepEqual(view.f.kills, ['a']);
});

test('resolved void kill acknowledgement, including already-absent session, releases last-close exactly once', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    const ack = deferred<void>();
    view.f.bridge.kill = id => { view.f.kills.push(id); return ack.promise; };
    await view.click('[aria-label="Close 1: zsh session"]');
    await emitExit(view.f, 'a'); await flushTimers();
    assert.equal(view.empty.mock.callCount(), 0, 'exit does not settle the pending IPC acknowledgement');
    await settle(ack, undefined); await flushTimers();
    assert.equal(view.empty.mock.callCount(), 1);
    assert.deepEqual(view.f.kills, ['a']);
    assert.equal(view.container.querySelector('[role="status"]'), null);
});

test('each pending close owns its acknowledgement and a newly created session survives late settlement', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a'), snapshot('b')] });
    const a = deferred<void>(); const b = deferred<void>();
    view.f.bridge.kill = id => { view.f.kills.push(id); return id === 'a' ? a.promise : b.promise; };
    await view.click('[aria-label="Close 1: zsh session"]');
    await view.click('[aria-label="Close 2: zsh session"]');
    await settle(b, undefined); await flushTimers();
    assert.equal(view.empty.mock.callCount(), 0, 'a still owns a pending acknowledgement');
    await shortcut('newTerminalSession');
    await settle(view.f.creates[0], { ok: true, id: 'c' });
    await settle(a, undefined); await flushTimers();
    assert.equal(view.empty.mock.callCount(), 0);
    assert.equal(view.tabs().length, 1); assert.deepEqual(view.f.kills, ['a', 'b']);
});

test('explicit hide/unmount during pending kill does not issue another kill or consume late rejection', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    const ack = deferred<void>();
    view.f.bridge.kill = id => { view.f.kills.push(id); return ack.promise; };
    await view.click('[aria-label="Close 1: zsh session"]');
    await view.click('.terminal-collapse-button');
    assert.equal(view.container.getAttribute('aria-hidden'), 'true');
    await view.unmount();
    await act(async () => ack.reject(new Error('late kill failure'))); await flushTimers();
    assert.equal(view.empty.mock.callCount(), 0); assert.deepEqual(view.f.kills, ['a']);
});

test('unrelated late append cannot cancel the newer selection focus waiting for its timer', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a'), snapshot('b')] });
    await flushTimers();
    await view.click('.terminal-new-tab');
    await act(async () => view.tabs()[0]!.click());
    await settle(view.f.creates[0], { ok: true, id: 'c' });
    await flushTimers();
    assert.equal(view.tabs()[0]!.getAttribute('aria-selected'), 'true');
    assert.equal(view.tabs()[0]!.tabIndex, 0);
    assert.equal(document.activeElement, terminals[0]!.input);
    assert.equal(terminals[2]!.focused, 0);
});

test('pending list cannot steal command input focus; explicit Reveal afterward focuses the restored session only', async t => {
    const view = await mount(t);
    const outside = document.createElement('input');
    outside.setAttribute('aria-label', 'Command input');
    document.body.append(outside);
    t.after(() => outside.remove());
    await act(async () => outside.focus());
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a'), snapshot('b')] });
    await flushTimers();
    assert.equal(document.activeElement, outside);
    assert.equal(view.tabs()[1]!.getAttribute('aria-selected'), 'true');
    assert.ok(terminals.every(term => term.focused === 0));
    await shortcut('focusTerminal'); await flushTimers();
    assert.equal(document.activeElement, terminals[1]!.input);
    assert.equal(view.f.lists.length, 1); assert.equal(view.f.creates.length, 0);
    assert.deepEqual(view.f.kills, []); assert.equal(terminals.length, 2);
});

test('outside sidebar focus revokes both queued creates and later Reveal does not renew the remaining queue', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    await flushTimers();
    await shortcut('newTerminalSession', 2);
    const outside = document.createElement('input');
    outside.setAttribute('aria-label', 'Sidebar search');
    document.body.append(outside);
    t.after(() => outside.remove());
    await act(async () => outside.focus());
    await settle(view.f.creates[0], { ok: true, id: 'b' }); await flushTimers();
    assert.equal(document.activeElement, outside);
    assert.equal(view.tabs()[0]!.getAttribute('aria-selected'), 'true');
    assert.equal(view.tabs()[0]!.tabIndex, 0);
    await shortcut('focusTerminal'); await flushTimers();
    assert.equal(document.activeElement, terminals[0]!.input);
    await settle(view.f.creates[1], { ok: true, id: 'c' }); await flushTimers();
    assert.equal(document.activeElement, terminals[0]!.input);
    assert.equal(view.tabs()[0]!.getAttribute('aria-selected'), 'true');
    assert.equal(view.tabs()[0]!.tabIndex, 0);
    assert.ok(terminals.slice(1).every(term => term.focused === 0));
    assert.equal(view.f.creates.length, 2); assert.equal(view.f.lists.length, 1);
    assert.deepEqual(view.f.kills, []);
});

test('window blur revokes pending list/create intent and already-scheduled focus; later explicit Reveal remains available', async t => {
    const view = await mount(t);
    await shortcut('newTerminalSession');
    await act(async () => window.dispatchEvent(new dom.window.Event('blur')));
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] });
    await settle(view.f.creates[0], { ok: true, id: 'b' }); await flushTimers();
    assert.equal(view.tabs()[0]!.getAttribute('aria-selected'), 'true');
    assert.ok(terminals.every(term => term.focused === 0));
    await shortcut('focusTerminal');
    await act(async () => window.dispatchEvent(new dom.window.Event('blur')));
    await flushTimers();
    assert.ok(terminals.every(term => term.focused === 0));
    await shortcut('focusTerminal'); await flushTimers();
    assert.equal(document.activeElement, terminals[0]!.input);
    assert.equal(view.f.creates.length, 1); assert.equal(view.f.lists.length, 1);
    assert.deepEqual(view.f.kills, []);
});

test('header close focus during a pending create preserves that control and existing selection without closing anything', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a'), snapshot('b')] });
    await flushTimers();
    await shortcut('newTerminalSession');
    const close = view.get('[aria-label="Close 1: zsh session"]');
    await act(async () => close.focus());
    await settle(view.f.creates[0], { ok: true, id: 'c' }); await flushTimers();
    assert.equal(document.activeElement, close);
    assert.equal(view.tabs()[1]!.getAttribute('aria-selected'), 'true');
    assert.equal(view.tabs()[1]!.tabIndex, 0);
    assert.equal(terminals[2]!.focused, 0);
    assert.deepEqual(view.f.kills, []);
});

test('header New focus revokes restore focus, while its later activation owns the new session focus', async t => {
    const view = await mount(t);
    const button = view.get<HTMLButtonElement>('.terminal-new-tab');
    await act(async () => button.focus());
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] }); await flushTimers();
    assert.equal(document.activeElement, button);
    assert.equal(terminals[0]!.focused, 0);
    await act(async () => button.click());
    await settle(view.f.creates[0], { ok: true, id: 'b' }); await flushTimers();
    assert.equal(view.tabs()[1]!.getAttribute('aria-selected'), 'true');
    assert.equal(document.activeElement, terminals[1]!.input);
    assert.equal(view.f.creates.length, 1); assert.deepEqual(view.f.kills, []);
});

test('guarded programmatic xterm focus does not revoke another create accepted under the same intent', async t => {
    const view = await mount(t);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('a')] }); await flushTimers();
    await shortcut('newTerminalSession', 2);
    await settle(view.f.creates[0], { ok: true, id: 'b' }); await flushTimers();
    assert.equal(document.activeElement, terminals[1]!.input);
    await settle(view.f.creates[1], { ok: true, id: 'c' }); await flushTimers();
    assert.equal(view.tabs()[2]!.getAttribute('aria-selected'), 'true');
    assert.equal(document.activeElement, terminals[2]!.input);
    assert.equal(view.f.creates.length, 2); assert.equal(view.f.maxOutstanding, 1);
});

test('focus departure subscriptions are removed with matching listeners and capture mode on unmount', async t => {
    const addDocument = t.mock.method(document, 'addEventListener');
    const removeDocument = t.mock.method(document, 'removeEventListener');
    const addWindow = t.mock.method(window, 'addEventListener');
    const removeWindow = t.mock.method(window, 'removeEventListener');
    const view = await mount(t);
    const focusAdds = addDocument.mock.calls.filter(call => call.arguments[0] === 'focusin');
    const blurAdds = addWindow.mock.calls.filter(call => call.arguments[0] === 'blur');
    assert.equal(focusAdds.length, 1); assert.equal(blurAdds.length, 1);
    assert.equal(focusAdds[0]!.arguments[2], true);
    await view.unmount();
    const focusRemoves = removeDocument.mock.calls.filter(call => call.arguments[0] === 'focusin');
    const blurRemoves = removeWindow.mock.calls.filter(call => call.arguments[0] === 'blur');
    assert.equal(focusRemoves.length, 1); assert.equal(blurRemoves.length, 1);
    assert.equal(focusRemoves[0]!.arguments[1], focusAdds[0]!.arguments[1]);
    assert.equal(focusRemoves[0]!.arguments[2], true);
    assert.equal(blurRemoves[0]!.arguments[1], blurAdds[0]!.arguments[1]);
    await settle(view.f.lists[0], { ok: true, sessions: [snapshot('late')] }); await flushTimers();
    assert.equal(terminals.length, 0); assert.equal(view.f.creates.length, 0); assert.deepEqual(view.f.kills, []);
});

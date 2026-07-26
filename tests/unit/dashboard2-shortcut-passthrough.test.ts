// 260725 wp1 — a shortcut with no handler must not steal the key.
//
// Regression: the provider matched a chord, called preventDefault(), then
// dispatched into a handler map that no production code populated. All seven
// actions therefore swallowed their keys and did nothing, blocking browser and
// OS defaults too (measured live: Alt+I/J/K/N/P and Meta+K/Meta+N all came back
// defaultPrevented=true).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createElement as h, act } from 'react';
import * as ReactNamespace from 'react';
import { JSDOM } from 'jsdom';
import type { PreferencesRegistryClient } from '../../public/dashboard2/src/providers/preferences-provider.tsx';

(globalThis as Record<string, unknown>).React = ReactNamespace;
const ROOT = resolve(import.meta.dirname, '..', '..');

const registry = {
    ui: { uiTheme: 'auto', locale: 'en', dashboardShortcutsEnabled: true, dashboardShortcutKeymap: 'default' },
} as never;
const prefsClient: PreferencesRegistryClient = {
    async load() { return { registry, status: {} }; },
    async patch() { return { registry, status: {} }; },
};

function installDom(): JSDOM {
    const dom = new JSDOM('<div id="root"></div>');
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    for (const [name, value] of Object.entries({
        window: dom.window,
        document: dom.window.document,
        navigator: dom.window.navigator,
        HTMLElement: dom.window.HTMLElement,
        KeyboardEvent: dom.window.KeyboardEvent,
        matchMedia: (query: string) => ({
            matches: false, media: query,
            addEventListener: () => {}, removeEventListener: () => {},
            addListener: () => {}, removeListener: () => {},
            onchange: null, dispatchEvent: () => false,
        }),
        requestAnimationFrame: (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(0), 0),
        cancelAnimationFrame: (id: number) => dom.window.clearTimeout(id),
    })) Object.defineProperty(globalThis, name, { configurable: true, value });
    return dom;
}

/** Fires a chord at document level and reports whether the app claimed it. */
function pressChord(dom: JSDOM, chord: { key: string; alt?: boolean; meta?: boolean; ctrl?: boolean; shift?: boolean }): boolean {
    const event = new dom.window.KeyboardEvent('keydown', {
        key: chord.key,
        altKey: Boolean(chord.alt),
        metaKey: Boolean(chord.meta),
        ctrlKey: Boolean(chord.ctrl),
        shiftKey: Boolean(chord.shift),
        bubbles: true,
        cancelable: true,
    });
    dom.window.document.body.dispatchEvent(event);
    return event.defaultPrevented;
}

/** Every action's default chord on a non-mac platform. */
const CHORDS: Record<string, { key: string; alt?: boolean; ctrl?: boolean }> = {
    focusInstances: { key: 'i', alt: true },
    focusActiveSession: { key: 'p', alt: true },
    focusNotes: { key: 'n', alt: true },
    previousInstance: { key: 'k', alt: true },
    nextInstance: { key: 'j', alt: true },
};

async function mountProvider(dom: JSDOM, register?: { action: string }): Promise<{ calls: string[]; unregister: () => void; unmount: () => Promise<void> }> {
    const { createRoot } = await import('react-dom/client');
    const { ManagerShortcutProvider, useManagerShortcuts } = await import('../../public/dashboard2/src/providers/shortcut-provider.tsx');
    const { ManagerPreferencesProvider } = await import('../../public/dashboard2/src/providers/preferences-provider.tsx');

    const calls: string[] = [];
    let unregister = (): void => {};
    function Probe(): null {
        const shortcuts = useManagerShortcuts();
        if (register && calls.length === 0 && unregister === undefined) { /* noop */ }
        (globalThis as Record<string, unknown>).__shortcuts = shortcuts;
        return null;
    }
    const root = createRoot(dom.window.document.getElementById('root')!);
    await act(async () => root.render(
        h(ManagerPreferencesProvider, { client: prefsClient },
            h(ManagerShortcutProvider, null, h(Probe))),
    ));
    if (register) {
        const shortcuts = (globalThis as Record<string, unknown>).__shortcuts as {
            registerHandler(action: string, cb: () => void): () => void;
        };
        await act(async () => { unregister = shortcuts.registerHandler(register.action, () => calls.push(register.action)); });
    }
    return { calls, unregister, unmount: async () => { await act(async () => root.unmount()); } };
}

test('R1: every action passes its key through while no handler is registered', async () => {
    const dom = installDom();
    const { unmount } = await mountProvider(dom);

    for (const [action, chord] of Object.entries(CHORDS)) {
        assert.equal(
            pressChord(dom, chord),
            false,
            `${action} has no handler, so its chord must reach the browser instead of being swallowed`,
        );
    }

    await unmount();
});

test('R2: a chord goes back to passing through after its handler unregisters', async () => {
    const dom = installDom();
    const { calls, unregister, unmount } = await mountProvider(dom, { action: 'focusNotes' });

    assert.equal(pressChord(dom, CHORDS.focusNotes!), true, 'a registered action claims its chord');
    assert.deepEqual(calls, ['focusNotes'], 'and runs its handler');

    await act(async () => { unregister(); });

    assert.equal(pressChord(dom, CHORDS.focusNotes!), false, 'after unregistering, the chord must pass through again');
    assert.deepEqual(calls, ['focusNotes'], 'and must not run the handler again');

    await unmount();
});

test('R3: the shortcut provider ships no debug logging', () => {
    const source = readFileSync(join(ROOT, 'public/dashboard2/src/providers/shortcut-provider.tsx'), 'utf8');
    assert.equal(source.includes('console.log'), false, 'console.log must not survive in the production shortcut path');
});

test('P1/P2: registered handlers still claim their chord, editable targets still pass through', async () => {
    const dom = installDom();
    const { calls, unmount } = await mountProvider(dom, { action: 'focusNotes' });

    assert.equal(pressChord(dom, CHORDS.focusNotes!), true);
    assert.deepEqual(calls, ['focusNotes']);

    // Typing into a field must never be hijacked, handler or not.
    const input = dom.window.document.createElement('input');
    dom.window.document.body.append(input);
    const event = new dom.window.KeyboardEvent('keydown', { key: 'n', altKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, 'editable targets keep their keystrokes');
    assert.deepEqual(calls, ['focusNotes'], 'and do not fire the shortcut');

    await unmount();
});

test('P3: dispatch works from non-DOM sources independently of the key listener', async () => {
    const dom = installDom();
    const { calls, unmount } = await mountProvider(dom, { action: 'focusNotes' });

    const shortcuts = (globalThis as Record<string, unknown>).__shortcuts as {
        dispatch(action: string, source: string): void;
    };
    for (const source of ['electron-menu', 'preview-iframe', 'electron-webcontents']) {
        await act(async () => shortcuts.dispatch('focusNotes', source));
    }

    assert.deepEqual(calls, ['focusNotes', 'focusNotes', 'focusNotes'],
        'menu and webcontents sources reach the handler without going through the DOM listener');

    await unmount();
});

import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://sidebar-width.test/' });
const replacements = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    React: await import('react'),
};
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act, createElement, StrictMode } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useSidebarWidth } = await import('../../public/manager/src/hooks/useSidebarWidth');
const { PanelResizer } = await import('../../public/manager/src/panels/PanelResizer');
const storageKey = 'jaw.sidebarWidth';

after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

async function mountWidth(t: TestContext, initiallyOpen = false, direction: 'horizontal' | 'vertical' = 'horizontal') {
    const container = dom.window.document.createElement('div');
    dom.window.document.body.append(container);
    const root = createRoot(container);
    const viewportDescriptor = Object.getOwnPropertyDescriptor(dom.window, 'innerWidth');
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 1440 });
    const ends = t.mock.fn();
    function WidthFixture({ open }: { open: boolean }) {
        const sidebar = useSidebarWidth({ rightPanelOpen: open, rightPanelWidth: 480 });
        return createElement('div', null,
            createElement('output', null, String(sidebar.width)),
            createElement(PanelResizer, {
                direction, onDelta: sidebar.addDelta,
                onEnd: () => { sidebar.persist(); ends(); }, ariaValueNow: sidebar.width,
            }),
            createElement('button', { onClick: sidebar.reset }, 'Reset'),
        );
    }
    const render = async (open: boolean) => {
        await act(async () => root.render(createElement(StrictMode, null, createElement(WidthFixture, { open }))));
    };
    t.after(async () => {
        await act(async () => root.unmount());
        container.remove();
        if (viewportDescriptor) Object.defineProperty(dom.window, 'innerWidth', viewportDescriptor);
        else Reflect.deleteProperty(dom.window, 'innerWidth');
        dom.window.localStorage.clear();
    });
    await render(initiallyOpen);
    const width = () => Number(container.querySelector('output')?.textContent);
    const resize = async (key: string, init: KeyboardEventInit = {}) => {
        const separator = container.querySelector<HTMLElement>('[role="separator"]');
        assert.ok(separator);
        separator.focus();
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
        await act(async () => { separator.dispatchEvent(event); });
        assert.equal(separator.getAttribute('aria-valuenow'), String(width()));
        return event;
    };
    return {
        container, render, width, resize, ends,
        viewport: async (value: number) => {
            await act(async () => {
                Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value });
                dom.window.dispatchEvent(new dom.window.Event('resize'));
            });
        },
        reset: async () => {
            const button = container.querySelector('button');
            assert.ok(button);
            await act(async () => button.click());
        },
    };
}

test('preferred 420 survives panel and viewport clamps without storage writes', async t => {
    dom.window.localStorage.setItem(storageKey, '420');
    const writes = t.mock.method(dom.window.Storage.prototype, 'setItem');
    const view = await mountWidth(t);
    assert.equal(view.width(), 420);
    await view.render(true);
    assert.equal(view.width(), 320);
    await view.render(false);
    assert.equal(view.width(), 420);
    await view.viewport(900);
    assert.equal(view.width(), 260);
    await view.viewport(1440);
    assert.equal(view.width(), 420);
    assert.equal(dom.window.localStorage.getItem(storageKey), '420');
    assert.equal(writes.mock.callCount(), 0);
});

test('resizer keyboard completion persists the latest delta exactly once in StrictMode', async t => {
    dom.window.localStorage.setItem(storageKey, '420');
    const writes = t.mock.method(dom.window.Storage.prototype, 'setItem');
    const view = await mountWidth(t);
    assert.equal((await view.resize('ArrowRight')).defaultPrevented, true);
    assert.equal(view.width(), 430);
    assert.equal(dom.window.localStorage.getItem(storageKey), '430');
    assert.equal(view.ends.mock.callCount(), 1);
    assert.deepEqual(writes.mock.calls.map(call => call.arguments), [[storageKey, '430']]);
    await view.resize('ArrowLeft');
    assert.equal(view.width(), 420);
    assert.equal(dom.window.localStorage.getItem(storageKey), '420');
    assert.equal(view.ends.mock.callCount(), 2);
    assert.equal(writes.mock.callCount(), 2);
    await view.render(true);
    await view.resize('ArrowLeft');
    assert.equal(view.width(), 310, 'resize starts at displayed 320, not preferred 420');
    assert.equal(dom.window.localStorage.getItem(storageKey), '310');
    await view.render(false);
    assert.equal(view.width(), 310);
});

test('ignored keys, modifiers and composition never resize or persist', async t => {
    dom.window.localStorage.setItem(storageKey, '420');
    const writes = t.mock.method(dom.window.Storage.prototype, 'setItem');
    const view = await mountWidth(t);
    for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', 'Escape']) {
        assert.equal((await view.resize(key)).defaultPrevented, false);
    }
    for (const init of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
        assert.equal((await view.resize('ArrowRight', init)).defaultPrevented, false);
    }
    assert.equal(view.width(), 420);
    assert.equal(view.ends.mock.callCount(), 0);
    assert.equal(writes.mock.callCount(), 0);
});

test('reset clears storage and restores default preference after a temporary clamp', async t => {
    dom.window.localStorage.setItem(storageKey, '420');
    const view = await mountWidth(t, true);
    await view.viewport(1280);
    assert.equal(view.width(), 220);
    await view.reset();
    assert.equal(dom.window.localStorage.getItem(storageKey), null);
    assert.equal(view.width(), 220);
    await view.viewport(1440);
    await view.render(false);
    assert.equal(view.width(), 300);
    await view.resize('ArrowRight');
    assert.equal(dom.window.localStorage.getItem(storageKey), '310', 'reset must also reset the synchronous preference ref');
});

for (const raw of ['broken', 'NaN', 'Infinity', '', '   ']) {
    test(`malformed stored width ${JSON.stringify(raw)} renders default and remains resizable`, async t => {
        dom.window.localStorage.setItem(storageKey, raw);
        const view = await mountWidth(t);
        assert.equal(view.width(), 300);
        await view.resize('ArrowRight');
        assert.equal(view.width(), 310);
        assert.equal(dom.window.localStorage.getItem(storageKey), '310');
    });
}

for (const mode of ['methods', 'getter', 'absent'] as const) {
    test(`unavailable storage (${mode}) leaves mount, resizing and reset usable`, async t => {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
        if (mode === 'methods') {
            for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
                t.mock.method(dom.window.Storage.prototype, method, () => { throw new Error('Storage blocked'); });
            }
        } else {
            Object.defineProperty(globalThis, 'localStorage', mode === 'getter'
                ? { configurable: true, get() { throw new Error('Storage access blocked'); } }
                : { configurable: true, writable: true, value: undefined });
        }
        t.after(() => {
            if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
            else Reflect.deleteProperty(globalThis, 'localStorage');
        });
        const view = await mountWidth(t);
        assert.equal(view.width(), 300);
        await view.resize('ArrowRight');
        assert.equal(view.width(), 310);
        await view.reset();
        assert.equal(view.width(), 300);
        await view.resize('ArrowLeft');
        assert.equal(view.width(), 290);
    });
}


test('vertical resizer commits handled Up/Down once and ignores horizontal arrows', async t => {
    dom.window.localStorage.setItem(storageKey, '420');
    const view = await mountWidth(t, false, 'vertical');
    assert.equal((await view.resize('ArrowUp')).defaultPrevented, true);
    assert.equal(view.width(), 410);
    assert.equal(dom.window.localStorage.getItem(storageKey), '410');
    assert.equal(view.ends.mock.callCount(), 1);
    assert.equal((await view.resize('ArrowDown')).defaultPrevented, true);
    assert.equal(view.width(), 420);
    assert.equal(view.ends.mock.callCount(), 2);
    for (const key of ['ArrowLeft', 'ArrowRight']) {
        assert.equal((await view.resize(key)).defaultPrevented, false);
    }
    assert.equal(view.ends.mock.callCount(), 2);
});

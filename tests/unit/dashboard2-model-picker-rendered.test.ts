import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement as h } from 'react';
import * as ReactNamespace from 'react';

(globalThis as Record<string, unknown>).React = ReactNamespace;

async function flush(): Promise<void> {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
}

test('ModelPicker supports pointer and virtual-focus keyboard selection', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
        url: 'http://127.0.0.1:24577/dashboard2/',
    });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    for (const name of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent']) {
        Object.defineProperty(globalThis, name, {
            configurable: true,
            value: (dom.window as unknown as Record<string, unknown>)[name],
        });
    }
    Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(globalThis, 'innerHeight', { configurable: true, value: 768 });

    const { createRoot } = await import('react-dom/client');
    const { ModelPicker } = await import('../../public/dashboard2/src/models/ModelPicker.tsx');
    const options = [
        { id: 'codex:gpt-5.5', provider: 'codex', model: 'gpt-5.5', label: 'gpt-5.5' },
        { id: 'codex:gpt-5.6-sol', provider: 'codex', model: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
        { id: 'codex:gpt-5.6-luna', provider: 'codex', model: 'gpt-5.6-luna', label: 'gpt-5.6-luna' },
    ];
    const selected: string[] = [];
    const root = createRoot(dom.window.document.getElementById('root')!);
    await act(async () => {
        root.render(h(ModelPicker, {
            value: options[0], options, workerWide: true,
            onSelect: (option: { id: string }) => selected.push(option.id),
        }));
        await flush();
    });

    const trigger = dom.window.document.querySelector<HTMLButtonElement>('[role="combobox"]');
    assert.ok(trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    trigger.focus();
    await act(async () => {
        trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        await flush();
    });
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.ok(trigger.getAttribute('aria-activedescendant'));
    assert.equal(dom.window.document.activeElement, trigger, 'virtual focus must remain on the trigger');

    await act(async () => {
        trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await flush();
    });
    assert.equal(selected.at(-1), 'codex:gpt-5.6-luna');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(dom.window.document.activeElement, trigger);

    await act(async () => {
        trigger.click();
        await flush();
    });
    const sol = [...dom.window.document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find(option => option.textContent?.includes('gpt-5.6-sol'));
    assert.ok(sol);
    await act(async () => {
        sol.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        await flush();
    });
    assert.equal(selected.at(-1), 'codex:gpt-5.6-sol');

    await act(async () => {
        trigger.click();
        await flush();
        trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await flush();
        root.unmount();
    });
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { act, createElement as h, useState } from 'react';
import * as ReactNamespace from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { PanelErrorBoundary } from '../../public/dashboard2/src/shell/PanelErrorBoundary.tsx';

(globalThis as Record<string, unknown>).React = ReactNamespace;

function installDom(): { dom: JSDOM; root: Root } {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://dashboard.test/dashboard2/' });
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const) {
        Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
    }
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
    return { dom, root: createRoot(dom.window.document.getElementById('root')!) };
}

function click(dom: JSDOM, label: string): void {
    const button = [...dom.window.document.querySelectorAll('button')].find(node => node.textContent === label);
    assert.ok(button, `${label} button must exist`);
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

test('per-tab fallback isolates siblings, retries by remount, and preserves a hidden outer slot', async () => {
    const { dom, root } = installDom();
    const originalConsoleError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => { logged.push(args); };
    let shouldThrow = true;
    let mounts = 0;
    const failure = Object.assign(new Error('fixture failure'), {
        secret: 'must-not-render',
        toJSON() { throw new Error('fallback serialized the error'); },
    });

    function Fixture(): ReactNamespace.JSX.Element {
        useState(() => { mounts += 1; return null; });
        if (shouldThrow) throw failure;
        return h('span', null, 'panel recovered');
    }

    try {
        await act(async () => root.render(h('main', null,
            h('div', { id: 'active-slot' },
                h(PanelErrorBoundary, { panelId: 'active', guardedClosePanel: async () => true }, h(Fixture))),
            h('div', { id: 'sibling-slot' }, 'sibling survives'),
            h('div', { id: 'hidden-slot', style: { display: 'none' }, inert: true, 'aria-hidden': true },
                h(PanelErrorBoundary, { panelId: 'hidden', guardedClosePanel: async () => true }, h(Fixture))),
        )));

        assert.match(dom.window.document.body.textContent ?? '', /패널을 표시할 수 없습니다/);
        assert.match(dom.window.document.querySelector('#sibling-slot')?.textContent ?? '', /sibling survives/);
        const hiddenSlot = dom.window.document.querySelector<HTMLElement>('#hidden-slot')!;
        assert.equal(hiddenSlot.style.display, 'none');
        assert.equal(hiddenSlot.hasAttribute('inert'), true);
        assert.equal(hiddenSlot.getAttribute('aria-hidden'), 'true');
        assert.doesNotMatch(dom.window.document.body.textContent ?? '', /must-not-render|fixture failure/);

        shouldThrow = false;
        await act(async () => click(dom, '다시 시도'));
        assert.match(dom.window.document.querySelector('#active-slot')?.textContent ?? '', /panel recovered/);
        assert.ok(mounts >= 3, 'retry remounts the active child after both crashing fixtures mounted');

        shouldThrow = true;
        await act(async () => click(dom, '다시 시도'));
        assert.equal(logged.filter(args => args[0] === '[PanelErrorBoundary] panel render failed' && args.includes(failure)).length, 1, 'boundary logging deduplicates one Error instance across retries');
    } finally {
        console.error = originalConsoleError;
        await act(async () => root.unmount());
    }
});

test('fallback close honors both guarded-close outcomes', async () => {
    for (const approved of [false, true]) {
        const { dom, root } = installDom();
        const originalConsoleError = console.error;
        console.error = () => {};
        let calls = 0;
        function Crash(): never { throw new Error(`close-${approved}`); }
        function Harness(): ReactNamespace.JSX.Element {
            const [open, setOpen] = useState(true);
            const guardedClosePanel = async (panelId: string): Promise<boolean> => {
                calls += 1;
                assert.equal(panelId, 'panel-guarded');
                if (approved) setOpen(false);
                return approved;
            };
            return open
                ? h(PanelErrorBoundary, { panelId: 'panel-guarded', guardedClosePanel }, h(Crash))
                : h('span', null, 'closed');
        }
        try {
            await act(async () => root.render(h(Harness)));
            await act(async () => click(dom, '패널 닫기'));
            assert.equal(calls, 1);
            assert.equal(dom.window.document.body.textContent?.includes('closed'), approved);
            assert.equal(dom.window.document.body.textContent?.includes('패널 닫기'), !approved);
        } finally {
            console.error = originalConsoleError;
            await act(async () => root.unmount());
        }
    }
});

test('fallback render path is structurally limited to static copy and actions', () => {
    const source = readFileSync(new URL('../../public/dashboard2/src/shell/PanelErrorBoundary.tsx', import.meta.url), 'utf8');
    const fallback = source.slice(source.indexOf('if (this.state.failed)'), source.indexOf('return <Fragment'));
    assert.match(fallback, /패널을 표시할 수 없습니다/);
    assert.doesNotMatch(fallback, /this\.state\.error|JSON\.stringify|String\s*\(|error\.message/);
});

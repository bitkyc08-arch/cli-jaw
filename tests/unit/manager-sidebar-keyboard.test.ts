import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
    createJumpHintVisibilityController,
    getInstanceJumpSelector,
    handleInstanceListKeyDown,
    jumpInstanceIndexFromAction,
    pageSettledPorts,
    registerInstanceJumpSelector,
    resolveAdjacentPort,
    shouldArmJumpHint,
} from '../../public/manager/src/components/sidebar-keyboard.js';

test('resolveAdjacentPort next/prev/null-current/missing/empty',
    () => {
        assert.equal(resolveAdjacentPort([1, 2, 3], 2, 'next'), 3);
        assert.equal(resolveAdjacentPort([1, 2, 3], 1, 'previous'), null);
        assert.equal(resolveAdjacentPort([1, 2, 3], null, 'next'), 1);
        assert.equal(resolveAdjacentPort([1, 2, 3], null, 'previous'), 3);
        assert.equal(resolveAdjacentPort([1, 2, 3], 9, 'next'), null);
        assert.equal(resolveAdjacentPort([], 1, 'next'), null);
        assert.equal(resolveAdjacentPort([1, 2, 3], 3, 'next'), null);
        assert.equal(resolveAdjacentPort([1, 2, 3], 2, 'previous'), 1);
    });

test('jumpInstanceIndexFromAction maps jumpInstance1..9 and rejects others',
    () => {
        assert.equal(jumpInstanceIndexFromAction('jumpInstance1'), 0);
        assert.equal(jumpInstanceIndexFromAction('jumpInstance3'), 2);
        assert.equal(jumpInstanceIndexFromAction('jumpInstance9'), 8);
        assert.equal(jumpInstanceIndexFromAction('jumpInstance0'), null);
        assert.equal(jumpInstanceIndexFromAction('jumpInstance10'), null);
        assert.equal(jumpInstanceIndexFromAction('nextInstance'), null);
    });

test('createJumpHintVisibilityController 199ms hidden / 200ms visible / hide / re-arm',
    () => {
        const timers = new Map<number, { fn: () => void; due: number }>();
        let nextId = 1;
        let now = 0;
        let visible = false;
        const setTimeoutFn = ((fn: () => void, delay: number) => {
            const id = nextId++;
            timers.set(id, { fn, due: now + delay });
            return id as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout;
        const clearTimeoutFn = ((id: ReturnType<typeof setTimeout>) => {
            timers.delete(id as unknown as number);
        }) as typeof clearTimeout;
        const advance = (ms: number): void => {
            now += ms;
            for (const [id, timer] of [...timers.entries()]) {
                if (timer.due <= now) {
                    timers.delete(id);
                    timer.fn();
                }
            }
        };

        const controller = createJumpHintVisibilityController({
            delayMs: 200,
            onVisibilityChange: next => { visible = next; },
            setTimeoutFn,
            clearTimeoutFn,
        });

        controller.sync(true);
        advance(199);
        assert.equal(visible, false);
        advance(1);
        assert.equal(visible, true);

        controller.sync(false);
        assert.equal(visible, false);

        controller.sync(true);
        advance(199);
        assert.equal(visible, false);
        advance(1);
        assert.equal(visible, true);

        controller.dispose();
        controller.sync(true);
        advance(200);
        assert.equal(visible, true);
    });

test('pageSettledPorts keeps the selected port when it is past the visible window',
    () => {
        const ports = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        assert.deepEqual(pageSettledPorts(ports, 10, 12), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12]);
        assert.deepEqual(pageSettledPorts(ports, 10, 3), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        assert.deepEqual(pageSettledPorts(ports, 10, null), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        assert.deepEqual(pageSettledPorts(ports, 0, 12), [12]);
    });

test('shouldArmJumpHint stays armed for Alt plus a follow-up key without extra modifiers',
    () => {
        assert.equal(shouldArmJumpHint({ altKey: true, metaKey: false, ctrlKey: false, shiftKey: false, key: 'Alt' }), true);
        assert.equal(shouldArmJumpHint({ altKey: true, metaKey: false, ctrlKey: false, shiftKey: false, key: '£' }), true);
        assert.equal(shouldArmJumpHint({ altKey: true, metaKey: true, ctrlKey: false, shiftKey: false, key: '1' }), false);
        assert.equal(shouldArmJumpHint({ altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, key: 'Alt' }), false);
    });

test('registerInstanceJumpSelector stores and clears the module-level callback',
    () => {
        const original = getInstanceJumpSelector();
        const fn = (_port: number): void => {};
        registerInstanceJumpSelector(fn);
        assert.equal(getInstanceJumpSelector(), fn);
        registerInstanceJumpSelector(null);
        assert.equal(getInstanceJumpSelector(), null);
        registerInstanceJumpSelector(original);
    });

test('list keyboard requires both focused selection ownership and the same event target', () => {
    const dom = new JSDOM('<!doctype html><div id="list"><button data-instance-port="3457"><span>First</span></button><button data-instance-port="3458">Second</button><button id="sessions">Sessions</button></div><button id="outside">Outside</button>');
    const replacements = { document: dom.window.document, HTMLElement: dom.window.HTMLElement };
    const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(replacements)) {
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    try {
        const root = dom.window.document.getElementById('list')!;
        const first = root.querySelector<HTMLButtonElement>('[data-instance-port="3457"]')!;
        const second = root.querySelector<HTMLButtonElement>('[data-instance-port="3458"]')!;
        const selections: number[] = [];
        root.addEventListener('keydown', event => handleInstanceListKeyDown(event as KeyboardEvent, root, port => selections.push(port)));
        const dispatch = (target: Element, key: string) => {
            const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
            target.dispatchEvent(event);
            return event;
        };
        // Focus outside the list must not be captured by a bubbled row event.
        dom.window.document.getElementById('outside')!.focus();
        assert.equal(dispatch(first, 'Home').defaultPrevented, false);
        assert.equal(dom.window.document.activeElement?.id, 'outside');
        first.focus();
        assert.equal(dispatch(second, 'Enter').defaultPrevented, false);
        assert.equal(dispatch(first.querySelector('span')!, 'End').defaultPrevented, false);
        assert.equal(dom.window.document.activeElement, first);
        dom.window.document.getElementById('sessions')!.focus();
        assert.equal(dispatch(dom.window.document.activeElement!, 'Enter').defaultPrevented, false);
        assert.deepEqual(selections, []);
        first.focus();
        assert.equal(dispatch(first, 'Enter').defaultPrevented, true);
        assert.deepEqual(selections, [3457]);
    } finally {
        dom.window.close();
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
});

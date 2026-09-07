import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

let visible = [2, 3];
let change: () => void = () => {};
// Control only the measured window. The real VirtualScroll owns DOM/lifecycle.
class Geometry {
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
        this.options = options;
        change = options['onChange'] as () => void;
    }
    _didMount() { return () => {}; }
    _willUpdate() {}
    getVirtualItems() { return visible.map(index => ({ index, start: index * 100, size: 100, end: (index + 1) * 100, key: index })); }
    getTotalSize() { return 400; }
    setOptions(options: Record<string, unknown>) { this.options = options; }
    measureElement() {}
    measure() {}
    scrollToIndex() {}
    scrollToOffset() {}
}
mock.module('@tanstack/virtual-core', { namedExports: {
    Virtualizer: Geometry, elementScroll() {}, observeElementRect() {}, observeElementOffset() {},
} });
mock.module('../../public/js/render.js', { namedExports: { releaseMermaidNodes() {} } });
mock.module('../../public/js/features/process-block.js', { namedExports: { releaseProcessBlockDetails() {} } });

let view: import('../../public/js/virtual-scroll.ts').VirtualScroll;
test.beforeEach(async () => {
    setupWebUiDom(); visible = [2, 3];
    const { VirtualScroll } = await import('../../public/js/virtual-scroll.ts');
    view = new VirtualScroll('chatMessages');
    view.setItems(Array.from({ length: 4 }, (_, index) => ({
        id: String(index), messageId: String(index), height: 100,
        html: `<div class="msg" data-message-id="${index}"><button id="row-${index}" class="lazy-pending">메시지 ${index}</button></div>`,
    })), { autoActivate: false });
    view.activateIfNeeded(false);
});
test.afterEach(() => { view.clear(); resetWebUiDom(); mock.restoreAll(); });

const inner = () => document.querySelector<HTMLElement>('.vs-inner')!;
const order = () => Array.from(inner().children, el => Number((el as HTMLElement).dataset['vsIdx']));
const button = (index: number) => document.getElementById(`row-${index}`)!;

test('backward window orders DOM before lazy/postRender and retains focused node identity', () => {
    const retained = button(2); const row = retained.parentElement;
    retained.focus();
    const observations: number[][] = [];
    const recycled: HTMLElement[] = [];
    view.onLazyRender = () => { observations.push(order()); };
    view.onPostRender = () => { observations.push(order()); };
    view.addLifecycleHooks({ postRender: () => { observations.push(order()); }, recycle: el => { recycled.push(el); } });
    visible = [0, 1, 2, 3]; change();
    assert.deepEqual(order(), [0, 1, 2, 3]);
    assert.deepEqual(observations, [[0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3]]);
    assert.equal(button(2), retained); assert.equal(retained.parentElement, row);
    assert.equal(document.activeElement, retained);
    assert.deepEqual(recycled, []);
    visible = [1, 2, 3]; change();
    assert.deepEqual(order(), [1, 2, 3]); assert.equal(document.activeElement, retained);
    assert.deepEqual(recycled.map(el => el.dataset['messageId']), ['0']);
});

test('outside focus is not stolen when older rows mount', () => {
    const outside = document.getElementById('btnSend')!; outside.focus();
    visible = [0, 1, 2, 3]; change();
    assert.deepEqual(order(), [0, 1, 2, 3]);
    assert.equal(document.activeElement, outside);
});

test('an evicted focused row is never restored', () => {
    const removed = button(2); removed.focus();
    const focus = mock.method(removed, 'focus');
    visible = [0, 1]; change();
    assert.deepEqual(order(), [0, 1]); assert.equal(removed.isConnected, false);
    assert.notEqual(document.activeElement, removed); assert.equal(focus.mock.callCount(), 0);
});

test('unchanged ordered window performs no DOM moves or focus calls', () => {
    visible = [0, 1, 2, 3]; change();
    const retained = button(2); retained.focus();
    const move = mock.method(inner(), 'insertBefore');
    const focus = mock.method(retained, 'focus');
    change();
    assert.equal(move.mock.callCount(), 0); assert.equal(focus.mock.callCount(), 0);
    assert.equal(document.activeElement, retained);
});

test('explicitly reordered retained DOM restores lost focus without scrolling', () => {
    visible = [0, 1, 2, 3]; change();
    // Boundary probe only: simulate an external DOM owner, NOT reversed geometry
    // or a normal TanStack scroll window. JSDOM moves lose focused descendants.
    for (const index of [0, 1, 2, 3]) inner().prepend(button(index).parentElement!);
    assert.deepEqual(order(), [3, 2, 1, 0]);
    const retained = button(0); retained.focus();
    const focus = mock.method(retained, 'focus');
    change();
    assert.deepEqual(order(), [0, 1, 2, 3]); assert.equal(button(0), retained);
    assert.equal(document.activeElement, retained); assert.equal(focus.mock.callCount(), 1);
    assert.deepEqual(focus.mock.calls[0]?.arguments, [{ preventScroll: true }]);
});

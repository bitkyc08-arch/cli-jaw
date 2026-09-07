import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

// Only the live-owner hooks are spies: actual history installer and TanStack VS
// execute. Main's activity-live tests own disclosure state and host-port behavior.
const remounts: HTMLElement[] = [];
const recycled: HTMLElement[] = [];
let VirtualScroll: typeof import('../../public/js/virtual-scroll.ts')['VirtualScroll'];
let history: typeof import('../../public/js/features/message-history.ts');
let buildItem: typeof import('../../public/js/features/message-item-html.ts')['buildLazyVirtualMessageItem'];
let vs: InstanceType<typeof VirtualScroll>;

test.before(async () => {
    setupWebUiDom();
    mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
    const live = await import('../../public/js/features/activity-live.ts');
    mock.module('../../public/js/features/activity-live.js', { namedExports: { ...live,
        remountLiveActivity: (root: HTMLElement) => { remounts.push(root); },
        recycleActivityHost: (element: HTMLElement) => { recycled.push(element); },
    } });
    ({ VirtualScroll } = await import('../../public/js/virtual-scroll.ts'));
    history = await import('../../public/js/features/message-history.ts');
    ({ buildLazyVirtualMessageItem: buildItem } = await import('../../public/js/features/message-item-html.ts'));
});
test.beforeEach(() => {
    const container = document.getElementById('chatMessages')!;
    container.replaceChildren();
    for (const name of ['clientHeight', 'offsetHeight']) Object.defineProperty(container, name, { configurable: true, value: 600 });
    for (const name of ['clientWidth', 'offsetWidth']) Object.defineProperty(container, name, { configurable: true, value: 900 });
    container.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 900,
        bottom: 600, width: 900, height: 600, toJSON() { return {}; } });
    vs = new VirtualScroll('chatMessages'); remounts.length = 0; recycled.length = 0;
});
test.afterEach(() => vs.clear());
test.after(() => { resetWebUiDom(); mock.restoreAll(); });

function item(id: string, text = id) {
    return { id: 'virtual-' + id, messageId: id, height: 80,
        html: `<div class="msg msg-agent" data-message-id="${id}"><div class="agent-body"><div class="msg-content">${text}</div></div></div>` };
}

test('Activity installer is additive/idempotent and clear allows fresh installation', () => {
    const lazy = mock.fn(); const post = mock.fn(); const recycle = mock.fn();
    vs.onLazyRender = lazy; vs.onPostRender = post; vs.onRecycle = recycle;
    history.ensureActivityVirtualCallbacks(vs); history.ensureActivityVirtualCallbacks(vs);
    history.registerVirtualScrollCallbacks(vs);
    assert.equal(vs.onLazyRender, lazy); assert.equal(vs.onPostRender, post); assert.equal(vs.onRecycle, recycle);
    vs.setItems([item('A')]); vs.activateIfNeeded();
    assert.ok(document.querySelector('[data-message-id="A"]'));
    assert.equal(remounts.length, post.mock.callCount(), 'one live hook per existing post-render callback');
    vs.clear();
    assert.equal(recycle.mock.callCount(), 1); assert.equal(recycled.length, 1);
    assert.equal(vs.onLazyRender, null); assert.equal(vs.onPostRender, null);
    remounts.length = 0; recycled.length = 0;
    history.registerVirtualScrollCallbacks(vs); history.ensureActivityVirtualCallbacks(vs);
    vs.setItems([item('B')]); vs.activateIfNeeded();
    assert.ok(remounts.length > 0);
    vs.clear(); assert.equal(recycled.length, 1);
});

test('live append immediately mounts a stable message and flush remounts without history discovery', () => {
    history.ensureActivityVirtualCallbacks(vs);
    vs.setItems([item('seed')]); vs.activateIfNeeded();
    const message = document.createElement('div');
    message.className = 'msg msg-agent'; message.dataset['messageId'] = 'live';
    message.innerHTML = '<div class="agent-body"><div class="msg-content">FINAL</div></div>';
    vs.appendLiveItem(message);
    assert.equal(document.querySelector('[data-message-id="live"] .msg-content')?.textContent, 'FINAL');
    assert.equal(vs.reconcileMessage('live', el => { el.querySelector('.msg-content')!.textContent = 'CORRECTED'; }), true);
    vs.flushToDOM();
    assert.equal(document.querySelectorAll('[data-message-id="live"]').length, 1);
    assert.equal(document.querySelector('[data-message-id="live"] .msg-content')?.textContent, 'CORRECTED');
    assert.equal(remounts.at(-1), document.getElementById('chatMessages'));
    assert.ok(recycled.some(el => el.dataset['messageId'] === 'live'));
});

test('offscreen correction uses unique message identity and refuses duplicate or mismatched rows', () => {
    vs.setItems([item('A'), item('B')], { autoActivate: false });
    assert.equal(vs.reconcileMessage('A', el => { el.querySelector('.msg-content')!.textContent = 'A corrected'; }), true);
    vs.activateIfNeeded(); vs.flushToDOM();
    assert.equal(document.querySelector('[data-message-id="A"] .msg-content')?.textContent, 'A corrected');
    assert.equal(document.querySelector('[data-message-id="B"] .msg-content')?.textContent, 'B');
    vs.clear();
    const update = mock.fn();
    vs.setItems([item('duplicate'), item('duplicate')], { autoActivate: false });
    assert.equal(vs.reconcileMessage('duplicate', update), false);
    assert.equal(vs.reconcileMessage('unknown', update), false);
    vs.setItems([{ ...item('actual'), messageId: 'claimed' }], { autoActivate: false });
    assert.equal(vs.reconcileMessage('claimed', update), false);
    assert.equal(update.mock.callCount(), 0);
});

test('lazy item retains escaped message/trace identity and default Markdown/tool hydration', () => {
    const trace = 'trace-" onclick="bad';
    const entry = buildItem({ id: 7, role: 'assistant', content: '**FINAL**', trace_run_id: trace,
        tool_log: JSON.stringify([{ icon: 'tool', label: 'Read', status: 'done', toolType: 'tool', detail: 'owned' }]) }, 0);
    assert.equal(entry.messageId, '7');
    history.registerVirtualScrollCallbacks(vs);
    vs.setItems([entry]); vs.activateIfNeeded();
    const row = document.querySelector<HTMLElement>('[data-message-id="7"]')!;
    assert.ok(row); assert.equal(row.dataset['traceRunId'], trace); assert.equal(row.hasAttribute('onclick'), false);
    assert.equal(row.querySelector('.msg-content strong')?.textContent, 'FINAL');
    assert.equal(row.querySelector('.lazy-pending'), null); assert.equal(row.querySelectorAll('.process-block').length, 1);
});

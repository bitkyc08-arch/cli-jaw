import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTick } from 'node:timers/promises';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

let ui: typeof import('../../public/js/ui.ts');
let vs: ReturnType<typeof import('../../public/js/virtual-scroll.ts')['getVirtualScroll']>;
let history: typeof import('../../public/js/features/message-history.ts');
let now = Date.now();
const tools = [{ label: 'Read', icon: 'tool', toolType: 'tool', status: 'done',
    stepRef: 'owned-read', detail: 'Owned result' }];

test.before(async () => {
    setupWebUiDom();
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true, data: { count: 0 } }), {
        headers: { 'Content-Type': 'application/json' },
    }));
    mock.method(Date, 'now', () => now);
    const container = document.getElementById('chatMessages')!;
    for (const [name, value] of Object.entries({ clientWidth: 900, clientHeight: 600, offsetWidth: 900, offsetHeight: 600 }))
        Object.defineProperty(container, name, { configurable: true, value });
    container.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 900,
        bottom: 600, width: 900, height: 600, toJSON() { return {}; } });
    ui = await import('../../public/js/ui.ts');
    history = await import('../../public/js/features/message-history.ts');
    vs = (await import('../../public/js/virtual-scroll.ts')).getVirtualScroll();
});
test.beforeEach(() => { ui.cleanupToolActivity(); vs.clear(); now += 1000; });
test.after(() => { ui.cleanupToolActivity(); vs.clear(); resetWebUiDom(); mock.restoreAll(); });

async function rendered() {
    vs.invalidateLayout();
    for (let i = 0; i < 20; i++) await nextTick();
    const content = document.querySelector<HTMLElement>('.msg-agent .msg-content');
    assert.ok(content, 'Actual VS mounts the promoted assistant');
    return content;
}

test('empty history first user -> native final with tools renders without streamed preview or reload', async () => {
    ui.addMessage('user', 'Read the owned file');
    assert.equal(vs.active, true); assert.equal(vs.onLazyRender, null);
    ui.finalizeAgent('APPROVED', tools, 'present');
    const content = await rendered();
    assert.equal(content.textContent?.trim(), 'APPROVED');
    assert.equal(content.dataset['raw'], 'APPROVED'); assert.equal(content.classList.contains('lazy-pending'), false);
    assert.equal(document.querySelectorAll('.msg-agent').length, 1);
    assert.equal(document.querySelectorAll('.process-block').length, 1);
});

test('clear then next user reinstalls lazy final rendering; existing history callback is preserved', async () => {
    history.registerVirtualScrollCallbacks(vs);
    const callback = vs.onLazyRender;
    ui.addMessage('user', 'Existing history'); ui.finalizeAgent('FIRST', tools, 'present');
    assert.equal((await rendered()).textContent?.trim(), 'FIRST'); assert.equal(vs.onLazyRender, callback);
    ui.cleanupToolActivity(); vs.clear(); now += 1000;
    assert.equal(vs.onLazyRender, null);
    ui.addMessage('user', 'After clear'); ui.finalizeAgent('SECOND', tools, 'present');
    assert.equal((await rendered()).textContent?.trim(), 'SECOND');
    assert.equal(document.querySelectorAll('.msg-agent').length, 1);
});

for (const [label, text, finality] of [
    ['empty', '', 'present'], ['absent', null, 'absent'], ['whitespace', ' \n ', 'present'],
] as const) test(`virtual native ${label} never resurrects provisional text`, async () => {
    ui.addMessage('user', 'Owned turn'); ui.appendAgentText('PRIVATE_PROVISIONAL');
    ui.finalizeAgent(text, tools, finality);
    const content = await rendered();
    assert.equal(content.textContent?.trim(), ''); assert.equal(content.dataset['raw'], '');
    assert.equal(content.classList.contains('lazy-pending'), false);
    assert.doesNotMatch(document.getElementById('chatMessages')!.textContent!, /PRIVATE_PROVISIONAL/);
});

test('virtual legacy tool-backed final retains final text and tool-less native final stays visible', async () => {
    ui.addMessage('user', 'Legacy'); ui.finalizeAgent('LEGACY_FINAL', tools);
    assert.equal((await rendered()).textContent?.trim(), 'LEGACY_FINAL');
    ui.cleanupToolActivity(); vs.clear(); now += 1000;
    ui.addMessage('user', 'No tools'); ui.finalizeAgent('PLAIN_FINAL', undefined, 'present');
    assert.equal((await rendered()).textContent?.trim(), 'PLAIN_FINAL');
});

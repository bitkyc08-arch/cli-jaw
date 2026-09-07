import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTick } from 'node:timers/promises';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

const identity = { sessionId: 'focus-chat', scope: 'local:focus' };
function request(requestId = 'one', expiresAt = Date.now() + 120_000) {
    return { ...identity, runId: 'run', turnId: 'turn', requestId, expiresAt, requestType: 'question',
        view: { title: `Question ${requestId}`, fields: [{ id: 'answer', label: 'Your answer',
            multiSelect: false, allowFreeform: true, options: [] }] } };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const listed = (requests: unknown[]) => json({ ok: true, data: { requests } });
const accepted = () => json({ ok: true, data: { accepted: true } });
let mountNativeRequests: typeof import('../../public/js/features/native-requests.ts')['mountNativeRequests'];
let serve: (init: RequestInit) => Promise<Response>;
let cleanups: Array<() => void> = [];
let postCount = 0;
async function until(check: () => boolean): Promise<void> {
    for (let count = 0; count < 5000; count++) { if (check()) return; await nextTick(); }
    assert.fail('Focus fixture did not settle');
}
function button(host: HTMLElement, label: string): HTMLButtonElement {
    const found = [...host.querySelectorAll('button')].find(node => node.textContent === label);
    assert.ok(found, label); return found;
}
async function mounted(initial = [request()]) {
    let current = initial;
    serve = async init => {
        if (init.method === 'POST') { current = []; return accepted(); }
        return listed(current);
    };
    const host = document.createElement('main');
    const area = document.createElement('div'); area.className = 'chat-input-area';
    const composer = document.createElement('textarea'); composer.id = 'chatInput'; area.append(composer);
    const external = document.createElement('button'); external.textContent = 'Other control';
    host.append(area, external); document.body.append(host);
    const panel = mountNativeRequests(host, identity); await panel.refresh();
    const root = host.querySelector<HTMLElement>('.native-requests')!;
    const announcer = host.querySelector<HTMLElement>('.native-request-announcer')!;
    cleanups.push(() => { panel.dispose(); host.remove(); });
    return { host, panel, root, composer, external, announcer };
}
function answer(host: HTMLElement, action = 'Submit answers'): void {
    const text = host.querySelector<HTMLTextAreaElement>('.native-requests textarea');
    if (text) text.value = 'My answer';
    const submit = button(host, action); submit.focus(); submit.click();
}

test.before(async () => {
    setupWebUiDom();
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(String(input), 'http://fixture');
        if (url.pathname === '/api/auth/token') return json({ token: '' });
        if (init.method === 'POST') postCount++;
        return serve(init);
    });
    ({ mountNativeRequests } = await import('../../public/js/features/native-requests.ts'));
});
test.beforeEach(() => { postCount = 0; });
test.afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
test.after(() => { mock.restoreAll(); resetWebUiDom(); });

test('one polite atomic announcer remains outside hidden panel and visible copy is not live', async () => {
    const { host, root, panel, announcer } = await mounted([]);
    assert.ok(announcer); assert.equal(announcer.parentElement, host);
    assert.equal(root.contains(announcer), false); assert.equal(announcer.hidden, false);
    assert.equal(announcer.closest('[hidden]'), null); assert.equal(root.hidden, true);
    assert.equal(host.querySelectorAll('[role="status"]').length, 1);
    assert.equal(announcer.getAttribute('aria-live'), 'polite'); assert.equal(announcer.getAttribute('aria-atomic'), 'true');
    const visible = root.querySelector('.native-request-status')!;
    assert.equal(visible.getAttribute('role'), null); assert.equal(visible.getAttribute('aria-live'), null);
    await panel.refresh(); assert.equal(host.querySelector('.native-request-announcer'), announcer);
    panel.dispose(); assert.equal(root.isConnected, false); assert.equal(announcer.isConnected, false);
});

test('accepted answer and cancellation restore composer focus and outcome survives repeated empty GET', async () => {
    for (const action of ['Submit answers', 'Cancel request']) {
        const { host, root, panel, composer, announcer } = await mounted();
        answer(host, action); await until(() => root.hidden);
        assert.equal(document.activeElement, composer);
        const expected = action === 'Submit answers' ? 'Response accepted.' : 'Request cancelled.';
        assert.equal(announcer.textContent, expected);
        const textNode = announcer.firstChild;
        await panel.refresh(); await panel.refresh();
        assert.equal(announcer.textContent, expected); assert.equal(announcer.firstChild, textNode);
        assert.equal(document.activeElement, composer);
        panel.dispose(); host.remove();
    }
});

test('accepted answer focuses the next verified request input with no draft carried over', async () => {
    const { host, panel, root, announcer } = await mounted();
    const old = root.querySelector('textarea')!;
    const next = request('two'); serve = async init => init.method === 'POST' ? accepted() : listed([next]);
    answer(host); await until(() => root.querySelector('h2')!.textContent === 'Question two');
    const input = root.querySelector('textarea')!;
    assert.notEqual(input, old); assert.equal(input.value, ''); assert.equal(document.activeElement, input);
    assert.equal(announcer.textContent, 'Runtime is waiting for your response.');
    await panel.refresh(); assert.equal(document.activeElement, input);
});

test('expiry transfers removed field focus safely and persists outcome after empty refresh', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
    const { root, host, composer, announcer, panel } = await mounted([request('one', 10_010)]);
    const input = root.querySelector('textarea')!; input.value = 'Draft'; input.focus();
    serve = async () => listed([]); t.mock.timers.tick(10);
    assert.equal(input.isConnected, false);
    assert.equal(document.activeElement, button(host, 'Refresh requests'));
    await until(() => root.hidden); assert.equal(document.activeElement, composer);
    assert.match(announcer.textContent!, /Request expired/);
    const message = announcer.textContent; await panel.refresh(); assert.equal(announcer.textContent, message);
    assert.equal(postCount, 0);
});

test('remote settlement restores composer or next control only when removed form owned focus', async () => {
    for (const next of [[], [request('two')]]) {
        const { root, panel, composer, host, announcer } = await mounted();
        root.querySelector('textarea')!.focus(); serve = async () => listed(next);
        await panel.refresh();
        assert.equal(document.activeElement, next.length ? root.querySelector('textarea') : composer);
        assert.equal(announcer.textContent, next.length ? 'Runtime is waiting for your response.' : 'Request is no longer pending.');
        assert.equal(postCount, 0); panel.dispose(); host.remove();
    }
});

test('external focus during deferred POST is never stolen by acceptance, cancellation or next request', async () => {
    for (const next of [[], [request('two')]]) {
        const { host, root, panel, external } = await mounted();
        const release = Promise.withResolvers<Response>();
        serve = async init => init.method === 'POST' ? release.promise : listed(next);
        const count = postCount; answer(host, next.length ? 'Cancel request' : 'Submit answers');
        await until(() => postCount === count + 1); external.focus(); release.resolve(accepted());
        await until(() => next.length ? root.querySelector('h2')!.textContent === 'Question two' : root.hidden);
        assert.equal(document.activeElement, external);
        panel.dispose(); host.remove();
    }
});

test('focus moved away during follow-up GET is not reclaimed when that GET completes', async () => {
    const { host, root, external } = await mounted();
    const read = Promise.withResolvers<Response>(); const started = Promise.withResolvers<void>();
    serve = async init => { if (init.method === 'POST') return accepted(); started.resolve(); return read.promise; };
    answer(host); await started.promise; external.focus(); read.resolve(listed([]));
    await until(() => root.hidden); assert.equal(document.activeElement, external);
});

test('iframe window blur during deferred POST invalidates focus restoration without document focusin', async () => {
    for (const next of [[], [request('two')]]) {
        const { host, root, panel, composer } = await mounted();
        const release = Promise.withResolvers<Response>();
        serve = async init => init.method === 'POST' ? release.promise : listed(next);
        const count = postCount; answer(host); await until(() => postCount === count + 1);
        let focusMoves = 0;
        const observe = () => { focusMoves++; };
        document.addEventListener('focusin', observe);
        try {
            // Parent-frame search/window focus leaves this document's activeElement stale.
            window.dispatchEvent(new window.Event('blur'));
            assert.equal(focusMoves, 0); release.resolve(accepted());
            await until(() => next.length ? root.querySelector('h2')!.textContent === 'Question two' : root.hidden);
            assert.equal(focusMoves, 0); assert.notEqual(document.activeElement, composer);
            if (next.length) assert.notEqual(document.activeElement, root.querySelector('textarea'));
            panel.dispose(); assert.equal(focusMoves, 0);
        } finally {
            document.removeEventListener('focusin', observe); panel.dispose(); host.remove();
            window.dispatchEvent(new window.Event('focus'));
        }
    }
});

test('window blur during follow-up GET cannot recapture stale refresh-button focus', async () => {
    const { host, root, composer } = await mounted();
    const read = Promise.withResolvers<Response>(); const started = Promise.withResolvers<void>();
    serve = async init => { if (init.method === 'POST') return accepted(); started.resolve(); return read.promise; };
    answer(host); await started.promise;
    assert.equal(document.activeElement, button(host, 'Refresh requests'));
    window.dispatchEvent(new window.Event('blur')); read.resolve(listed([]));
    await until(() => root.hidden); assert.notEqual(document.activeElement, composer);
});

test('window focus permits a new interaction and dispose unregisters window listeners', async t => {
    const { host, root, panel, composer } = await mounted();
    const remove = t.mock.method(window, 'removeEventListener');
    window.dispatchEvent(new window.Event('blur')); window.dispatchEvent(new window.Event('focus'));
    answer(host); await until(() => root.hidden); assert.equal(document.activeElement, composer);
    panel.dispose();
    assert.equal(remove.mock.calls.filter(call => call.arguments[0] === 'blur').length, 1);
    assert.equal(remove.mock.calls.filter(call => call.arguments[0] === 'focus').length, 1);
});

test('submitting programmatically while focus is outside panel never takes focus', async () => {
    const { root, external } = await mounted();
    root.querySelector('textarea')!.value = 'Answer'; external.focus();
    root.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => root.hidden); assert.equal(document.activeElement, external);
});

test('ordinary same-view GET preserves exact input, selection range and focused approval button', async () => {
    const { root, panel } = await mounted();
    const input = root.querySelector('textarea')!; input.value = 'Keep this draft'; input.focus(); input.setSelectionRange(2, 7);
    for (let i = 0; i < 3; i++) {
        await panel.refresh(); assert.equal(root.querySelector('textarea'), input);
        assert.equal(document.activeElement, input); assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 7);
    }
    const control = button(root, 'Cancel request'); control.focus(); await panel.refresh();
    assert.equal(document.activeElement, control); assert.equal(input.value, 'Keep this draft');
});

test('new incoming request, remote settlement and expiry never steal external/composer focus', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
    const { root, panel, composer, external } = await mounted([]); composer.focus();
    serve = async () => listed([request('one', 10_020)]); await panel.refresh();
    assert.equal(document.activeElement, composer);
    external.focus(); serve = async () => listed([request('two', 10_030)]); await panel.refresh();
    assert.equal(document.activeElement, external);
    serve = async () => listed([]); t.mock.timers.tick(30); await until(() => root.hidden);
    assert.equal(document.activeElement, external);
});

test('implicit body focus after submitting control removal still restores focus after acceptance', async () => {
    const { host, root, composer } = await mounted();
    const release = Promise.withResolvers<Response>();
    serve = async init => init.method === 'POST' ? release.promise : listed([]);
    answer(host); await until(() => postCount === 1);
    (document.activeElement as HTMLElement).remove(); assert.equal(document.activeElement, document.body);
    release.resolve(accepted()); await until(() => root.hidden); assert.equal(document.activeElement, composer);
});

test('disposing focused panel removes both roots and does not let a late POST reclaim focus', async () => {
    const { host, root, panel, composer, external, announcer } = await mounted();
    const release = Promise.withResolvers<Response>();
    serve = async () => release.promise;
    answer(host); await until(() => postCount === 1); panel.dispose();
    assert.equal(root.isConnected, false); assert.equal(announcer.isConnected, false);
    assert.equal(document.activeElement, composer);
    external.focus(); release.resolve(accepted()); await nextTick();
    assert.equal(document.activeElement, external);
});

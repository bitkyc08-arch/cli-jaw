import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { setImmediate as nextTick } from 'node:timers/promises';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import { RuntimeRequests } from '../../src/agent/runtime/requests.ts';
import { registerRuntimeRequestRoutes } from '../../src/routes/runtime-requests.ts';
import { preparePermissionRequest } from '../../src/agent/runtime/acp/permissions.ts';
import type { RuntimeRequestView } from '../../src/shared/runtime-contract.ts';

const identity = { sessionId: 'chat & one', scope: 'local:chat' };
const binding = { ...identity, runId: 'run', turnId: 'turn' };
const nativeFetch = globalThis.fetch;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const listed = (requests: unknown[]) => json({ ok: true, data: { requests } });
const accepted = () => json({ ok: true, data: { accepted: true } });
const field = (overrides: Partial<RuntimeRequestView['fields'][number]> = {}): RuntimeRequestView['fields'][number] => ({
    id: 'field', label: 'Choose a path', options: [{ id: 'opaque/yes', label: 'Allow once' }, { id: 'opaque/no', label: 'Deny' }],
    multiSelect: false, allowFreeform: false, ...overrides,
});
function pending(overrides: Record<string, unknown> = {}) {
    return { ...binding, requestId: 'request/a', requestType: 'approval', expiresAt: Date.now() + 120_000,
        view: { title: 'Permission needed', fields: [field()] }, ...overrides };
}
const question = (fields = [field()]) => pending({ requestType: 'question', view: { title: 'Questions', fields } });
let mountNativeRequests: typeof import('../../public/js/features/native-requests.ts')['mountNativeRequests'];
let serve: (url: URL, init: RequestInit) => Promise<Response>;
let calls: Array<{ url: URL; init: RequestInit }> = [];
let cleanups: Array<() => void> = [];
function posts() { return calls.filter(call => call.init.method === 'POST'); }
function body(index = 0) { return JSON.parse(String(posts()[index]!.init.body)); }
function button(host: HTMLElement, name: string): HTMLButtonElement {
    const result = [...host.querySelectorAll('button')].find(node => node.textContent === name);
    assert.ok(result, `Missing button: ${name}`); return result;
}
async function until(check: () => boolean): Promise<void> {
    for (let count = 0; count < 5000; count++) { if (check()) return; await nextTick(); }
    assert.fail('DOM/network state did not settle');
}
async function mounted(value: unknown[] = [pending()]) {
    serve = async (_url, init) => init.method === 'POST' ? accepted() : listed(value);
    const host = document.createElement('main');
    const disclosure = document.createElement('details'); disclosure.className = 'activity-disclosure';
    const input = document.createElement('div'); input.className = 'chat-input-area';
    host.append(disclosure, input); document.body.append(host);
    const panel = mountNativeRequests(host, identity);
    cleanups.push(() => { panel.dispose(); host.remove(); });
    await panel.refresh();
    return { host, panel, root: host.querySelector<HTMLElement>('.native-requests')!, input, disclosure };
}
function submit(host: HTMLElement): void {
    host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

test.before(async () => {
    setupWebUiDom();
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(String(input), 'http://fixture');
        if (url.pathname === '/api/auth/token') return json({ token: 'fixture-token' });
        calls.push({ url, init }); return serve(url, init);
    });
    ({ mountNativeRequests } = await import('../../public/js/features/native-requests.ts'));
});
test.beforeEach(() => { calls = []; });
test.afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
test.after(() => { mock.restoreAll(); resetWebUiDom(); });

test('panel is a direct composer sibling outside Activity, hides empty, and announces politely', async () => {
    const { host, root, input, disclosure, panel } = await mounted([]);
    assert.equal(root.parentElement, host); assert.equal(root.nextElementSibling, input);
    assert.equal(disclosure.contains(root), false); assert.equal(root.hidden, true);
    assert.equal(root.querySelector('[role=status]')!.getAttribute('aria-live'), 'polite');
    assert.equal(root.querySelector('[role=status]')!.getAttribute('aria-atomic'), 'true');
    assert.equal(calls[0]!.url.searchParams.get('sessionId'), identity.sessionId);
    assert.equal(new Headers(calls[0]!.init.headers).get('Authorization'), 'Bearer fixture-token');
    panel.dispose(); input.remove();
    const nestedInput = document.createElement('div'); nestedInput.className = 'chat-input-area'; disclosure.append(nestedInput);
    const fallback = mountNativeRequests(host, identity); cleanups.push(fallback.dispose);
    await fallback.refresh(); assert.equal(host.lastElementChild?.className, 'native-requests');
});

test('approval sends exact opaque option and binding once; cancellation sends null', async () => {
    const item = pending(); const { host, panel } = await mounted([item]);
    const release = Promise.withResolvers<Response>();
    serve = async (_url, init) => init.method === 'POST' ? release.promise : listed([]);
    const allow = button(host, 'Allow once'); allow.click(); allow.click();
    await until(() => posts().length === 1);
    assert.equal(allow.disabled, true);
    assert.deepEqual(body(), { ...binding, response: { optionId: 'opaque/yes' } });
    assert.equal(posts()[0]!.url.pathname, '/api/runtime/requests/request%2Fa');
    release.resolve(accepted()); await until(() => host.querySelector<HTMLElement>('.native-requests')!.hidden);
    serve = async (_url, init) => init.method === 'POST' ? accepted() : listed([item]);
    await panel.refresh(); button(host, 'Cancel request').click();
    await until(() => posts().length === 2);
    assert.deepEqual(body(1), { ...binding, response: { optionId: null } });
});

test('all question fields are required and single/multi selection submits only view IDs', async () => {
    const { host } = await mounted([question([field(), field({ id: 'multi', multiSelect: true })])]);
    submit(host); assert.equal(posts().length, 0);
    const groups = host.querySelectorAll('fieldset');
    const radio = groups[0]!.querySelector<HTMLInputElement>('input')!; radio.click();
    submit(host); assert.equal(posts().length, 0);
    groups[1]!.querySelectorAll<HTMLInputElement>('input').forEach(node => node.click());
    submit(host); submit(host); await until(() => posts().length === 1);
    assert.deepEqual(body(), { ...binding, response: { answers: {
        field: { selected: ['opaque/yes'] }, multi: { selected: ['opaque/yes', 'opaque/no'] },
    } } });
    assert.equal(groups[0]!.querySelector('legend')!.textContent, 'Choose a path');
    assert.equal(radio.labels!.length, 1);
});

test('question uses h2 and locks draft inputs only during POST, including concurrent same-view refresh', async () => {
    const item = question([field({ allowFreeform: true, multiSelect: true })]);
    const { host, panel, root } = await mounted([item]);
    assert.equal(root.querySelector('.native-request-title')!.tagName, 'H2');
    const text = host.querySelector('textarea')!; text.value = 'submitted draft';
    const inputs = [...host.querySelectorAll<HTMLInputElement>('input')]; inputs[0]!.click();
    const read = Promise.withResolvers<Response>(); const entered = Promise.withResolvers<void>();
    serve = async () => { entered.resolve(); return read.promise; };
    const reading = panel.refresh(); await entered.promise;
    assert.equal(text.disabled, false); assert.ok(inputs.every(input => !input.disabled));
    read.resolve(listed([item])); await reading;
    const write = Promise.withResolvers<Response>();
    serve = async (_url, init) => init.method === 'POST' ? write.promise : listed([item]);
    submit(host); await until(() => posts().length === 1);
    assert.equal(text.disabled, true); assert.ok(inputs.every(input => input.disabled));
    inputs[1]!.click(); assert.equal(inputs[1]!.checked, false);
    await panel.refresh();
    assert.equal(host.querySelector('textarea'), text); assert.equal(text.disabled, true);
    assert.ok(inputs.every(input => input.disabled));
    assert.deepEqual(body().response.answers.field, { selected: ['opaque/yes'], text: 'submitted draft' });
    write.reject(new TypeError('uncertain response'));
    await until(() => !button(host, 'Submit answers').disabled);
    assert.equal(host.querySelector('textarea'), text); assert.equal(text.value, 'submitted draft');
    assert.equal(text.disabled, false); assert.ok(inputs.every(input => !input.disabled));
    assert.equal(posts().length, 1);
});

test('radio behavior selects one, freeform is opt-in and can replace a cleared selection', async () => {
    const { host } = await mounted([question([field({ allowFreeform: true }), field({ id: 'locked' })])]);
    const groups = host.querySelectorAll('fieldset');
    const radios = groups[0]!.querySelectorAll<HTMLInputElement>('input');
    radios[0]!.click(); radios[1]!.click(); assert.equal(radios[0]!.checked, false);
    assert.equal(groups[1]!.querySelector('textarea'), null);
    groups[1]!.querySelector<HTMLInputElement>('input')!.click();
    const text = groups[0]!.querySelector('textarea')!; text.value = 'custom';
    submit(host); assert.equal(posts().length, 0);
    button(host, 'Clear selection').click(); submit(host); await until(() => posts().length === 1);
    assert.deepEqual(body().response.answers.field, { selected: [], text: 'custom' });
    assert.equal(text.labels!.length, 1);
});

test('freeform rejects present blank and >2000, omits absent text, accepts 2000', async () => {
    const { host } = await mounted([question([field({ allowFreeform: true, multiSelect: true })])]);
    const text = host.querySelector('textarea')!; const choice = host.querySelector<HTMLInputElement>('input')!;
    choice.click();
    for (const invalid of [' ', '\n\t', 'x'.repeat(2001)]) {
        text.value = invalid; submit(host); assert.equal(posts().length, 0);
    }
    text.value = 'x'.repeat(2000); submit(host); await until(() => posts().length === 1);
    assert.deepEqual(body().response.answers.field, { selected: ['opaque/yes'], text: 'x'.repeat(2000) });
});

test('aggregate freeform cap is 8000 and every text-only question needs an answer', async () => {
    const fields = Array.from({ length: 5 }, (_, i) => field({ id: `q${i}`, options: [], allowFreeform: true }));
    const { host } = await mounted([question(fields)]);
    const inputs = host.querySelectorAll('textarea'); inputs.forEach(input => { input.value = 'a'.repeat(1600); });
    inputs[0]!.value += 'a'; submit(host); assert.equal(posts().length, 0);
    assert.match(host.textContent!, /8,000/);
    inputs[0]!.value = ''; submit(host); assert.equal(posts().length, 0);
    inputs[0]!.value = 'a'.repeat(1600); submit(host); await until(() => posts().length === 1);
    assert.equal(Object.keys(body().response.answers).length, 5);
});

test('dangerous opaque IDs survive JSON and labels render literally; questions cancel with null', async () => {
    const literal = '<img src=x onerror=alert(1)><script>bad()</script>';
    const item = question([field({ id: '__proto__', label: literal, options: [{ id: '__proto__', label: literal }] })]);
    const { host, panel } = await mounted([item]);
    assert.equal(host.querySelector('img, script'), null); assert.ok(host.textContent!.includes(literal));
    host.querySelector<HTMLInputElement>('input')!.click(); submit(host);
    await until(() => posts().length === 1);
    assert.equal(Object.hasOwn(body().response.answers, '__proto__'), true);
    assert.deepEqual(body().response.answers['__proto__'], { selected: ['__proto__'] });
    await until(() => button(host, 'Cancel request').disabled === false);
    await panel.refresh(); button(host, 'Cancel request').click(); await until(() => posts().length === 2);
    assert.deepEqual(body(1).response, { optionId: null });
});

test('identical GET retains draft, selection, focus and selection range even if list order changes', async () => {
    const item = question([field({ allowFreeform: true, multiSelect: true })]);
    const { host, panel } = await mounted([item]);
    const text = host.querySelector('textarea')!; text.value = 'draft'; text.focus(); text.setSelectionRange(1, 4);
    const choice = host.querySelector<HTMLInputElement>('input')!; choice.checked = true;
    serve = async () => listed([pending({ requestId: 'earlier' }), { ...item, expiresAt: item.expiresAt + 100 }]);
    await panel.refresh();
    assert.equal(host.querySelector('textarea'), text); assert.equal(document.activeElement, text);
    assert.equal(text.value, 'draft'); assert.equal(text.selectionStart, 1); assert.equal(text.selectionEnd, 4);
    assert.equal(choice.checked, true); assert.equal(host.querySelectorAll('form').length, 1);
    serve = async () => listed([{ ...item, turnId: 'new-turn' }]); await panel.refresh();
    assert.notEqual(host.querySelector('textarea'), text); assert.equal(host.querySelector('textarea')!.value, '');
});

test('same binding but changed view clears the old draft and detached buttons are inert', async () => {
    const item = question([field({ allowFreeform: true })]); const { host, panel } = await mounted([item]);
    const old = button(host, 'Cancel request'); const text = host.querySelector('textarea')!; text.value = 'old';
    serve = async () => listed([{ ...item, view: { title: 'Changed', fields: [field({ allowFreeform: true })] } }]);
    await panel.refresh(); assert.equal(host.querySelector('textarea')!.value, '');
    old.click(); await nextTick(); assert.equal(posts().length, 0);
});

test('focused approval survives same-view GET but cannot send until that GET confirms it', async () => {
    const item = pending(); const { host, panel } = await mounted([item]);
    const allow = button(host, 'Allow once'); allow.focus();
    const release = Promise.withResolvers<Response>(); const entered = Promise.withResolvers<void>();
    serve = async () => { entered.resolve(); return release.promise; };
    const reading = panel.refresh(); await entered.promise;
    assert.equal(allow.disabled, false); assert.equal(allow.getAttribute('aria-disabled'), 'true');
    allow.click(); await nextTick(); assert.equal(posts().length, 0);
    release.resolve(listed([item])); await reading;
    assert.equal(document.activeElement, allow); assert.equal(allow.getAttribute('aria-disabled'), 'false');
});

test('suspend aborts stale GET and preserves draft/focus through failed reconnect until verified GET', async () => {
    const item = question([field({ allowFreeform: true, multiSelect: true })]);
    const { host, panel } = await mounted([item]);
    const text = host.querySelector('textarea')!; text.value = 'keep me'; text.focus(); text.setSelectionRange(2, 5);
    const choice = host.querySelector<HTMLInputElement>('input')!; choice.checked = true;
    const release = Promise.withResolvers<Response>(); const entered = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    serve = async (_url, init) => { signal = init.signal!; entered.resolve(); return release.promise; };
    const reading = panel.refresh(); await entered.promise;
    panel.suspend(); panel.suspend(); assert.equal(signal!.aborted, true);
    assert.equal(host.querySelector('textarea'), text); assert.equal(document.activeElement, text);
    assert.equal(button(host, 'Submit answers').disabled, true);
    submit(host); button(host, 'Cancel request').click(); assert.equal(posts().length, 0);
    release.resolve(listed([])); await reading; assert.equal(host.querySelector('textarea'), text);
    serve = async () => json({ ok: false }, 503); await panel.refresh();
    assert.equal(host.querySelector('textarea'), text); assert.equal(text.value, 'keep me');
    assert.equal(button(host, 'Submit answers').disabled, true);
    assert.match(host.textContent!, /could not be loaded/);
    serve = async () => listed([item]); await panel.refresh();
    assert.equal(host.querySelector('textarea'), text); assert.equal(document.activeElement, text);
    assert.equal(text.selectionStart, 2); assert.equal(text.selectionEnd, 5); assert.equal(choice.checked, true);
    assert.equal(button(host, 'Submit answers').disabled, false);
});

test('suspended expired draft stays inert without network work until reconnect verifies expiry', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
    const item = question([field({ allowFreeform: true })]); item.expiresAt = 10_010;
    const { host, panel, root } = await mounted([item]);
    const text = host.querySelector('textarea')!; text.value = 'offline'; panel.suspend();
    const count = calls.length; t.mock.timers.tick(11); await nextTick();
    assert.equal(calls.length, count); assert.equal(host.querySelector('textarea'), text);
    submit(host); assert.equal(posts().length, 0);
    await panel.refresh(); assert.equal(root.hidden, true); assert.equal(host.querySelector('form'), null);
});

test('POST settling while suspended never retries or clears the draft before reconnect GET', async () => {
    for (const success of [true, false]) {
        const { host, panel, root } = await mounted([question([field({ allowFreeform: true })])]);
        const text = host.querySelector('textarea')!; text.value = 'in flight';
        const release = Promise.withResolvers<Response>(); const before = posts().length;
        let signal: AbortSignal | undefined;
        serve = async (_url, init) => { signal = init.signal!; return release.promise; };
        submit(host); await until(() => posts().length === before + 1);
        panel.suspend(); assert.equal(signal!.aborted, false);
        const count = calls.length;
        if (success) release.resolve(accepted()); else release.reject(new TypeError('connection reset'));
        await until(() => root.getAttribute('aria-busy') === 'false');
        assert.equal(calls.length, count); assert.equal(host.querySelector('textarea'), text);
        assert.equal(button(host, 'Submit answers').disabled, true); assert.match(root.textContent!, /Connection lost/);
        serve = async () => listed([]); await panel.refresh();
        assert.equal(root.hidden, true); assert.equal(posts().length, before + 1);
        panel.dispose(); panel.suspend(); await panel.refresh(); assert.equal(host.querySelector('.native-requests'), null);
    }
});

test('suspend during uncertain POST follow-up GET keeps offline status and rejects late repaint', async () => {
    const item = pending(); const { host, panel } = await mounted([item]);
    const release = Promise.withResolvers<Response>(); const entered = Promise.withResolvers<void>();
    serve = async (_url, init) => {
        if (init.method === 'POST') throw new TypeError('uncertain');
        entered.resolve(); return release.promise;
    };
    button(host, 'Allow once').click(); await entered.promise; panel.suspend();
    release.resolve(listed([item])); await nextTick();
    assert.match(host.textContent!, /Connection lost/); assert.equal(button(host, 'Allow once').disabled, true);
    assert.equal(posts().length, 1);
});

test('new GET aborts old GET; stale success and stale failure cannot replace current form', async () => {
    const { host, panel } = await mounted();
    for (const fail of [false, true]) {
        const release = Promise.withResolvers<Response>(); const entered = Promise.withResolvers<void>();
        let signal: AbortSignal | undefined;
        serve = async (_url, init) => { signal = init.signal!; entered.resolve(); return release.promise; };
        const old = panel.refresh(); await entered.promise;
        serve = async () => listed([pending({ view: { title: 'New', fields: [field()] } })]);
        await panel.refresh(); assert.equal(signal!.aborted, true);
        if (fail) release.reject(new Error('stale')); else release.resolve(listed([]));
        await old; assert.equal(host.querySelector('h2')!.textContent, 'New');
    }
});

test('expiry removes actions and refreshes; even a delayed timer cannot permit an expired POST', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
    const { host, panel } = await mounted([pending({ expiresAt: 10_010 })]);
    const old = button(host, 'Allow once'); serve = async () => listed([]);
    t.mock.timers.tick(10); assert.equal(host.querySelector('form'), null);
    await until(() => host.querySelector<HTMLElement>('.native-requests')!.hidden);
    old.click(); assert.equal(posts().length, 0);
    serve = async () => listed([pending({ expiresAt: 20_000 })]); await panel.refresh();
    t.mock.method(Date, 'now', () => 20_001);
    button(host, 'Allow once').click(); await nextTick(); assert.equal(posts().length, 0);
});

test('GET failure removes stale actions and retry is visible; 409 and uncertain POST refresh without retrying POST', async () => {
    const { host, root, panel } = await mounted();
    serve = async () => json({ ok: false }, 503); await panel.refresh();
    assert.equal(root.hidden, false); assert.equal(root.querySelector('form'), null);
    assert.match(root.textContent!, /could not be loaded/);
    serve = async () => listed([pending()]); button(host, 'Refresh requests').click();
    await until(() => !!host.querySelector('form'));
    for (const code of [409, 503, 200]) {
        const before = posts().length;
        serve = async (_url, init) => init.method === 'POST' ? json({ accepted: true }, code) : listed([pending()]);
        button(host, 'Allow once').click();
        await until(() => posts().length === before + 1 && !button(host, 'Allow once').disabled);
        assert.match(root.textContent!, code === 409 ? /expired or was already answered/ : /could not be confirmed/);
        await nextTick(); assert.equal(posts().length, before + 1);
    }
});

test('late POST cannot paint another selected request and blocks double send while in flight', async () => {
    const { host, panel } = await mounted();
    const release = Promise.withResolvers<Response>();
    serve = async (_url, init) => init.method === 'POST' ? release.promise : listed([pending({ requestId: 'next', view: { title: 'Next request', fields: [field()] } })]);
    button(host, 'Allow once').click(); await until(() => posts().length === 1);
    await panel.refresh(); assert.equal(button(host, 'Allow once').disabled, true);
    release.resolve(json({ ok: false }, 409)); await until(() => !button(host, 'Allow once').disabled);
    assert.equal(host.querySelector('h2')!.textContent, 'Next request');
    assert.doesNotMatch(host.textContent!, /expired or was already answered/);
    assert.equal(posts().length, 1);
});

test('dispose aborts GET/POST and no late completion, detached control, or refresh can revive panel', async () => {
    for (const method of ['GET', 'POST']) {
        const { host, panel } = await mounted(); const release = Promise.withResolvers<Response>();
        let signal: AbortSignal | undefined;
        serve = async (_url, init) => { signal = init.signal!; return release.promise; };
        const old = button(host, 'Cancel request');
        const task = method === 'GET' ? panel.refresh() : (old.click(), Promise.resolve());
        await until(() => !!signal); panel.dispose(); panel.dispose(); assert.equal(signal!.aborted, true);
        const count = calls.length; release.resolve(method === 'GET' ? listed([pending()]) : accepted());
        await task; await nextTick(); old.click(); await panel.refresh();
        assert.equal(host.querySelector('.native-requests'), null); assert.equal(calls.length, count);
    }
});

test('wrong identity, expired, invalid IDs and malformed/duplicate views never provide actions', async () => {
    const { host, root, panel } = await mounted();
    for (const patch of [
        { sessionId: 'foreign' }, { scope: 'foreign' }, { expiresAt: Date.now() - 1 },
        ...['runId', 'turnId', 'requestId'].flatMap(name => [{ [name]: '' }, { [name]: 'x'.repeat(241) }]),
        { expiresAt: 'tomorrow' }, { requestType: 'unknown' },
        { view: { title: 'Duplicate fields', fields: [field(), field()] } },
        { view: { title: 'Duplicate options', fields: [field({ options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] })] } },
        { view: { title: 'Too many fields', fields: Array.from({ length: 9 }, (_, i) => field({ id: `f${i}` })) } },
        { view: { title: 'Too many options', fields: [field({ options: Array.from({ length: 21 }, (_, i) => ({ id: `o${i}`, label: 'x' })) })] } },
        { view: { title: 'Unrepresentable', fields: [] } },
    ]) {
        serve = async () => listed([pending(patch)]); await panel.refresh(); assert.equal(host.querySelector('form'), null);
    }
    serve = async () => listed([pending(), pending()]); await panel.refresh();
    assert.equal(host.querySelector('form'), null); assert.equal(root.hidden, false);
    assert.match(root.textContent!, /could not be loaded/);
});

test('list cap is 128; 6MiB receive cap cancels oversized stream before rendering', async () => {
    const { host, panel } = await mounted();
    const requests = Array.from({ length: 128 }, (_, i) => pending({ requestId: `r${i}` }));
    serve = async () => listed(requests); await panel.refresh(); assert.equal(host.querySelectorAll('form').length, 1);
    serve = async () => listed([...requests, pending()]); await panel.refresh(); assert.equal(host.querySelector('form'), null);
    // Legal envelope padding above the old 2MiB ceiling still loads through the real helper.
    serve = async () => json({ ok: true, data: { requests: [pending()] }, padding: 'x'.repeat(3 * 1024 * 1024) });
    await panel.refresh(); assert.equal(host.querySelectorAll('form').length, 1);
    let cancelled = false;
    serve = async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(6 * 1024 * 1024 + 1)); },
        cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'application/json' } });
    await panel.refresh(); assert.equal(cancelled, true); assert.equal(host.querySelector('form'), null);
});

test('malformed envelopes fail closed, and replayed request events cannot create actions or refreshes', async () => {
    const { host, panel, root } = await mounted([]);
    const count = calls.length;
    host.dispatchEvent(new window.CustomEvent('agent_runtime', { bubbles: true, detail: {
        ...binding, kind: 'request', requestId: 'replayed', requestType: 'approval', view: pending().view,
    } }));
    window.dispatchEvent(new window.CustomEvent('request', { detail: pending() }));
    await nextTick(); assert.equal(calls.length, count); assert.equal(root.hidden, true);
    for (const envelope of [null, [], { requests: [pending()] }, { ok: false, data: { requests: [pending()] } },
        { ok: true, data: { requests: {} } }, { ok: true, data: null }]) {
        serve = async () => json(envelope); await panel.refresh();
        assert.equal(root.hidden, false); assert.equal(host.querySelector('form'), null);
    }
});

test('same unsupported view stays visibly unavailable across refresh; exact view bounds remain actionable', async () => {
    const unsupported = pending({ view: { title: 'Unsupported approval', fields: [field({ multiSelect: true })] } });
    const { host, panel } = await mounted([unsupported]);
    await panel.refresh(); assert.match(host.textContent!, /cannot be answered here/);
    assert.equal(host.querySelector('form'), null);
    const fields = Array.from({ length: 8 }, (_, f) => field({ id: `${f}`.repeat(240), multiSelect: true,
        options: Array.from({ length: 20 }, (_, o) => ({ id: `${o}`.padEnd(240, 'a'), label: `Option ${o}` })) }));
    const item = question(fields);
    serve = async (_url, init) => init.method === 'POST' ? accepted() : listed([{ ...item, runId: 'r'.repeat(240), turnId: 't'.repeat(240), requestId: 'q'.repeat(240) }]);
    await panel.refresh(); assert.equal(host.querySelectorAll('fieldset').length, 8);
    assert.equal(host.querySelectorAll('input').length, 160);
    host.querySelectorAll('fieldset').forEach(group => group.querySelector<HTMLInputElement>('input')!.click());
    submit(host); await until(() => posts().length === 1);
    assert.equal(Object.keys(body().response.answers).length, 8);
    assert.equal(body().runId.length, 240);
});

test('network rejection after an admitted POST rereads the registry with no automatic resend', async () => {
    const { host, root } = await mounted();
    let reads = 0;
    serve = async (_url, init) => {
        if (init.method === 'POST') throw new TypeError('connection reset after write');
        reads++; return listed([]);
    };
    button(host, 'Allow once').click(); await until(() => root.hidden);
    assert.equal(posts().length, 1); assert.equal(reads, 1);
});

async function httpFixture(t: TestContext) {
    const registry = new RuntimeRequests(); const app = express(); app.use(express.json());
    registerRuntimeRequestRoutes(app, (req, res, next) => {
        if (req.headers.authorization !== 'Bearer fixture-token') { res.sendStatus(401); return; } next();
    }, registry);
    const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    t.after(async () => {
        registry.cancelRun(binding.runId); server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    return { registry, route: (url: URL, init: RequestInit) => nativeFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init) };
}

test('real HTTP registry and ACP opaque encoder accept selected/null, prune ownership and reject stale POST', async t => {
    const { registry, route } = await httpFixture(t);
    const permission = preparePermissionRequest('Read a file', [{ optionId: 'native-only-id', name: 'Read once', kind: 'allow_once' }]);
    t.after(permission.dispose);
    const open = () => registry.open({ ...binding, requestType: 'approval', view: permission.view,
        cancelled: { outcome: { outcome: 'cancelled' as const } }, isCurrent: () => true, validate: permission.validate });
    const { host, panel, root } = await mounted([]); serve = route;
    let request = open(); await panel.refresh(); button(host, 'Read once').click();
    assert.deepEqual(await request.answer, { outcome: { outcome: 'selected', optionId: 'native-only-id' } });
    await until(() => root.hidden); assert.notEqual(body().response.optionId, 'native-only-id');
    request = open(); await panel.refresh(); button(host, 'Cancel request').click();
    assert.deepEqual(await request.answer, { outcome: { outcome: 'cancelled' } }); await until(() => root.hidden);
    request = open(); await panel.refresh(); registry.cancelRun(binding.runId); button(host, 'Read once').click();
    await until(() => root.hidden); assert.equal(posts().length, 3); assert.deepEqual(registry.list(identity.sessionId), []);
});

test('real HTTP question request receives all fields and explicit cancellation', async t => {
    const { registry, route } = await httpFixture(t);
    const { host, panel, root } = await mounted([]); serve = route;
    const open = () => registry.open({ ...binding, requestType: 'question', view: { title: 'Questions', fields: [field({ options: [{ id: 'opaque_yes', label: 'Yes' }] })] },
        cancelled: { optionId: null }, isCurrent: () => true, validate: (value: unknown) => value });
    let request = open(); await panel.refresh(); host.querySelector<HTMLInputElement>('input')!.click(); submit(host);
    assert.deepEqual(await request.answer, { answers: { field: { selected: ['opaque_yes'] } } }); await until(() => root.hidden);
    request = open(); await panel.refresh(); button(host, 'Cancel request').click();
    assert.deepEqual(await request.answer, { optionId: null }); await until(() => root.hidden);
});

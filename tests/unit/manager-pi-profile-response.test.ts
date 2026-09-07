import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type { ComponentProps } from 'react';
import { ok } from '../../src/http/response.ts';
import { createSettingsClient } from '../../public/manager/src/settings/settings-client';
import type { PiSettingsView } from '../../public/manager/src/settings/pages/components/pi-profile';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, React: await import('react') };
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) globals[key] = value;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PiProfileDialog } = await import('../../public/manager/src/settings/pages/components/PiProfileDialog');
type Props = ComponentProps<typeof PiProfileDialog>;
after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key];
    }
});
const bounded = { timeout: 10_000 };
const returnedPi: PiSettingsView = {
    defaultProfileId: 'submitted-provider',
    profiles: [{ id: 'submitted-provider', label: 'Returned profile', mode: 'openai',
        endpoint: 'https://returned.invalid/v1', apiKind: 'openai-completions', model: 'selected-model',
        apiKeySet: true, apiKeyLast4: '1234' }],
    discoveredModels: { 'submitted-provider': ['selected-model', 'discovered-only-model'] },
};
function envelope(data: unknown): unknown {
    let payload: unknown;
    // Only the serializer's json port is needed; no Express server or route mocks.
    ok({ json(value: unknown) { payload = value; } } as Parameters<typeof ok>[0], data);
    return payload;
}
async function mount(t: TestContext) {
    const container = document.createElement('div'), opener = document.createElement('button');
    document.body.append(opener, container); opener.focus();
    const root = createRoot(container), response = Promise.withResolvers<Response>();
    const requests: Array<{ url: string; method: string | undefined; body: unknown; signal: AbortSignal | null | undefined }> = [];
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)), signal: init?.signal });
        assert.equal(String(url), '/i/43225/api/pi/profiles/register'); assert.equal(init?.method, 'POST');
        return response.promise;
    });
    const client = createSettingsClient(43225);
    let restores = 0;
    const focus = opener.focus.bind(opener);
    t.mock.method(opener, 'focus', (options?: FocusOptions) => { restores++; focus(options); });
    const registrations: Array<{ owner: string; next: Parameters<Props['onRegistered']>[0] }> = [], closes: string[] = [];
    const callbacks = (owner: string) => ({ onRegistered: (next: Parameters<Props['onRegistered']>[0]) => { registrations.push({ owner, next }); },
        onClose: () => { closes.push(owner); root.render(null); } });
    const props: Props = { client, provider: 'old-profile', model: 'old-model',
        pi: { defaultProfileId: 'old-profile', profiles: [{ id: 'old-profile', label: 'Old', mode: 'basic',
            endpoint: 'http://old.invalid/v1', model: 'old-model' }] }, ...callbacks('initial') };
    const render = async (patch: Partial<Props> = {}) => {
        Object.assign(props, patch); await act(async () => root.render(createElement(PiProfileDialog, props)));
    };
    t.after(async () => {
        await act(async () => {
            response.resolve(new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } }));
        });
        await act(async () => root.unmount()); container.remove(); opener.remove();
    });
    await render();
    const input = (id: string) => {
        const el = container.querySelector<HTMLInputElement>('#' + id); assert.ok(el); return el;
    };
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
        for (const [id, value] of [['pi-profile-id', 'submitted-provider'], ['pi-profile-model', 'selected-model']]) {
            const el = input(id); setter.call(el, value); el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        }
    });
    const button = (selector: string) => { const el = container.querySelector<HTMLButtonElement>(selector); assert.ok(el); return el; };
    return { container, opener, requests, registrations, closes, render, callbacks, input,
        restores: () => restores,
        submit: async () => { await act(async () => button('.settings-action-save').click()); },
        close: async () => { await act(async () => button('.settings-action-discard').click()); },
        finish: async (payload: unknown, status = 200) => { await act(async () => response.resolve(new Response(JSON.stringify(payload),
            { status, headers: { 'content-type': 'application/json' } }))); },
    };
}

test('Pi registration unwraps nested models and complete redacted metadata through the real SettingsClient', bounded, async t => {
    const h = await mount(t); await h.submit();
    await h.finish(envelope({ profile: returnedPi.profiles[0], models: ['selected-model', 'discovered-only-model'],
        modelSource: 'pi-offline', settings: { pi: returnedPi } }));
    assert.deepEqual(h.registrations, [{ owner: 'initial', next: { provider: 'submitted-provider', model: 'selected-model',
        models: ['selected-model', 'discovered-only-model'], pi: returnedPi } }]);
    assert.deepEqual(h.closes, ['initial']); assert.equal(h.requests.length, 1);
    assert.deepEqual(h.requests[0]!.body, { id: 'submitted-provider', label: 'submitted-provider', mode: 'basic',
        endpoint: 'http://old.invalid/v1', model: 'selected-model', apiKey: '' });
    assert.equal(Object.hasOwn(h.registrations[0]!.next.pi!.profiles[0]!, 'apiKey'), false);
});

test('submitted selection remains authoritative even when response profile differs', bounded, async t => {
    const h = await mount(t); await h.submit();
    await h.finish(envelope({ profile: { ...returnedPi.profiles[0], id: 'server-profile', model: 'server-model' },
        models: ['discovered-only-model'], settings: { pi: returnedPi } }));
    assert.deepEqual(h.registrations[0]?.next, { provider: 'submitted-provider', model: 'selected-model',
        models: ['discovered-only-model'], pi: returnedPi });
});

for (const settings of [undefined, {}]) test(`absent optional pi remains undefined, settings present=${settings !== undefined}`, bounded, async t => {
    const h = await mount(t); await h.submit();
    await h.finish(envelope({ models: ['discovered-only-model'], ...(settings ? { settings } : {}) }));
    assert.deepEqual(h.registrations[0]?.next, { provider: 'submitted-provider', model: 'selected-model',
        models: ['discovered-only-model'], pi: undefined });
});

test('rejected registration retains input and alert without success callbacks or retry', bounded, async t => {
    const h = await mount(t); await h.submit();
    await h.finish({ ok: false, error: 'Fixture model discovery rejected' }, 400);
    assert.match(h.container.querySelector('[role="alert"]')?.textContent ?? '', /Fixture model discovery rejected/);
    assert.equal(h.input('pi-profile-model').value, 'selected-model');
    assert.equal(h.container.querySelector<HTMLButtonElement>('.settings-action-save')?.disabled, false);
    assert.deepEqual(h.registrations, []); assert.deepEqual(h.closes, []); assert.equal(h.requests.length, 1);
});

test('missing data does not report root-only metadata as successful registration', bounded, async t => {
    const h = await mount(t); await h.submit();
    await h.finish({ models: ['root-only'], settings: { pi: returnedPi } });
    assert.ok(h.container.querySelector('[role="alert"]'));
    assert.deepEqual(h.registrations, []); assert.deepEqual(h.closes, []); assert.equal(h.requests.length, 1);
});

test('late metadata after Close retains admitted POST and captured callbacks without another focus restoration', bounded, async t => {
    const h = await mount(t); await h.submit(); await h.render(h.callbacks('latest')); await h.close();
    assert.deepEqual(h.closes, ['latest']); assert.equal(h.restores(), 1);
    assert.equal(h.requests[0]?.signal?.aborted, false, 'Close does not abort the admitted request');
    await h.finish(envelope({ models: ['selected-model', 'discovered-only-model'], settings: { pi: returnedPi } }));
    assert.deepEqual(h.registrations, [{ owner: 'initial', next: { provider: 'submitted-provider', model: 'selected-model',
        models: ['selected-model', 'discovered-only-model'], pi: returnedPi } }]);
    assert.deepEqual(h.closes, ['latest', 'initial']); assert.equal(h.restores(), 1);
    assert.equal(document.activeElement === h.opener, true); assert.equal(h.requests.length, 1);
});

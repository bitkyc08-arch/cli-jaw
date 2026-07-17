import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement as h } from 'react';
import * as ReactNamespace from 'react';
import type {
    CodeApiClient,
    CodeModelOptions,
    CodeRequestOptions,
} from '../../public/dashboard2/src/code/code-api-client.ts';
import { CodeApiError } from '../../public/dashboard2/src/code/code-api-client.ts';

(globalThis as Record<string, unknown>).React = ReactNamespace;

const anthropic: CodeModelOptions = {
    providers: [{
        id: 'anthropic',
        models: ['claude-sonnet-4.6', 'claude-opus-4.6'],
        efforts: [],
        modelSource: 'jwc-cache',
    }],
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4.6',
};

const codex: CodeModelOptions = {
    providers: [{
        id: 'openai-codex',
        models: ['gpt-5.6-sol'],
        efforts: ['high'],
        modelSource: 'static-fallback',
    }],
    defaultProvider: 'openai-codex',
    defaultModel: 'gpt-5.6-sol',
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function stubClient(overrides: Partial<CodeApiClient>): CodeApiClient {
    return overrides as CodeApiClient;
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
}

function installDom(): JSDOM {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
        url: 'http://127.0.0.1:24577/dashboard2/',
    });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    for (const name of [
        'window', 'document', 'navigator', 'Element', 'HTMLElement', 'Node',
        'Event', 'MouseEvent', 'KeyboardEvent', 'DOMException',
    ]) {
        Object.defineProperty(globalThis, name, {
            configurable: true,
            value: (dom.window as unknown as Record<string, unknown>)[name],
        });
    }
    Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(globalThis, 'innerHeight', { configurable: true, value: 768 });
    return dom;
}

test('rendered Code model control ignores a stale port inventory and reports the qualified selection', async () => {
    const dom = installDom();
    const first = deferred<CodeModelOptions>();
    const second = deferred<CodeModelOptions>();
    let firstSignal: AbortSignal | undefined;
    const firstClient = stubClient({
        listModelOptions: (options?: CodeRequestOptions) => {
            firstSignal = options?.signal;
            return first.promise;
        },
    });
    const secondClient = stubClient({ listModelOptions: async () => second.promise });
    const selected: Array<string | null> = [];

    const { createRoot } = await import('react-dom/client');
    const { CodeModelControl } = await import('../../public/dashboard2/src/code/CodeModelControl.tsx');
    const root = createRoot(dom.window.document.getElementById('root')!);
    await act(async () => {
        root.render(h(CodeModelControl, {
            client: firstClient,
            sessionId: null,
            onSelectionChange: (value: string | null) => selected.push(value),
        }));
        await flush();
    });
    await act(async () => {
        root.render(h(CodeModelControl, {
            client: secondClient,
            sessionId: null,
            onSelectionChange: (value: string | null) => selected.push(value),
        }));
        second.resolve(codex);
        await flush();
    });
    assert.equal(firstSignal?.aborted, true);
    assert.match(dom.window.document.querySelector('[role="combobox"]')?.textContent ?? '', /openai-codex.*gpt-5\.6-sol/);
    assert.equal(selected.at(-1), 'openai-codex/gpt-5.6-sol');

    await act(async () => {
        first.resolve(anthropic);
        await flush();
    });
    assert.match(dom.window.document.querySelector('[role="combobox"]')?.textContent ?? '', /openai-codex.*gpt-5\.6-sol/);
    assert.equal(selected.at(-1), 'openai-codex/gpt-5.6-sol');
    await act(async () => root.unmount());
});

test('rendered active-session switch keeps the last confirmed model and shows a typed safe error', async () => {
    const dom = installDom();
    const secret = 'provider-secret-details';
    const switched: string[] = [];
    const client = stubClient({
        listModelOptions: async () => anthropic,
        setSessionModel: async (_sessionId: string, modelId: string) => {
            switched.push(modelId);
            void secret;
            throw new CodeApiError('http_error', 'Code model switch request failed (500)', 500);
        },
    });
    const confirmed: Array<string | null> = [];

    const { createRoot } = await import('react-dom/client');
    const { CodeModelControl } = await import('../../public/dashboard2/src/code/CodeModelControl.tsx');
    const root = createRoot(dom.window.document.getElementById('root')!);
    await act(async () => {
        root.render(h(CodeModelControl, {
            client,
            sessionId: 'session-1',
            confirmedModelId: 'anthropic/claude-sonnet-4.6',
            onSelectionChange: (value: string | null) => confirmed.push(value),
        }));
        await flush();
    });

    const trigger = dom.window.document.querySelector<HTMLButtonElement>('[role="combobox"]');
    assert.ok(trigger);
    await act(async () => {
        trigger.click();
        await flush();
    });
    const opus = [...dom.window.document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find(option => option.textContent?.includes('claude-opus-4.6'));
    assert.ok(opus);
    await act(async () => {
        opus.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        await flush();
    });

    assert.deepEqual(switched, ['anthropic/claude-opus-4.6']);
    assert.equal(confirmed.at(-1), 'anthropic/claude-sonnet-4.6');
    assert.match(trigger.textContent ?? '', /claude-sonnet-4\.6/);
    assert.doesNotMatch(trigger.textContent ?? '', /claude-opus-4\.6/);
    const alert = dom.window.document.querySelector<HTMLElement>('[role="alert"]');
    assert.ok(alert);
    assert.equal(alert.dataset['errorCode'], 'http_error');
    assert.equal(alert.textContent?.includes(secret), false);
    await act(async () => root.unmount());
});

test('active session with unreported model stays unknown instead of guessing the catalog default', async () => {
    const dom = installDom();
    const confirmed: Array<string | null> = [];
    const client = stubClient({ listModelOptions: async () => anthropic });
    const { createRoot } = await import('react-dom/client');
    const { CodeModelControl } = await import('../../public/dashboard2/src/code/CodeModelControl.tsx');
    const root = createRoot(dom.window.document.getElementById('root')!);
    await act(async () => {
        root.render(h(CodeModelControl, {
            client, sessionId: 'loaded-without-model', confirmedModelId: null,
            onSelectionChange: (value: string | null) => confirmed.push(value),
        }));
        await flush();
    });
    assert.equal(confirmed.length, 0);
    assert.match(dom.window.document.querySelector('[role="combobox"]')?.textContent ?? '', /Select model/i);
    await act(async () => root.unmount());
});

test('authoritative session model event rerender updates the visible picker value', async () => {
    const dom = installDom();
    const client = stubClient({ listModelOptions: async () => anthropic });
    const { createRoot } = await import('react-dom/client');
    const { CodeModelControl } = await import('../../public/dashboard2/src/code/CodeModelControl.tsx');
    const root = createRoot(dom.window.document.getElementById('root')!);
    const render = (confirmedModelId: string) => h(CodeModelControl, {
        client, sessionId: 'event-session', confirmedModelId,
        onSelectionChange: () => {},
    });
    await act(async () => {
        root.render(render('anthropic/claude-sonnet-4.6'));
        await flush();
    });
    assert.match(dom.window.document.querySelector('[role="combobox"]')?.textContent ?? '', /claude-sonnet-4\.6/);
    await act(async () => {
        root.render(render('anthropic/claude-opus-4.6'));
        await flush();
    });
    assert.match(dom.window.document.querySelector('[role="combobox"]')?.textContent ?? '', /claude-opus-4\.6/);
    await act(async () => root.unmount());
});

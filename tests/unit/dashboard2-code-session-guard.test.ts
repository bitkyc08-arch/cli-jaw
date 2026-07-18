import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement as h } from 'react';
import * as ReactNamespace from 'react';
import type { CodeSessionInfo } from '../../src/code-mode/types.ts';
import type { CodeApiClient, CodeModelOptions } from '../../public/dashboard2/src/code/code-api-client.ts';
import { CodeApiError } from '../../public/dashboard2/src/code/code-api-client.ts';

(globalThis as Record<string, unknown>).React = ReactNamespace;

const catalog: CodeModelOptions = {
    providers: [{
        id: 'anthropic',
        models: ['claude-sonnet-5'],
        efforts: [],
        modelSource: 'jwc-cache',
    }],
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-5',
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
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

test('delayed create on the same port never overwrites a session the user selected mid-flight', async () => {
    const dom = installDom();
    const liveSession: CodeSessionInfo = {
        sessionId: 'live-1', cwd: '/repo', status: 'idle',
        createdAt: 1, lastUsedAt: 1, modelId: 'anthropic/claude-sonnet-5',
    };
    const createdSession: CodeSessionInfo = {
        sessionId: 'created-1', cwd: '/repo', status: 'idle',
        createdAt: 2, lastUsedAt: 2, modelId: 'openai-codex/gpt-5.6-sol',
    };
    const pendingCreate = deferred<CodeSessionInfo>();
    const closed: string[] = [];
    const clientStub = {
        listModelOptions: async () => catalog,
        listSessions: async () => [liveSession],
        listStoredSessions: async () => [],
        newSession: () => pendingCreate.promise,
        closeSession: async (sessionId: string) => { closed.push(sessionId); return { ok: true as const }; },
    } as unknown as CodeApiClient;

    mock.module('../../public/dashboard2/src/providers/api-provider.tsx', {
        namedExports: {
            useManagerApi: () => ({ fetchInstances: async () => [{ port: 3506, workingDir: '/repo' }] }),
        },
    });
    mock.module('../../public/dashboard2/src/providers/sync-provider.tsx', {
        namedExports: { useManagerSync: () => ({ subscribeJwc: () => () => {} }) },
    });
    mock.module('../../public/dashboard2/src/code/code-api-client.ts', {
        namedExports: { createCodeApiClient: () => clientStub, CodeApiError },
    });

    const { createRoot } = await import('react-dom/client');
    const { CodeTab } = await import('../../public/dashboard2/src/code/CodeTab.tsx');
    const root = createRoot(dom.window.document.getElementById('root')!);
    try {
        await act(async () => {
            root.render(h(CodeTab, { port: 3506 }));
            await flush();
        });
        const newButton = dom.window.document.querySelector('.d2-code-new-session');
        const liveRow = dom.window.document.querySelector('.d2-code-session-row');
        assert.ok(newButton, 'new session button rendered');
        assert.ok(liveRow, 'live session row rendered');

        // Start a create (stays in flight), then select the live session.
        await act(async () => {
            newButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
            await flush();
        });
        await act(async () => {
            liveRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
            await flush();
        });

        // The late create resolves: it must be cleaned up, not adopted.
        await act(async () => {
            pendingCreate.resolve(createdSession);
            await flush();
        });

        assert.deepEqual(closed, ['created-1']);
        const activePicker = [...dom.window.document.querySelectorAll('button')]
            .find(button => button.getAttribute('aria-label')?.includes('Active Code session provider and model'));
        assert.ok(activePicker, 'active session picker rendered');
        const label = activePicker.getAttribute('aria-label') ?? '';
        assert.ok(label.includes('anthropic'), `expected live session model, got: ${label}`);
        assert.equal(label.includes('gpt-5.6-sol'), false, `late create leaked into UI: ${label}`);
    } finally {
        await act(async () => { root.unmount(); });
        mock.restoreAll();
    }
});

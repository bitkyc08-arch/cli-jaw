import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement as h } from 'react';
import * as ReactNamespace from 'react';
import type { DashboardInstance, DashboardRegistry } from '../../src/manager/types.ts';

function row(status: 'online' | 'offline'): DashboardInstance {
    return {
        port: 3457,
        url: 'http://127.0.0.1:3457',
        status,
        ok: status === 'online',
        version: status === 'online' ? '2.2.7' : null,
        uptime: status === 'online' ? 1 : null,
        instanceId: status === 'online' ? 'rendered-test' : null,
        homeDisplay: '~/.cli-jaw',
        workingDir: '/tmp/rendered-test',
        projectDirs: ['/tmp/rendered-test'],
        currentCli: status === 'online' ? 'codex' : null,
        currentModel: null,
        serviceMode: 'ad-hoc',
        label: 'Instance 3457',
        lastCheckedAt: '2026-07-16T00:00:00.000Z',
        healthReason: null,
        lifecycle: {
            owner: status === 'online' ? 'manager' : 'none',
            canStart: status === 'offline',
            canStop: status === 'online',
            canRestart: status === 'online',
            canPerm: status === 'online',
            canUnperm: false,
            reason: 'rendered test',
            defaultHome: '/tmp/rendered-test',
            commandPreview: ['jaw', 'serve'],
            pid: status === 'online' ? 1234 : null,
        },
    };
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
}

test('rendered Sidebar suppresses duplicate Start and announces Start/Stop convergence', async () => {
    (globalThis as Record<string, unknown>).React = ReactNamespace;
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
        url: 'http://127.0.0.1:24577/dashboard2/',
    });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    for (const name of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'Node', 'Event', 'MouseEvent']) {
        Object.defineProperty(globalThis, name, {
            configurable: true,
            value: (dom.window as unknown as Record<string, unknown>)[name],
        });
    }
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage });
    Object.defineProperty(globalThis, 'matchMedia', {
        configurable: true,
        value: () => ({
            matches: false,
            addEventListener() {},
            removeEventListener() {},
        }),
    });
    Object.defineProperty(dom.window, 'confirm', { configurable: true, value: () => true });

    class FakeEventSource {
        onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(readonly url: string) {}
        close(): void {}
    }
    Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: FakeEventSource });

    let lifecyclePosts = 0;
    let instanceListCalls = 0;
    let singleInstancePolls = 0;
    let liveStatus: 'online' | 'offline' = 'offline';
    let resolveStaleList!: (response: Response) => void;
    const staleList = new Promise<Response>(resolve => { resolveStaleList = resolve; });
    let resolveStartPoll!: (response: Response) => void;
    const startPoll = new Promise<Response>(resolve => { resolveStartPoll = resolve; });
    let holdNextStart = false;
    let heldStartSignal: AbortSignal | undefined;
    let resolveHeldStart!: (response: Response) => void;
    const heldStart = new Promise<Response>(resolve => { resolveHeldStart = resolve; });
    Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            if (url === '/api/dashboard/instances') {
                instanceListCalls += 1;
                if (instanceListCalls === 1) return staleList;
                return json({ manager: {}, instances: [row(liveStatus)], peerDashboards: [], platform: 'darwin' });
            }
            if (url === '/api/dashboard/lifecycle/start') {
                lifecyclePosts += 1;
                if (holdNextStart) {
                    heldStartSignal = init?.signal ?? undefined;
                    return heldStart;
                }
                return json({
                    ok: true, action: 'start', port: 3457, status: 'started', message: 'started',
                    home: '/tmp/rendered-test', pid: 1234, command: ['jaw', 'serve'], expectedStateAfter: 'online',
                });
            }
            if (url === '/api/dashboard/lifecycle/stop') {
                lifecyclePosts += 1;
                liveStatus = 'offline';
                return json({
                    ok: true, action: 'stop', port: 3457, status: 'stopped', message: 'stopped',
                    home: '/tmp/rendered-test', pid: null, command: ['jaw', 'serve'], expectedStateAfter: 'offline',
                });
            }
            if (url === '/api/dashboard/instances/3457') {
                singleInstancePolls += 1;
                if (liveStatus === 'offline' && lifecyclePosts === 1) return startPoll;
                return json({ ok: true, instance: row(liveStatus), platform: 'darwin' });
            }
            throw new Error(`unexpected fetch ${init?.method || 'GET'} ${url}`);
        },
    });

    const registry = {
        ui: {
            uiTheme: 'auto', locale: 'ko', dashboardShortcutsEnabled: true,
            dashboardShortcutKeymap: {}, chatLinkPreviewsEnabled: false,
        },
    } as unknown as DashboardRegistry;
    const preferencesClient = {
        load: async () => ({ registry, status: {} }),
        patch: async () => ({ registry, status: {} }),
    };

    const { createRoot } = await import('react-dom/client');
    const { ManagerApiProvider } = await import('../../public/dashboard2/src/providers/api-provider.tsx');
    const { ManagerPreferencesProvider } = await import('../../public/dashboard2/src/providers/preferences-provider.tsx');
    const { ManagerSyncProvider } = await import('../../public/dashboard2/src/providers/sync-provider.tsx');
    const { AppScopeProvider } = await import('../../public/dashboard2/src/state/scope.tsx');
    const { Sidebar } = await import('../../public/dashboard2/src/shell/Sidebar.tsx');
    const root = createRoot(dom.window.document.getElementById('root')!);

    await act(async () => {
        root.render(h(ReactNamespace.StrictMode, null,
            h(ManagerApiProvider, null,
                h(ManagerPreferencesProvider, { client: preferencesClient },
                    h(AppScopeProvider, null,
                        h(ManagerSyncProvider, null, h(Sidebar)))))));
        await flush();
    });

    const start = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Start Instance 3457"]');
    assert.ok(start, 'offline Start must render as a semantic button');
    assert.equal(start.disabled, false);
    assert.match(start.className, /is-always-visible/);

    await act(async () => {
        start.click();
        start.click();
        await flush();
    });
    assert.equal(lifecyclePosts, 1, 'busy ref guard must suppress the duplicate lifecycle POST');
    assert.equal(dom.window.document.querySelector('[role="status"]')?.textContent, 'Starting…');
    assert.equal(dom.window.document.querySelector('.d2-instance-row')?.getAttribute('aria-busy'), 'true');

    liveStatus = 'online';
    await act(async () => {
        resolveStartPoll(json({ ok: true, instance: row('online'), platform: 'darwin' }));
        await flush();
    });
    await act(async () => {
        resolveStaleList(json({ manager: {}, instances: [row('offline')], peerDashboards: [], platform: 'darwin' }));
        await flush();
    });
    const stop = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Stop Instance 3457"]');
    assert.ok(stop, 'a stale full-list response must not overwrite the converged online row');

    await act(async () => {
        stop.click();
        await flush();
    });
    assert.equal(lifecyclePosts, 2);
    assert.ok(dom.window.document.querySelector('[aria-label="Start Instance 3457"]'));
    assert.equal(dom.window.document.querySelector('[role="alert"]'), null);

    holdNextStart = true;
    const pollsBeforeUnmount = singleInstancePolls;
    const startAfterStop = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Start Instance 3457"]');
    assert.ok(startAfterStop);
    await act(async () => {
        startAfterStop.click();
        await flush();
    });
    assert.equal(lifecyclePosts, 3);
    await act(async () => root.unmount());
    assert.equal(heldStartSignal?.aborted, true, 'unmount must abort a pending lifecycle POST');
    await act(async () => {
        resolveHeldStart(json({
            ok: true, action: 'start', port: 3457, status: 'started', message: 'late start',
            home: '/tmp/rendered-test', pid: 4321, command: ['jaw', 'serve'], expectedStateAfter: 'online',
        }));
        await flush();
    });
    assert.equal(singleInstancePolls, pollsBeforeUnmount, 'a late POST response must not start polling after unmount');
});

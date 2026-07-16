import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h, act } from 'react';
import * as ReactNamespace from 'react';
import { JSDOM } from 'jsdom';
import type {
    DashboardInstance,
    DashboardLifecycleResult,
} from '../../src/manager/types.ts';
import type { ManagerApiClient } from '../../public/dashboard2/src/providers/api-provider.tsx';

(globalThis as Record<string, unknown>).React = ReactNamespace;

function instance(port: number): DashboardInstance {
    return {
        port,
        url: `http://127.0.0.1:${port}`,
        status: 'online',
        ok: true,
        version: '2.2.7',
        uptime: 12,
        instanceId: `instance-${port}`,
        homeDisplay: '~/.cli-jaw',
        workingDir: '/tmp/project',
        projectDirs: ['/tmp/project'],
        currentCli: 'codex',
        currentModel: 'gpt-5.6',
        serviceMode: 'ad-hoc',
        lastCheckedAt: '2026-07-16T00:00:00.000Z',
        healthReason: null,
    };
}

function lifecycleResult(overrides: Partial<DashboardLifecycleResult> = {}): DashboardLifecycleResult {
    return {
        ok: true,
        action: 'start',
        port: 3457,
        status: 'started',
        message: 'started :3457',
        home: '/tmp/home',
        pid: 1234,
        command: ['jaw', 'serve'],
        expectedStateAfter: 'online',
        ...overrides,
    };
}

test('manager API exposes typed single-instance and lifecycle contracts with retry classification', async () => {
    const dom = new JSDOM('<div id="root"></div>');
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    for (const [name, value] of Object.entries({
        window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    })) Object.defineProperty(globalThis, name, { configurable: true, value });

    const responses: Array<Response | Error> = [
        new Response(JSON.stringify({ ok: true, instance: instance(3457), platform: 'darwin' }), {
            status: 200, headers: { 'content-type': 'application/json' },
        }),
        new Response(JSON.stringify({ ok: true, instance: instance(3458), platform: 'darwin' }), {
            status: 200, headers: { 'content-type': 'application/json' },
        }),
        new Response(JSON.stringify({ ok: false, error: 'port out of configured scan range' }), {
            status: 400, headers: { 'content-type': 'application/json' },
        }),
        new Response(JSON.stringify({ ok: false, error: 'single scan unavailable' }), {
            status: 503, headers: { 'content-type': 'application/json' },
        }),
        new TypeError('network down'),
        new Response(JSON.stringify(lifecycleResult({ action: 'stop', port: 3458 })), {
            status: 200, headers: { 'content-type': 'application/json' },
        }),
        new Response(JSON.stringify(lifecycleResult({
            ok: false, status: 'rejected', message: 'instance already running', expectedStateAfter: undefined,
        })), { status: 400, headers: { 'content-type': 'application/json' } }),
        new Response(JSON.stringify(lifecycleResult()), {
            status: 200, headers: { 'content-type': 'application/json' },
        }),
    ];
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: async (input: string, init?: RequestInit) => {
            calls.push({ input, ...(init ? { init } : {}) });
            const next = responses.shift();
            if (next instanceof Error) throw next;
            assert.ok(next, 'unexpected fetch call');
            return next;
        },
    });

    const { createRoot } = await import('react-dom/client');
    const { ManagerApiProvider, ManagerApiError, useManagerApi } = await import('../../public/dashboard2/src/providers/api-provider.tsx');
    let api: ManagerApiClient | null = null;
    function Probe() {
        api = useManagerApi();
        return null;
    }
    const root = createRoot(dom.window.document.getElementById('root')!);
    await act(async () => root.render(h(ManagerApiProvider, null, h(Probe))));
    const client = api as ManagerApiClient | null;
    assert.ok(client);

    const controller = new AbortController();
    const success = await client.manager.fetchInstance(3457, { signal: controller.signal });
    assert.equal(success.ok, true);
    assert.equal(success.instance?.port, 3457);
    assert.equal(success.platform, 'darwin');
    assert.equal(calls[0]?.input, '/api/dashboard/instances/3457');
    assert.equal(calls[0]?.init?.signal, controller.signal);
    assert.equal(new Headers(calls[0]?.init?.headers).get('accept'), 'application/json');

    await assert.rejects(client.manager.fetchInstance(3457), (error: unknown) => {
        assert.ok(error instanceof ManagerApiError);
        assert.equal(error.retryable, false);
        assert.equal(error.message, 'Instance returned an invalid response');
        return true;
    });
    await assert.rejects(client.manager.fetchInstance(9999), (error: unknown) => {
        assert.ok(error instanceof ManagerApiError);
        assert.equal(error.status, 400);
        assert.equal(error.retryable, false);
        assert.equal(error.message, 'port out of configured scan range');
        assert.deepEqual(error.envelope, { ok: false, error: 'port out of configured scan range' });
        return true;
    });
    await assert.rejects(client.manager.fetchInstance(3457), (error: unknown) => {
        assert.ok(error instanceof ManagerApiError);
        assert.equal(error.status, 503);
        assert.equal(error.retryable, true);
        assert.equal(error.message, 'single scan unavailable');
        return true;
    });
    await assert.rejects(client.manager.fetchInstance(3457), (error: unknown) => {
        assert.ok(error instanceof ManagerApiError);
        assert.equal(error.status, null);
        assert.equal(error.retryable, true);
        assert.equal(error.message, 'network down');
        return true;
    });

    await assert.rejects(client.manager.runLifecycleAction('start', 3457, '/tmp/home'), (error: unknown) => {
        assert.ok(error instanceof ManagerApiError);
        assert.equal(error.message, 'Lifecycle start returned an invalid response');
        return true;
    });
    await assert.rejects(client.manager.runLifecycleAction('start', 3457, '/tmp/home'), (error: unknown) => {
        assert.ok(error instanceof ManagerApiError);
        assert.equal(error.status, 400);
        assert.equal(error.retryable, false);
        assert.equal(error.message, 'instance already running');
        assert.equal(error.result?.message, 'instance already running');
        return true;
    });
    const actionController = new AbortController();
    const started = await client.manager.runLifecycleAction(
        'start',
        3457,
        '/tmp/home',
        { signal: actionController.signal },
    );
    assert.equal(started.message, 'started :3457');
    assert.equal(started.expectedStateAfter, 'online');
    assert.deepEqual(JSON.parse(String(calls[7]?.init?.body)), { port: 3457, home: '/tmp/home' });
    assert.equal(calls[7]?.input, '/api/dashboard/lifecycle/start');
    assert.equal(calls[7]?.init?.signal, actionController.signal);

    await act(async () => root.unmount());
});

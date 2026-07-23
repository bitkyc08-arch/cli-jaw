// 048 Gate D2 companion — BEHAVIORAL generation-race test: a stale
// EventSource (previous port generation) must never reach subscribers, and
// port changes publish the port_change invalidation in order.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement as h, act } from 'react';
import * as ReactNamespace from 'react';
import { JSDOM } from 'jsdom';

(globalThis as Record<string, unknown>).React = ReactNamespace;

class FakeEventSource {
    static instances: FakeEventSource[] = [];
    url: string;
    onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
    }
    close(): void { this.closed = true; }
    emit(payload: unknown, lastEventId = ''): void {
        this.onmessage?.({ data: JSON.stringify(payload), lastEventId });
    }
}

test('D2: stale-generation EventSource messages never reach subscribers; port_change ordered', async () => {
    const dom = new JSDOM('<div id="root"></div>');
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    for (const [name, value] of Object.entries({
        window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    })) Object.defineProperty(globalThis, name, { configurable: true, value });
    // jsdom defaults to visibilityState 'prerender' (hidden=true) which makes
    // the provider skip open(); force a visible document
    Object.defineProperty(dom.window.document, 'hidden', { configurable: true, value: false });
    Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, value: 'visible' });
    (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
    (dom.window as unknown as Record<string, unknown>).EventSource = FakeEventSource;

    const { createRoot } = await import('react-dom/client');
    const { AppScopeProvider, useAppScope } = await import('../../public/dashboard2/src/state/scope.tsx');
    const { ManagerSyncProvider, useManagerSync } = await import('../../public/dashboard2/src/providers/sync-provider.tsx');

    const received: string[] = [];
    const invalidations: string[] = [];
    let scopeApi: { guardedSelectSession(port: number, sessionId: string): Promise<boolean> } | null = null;

    function Probe() {
        const scope = useAppScope();
        const sync = useManagerSync();
        scopeApi = scope;
        (ReactNamespace as typeof import('react')).useEffect(() => {
            const offTurn = sync.subscribeTurnLifecycle(payload => { received.push(`${payload.turnId}#${payload.turnSeq}`); });
            const offInv = sync.subscribeInvalidation(reason => { invalidations.push(reason); });
            return () => { offTurn(); offInv(); };
        }, [sync]);
        return null;
    }

    const root = createRoot(dom.window.document.getElementById('root')!);
    await act(async () => {
        root.render(h(AppScopeProvider, null, h(ManagerSyncProvider, null, h(Probe))));
    });
    await act(async () => { await scopeApi!.guardedSelectSession(3457, 'main'); });
    assert.ok(FakeEventSource.instances.length >= 1, 'EventSource opened for the first port');
    const first = FakeEventSource.instances[FakeEventSource.instances.length - 1];

    const row = {
        topic: 'agent', event: 'turn_segment', turnId: 'race-turn', turnSeq: 1,
        segmentId: 'race-turn:seg', sessionId: 'main', createdAt: 1, observedAt: 1,
        providerAt: null, fidelity: 'full', thinkingMarker: null, type: 'thinking', status: 'running', detailRef: null,
    };
    await act(async () => { first.emit(row, '1'); });
    assert.deepEqual(received, ['race-turn#1'], 'live generation delivers');

    // port switch: new generation + port_change invalidation
    await act(async () => { await scopeApi!.guardedSelectSession(3458, 'main'); });
    assert.ok(invalidations.includes('port_change'), 'port_change invalidation published');
    const second = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    assert.notEqual(second, first, 'a new EventSource opened for the new port');

    // STALE emit on the old source must not reach subscribers
    await act(async () => { first.emit({ ...row, turnSeq: 2 }, '2'); });
    assert.deepEqual(received, ['race-turn#1'], 'stale-generation callback delivered 0 events');

    // live emit on the new source still works
    await act(async () => { second.emit({ ...row, turnSeq: 3 }, '3'); });
    assert.deepEqual(received, ['race-turn#1', 'race-turn#3'], 'new generation delivers');

    // 089.10 adds per-source watchdog timers; unmount proves provider cleanup
    // and prevents a passed contract test from retaining live transport work.
    await act(async () => { root.unmount(); });
});

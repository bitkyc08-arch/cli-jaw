import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h, act, useEffect } from 'react';
import * as ReactNamespace from 'react';
import { JSDOM } from 'jsdom';
import {
    SseConnection,
    type SseConnectionClock,
    type SseSourceLike,
} from '../../public/dashboard2/src/providers/sse-connection.ts';
import {
    dispatchSyncPayloadForSource,
    type ManagerSyncContextValue,
} from '../../public/dashboard2/src/providers/sync-provider.tsx';

(globalThis as Record<string, unknown>).React = ReactNamespace;

class FakeSource implements SseSourceLike {
    onmessage: ((message: { data: string; lastEventId?: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;

    constructor(readonly url: string) {}

    close(): void { this.closed = true; }

    emit(payload: unknown, lastEventId = ''): void {
        this.onmessage?.({ data: JSON.stringify(payload), lastEventId });
    }

    fail(): void { this.onerror?.(); }
}

type FakeTimer = { at: number; callback: () => void; every?: number; active: boolean };

class FakeClock implements SseConnectionClock {
    current = 0;
    timers: FakeTimer[] = [];
    now(): number { return this.current; }
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
        return this.add(callback, delayMs) as unknown as ReturnType<typeof setTimeout>;
    }
    clearTimeout(timer: ReturnType<typeof setTimeout>): void { (timer as unknown as FakeTimer).active = false; }
    setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval> {
        const timer = this.add(callback, delayMs);
        timer.every = delayMs;
        return timer as unknown as ReturnType<typeof setInterval>;
    }
    clearInterval(timer: ReturnType<typeof setInterval>): void { (timer as unknown as FakeTimer).active = false; }
    tick(ms: number): void {
        const target = this.current + ms;
        while (true) {
            const next = this.timers
                .filter(timer => timer.active && timer.at <= target)
                .sort((a, b) => a.at - b.at)[0];
            if (!next) break;
            this.current = next.at;
            if (next.every) next.at += next.every;
            else next.active = false;
            next.callback();
        }
        this.current = target;
    }
    private add(callback: () => void, delayMs: number): FakeTimer {
        const timer = { at: this.current + delayMs, callback, active: true };
        this.timers.push(timer);
        return timer;
    }
}

test('source policy keeps JWC worker-canonical and drops non-allowlisted manager topics', () => {
    const seen: string[] = [];
    const dispatchers = {
        turn: () => seen.push('turn'), body: () => seen.push('body'), queue: () => seen.push('queue'),
        system: () => seen.push('system'), jwc: () => seen.push('jwc'),
        managerWorker: (payload: { event: string }) => seen.push(payload.event),
    };

    dispatchSyncPayloadForSource('manager', {
        topic: 'worker', event: 'instance-status-changed', port: 3457, change: 'status',
        prev: { status: 'offline', version: null }, next: { status: 'online', version: '2.2.7' },
    }, dispatchers);
    dispatchSyncPayloadForSource('manager', {
        topic: 'worker', event: 'worker_settings_change', port: 3457, changedKeys: ['currentModel'],
    }, dispatchers);
    dispatchSyncPayloadForSource('manager', { topic: 'jwc', event: 'code_delta' }, dispatchers);
    dispatchSyncPayloadForSource('manager', { topic: 'agent', event: 'turn_start' }, dispatchers);
    dispatchSyncPayloadForSource('manager', { topic: 'unknown', event: 'anything' }, dispatchers);
    dispatchSyncPayloadForSource('worker', { topic: 'jwc', event: 'code_delta' }, dispatchers, 'w-9');

    assert.deepEqual(seen, ['instance-status-changed', 'worker_settings_change', 'jwc']);
});

test('manager worker frames are normalized as a validated discriminated union', () => {
    const seen: unknown[] = [];
    const dispatchers = {
        turn: () => {}, body: () => {}, queue: () => {}, system: () => {},
        managerWorker: (payload: unknown) => seen.push(payload),
    };
    const dispatch = (payload: unknown) => dispatchSyncPayloadForSource('manager', payload, dispatchers);

    assert.equal(dispatch({
        topic: 'worker', event: 'instance-status-changed', port: 3457, change: 'appeared',
        next: { status: 'online', version: '2.2.7' }, sseReplay: true, ignored: 'not forwarded',
    }), 'manager-worker');
    assert.equal(dispatch({
        topic: 'worker', event: 'instance-status-changed', port: 3458, change: 'disappeared',
        prev: { status: 'offline', version: null },
    }), 'manager-worker');
    assert.equal(dispatch({
        topic: 'worker', event: 'worker_settings_change', port: 3459, changedKeys: null,
    }), 'manager-worker');

    const malformed = [
        null,
        [],
        { topic: 'worker', event: 'instance-status-changed', change: 'appeared', next: { status: 'online', version: null } },
        { topic: 'worker', event: 'instance-status-changed', port: '3457', change: 'appeared', next: { status: 'online', version: null } },
        { topic: 'worker', event: 'instance-status-changed', port: 65_536, change: 'appeared', next: { status: 'online', version: null } },
        { topic: 'worker', event: 'instance-status-changed', port: 3457, change: 'appeared', prev: { status: 'offline', version: null }, next: { status: 'online', version: null } },
        { topic: 'worker', event: 'instance-status-changed', port: 3457, change: 'disappeared', prev: { status: 'offline', version: null }, next: { status: 'online', version: null } },
        { topic: 'worker', event: 'instance-status-changed', port: 3457, change: 'status', prev: { status: 'offline', version: null } },
        { topic: 'worker', event: 'instance-status-changed', port: 3457, change: 'version', prev: { status: 'online' }, next: { status: 'online', version: '2.2.7' } },
        { topic: 'worker', event: 'instance-status-changed', port: 3457, change: 'other', prev: { status: 'offline', version: null }, next: { status: 'online', version: null } },
        { topic: 'worker', event: 'instance-status-changed', port: 3457, change: 'appeared', next: { status: 'online', version: null }, sseReplay: 'yes' },
        { topic: 'worker', event: 'worker_settings_change', port: 3457 },
        { topic: 'worker', event: 'worker_settings_change', port: 3457, changedKeys: ['currentCli', 2] },
        { topic: 'agent', event: 'worker_settings_change', port: 3457, changedKeys: null },
    ];
    for (const payload of malformed) assert.equal(dispatch(payload), null);

    assert.deepEqual(seen, [
        {
            topic: 'worker', event: 'instance-status-changed', port: 3457, change: 'appeared',
            next: { status: 'online', version: '2.2.7' }, sseReplay: true,
        },
        {
            topic: 'worker', event: 'instance-status-changed', port: 3458, change: 'disappeared',
            prev: { status: 'offline', version: null },
        },
        { topic: 'worker', event: 'worker_settings_change', port: 3459, changedKeys: null },
    ]);
});

test('connection owns cursor, close-before-backoff, ping health, and stale restart per source', () => {
    const clock = new FakeClock();
    const sources: FakeSource[] = [];
    const cursors = new Map<string, string>();
    let reconnects = 0;
    const payloads: Record<string, unknown>[] = [];
    const connection = new SseConnection({
        key: 'manager', url: '/api/events', clock,
        createSource: url => { const source = new FakeSource(url); sources.push(source); return source; },
        getCursor: () => cursors.get('manager'),
        setCursor: cursor => cursors.set('manager', cursor),
        onPayload: payload => payloads.push(payload),
        onReconnect: () => { reconnects += 1; },
    });

    connection.start();
    assert.equal(sources[0].url, '/api/events');
    sources[0].emit({ topic: 'worker', event: 'instance-status-changed' }, '17');
    clock.tick(30_000);
    sources[0].emit({ topic: 'system', event: 'ping' });
    assert.equal(cursors.get('manager'), '17', 'id-less ping must not advance the cursor');
    clock.tick(44_999);
    assert.equal(sources.length, 1, 'ping postpones staleness for 45 seconds');
    clock.tick(1);
    assert.equal(sources[0].closed, true, 'stale source closes before retry');
    clock.tick(999);
    assert.equal(sources.length, 1);
    clock.tick(1);
    assert.equal(sources[1].url, '/api/events?lastEventId=17');
    assert.equal(reconnects, 2, 'stale detection and its reopen are source-local signals');

    sources[1].emit({ topic: 'system', event: 'ping' });
    sources[1].fail();
    assert.equal(sources[1].closed, true, 'onerror closes native EventSource immediately');
    clock.tick(999);
    assert.equal(sources.length, 2, 'manual backoff is the sole reconnect authority');
    clock.tick(1);
    assert.equal(sources.length, 3);
    assert.equal(payloads.length, 3);
    connection.stop();
});

test('provider keeps manager source across worker port changes and reconnects both on visibility', async () => {
    FakeEventSource.instances = [];
    const dom = new JSDOM('<div id="root"></div>');
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    for (const [name, value] of Object.entries({
        window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    })) Object.defineProperty(globalThis, name, { configurable: true, value });
    let hidden = false;
    Object.defineProperty(dom.window.document, 'hidden', { configurable: true, get: () => hidden });
    (globalThis as Record<string, unknown>).EventSource = FakeEventSource;

    const { createRoot } = await import('react-dom/client');
    const { AppScopeProvider, useAppScope } = await import('../../public/dashboard2/src/state/scope.tsx');
    const { ManagerSyncProvider, useManagerSync } = await import('../../public/dashboard2/src/providers/sync-provider.tsx');
    let selectSession: ((port: number, sessionId: string) => Promise<boolean>) | null = null;
    const managerEvents: string[] = [];
    const jwcEvents: string[] = [];

    function Probe() {
        const scope = useAppScope();
        const sync: ManagerSyncContextValue = useManagerSync();
        selectSession = scope.guardedSelectSession;
        useEffect(() => {
            const offManager = sync.subscribeManagerWorker(payload => managerEvents.push(payload.event));
            const offJwc = sync.subscribeJwc(payload => jwcEvents.push(payload.event));
            return () => { offManager(); offJwc(); };
        }, [sync]);
        return null;
    }

    const root = createRoot(dom.window.document.getElementById('root')!);
    await act(async () => root.render(h(AppScopeProvider, null, h(ManagerSyncProvider, null, h(Probe)))));
    assert.deepEqual(FakeEventSource.instances.map(source => source.url), ['/api/events']);
    const manager = FakeEventSource.instances[0];
    await act(async () => { await selectSession!(3457, 'main'); });
    const worker3457 = FakeEventSource.instances.at(-1)!;
    manager.emit({
        topic: 'worker', event: 'instance-status-changed', port: 3457, change: 'status',
        prev: { status: 'offline', version: null }, next: { status: 'online', version: '2.2.7' },
    }, '5');
    manager.emit({ topic: 'jwc', event: 'code_delta' }, '6');
    worker3457.emit({ topic: 'jwc', event: 'code_delta' }, '5');
    assert.deepEqual(managerEvents, ['instance-status-changed']);
    assert.deepEqual(jwcEvents, ['code_delta'], 'manager JWC is dropped; worker JWC is delivered once');

    await act(async () => { await selectSession!(3458, 'main'); });
    assert.equal(manager.closed, false, 'port change must not replace manager source');
    assert.equal(worker3457.closed, true);
    assert.equal(FakeEventSource.instances.at(-1)!.url, '/i/3458/api/events');

    hidden = true;
    dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
    assert.ok(FakeEventSource.instances.every(source => source.closed));
    hidden = false;
    dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
    assert.ok(FakeEventSource.instances.some(source => source.url === '/api/events?lastEventId=6'));
    assert.ok(FakeEventSource.instances.some(source => source.url === '/i/3458/api/events'));
    await act(async () => root.unmount());
});

class FakeEventSource extends FakeSource {
    static instances: FakeEventSource[] = [];
    constructor(url: string) {
        super(url);
        FakeEventSource.instances.push(this);
    }
}

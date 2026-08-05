import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

// 072 §1.3a — every SSE test so far exercised the server predicate, so the browser could
// stop sending its scope entirely and they would all stay green. This one watches the URL.

type Constructed = { url: string };
const constructed: Constructed[] = [];

class FakeEventSource {
    onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onopen: (() => void) | null = null;
    constructor(public url: string) { constructed.push({ url }); }
    close(): void {}
}

const globals = globalThis as unknown as Record<string, unknown>;
const previous = {
    EventSource: globals['EventSource'],
    window: globals['window'],
    localStorage: globals['localStorage'],
};
globals['EventSource'] = FakeEventSource;
globals['window'] = { location: { origin: 'http://localhost:3457', pathname: '/' } };

const channel = await import('../../public/js/event-channel.ts');

afterEach(() => {
    constructed.length = 0;
    channel.setEventChannelScopeProvider(null);
    channel.closeEventChannel?.();
});

test.after(() => {
    globals['EventSource'] = previous.EventSource;
    globals['window'] = previous.window;
    globals['localStorage'] = previous.localStorage;
});

function lastUrl(): string {
    const entry = constructed[constructed.length - 1];
    assert.ok(entry, 'the channel must have opened a connection');
    return entry.url;
}

test('the channel subscribes with the scope its provider returns', () => {
    channel.setEventChannelScopeProvider(() => 'local:sess-2');
    channel.connectEventChannel('en');
    assert.match(lastUrl(), /[?&]scope=local%3Asess-2(&|$)/);
});

test('a remote scope survives url encoding intact', () => {
    channel.setEventChannelScopeProvider(() => 'jaw:slack:channel:C1');
    channel.connectEventChannel('en');
    assert.match(lastUrl(), /[?&]scope=jaw%3Aslack%3Achannel%3AC1(&|$)/);
});

test('no provider and a null scope both open an unfiltered connection', () => {
    channel.connectEventChannel('en');
    assert.doesNotMatch(lastUrl(), /[?&]scope=/);

    channel.setEventChannelScopeProvider(() => null);
    channel.connectEventChannel('en');
    assert.doesNotMatch(lastUrl(), /[?&]scope=/);
});

// A provider that throws must not take the channel down with it.
test('a failing provider degrades to an unfiltered connection', () => {
    channel.setEventChannelScopeProvider(() => { throw new Error('view not ready'); });
    channel.connectEventChannel('en');
    assert.doesNotMatch(lastUrl(), /[?&]scope=/);
});

// The scope is read on every connect, so a tab that navigates between sessions
// resubscribes rather than staying on the scope it booted with.
test('the scope is re-read on each connect rather than frozen at boot', () => {
    let scope = 'local:first';
    channel.setEventChannelScopeProvider(() => scope);
    channel.connectEventChannel('en');
    assert.match(lastUrl(), /scope=local%3Afirst/);

    scope = 'local:second';
    channel.connectEventChannel('en');
    assert.match(lastUrl(), /scope=local%3Asecond/);
});

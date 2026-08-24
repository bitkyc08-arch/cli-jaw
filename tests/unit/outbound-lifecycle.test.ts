// #417 — outbound send cancellation. The registry is the shutdown half; each
// channel's plumbing is proven in its own suite. These pin the contract:
// drain aborts every in-flight scope, done() releases, abort is observable
// as an AbortSignal (what the HTTP layers consume), and abortableDelay wakes
// early instead of sitting out a rate-limit window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OutboundSendRegistry, abortableDelay } from '../../src/messaging/outbound-lifecycle.ts';

test('OSR-001: drain aborts every in-flight scope and empties the registry', async () => {
    const registry = new OutboundSendRegistry();
    const a = registry.start();
    const b = registry.start();
    assert.equal(registry.size, 2);
    await registry.drain(10);
    assert.equal(a.signal.aborted, true);
    assert.equal(b.signal.aborted, true);
    assert.equal(registry.size, 0);
});

test('OSR-002: done() releases a scope so drain does not touch it', async () => {
    const registry = new OutboundSendRegistry();
    const settled = registry.start();
    settled.done();
    const inflight = registry.start();
    await registry.drain(10);
    assert.equal(settled.signal.aborted, false, 'a completed send is not retro-aborted');
    assert.equal(inflight.signal.aborted, true);
});

test('OSR-003: a parent abort propagates into the scope', () => {
    const registry = new OutboundSendRegistry();
    const parent = new AbortController();
    const scope = registry.start(parent.signal);
    assert.equal(scope.signal.aborted, false);
    parent.abort(new Error('ingress gone'));
    assert.equal(scope.signal.aborted, true);
    scope.done();
    assert.equal(registry.size, 0);
});

test('OSR-004: abortableDelay wakes early on abort instead of sitting out the window', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const wait = abortableDelay(60_000, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await wait;
    assert.ok(Date.now() - started < 5_000, 'the 60s sleep must end at the abort');
});

test('OSR-005: an already-aborted parent yields an aborted scope immediately', () => {
    const registry = new OutboundSendRegistry();
    const parent = new AbortController();
    parent.abort();
    const scope = registry.start(parent.signal);
    assert.equal(scope.signal.aborted, true);
    scope.done();
});

// Telegram plumbing (#417 2/3): the markdown sender must stop between chunks
// on abort and must not spend a fallback/retry leg on a cancelled send.
test('OSR-006: sendTelegramMarkdown aborts between chunks and skips fallback legs', async () => {
    const { sendTelegramMarkdown } = await import('../../src/telegram/rich-message.ts');
    const controller = new AbortController();
    const calls: string[] = [];
    const api = {
        sendRichMessage: async () => {
            calls.push('rich');
            // Abort DURING the first chunk's send, then fail it the way the
            // ipv4 fetch adapter does on req.destroy().
            controller.abort();
            throw new Error('socket destroyed');
        },
        sendMessage: async () => { calls.push('html'); },
    };
    // Long enough to need multiple chunks so the loop guard matters too.
    const text = 'x'.repeat(9000);
    await assert.rejects(
        () => sendTelegramMarkdown(api as never, 1, text, { signal: controller.signal }),
        /socket destroyed/,
        'a cancelled send surfaces the abort error',
    );
    assert.deepEqual(calls, ['rich'], 'no fallback or retry leg after the abort');
});

// Slack in-flight abort must be a 499 cancellation, not a 502 vendor failure
// (#417 review): the queued waiter uses ok:false to expire the notice either
// way, but the outbox/diagnostics must not record a Slack rejection for a
// send we cut short.
test('OSR-007: an aborted in-flight slackApi call reports slack_send_aborted 499', async () => {
    const { slackApi } = await import('../../src/slack/api.ts');
    const controller = new AbortController();
    const hungFetch: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        }, { once: true });
    });
    const pending = slackApi('xoxb-test', 'chat.postMessage',
        { channel: 'C1', text: 'hi' }, { fetchImpl: hungFetch, signal: controller.signal });
    controller.abort();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.status, 499, 'abort is a cancellation, not a 502');
    assert.equal(result.error, 'slack_send_aborted');
});

// Shutdown ordering (#417 review): a hung queued send must be aborted BEFORE
// the notice drain awaits its terminal, or the drain eats its whole budget on
// a socket nobody can cancel. Proven at the registry level: drain resolves in
// grace time even while a scope's owner is still pending.
test('OSR-008: drain returns within grace while a hung send is still pending', async () => {
    const registry = new OutboundSendRegistry();
    const scope = registry.start();
    let hungSettled = false;
    const hung = new Promise<void>((resolve) => {
        scope.signal.addEventListener('abort', () => { hungSettled = true; resolve(); }, { once: true });
    });
    const started = Date.now();
    await registry.drain(100);
    assert.ok(Date.now() - started < 5_000, 'drain must not wait for the send to finish');
    await hung;
    assert.equal(hungSettled, true, 'the hung send observed the abort');
    scope.done();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { drainLogRing, log } from '../../src/core/logger.ts';
import { stampOutboundSend } from '../../src/messaging/send.ts';
import { IngressJournal, admitIngress } from '../../src/messaging/durable-ingress.ts';
import {
    __resetMessagingTraceForTests,
    childSpan,
    getMessagingTrace,
    runWithMessagingTrace,
} from '../../src/messaging/trace-context.ts';
import type { InboundEnvelope } from '../../src/messaging/types.ts';

function lastEvent(name: string): Record<string, unknown> {
    const matches = drainLogRing()
        .map((entry) => {
            try { return JSON.parse(entry.text) as Record<string, unknown>; }
            catch { return null; }
        })
        .filter((row): row is Record<string, unknown> => !!row && row.event === name);
    assert.ok(matches.length > 0, `expected ring event ${name}`);
    return matches[matches.length - 1]!;
}

function envelope(eventId = '12345'): InboundEnvelope {
    return {
        channel: 'telegram',
        accountId: '777',
        eventId,
        conversationKey: 'telegram:-100999',
        actorId: '42',
        receivedAt: 1_700_000_000_000,
        ackPolicy: 'after-final-delivery',
        target: { channel: 'telegram', targetKind: 'channel', peerKind: 'group', targetId: '-100999' },
    };
}

test.beforeEach(() => {
    __resetMessagingTraceForTests();
});

test.afterEach(() => {
    __resetMessagingTraceForTests();
});

test('log.event is JSON on the same ring as log.info', () => {
    log.info('ring-sentinel-before-event');
    log.event('ingress.append', { channel: 'telegram', result: 'ok' });
    const ring = drainLogRing();
    assert.ok(ring.some((entry) => entry.text.includes('ring-sentinel-before-event')));
    const row = lastEvent('ingress.append');
    assert.equal(row.event, 'ingress.append');
    assert.equal(row.channel, 'telegram');
    assert.equal(row.result, 'ok');
    assert.equal(row.traceId, undefined);
});

test('log.event stamps the ALS trace and still works outside one', () => {
    runWithMessagingTrace({ traceId: 'boot-1:telegram:1', channel: 'telegram' }, () => {
        log.event('ingress.dedupe', { result: 'fresh' });
    });
    const inside = lastEvent('ingress.dedupe');
    assert.equal(inside.traceId, 'boot-1:telegram:1');
    assert.equal(typeof inside.spanId, 'string');
    assert.equal((inside.spanId as string).length, 16);
    assert.equal(inside.channel, 'telegram');

    log.event('ingress.idle', { result: 'outside' });
    const outside = lastEvent('ingress.idle');
    assert.equal(outside.traceId, undefined);
    assert.equal(outside.spanId, undefined);
    assert.equal(outside.result, 'outside');
});

test('nested run restores the previous context', () => {
    runWithMessagingTrace({ traceId: 'outer', spanId: 'aaaaaaaaaaaaaaaa' }, () => {
        assert.equal(getMessagingTrace()?.traceId, 'outer');
        assert.equal(getMessagingTrace()?.spanId, 'aaaaaaaaaaaaaaaa');
        runWithMessagingTrace({ traceId: 'inner' }, () => {
            assert.equal(getMessagingTrace()?.traceId, 'inner');
            assert.notEqual(getMessagingTrace()?.spanId, 'aaaaaaaaaaaaaaaa');
        });
        assert.equal(getMessagingTrace()?.traceId, 'outer');
        assert.equal(getMessagingTrace()?.spanId, 'aaaaaaaaaaaaaaaa');
        childSpan(() => {
            assert.equal(getMessagingTrace()?.traceId, 'outer');
            assert.notEqual(getMessagingTrace()?.spanId, 'aaaaaaaaaaaaaaaa');
        });
        assert.equal(getMessagingTrace()?.spanId, 'aaaaaaaaaaaaaaaa');
    });
    assert.equal(getMessagingTrace(), undefined);
});

test('log.event drops raw payload fields', () => {
    log.event('ingress.redact', {
        result: 'ok',
        payload_json: '{\"text\":\"secret\"}',
        token: '123:abc',
        text: 'hello',
    });
    const row = lastEvent('ingress.redact');
    assert.equal(row.result, 'ok');
    assert.equal(row.payload_json, undefined);
    assert.equal(row.token, undefined);
    assert.equal(row.text, undefined);
});

test('admit of a new event enters the journal trace_id', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    const journal = new IngressJournal(database, { now: () => 1, bootId: 'boot-1' });
    const admission = admitIngress(journal, envelope(), 'digest-1');
    assert.equal(admission.admit, true);
    const row = journal.find('telegram', '777', '12345');
    assert.equal(row?.traceId, 'boot-1:telegram:12345');
    assert.equal(getMessagingTrace()?.traceId, 'boot-1:telegram:12345');
    assert.equal(getMessagingTrace()?.channel, 'telegram');
    log.event('ingress.admit', { result: 'fresh' });
    assert.equal(lastEvent('ingress.admit').traceId, 'boot-1:telegram:12345');
});

test('re-admit of the same event reuses the stored trace_id', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    const journal = new IngressJournal(database, { now: () => 1, bootId: 'boot-1' });
    admitIngress(journal, envelope(), 'digest-1');
    __resetMessagingTraceForTests();
    assert.equal(getMessagingTrace(), undefined);
    const again = admitIngress(journal, envelope(), 'digest-1');
    assert.equal(again.admit, true);
    assert.equal(journal.find('telegram', '777', '12345')?.traceId, 'boot-1:telegram:12345');
    assert.equal(getMessagingTrace()?.traceId, 'boot-1:telegram:12345');
});

test('outbound.send stamps the admit traceId and stays silent without ALS', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    const journal = new IngressJournal(database, { now: () => 1, bootId: 'boot-1' });
    admitIngress(journal, envelope(), 'digest-1');
    stampOutboundSend('telegram', true);
    const outbound = lastEvent('outbound.send');
    assert.equal(outbound.traceId, 'boot-1:telegram:12345');
    assert.equal(outbound.channel, 'telegram');
    assert.equal(outbound.result, 'ok');

    __resetMessagingTraceForTests();
    stampOutboundSend('telegram', true);
    const outside = lastEvent('outbound.send');
    assert.equal(outside.traceId, undefined);
    assert.equal(outside.result, 'ok');
});

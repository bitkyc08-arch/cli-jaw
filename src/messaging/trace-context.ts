// Messaging trace context.
//
// One event has one identity: the journal row's `trace_id`. This module does not
// mint a second 128-bit id. `log.event` reads the current context through a
// logger-side hook so core/logger never imports messaging.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { setLogTraceReader } from '../core/logger.js';
import type { MessengerChannel } from './types.js';

export type MessagingTraceContext = {
    traceId: string;
    spanId: string;
    channel?: MessengerChannel;
};

const storage = new AsyncLocalStorage<MessagingTraceContext>();

setLogTraceReader(() => {
    const current = storage.getStore();
    if (!current) return undefined;
    const fields: { traceId: string; spanId: string; channel?: string } = {
        traceId: current.traceId,
        spanId: current.spanId,
    };
    if (current.channel) fields.channel = current.channel;
    return fields;
});

export function getMessagingTrace(): MessagingTraceContext | undefined {
    return storage.getStore();
}

export function mintSpanId(): string {
    return randomBytes(8).toString('hex');
}

export function runWithMessagingTrace<T>(
    context: Pick<MessagingTraceContext, 'traceId'> & Partial<Omit<MessagingTraceContext, 'traceId'>>,
    fn: () => T,
): T {
    const next: MessagingTraceContext = {
        traceId: context.traceId,
        spanId: context.spanId ?? mintSpanId(),
        ...(context.channel ? { channel: context.channel } : {}),
    };
    return storage.run(next, fn);
}

export function childSpan<T>(fn: () => T): T {
    const parent = storage.getStore();
    if (!parent) return fn();
    return storage.run({ ...parent, spanId: mintSpanId() }, fn);
}

/** Persist the journal row's identity for the rest of this turn. */
export function enterMessagingTrace(
    context: Pick<MessagingTraceContext, 'traceId'> & Partial<Omit<MessagingTraceContext, 'traceId'>>,
): MessagingTraceContext {
    const next: MessagingTraceContext = {
        traceId: context.traceId,
        spanId: context.spanId ?? mintSpanId(),
        ...(context.channel ? { channel: context.channel } : {}),
    };
    storage.enterWith(next);
    return next;
}

/** Test seam: an admit enterWith would otherwise leak into the next case. */
export function __resetMessagingTraceForTests(): void {
    storage.enterWith(undefined as unknown as MessagingTraceContext);
}

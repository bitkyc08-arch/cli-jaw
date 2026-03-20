// ─── Messaging Runtime ───────────────────────────────
// Active channel runtime lifecycle: init, shutdown, restart.
// Transport modules register themselves via registerTransport() to avoid circular deps.

import { settings } from '../core/config.js';
import type { MessengerChannel, RemoteTarget } from './types.js';

// ─── Transport Registry (push-based, no circular imports) ─────

type TransportFns = {
    init: () => Promise<void>;
    shutdown: () => Promise<void>;
};

const transports = new Map<MessengerChannel, TransportFns>();

export function registerTransport(channel: MessengerChannel, fns: TransportFns) {
    transports.set(channel, fns);
}

// ─── Last Active / Latest Seen Target State ─────────

const lastActiveTargets = new Map<MessengerChannel, RemoteTarget | null>();
const latestSeenTargets = new Map<MessengerChannel, RemoteTarget | null>();

export function getLastActiveTarget(channel: MessengerChannel): RemoteTarget | null {
    return lastActiveTargets.get(channel) ?? null;
}

export function setLastActiveTarget(channel: MessengerChannel, target: RemoteTarget) {
    lastActiveTargets.set(channel, target);
}

export function getLatestSeenTarget(channel: MessengerChannel): RemoteTarget | null {
    return latestSeenTargets.get(channel) ?? null;
}

export function setLatestSeenTarget(channel: MessengerChannel, target: RemoteTarget) {
    latestSeenTargets.set(channel, target);
}

// ─── Lifecycle ──────────────────────────────────────

export function getActiveChannel(): MessengerChannel {
    return (settings.channel as MessengerChannel) || 'telegram';
}

export async function initActiveMessagingRuntime() {
    const channel = getActiveChannel();
    const transport = transports.get(channel);
    if (transport) {
        await transport.init();
    } else {
        console.log(`[messaging] no transport registered for ${channel}`);
    }
}

export async function shutdownMessagingRuntime() {
    for (const [name, transport] of transports) {
        try {
            await transport.shutdown();
        } catch (e) {
            console.warn(`[messaging] ${name} shutdown error:`, (e as Error).message);
        }
    }
}

export async function restartMessagingRuntime(
    prev: Record<string, any>,
    next: Record<string, any>,
    patch: Record<string, any>,
) {
    const prevChannel = prev.channel || 'telegram';
    const nextChannel = next.channel || 'telegram';
    const changed = prevChannel !== nextChannel
        || !!patch.telegram
        || !!patch.discord
        || patch.locale !== undefined;
    if (!changed) return;
    await shutdownMessagingRuntime();
    await initActiveMessagingRuntime();
}

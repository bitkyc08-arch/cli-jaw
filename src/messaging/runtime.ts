// ─── Messaging Runtime ───────────────────────────────
// Active channel runtime lifecycle: init, shutdown, restart.
// Transport modules register themselves via registerTransport() to avoid circular deps.

import { settings, saveSettings } from '../core/config.js';
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
    schedulePersistTargets();
}

export function getLatestSeenTarget(channel: MessengerChannel): RemoteTarget | null {
    return latestSeenTargets.get(channel) ?? null;
}

export function setLatestSeenTarget(channel: MessengerChannel, target: RemoteTarget) {
    latestSeenTargets.set(channel, target);
    schedulePersistTargets();
}

export function clearTargetState(channel?: MessengerChannel) {
    if (channel) {
        lastActiveTargets.delete(channel);
        latestSeenTargets.delete(channel);
    } else {
        lastActiveTargets.clear();
        latestSeenTargets.clear();
    }
    persistTargetsNow();
}

// ─── Target Persistence (debounced) ─────────────────

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersistTargets() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        persistTargetsNow();
    }, 5000);
}

function persistTargetsNow() {
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    if (!settings.messaging) settings.messaging = { lastActive: {}, latestSeen: {} };
    settings.messaging.lastActive = Object.fromEntries(lastActiveTargets);
    settings.messaging.latestSeen = Object.fromEntries(latestSeenTargets);
    try { saveSettings(settings); } catch (e) { console.warn('[messaging:persist]', (e as Error).message); }
}

/** Check if a target has the minimum required shape */
function isValidTarget(t: unknown): t is RemoteTarget {
    return !!t && typeof t === 'object'
        && typeof (t as { channel?: unknown }).channel === 'string'
        && typeof (t as { targetId?: unknown }).targetId === 'string'
        && (t as { targetId: string }).targetId.length > 0;
}

/** Hydrate target state from persisted settings.messaging (skip malformed) */
export function hydrateTargetsFromSettings(s: Record<string, any>) {
    const messaging = s?.messaging;
    if (!messaging) return;
    for (const ch of ['telegram', 'discord'] as MessengerChannel[]) {
        const la = messaging.lastActive?.[ch];
        if (isValidTarget(la)) {
            lastActiveTargets.set(ch, la);
        }
        const ls = messaging.latestSeen?.[ch];
        if (isValidTarget(ls)) {
            latestSeenTargets.set(ch, ls);
        }
    }
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

    // Only restart if active channel changed, or the active channel's config changed
    const channelSwitched = prevChannel !== nextChannel;
    const activeChannelPatched = !!patch[nextChannel as string];
    const localeSwitched = patch.locale !== undefined;

    // Inactive channel config change should NOT trigger restart
    if (!channelSwitched && !activeChannelPatched && !localeSwitched) return;

    // Clear stale targets on restart to prevent routing to previous channel/thread
    clearTargetState();

    await shutdownMessagingRuntime();
    await initActiveMessagingRuntime();
}

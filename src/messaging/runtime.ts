// ─── Messaging Runtime ───────────────────────────────
// Active channel runtime lifecycle: init, shutdown, restart.
// Transport modules register themselves via registerTransport() to avoid circular deps.

import { settings, saveSettings } from '../core/config.js';
import { isRemoteTarget, type MessengerChannel, type RemoteTarget } from './types.js';
import { log } from '../core/logger.js';
import { logErrorText } from './redact.js';

// ─── Transport Registry (push-based, no circular imports) ─────

type TransportFns = {
    init: () => Promise<boolean>;
    shutdown: () => Promise<void>;
};

const transports = new Map<MessengerChannel, TransportFns>();
const CHANNELS = ['telegram', 'discord', 'slack'] as const;
const runningTransports = new Set<MessengerChannel>();
const transportErrors = new Map<MessengerChannel, string>();

function isMessengerChannel(value: unknown): value is MessengerChannel {
    return CHANNELS.includes(value as MessengerChannel);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function registerTransport(channel: MessengerChannel, fns: TransportFns) {
    transports.set(channel, fns);
}

/** Test-only: clear registry and running state between tests. */
export function __resetTransportRegistryForTests() {
    transports.clear();
    lastActiveTargets.clear();
    latestSeenTargets.clear();
    runningTransports.clear();
    transportErrors.clear();
}

/** Test-only: clear target maps between tests. */
export function __resetTargetStateForTests() {
    lastActiveTargets.clear();
    latestSeenTargets.clear();
    persistTimer = null;
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
    if (!settings["messaging"]) settings["messaging"] = { lastActive: {}, latestSeen: {} };
    settings["messaging"].lastActive = Object.fromEntries(lastActiveTargets);
    settings["messaging"].latestSeen = Object.fromEntries(latestSeenTargets);
    try { saveSettings(settings); } catch (e) { log.warn('[messaging:persist]', logErrorText(e)); }
}

/** Hydrate target state from persisted settings.messaging (skip malformed) */
export function hydrateTargetsFromSettings(s: Record<string, any>) {
    const messaging = s?.["messaging"];
    if (!messaging) return;
    for (const ch of ['telegram', 'discord', 'slack'] as MessengerChannel[]) {
        const la = messaging.lastActive?.[ch];
        if (isRemoteTarget(la) && la.channel === ch) {
            lastActiveTargets.set(ch, la);
        }
        const ls = messaging.latestSeen?.[ch];
        if (isRemoteTarget(ls) && ls.channel === ch) {
            latestSeenTargets.set(ch, ls);
        }
    }
}

// ─── Lifecycle ──────────────────────────────────────

/** The only part of a settings document these readers look at. Narrow on purpose:
 *  callers pass whatever settings shape they hold (server, CLI, doctor), and none of
 *  them should have to widen to an index signature to ask which channels are on. */
export type MessagingSnapshot = { messaging?: unknown };

export function getEnabledChannels(
    snapshot: MessagingSnapshot = settings,
): MessengerChannel[] {
    const messaging = snapshot.messaging;
    const raw = isPlainRecord(messaging) ? messaging["enabledChannels"] : undefined;
    return Array.isArray(raw) ? raw.filter(isMessengerChannel) : [];
}

export function getHomeChannel(
    snapshot: MessagingSnapshot = settings,
): MessengerChannel {
    const messaging = snapshot.messaging;
    const home = isPlainRecord(messaging) ? messaging["homeChannel"] : undefined;
    return isMessengerChannel(home) ? home : 'telegram';
}

export function isMessagingTransportRunning(channel: MessengerChannel): boolean {
    return runningTransports.has(channel);
}

export function getRunningMessagingTransports(): MessengerChannel[] {
    return [...runningTransports];
}

export async function startMessagingTransport(channel: MessengerChannel): Promise<boolean> {
    const transport = transports.get(channel);
    if (!transport) {
        transportErrors.set(channel, 'transport_not_registered');
        log.warn(`[messaging] no transport registered for ${channel}`);
        return false;
    }
    try {
        const started = await transport.init();
        if (!started) {
            runningTransports.delete(channel);
            transportErrors.delete(channel);
            return false;
        }
        runningTransports.add(channel);
        transportErrors.delete(channel);
        return true;
    } catch (error) {
        runningTransports.delete(channel);
        transportErrors.set(channel, logErrorText(error));
        log.warn(`[messaging] ${channel} init error:`, logErrorText(error));
        return false;
    }
}

export async function stopMessagingTransport(channel: MessengerChannel): Promise<boolean> {
    const transport = transports.get(channel);
    if (!transport) return true;
    try {
        await transport.shutdown();
        runningTransports.delete(channel);
        return true;
    } catch (error) {
        transportErrors.set(channel, logErrorText(error));
        log.warn(`[messaging] ${channel} shutdown error:`, logErrorText(error));
        return false;
    }
}

export async function initEnabledMessagingRuntimes(): Promise<Record<MessengerChannel, boolean>> {
    const result: Record<MessengerChannel, boolean> = { telegram: false, discord: false, slack: false };
    for (const channel of getEnabledChannels()) {
        result[channel] = await startMessagingTransport(channel);
    }
    return result;
}

/** @deprecated Use initEnabledMessagingRuntimes instead. */
export async function initActiveMessagingRuntime(): Promise<Record<MessengerChannel, boolean>> {
    return initEnabledMessagingRuntimes();
}

export async function shutdownMessagingRuntime() {
    for (const channel of CHANNELS) {
        await stopMessagingTransport(channel);
    }
}

export { getTransportCapability, buildChannelHealthSnapshot } from './channel-health.js';
export type { TransportCapability, ChannelHealthSnapshot } from './channel-health.js';

export async function restartMessagingRuntime(
    prev: Record<string, any>,
    next: Record<string, any>,
    patch: Record<string, any>,
) {
    const prevEnabled = new Set(getEnabledChannels(prev));
    const nextEnabled = new Set(getEnabledChannels(next));
    const affected = new Set<MessengerChannel>();

    for (const channel of CHANNELS) {
        if (prevEnabled.has(channel) !== nextEnabled.has(channel)) affected.add(channel);
        if (patch[channel] !== undefined && (prevEnabled.has(channel) || nextEnabled.has(channel))) {
            affected.add(channel);
        }
        if (patch["locale"] !== undefined && nextEnabled.has(channel)) affected.add(channel);
    }

    if (affected.size === 0) return;

    for (const channel of affected) {
        if (prevEnabled.has(channel)) await stopMessagingTransport(channel);
        clearTargetState(channel);
        if (nextEnabled.has(channel)) await startMessagingTransport(channel);
    }
}

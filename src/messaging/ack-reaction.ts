// ─── Inbound ACK Reaction Lifecycle ──────────────────
// A command that was received should be able to say so without adding a message
// to the channel. This module owns WHEN the state changes and WHICH emoji each
// state gets; it never knows how a channel actually applies one.
//
// Two transition shapes exist in the wild and both are correct for their vendor:
// Telegram REPLACES a bot's reaction atomically (setMessageReaction), while
// Discord and Slack need remove-then-add. The transport declares which it is.

export type AckState = 'received' | 'running' | 'success' | 'failure';

/** States `to()` accepts. Terminal outcomes belong to `settle()`, which also owns
 *  `removeAfterReply`; letting `to()` apply them would skip that cleanup. */
export type AckProgressState = Extract<AckState, 'received' | 'running'>;

/** How a transport moves between two reactions. Not a preference — a vendor fact. */
export type AckTransitionMode = 'replace' | 'remove-then-add';

export type AckEmojiSet = {
    readonly running: string;
    readonly success: string;
    readonly failure: string;
    /** Optional. A turn waiting behind another is not the same as one being
     *  worked on, and saying so costs nothing. Falls back to `running`. */
    readonly queued?: string;
};

export type AckScope = 'all' | 'direct' | 'group-mentions' | 'off';

export type AckReactionConfig = {
    readonly enabled: boolean;
    readonly scope: AckScope;
    readonly emoji: AckEmojiSet;
    /** Clear the terminal reaction after the reply lands. Default false: the
     *  reaction IS the receipt, and removing it throws the receipt away. */
    readonly removeAfterReply: boolean;
};

/** Everything that varies the choice of emoji. Passed per transition rather than
 *  captured at construction: whether a turn was queued is known at submit time. */
export type AckContext = {
    /** True when the gateway answered `queued` rather than `started`. */
    readonly wasQueued?: boolean;
};

/**
 * What a transport must supply.
 *
 * IMPORTANT: `apply`/`remove` MUST reject on vendor failure. Slack's slackApi()
 * resolves with {ok:false} instead of throwing, so a transport that merely awaits
 * it would record a reaction that never landed and then try to remove something
 * that is not there. Each transport inspects its own result and throws.
 */
export type AckTransport = {
    readonly mode: AckTransitionMode;
    apply(emoji: string): Promise<void>;
    remove(emoji: string): Promise<void>;
    /** Reject an emoji this channel cannot render, returning a usable substitute
     *  or null to skip. Telegram's fixed allowlist is why this exists. */
    coerce(emoji: string): string | null;
};

export type AckHandle = {
    to(state: AckProgressState, context?: AckContext): Promise<void>;
    settle(outcome: 'success' | 'failure', context?: AckContext): Promise<void>;
    readonly applied: string | null;
};

/**
 * Pick the emoji for a moment, not just a state.
 *
 * Channel-agnostic on purpose: the transport's coerce() decides whether the
 * result is renderable. Teaching this function about Telegram's allowlist would
 * leak one channel's constraint into all three.
 */
export function resolveAckEmoji(
    config: AckReactionConfig,
    state: AckState,
    context: AckContext = {},
): string | null {
    if (state === 'success') return config.emoji.success;
    if (state === 'failure') return config.emoji.failure;
    // 'received' and 'running' share a signal: for the user, being picked up and
    // being worked on are the same moment.
    if (context.wasQueued && config.emoji.queued) return config.emoji.queued;
    return config.emoji.running;
}

export function shouldAck(
    config: AckReactionConfig,
    context: { isDirect: boolean; isMention: boolean },
): boolean {
    if (!config.enabled) return false;
    switch (config.scope) {
        case 'off': return false;
        case 'all': return true;
        case 'direct': return context.isDirect;
        case 'group-mentions': return context.isDirect || context.isMention;
    }
}

const ACK_SCOPES: ReadonlySet<string> = new Set<AckScope>(['all', 'direct', 'group-mentions', 'off']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize whatever is in settings into a usable config.
 *
 * Settings arrive from a PUT body and a watched file, so every field is
 * attacker-shaped until proven otherwise. A malformed value falls back to the
 * default rather than throwing inside a message handler.
 */
export function resolveAckConfig(
    raw: unknown,
    fallback: AckReactionConfig,
): AckReactionConfig {
    if (!isPlainRecord(raw)) return fallback;
    const emoji = isPlainRecord(raw['emoji']) ? raw['emoji'] : {};
    const pick = (key: keyof AckEmojiSet, dflt: string): string => {
        const value = emoji[key];
        return typeof value === 'string' && value.trim() ? value : dflt;
    };
    const rawScope = raw['scope'];
    const scope = typeof rawScope === 'string' && ACK_SCOPES.has(rawScope)
        ? rawScope as AckScope
        : fallback.scope;
    const rawQueued = emoji['queued'];
    const queued = typeof rawQueued === 'string' && rawQueued.trim()
        ? rawQueued
        : fallback.emoji.queued;
    return {
        enabled: raw['enabled'] === true,
        scope,
        emoji: {
            running: pick('running', fallback.emoji.running),
            success: pick('success', fallback.emoji.success),
            failure: pick('failure', fallback.emoji.failure),
            // exactOptionalPropertyTypes: the key must be absent, not undefined.
            ...(queued ? { queued } : {}),
        },
        removeAfterReply: raw['removeAfterReply'] === true,
    };
}

export function createAckHandle(
    config: AckReactionConfig,
    transport: AckTransport,
    onError?: (error: unknown) => void,
): AckHandle {
    let applied: string | null = null;
    let settled = false;
    // Every transition goes through one chain. A lane runner can start a task
    // synchronously (orchestrator/session-lanes.ts), so settle(success) may be
    // issued while the running apply is still awaiting its vendor call — and the
    // late one would otherwise overwrite the terminal state.
    let chain: Promise<void> = Promise.resolve();

    const swallow = (error: unknown) => { onError?.(error); };

    const applyTransition = async (state: AckState, context: AckContext): Promise<void> => {
        const terminal = state === 'success' || state === 'failure';
        // Checked HERE rather than at enqueue time: the queue position and the
        // execution moment are different, and only this one is authoritative.
        if (settled) return;
        // Claimed BEFORE the vendor call so a second terminal transition already
        // sitting in the chain cannot also fire. First outcome wins.
        if (terminal) settled = true;
        const wanted = resolveAckEmoji(config, state, context);
        if (!wanted) return;
        const usable = transport.coerce(wanted);
        if (!usable || usable === applied) return;
        try {
            // 'replace' channels overwrite in one call; removing first would show
            // an empty intermediate state and cost an extra request.
            if (transport.mode === 'remove-then-add' && applied) {
                await transport.remove(applied).catch(swallow);
            }
            await transport.apply(usable);
            // Only after apply() RESOLVES. A transport that resolves on vendor
            // failure would corrupt this; see the AckTransport contract note.
            applied = usable;
        } catch (error) {
            swallow(error);
        }
    };

    const enqueue = (state: AckState, context: AckContext): Promise<void> => {
        chain = chain.then(() => applyTransition(state, context)).catch(swallow);
        return chain;
    };

    return {
        get applied() { return applied; },
        to(state, context = {}) {
            return enqueue(state, context);
        },
        async settle(outcome, context = {}) {
            await enqueue(outcome, context);
            if (!config.removeAfterReply || !applied) return;
            const last = applied;
            applied = null;
            chain = chain.then(() => transport.remove(last)).catch(swallow);
            await chain;
        },
    };
}

// ─── Per-channel defaults ────────────────────────────
// Exported from the core so config.ts and each transport read the SAME values;
// duplicating them is how a default drifts. Emoji notation differs by vendor:
// Slack takes names without colons, the other two take unicode.

export const SLACK_ACK_DEFAULTS: AckReactionConfig = {
    enabled: false,
    scope: 'group-mentions',
    emoji: { running: 'eyes', success: 'white_check_mark', failure: 'x', queued: 'hourglass_flowing_sand' },
    removeAfterReply: false,
};

export const TELEGRAM_ACK_DEFAULTS: AckReactionConfig = {
    enabled: false,
    scope: 'group-mentions',
    // Neither white-check-mark nor cross-mark is in Telegram's ReactionTypeEmoji
    // allowlist, so the sanctioned pair is thumbs. Hourglass is absent too.
    emoji: { running: '👀', success: '👍', failure: '👎', queued: '🕊' },
    removeAfterReply: false,
};

export const DISCORD_ACK_DEFAULTS: AckReactionConfig = {
    enabled: false,
    scope: 'group-mentions',
    emoji: { running: '👀', success: '✅', failure: '❌', queued: '⏳' },
    removeAfterReply: false,
};

/**
 * A fresh copy per call.
 *
 * createDefaultSettings() runs more than once and the runtime settings object is
 * a mutable Record, so sharing the nested emoji object would let one instance's
 * edit reach the exported constant and every other instance.
 */
export function cloneAckDefaults(defaults: AckReactionConfig): AckReactionConfig {
    return { ...defaults, emoji: { ...defaults.emoji } };
}

/**
 * Merge a partial ack patch onto a base without dropping siblings.
 *
 * The channel merges elsewhere are one level deep, which is right for flat
 * credential fields and wrong for a nested group: a PUT carrying only
 * {ack:{enabled:true}} would otherwise drop scope, emoji and removeAfterReply.
 * Shared by the boot merge and the API/watch patch path so the three ingresses
 * cannot diverge.
 */
export function mergeAckSettings(base: unknown, patch: unknown): Record<string, unknown> {
    const baseRecord = isPlainRecord(base) ? base : {};
    if (!isPlainRecord(patch)) return { ...baseRecord };
    const merged: Record<string, unknown> = { ...baseRecord, ...patch };
    const baseEmoji = isPlainRecord(baseRecord['emoji']) ? baseRecord['emoji'] : {};
    const patchEmoji = patch['emoji'];
    if (isPlainRecord(patchEmoji)) {
        merged['emoji'] = { ...baseEmoji, ...patchEmoji };
    }
    return merged;
}


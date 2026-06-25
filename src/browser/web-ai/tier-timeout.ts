import type { WebAiVendor } from './types.js';
import { normalizeChatGptModelChoice } from './chatgpt-model.js';
import { normalizeGeminiModelChoice, isGeminiDeepThinkChoice } from './gemini-model.js';
import { normalizeGrokModelChoice } from './grok-model.js';

/**
 * Model-tier → default poll timeout (parity catalog 105.4). cli-jaw used a flat 1200s
 * (20 min) default everywhere, so long-reasoning runs (deep-research / pro) timed out at
 * 20 min instead of an hour. An explicit --timeout always overrides these defaults.
 * Strict-TS port of agbrowse session.mjs tier-timeout helpers.
 */

export const TIER_DEFAULT_TIMEOUT_SEC: Readonly<Record<string, number>> = Object.freeze({
    instant: 120,
    thinking: 600,
    pro: 3600,
    'deep-research': 3600,
});

/** Long-reasoning ceiling (seconds), exported for cross-module reuse (e.g. lease TTLs). */
export const PRO_TIMEOUT_SEC = TIER_DEFAULT_TIMEOUT_SEC['pro'];

const FALLBACK_TIMEOUT_SEC = 1200;

/** Resolve a tier name to a default timeout (seconds), falling back to 1200s when unknown. */
export function tierDefaultTimeoutSec(tier: string | null): number {
    if (tier && TIER_DEFAULT_TIMEOUT_SEC[tier] != null) return TIER_DEFAULT_TIMEOUT_SEC[tier];
    return FALLBACK_TIMEOUT_SEC;
}

/**
 * Map (vendor, model, research) to a normalized timeout tier, or null when unknown.
 * Reuses the per-vendor model normalizers; chatgpt deep-research is signalled by the
 * separate `research: 'deep'` flag, gemini by the deep-think alias.
 */
export function deriveTimeoutTier(vendor: WebAiVendor, model: string | undefined, research?: string): string | null {
    if (vendor === 'gemini') {
        if (isGeminiDeepThinkChoice(model)) return 'deep-research';
        const m = normalizeGeminiModelChoice(model);
        if (m === 'flash-lite') return 'instant';
        if (m === 'flash' || m === 'pro') return 'thinking';
        return null;
    }
    if (vendor === 'grok') {
        const m = normalizeGrokModelChoice(model);
        if (m === 'heavy') return 'pro';
        if (m === 'fast') return 'instant';
        return m ? 'thinking' : null;
    }
    // chatgpt (default vendor)
    if (String(research || '').trim().toLowerCase() === 'deep') return 'deep-research';
    return normalizeChatGptModelChoice(model);
}

/** Tier-aware default poll timeout (seconds), applied when no explicit --timeout is given. */
export function resolveTimeoutDefaultSec(
    input: { model?: string; research?: string } = {},
    vendor: WebAiVendor = 'chatgpt',
): number {
    return tierDefaultTimeoutSec(deriveTimeoutTier(vendor, input.model, input.research));
}

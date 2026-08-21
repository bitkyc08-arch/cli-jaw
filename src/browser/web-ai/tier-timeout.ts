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
    // parity2 030 slice 3.3 (C-19): vendor-specific long-reasoning tiers stay
    // independent so one budget change cannot silently change another
    // provider's behavior. Pro runs get 1.5h (agbrowse chatgpt-pro), Grok
    // Heavy 1h. Legacy 'pro' key kept as an alias for existing callers.
    'chatgpt-pro': 5400,
    pro: 5400,
    'grok-heavy': 3600,
    'deep-research': 3600,
});

/** ChatGPT Pro ceiling (seconds), exported for cross-module reuse (e.g. lease TTLs). */
export const CHATGPT_PRO_TIMEOUT_SEC = TIER_DEFAULT_TIMEOUT_SEC['chatgpt-pro'];
/** Backward-compatible alias; new consumers use CHATGPT_PRO_TIMEOUT_SEC. */
export const PRO_TIMEOUT_SEC = CHATGPT_PRO_TIMEOUT_SEC;

/** parity2 030 slice 3.3 (C-19): per-vendor defaults — Grok answers fast, so its unknown-tier budget is tighter. */
const VENDOR_DEFAULT_TIMEOUT_SEC: Readonly<Record<string, number>> = Object.freeze({ chatgpt: 1200, gemini: 1200, grok: 600 });

/** Resolve a tier name to a default timeout (seconds), falling back to the vendor default, then 1200s. */
export function tierDefaultTimeoutSec(tier: string | null, vendor: string = 'chatgpt'): number {
    if (tier && TIER_DEFAULT_TIMEOUT_SEC[tier] != null) return TIER_DEFAULT_TIMEOUT_SEC[tier];
    return VENDOR_DEFAULT_TIMEOUT_SEC[vendor] || 1200;
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
        if (m === 'heavy') return 'grok-heavy';
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
    return tierDefaultTimeoutSec(deriveTimeoutTier(vendor, input.model, input.research), vendor);
}

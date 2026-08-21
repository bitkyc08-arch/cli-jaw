// Shared composer-readiness interstitial classification (parity2 090, B5/C-12).
//
// ChatGPT already does this inline; this gives Grok and Gemini the same
// behavior: when the composer never appears, ask a bounded probe whether an
// interstitial is the reason, and only then replace the composer error with a
// typed provider.interstitial carrying the detector's own retry hint.

import { detectInterstitial } from './interstitial.js';
import { WebAiError } from './errors.js';
import type { Page } from 'playwright-core';

/**
 * Re-classify a composer-readiness failure as a provider interstitial when a
 * bounded probe finds one. Returns the interstitial error to throw, or null
 * when the original failure should stand — a probe failure must never replace
 * the real composer error.
 */
export async function classifyComposerInterstitial(
    page: Page,
    vendor: 'chatgpt' | 'grok' | 'gemini',
    cause: unknown,
    { detect }: { detect?: typeof detectInterstitial } = {},
): Promise<WebAiError | null> {
    const probe = typeof detect === 'function' ? detect : detectInterstitial;
    const verdict = await Promise.resolve()
        .then(() => probe(page))
        .catch(() => null);
    if (!verdict || verdict.kind === 'none') return null;
    return new WebAiError({
        errorCode: 'provider.interstitial',
        stage: 'provider-interstitial',
        vendor,
        retryHint: verdict.retryHint,
        message: `${vendor} interstitial blocked composer readiness: ${verdict.kind}`,
        evidence: verdict as unknown as Record<string, unknown>,
        cause,
    });
}

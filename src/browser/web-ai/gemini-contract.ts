/**
 * PRD32.8A — Gemini Deep Think Contract (Disabled Runtime)
 *
 * Selectors and account/mode constraints captured from official Gemini docs
 * and the local Oracle gemini provider. No mutation is performed; this module
 * is the read-only blueprint for the future 32.8B runtime slice.
 */

import { createDisabledProviderAdapter, type WebAiProviderAdapter } from './provider-adapter.js';

export const GEMINI_DEEP_THINK_SELECTORS = {
    input: [
        'rich-textarea .ql-editor',
        '[role="textbox"][aria-label*="prompt" i]',
        'div[contenteditable="true"]',
    ],
    toolsButton: [
        'button.toolbox-drawer-button',
        'button[aria-label*="Tools" i]',
    ],
    deepThinkMenuItem: [
        '[role="menuitem"]:has-text("Deep Think")',
        '[role="menuitemcheckbox"]:has-text("Deep Think")',
    ],
    sendButton: [
        'button.send-button',
        'button[aria-label*="Send message" i]',
    ],
    responseTurn: ['model-response'],
    responseText: ['message-content'],
    completionSignal: ['.response-footer.complete'],
    spinner: ['[role="progressbar"]'],
    thoughts: ['model-thoughts'],
} as const;

export type GeminiAccountStatus =
    | 'signed-out'
    | 'gemini-unavailable'
    | 'deep-think-unavailable'
    | 'no-ultra'
    | 'no-ultra-for-business'
    | 'age-or-account-gate'
    | 'usage-limit-reached'
    | 'contract-only-disabled';

export interface GeminiStatusReport {
    vendor: 'gemini';
    status: GeminiAccountStatus;
    /** Always false in 32.8A — set true only when 32.8B lands. */
    runtimeEnabled: false;
    notes: string[];
    sources: string[];
}

export const GEMINI_DEEP_THINK_OFFICIAL_SOURCES: readonly string[] = Object.freeze([
    'https://support.google.com/gemini/answer/16345172',
    'https://support.google.com/gemini/answer/14903178',
    'https://support.google.com/gemini/answer/16275805',
    'https://support.google.com/gemini/answer/15719111',
]);

export interface GeminiDeepThinkConstraints {
    requiresUltra: true;
    requiresUltraForBusinessForOrgs: true;
    requiresSignedInGeminiApps: true;
    minimumAge: 18;
    /** Minimum order-of-magnitude wait. Real waits can be many minutes. */
    minimumWaitMs: number;
    canLeaveChatWhileWaiting: true;
    notifiesNextToCompletedThread: true;
    isExperimental: true;
}

export const GEMINI_DEEP_THINK_CONSTRAINTS: GeminiDeepThinkConstraints = {
    requiresUltra: true,
    requiresUltraForBusinessForOrgs: true,
    requiresSignedInGeminiApps: true,
    minimumAge: 18,
    // Deep Think can take a few minutes — start the wait floor at 90s so callers
    // never confuse it with a normal ChatGPT poll.
    minimumWaitMs: 90_000,
    canLeaveChatWhileWaiting: true,
    notifiesNextToCompletedThread: true,
    isExperimental: true,
};

export function reportGeminiContractOnlyStatus(): GeminiStatusReport {
    return {
        vendor: 'gemini',
        status: 'contract-only-disabled',
        runtimeEnabled: false,
        notes: [
            'Gemini Deep Think runtime is contract-only in PRD32.8A.',
            'Mutation commands reject before browser action until 32.8B.',
            'ChatGPT selectors are never reused for Gemini.',
        ],
        sources: [...GEMINI_DEEP_THINK_OFFICIAL_SOURCES],
    };
}

export function createGeminiDeepThinkContractAdapter(): WebAiProviderAdapter {
    return createDisabledProviderAdapter('gemini');
}

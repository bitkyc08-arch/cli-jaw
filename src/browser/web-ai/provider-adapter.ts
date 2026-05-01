/**
 * PRD32.8A — Provider Lifecycle Contract
 *
 * Provider adapters abstract the per-vendor lifecycle so ChatGPT, Gemini Deep
 * Think, and future vendors do not share textarea/selector code.
 *
 * 32.8A is the contract-only phase. Gemini live runtime is gated behind
 * `mutationAllowed=false` until 32.8B lands.
 */

import type { WebAiDiagnostics, WebAiFailureStage } from './diagnostics.js';

export type WebAiVendorId = 'chatgpt' | 'gemini' | 'grok';

export interface WaitForResponseOptions {
    timeoutMs: number;
    minTurnIndex?: number;
    /** Opt-in flag for copy-markdown fallback. Recorded in usedFallbacks. */
    allowCopyMarkdownFallback?: boolean;
}

export interface ResponseCaptureResult {
    ok: boolean;
    answerText?: string;
    canvas?: { kind: 'opened'; reason?: string };
    usedFallbacks: string[];
    warnings: string[];
}

export interface WebAiProviderAdapter {
    vendor: WebAiVendorId;
    /** True when this adapter is allowed to mutate the page today. */
    mutationAllowed: boolean;
    waitForUi(): Promise<void>;
    selectMode?(name?: string): Promise<void>;
    typePrompt(text: string): Promise<void>;
    submitPrompt(): Promise<void>;
    waitForResponse(options: WaitForResponseOptions): Promise<ResponseCaptureResult>;
    extractArtifacts?(): Promise<unknown>;
    stop?(): Promise<void>;
    diagnose?(stage: WebAiFailureStage): Promise<WebAiDiagnostics>;
}

export class ProviderRuntimeDisabledError extends Error {
    readonly vendor: WebAiVendorId;
    readonly stage: WebAiFailureStage;
    constructor(vendor: WebAiVendorId, stage: WebAiFailureStage = 'provider-select-mode') {
        super(`provider runtime disabled: ${vendor} (PRD32.8A contract-only). stage=${stage}`);
        this.name = 'ProviderRuntimeDisabledError';
        this.vendor = vendor;
        this.stage = stage;
    }
}

/**
 * Build a contract-only adapter that rejects every mutation. Used for vendors
 * whose live runtime is not yet enabled.
 */
export function createDisabledProviderAdapter(vendor: WebAiVendorId): WebAiProviderAdapter {
    return {
        vendor,
        mutationAllowed: false,
        async waitForUi() { throw new ProviderRuntimeDisabledError(vendor, 'status'); },
        async typePrompt() { throw new ProviderRuntimeDisabledError(vendor, 'composer-insert'); },
        async submitPrompt() { throw new ProviderRuntimeDisabledError(vendor, 'send-click'); },
        async waitForResponse() { throw new ProviderRuntimeDisabledError(vendor, 'poll-timeout'); },
    };
}

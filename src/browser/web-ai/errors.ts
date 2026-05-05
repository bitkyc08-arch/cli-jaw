import { stripUndefined } from '../../core/strip-undefined.js';

// Typed error taxonomy for cli-jaw web-ai. Mirrors agbrowse web-ai/errors.mjs
// (https://github.com/lidge-jun/agbrowse/blob/main/web-ai/errors.mjs) with the
// extensions GPT Pro flagged in the 2026-05-01 plan close-out:
//
//   WrongTargetError              -> cdp.target-mismatch
//   BrowserCapabilityError        -> capability.unsupported
//   ProviderRuntimeDisabledError  -> provider.runtime-disabled
//
// Catalog (devlog/03_phase2_errors.md in agbrowse is the source of truth):
//
//   cdp.unreachable / cdp.target-mismatch
//   provider.composer-not-visible / provider.model-mismatch
//   provider.attachment-preflight / provider.attachment-evidence-missing
//   provider.commit-not-verified / provider.poll-timeout
//   provider.runtime-disabled
//   capability.unsupported
//   context.over-budget / context.symlink-rejected
//   grok.context-pack-not-allowed
//   internal.unhandled

export interface WebAiErrorInit {
    errorCode?: string;
    stage?: string;
    message?: string;
    retryHint?: string;
    vendor?: string;
    mutationAllowed?: boolean;
    selectorsTried?: string[];
    evidence?: unknown;
    cause?: unknown;
}

export interface WebAiErrorJson {
    name: string;
    errorCode: string;
    stage: string;
    message: string;
    retryHint: string;
    vendor?: string;
    mutationAllowed: boolean;
    selectorsTried: string[];
    evidence: unknown;
}

export class WebAiError extends Error {
    errorCode: string;
    stage: string;
    retryHint: string;
    vendor?: string;
    mutationAllowed: boolean;
    selectorsTried: string[];
    evidence: unknown;

    constructor(init: WebAiErrorInit = {}) {
        super(init.message || init.errorCode || 'web-ai error');
        this.name = 'WebAiError';
        this.errorCode = init.errorCode || 'internal.unhandled';
        this.stage = init.stage || 'internal';
        this.retryHint = init.retryHint || 'report';
        if (init.vendor !== undefined) this.vendor = init.vendor;
        this.mutationAllowed = init.mutationAllowed === true;
        this.selectorsTried = Array.isArray(init.selectorsTried) ? init.selectorsTried : [];
        this.evidence = init.evidence ?? null;
        if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
    }

    toJSON(): WebAiErrorJson {
        return toErrorJson(this);
    }
}

export function wrapError(err: unknown, fallback: WebAiErrorInit = {}): WebAiError {
    if (err instanceof WebAiError) return err;
    return new WebAiError({
        errorCode: 'internal.unhandled',
        stage: 'internal',
        retryHint: 'report',
        message: (err as { message?: string })?.message || String(err),
        ...fallback,
        cause: err,
    });
}

export function providerError(vendor: string, init: WebAiErrorInit = {}): WebAiError {
    return new WebAiError({ ...init, vendor });
}

export function contextError(init: WebAiErrorInit = {}): WebAiError {
    return new WebAiError(init);
}

export function toErrorJson(err: WebAiError | { name?: string; errorCode?: string; stage?: string; message?: string; retryHint?: string; vendor?: string; mutationAllowed?: boolean; selectorsTried?: string[]; evidence?: unknown }): WebAiErrorJson {
    const out: WebAiErrorJson = {
        name: err?.name || 'WebAiError',
        errorCode: err?.errorCode || 'internal.unhandled',
        stage: err?.stage || 'internal',
        message: err?.message || '',
        retryHint: err?.retryHint || 'report',
        mutationAllowed: err?.mutationAllowed === true,
        selectorsTried: Array.isArray(err?.selectorsTried) ? err.selectorsTried : [],
        evidence: err?.evidence ?? null,
    };
    if (err?.vendor) out.vendor = err.vendor;
    return out;
}

// Map cli-jaw's existing structured errors into WebAiError codes. Used by
// stageError replacements and toWebAiHttpError to preserve evidence
// (expectedTargetId/actualTargetId, capabilityId, ownerPrd, etc.).
export function fromCliJawStructuredError(err: unknown, fallbackStage = 'internal'): WebAiError | null {
    if (!err || typeof err !== 'object') return null;
    const name = (err as { name?: string }).name;
    if (name === 'WrongTargetError') {
        const e = err as { expectedTargetId?: string; actualTargetId?: string; message?: string };
        return new WebAiError({
            errorCode: 'cdp.target-mismatch',
            stage: 'session-target-verify',
            retryHint: 'tab-switch',
            message: e.message || 'wrong target',
            evidence: { expectedTargetId: e.expectedTargetId, actualTargetId: e.actualTargetId },
            cause: err,
        });
    }
    if (name === 'BrowserCapabilityError') {
        const e = err as { capabilityId?: string; stage?: string; mutationAllowed?: boolean; ownerPrd?: string; message?: string };
        return new WebAiError({
            errorCode: 'capability.unsupported',
            stage: e.stage || 'capability-preflight',
            retryHint: 'feature-fallback',
            message: e.message || 'capability unsupported',
            mutationAllowed: e.mutationAllowed === true,
            evidence: { capabilityId: e.capabilityId, ownerPrd: e.ownerPrd },
            cause: err,
        });
    }
    if (name === 'ProviderRuntimeDisabledError') {
        const e = err as { vendor?: string; stage?: string; message?: string };
        return new WebAiError(stripUndefined({
            errorCode: 'provider.runtime-disabled',
            stage: e.stage || 'provider-runtime-gate',
            vendor: e.vendor,
            retryHint: 'enable-or-skip',
            message: e.message || 'provider runtime disabled',
            cause: err,
        }));
    }
    return null;
}

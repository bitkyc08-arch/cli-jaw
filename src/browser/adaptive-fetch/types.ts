// Shared type definitions for adaptive-fetch module.

export type AdaptiveFetchVerdict = 'strong_ok' | 'weak_ok' | 'blocked' | 'auth_required' | 'challenge' | 'paywall' | 'browser_required' | 'unsupported' | 'error';
export type AdaptiveFetchSource = 'public_endpoint' | 'fetch' | 'reader' | 'metadata' | 'third_party_reader' | 'browser' | 'browser_user' | 'human_resolved' | 'network_api' | 'validation';
export type BrowserMode = 'auto' | 'never' | 'required';
export type BrowserSessionMode = 'none' | 'isolated' | 'existing' | 'user' | 'interactive';
export type IdentityMode = 'auto' | 'minimal' | 'chrome';

export interface AdaptiveFetchOptions {
    url: string;
    json: boolean;
    trace: boolean;
    browserMode: BrowserMode;
    browserSession: string;
    browserSessionRaw: string;
    identity: IdentityMode;
    userSessionExplicit: boolean;
    humanLoop: boolean;
    maxBytes: number;
    timeoutMs: number;
    selector: string | null;
    publicEndpoints: boolean;
    allowPrivateNetwork: boolean;
    allowThirdPartyReader: boolean;
    allowArchive: boolean;
    interactive: boolean;
    query?: string;
    optionWarnings: string[];
}

export interface FetchTextCandidateOptions {
    maxBytes?: number;
    timeoutMs?: number;
    redirectLimit?: number;
    allowPrivateNetwork?: boolean;
    fetchImpl?: typeof fetch;
    beforeFetch?: (url: string) => Promise<void> | void;
    identity?: string;
}

export interface BrowserCandidateOptions {
    browserDeps?: Record<string, unknown>;
    browserSession?: 'none' | 'isolated' | 'existing';
    timeoutMs?: number;
    selector?: string | null;
    allowPrivateNetwork?: boolean;
    challengeInfo?: ChallengeInfo | null;
}

export interface FetchAttempt {
    source: string;
    verdict: string;
    at?: string;
    url?: string;
    status?: number;
    contentType?: string;
    byteLength?: number;
    error?: string;
    reason?: string;
    label?: string;
    [key: string]: unknown;
}

export interface AttemptTrace {
    url: string | null;
    browserMode: string;
    browserSession: string;
    createdAt: string;
    attempts: FetchAttempt[];
}

export interface ReaderCandidate {
    source: string;
    label: string;
    finalUrl: string;
    title: string;
    text: string;
    contentType: string;
    status: number;
    ok: boolean;
    metadata: Record<string, unknown> | null;
    evidence: string[];
    warnings: string[];
    safetyFlags: string[];
    rawTextLength: number;
    score?: number;
    challenge?: ChallengeInfo | null;
    [key: string]: unknown;
}

export interface ChallengeInfo {
    type: string;
    wafId?: string;
    signals?: string[];
    [key: string]: unknown;
}

export interface WafProfile {
    id: string;
    detect: {
        cookies?: RegExp[];
        headers?: Record<string, RegExp>;
        body?: RegExp[];
        status?: number[];
    };
    behavior: {
        jsChallengeSolvable?: boolean;
        interactiveCaptcha?: boolean;
        cookieWarmingHelps?: boolean;
        userSessionHelps?: boolean;
    };
}

export interface AdaptiveFetchResult {
    url: string;
    verdict: string;
    source: string;
    text: string;
    title: string;
    contentType: string;
    status: number;
    byteLength: number;
    metadata: Record<string, unknown> | null;
    trace?: AttemptTrace;
    candidates?: ReaderCandidate[];
    error?: string;
    challenge?: ChallengeInfo | null;
    optionWarnings?: string[];
}

export interface CandidateUrl {
    label: string;
    url: string;
    source: string;
    [key: string]: unknown;
}

export interface PageRef {
    page: Record<string, unknown>;
    close: () => Promise<void> | void;
}

export interface MetadataResult {
    title?: string;
    description?: string;
    author?: string;
    publishedDate?: string;
    siteName?: string;
    ogImage?: string;
    canonical?: string;
    [key: string]: unknown;
}

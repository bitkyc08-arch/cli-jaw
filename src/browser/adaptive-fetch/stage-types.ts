import type {
    AdaptiveFetchOptions,
    AdaptiveFetchVerdict,
    AttemptTrace,
    BrowserMode,
    ChallengeInfo,
    FetchAttempt,
    ReaderCandidate,
} from './types.js';

export type StageId =
    | 'endpoint'
    | 'direct'
    | 'tls'
    | 'discovered'
    | 'jina'
    | 'camoufox'
    | 'cdp'
    | 'user-session'
    | 'human-loop';

export type StageOutcome =
    | { kind: 'candidates'; stageId: StageId; candidates: ReaderCandidate[]; challenge?: ChallengeInfo }
    | { kind: 'blocked'; stageId: StageId; challenge: ChallengeInfo }
    | { kind: 'skipped'; stageId: StageId; reason: string }
    | { kind: 'error'; stageId: StageId; error: string };

export interface StageContext {
    url: URL;
    options: AdaptiveFetchOptions;
    deps: Record<string, unknown>;
    trace: AttemptTrace;
    candidates: ReaderCandidate[];
    challenge: ChallengeInfo | null;
    fetchedUrls: Set<string>;
    fetchOpt: Record<string, unknown>;
    chromeUsed: boolean;
    deadline: number;
}

export interface AdaptiveFetchFinalResult {
    ok: boolean;
    verdict: AdaptiveFetchVerdict;
    source: string;
    finalUrl: string;
    title: string | null;
    content: string;
    summary: string;
    evidence: string[];
    warnings: string[];
    safetyFlags: string[];
    metadata: Record<string, unknown> | null;
    browserMode: BrowserMode;
    browserSession: string;
    identity: string;
    chromeUsed: boolean;
    chromeRequired: boolean;
    attempts: FetchAttempt[];
    _traceSummary: string;
}

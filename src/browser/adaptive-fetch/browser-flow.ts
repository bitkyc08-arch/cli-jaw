import type { AdaptiveFetchOptions, AttemptTrace, ChallengeInfo } from './types.js';
import {
    collectBrowserCandidate,
    collectBrowserMetadataCandidate,
    collectBrowserStructuredResultCandidates,
    collectDefuddleCandidate,
    collectNetworkJsonCandidates,
} from './browser-escalation.js';
import { BrowserRequiredError } from './browser-runtime.js';
import { scoreReaderCandidate } from './content-scorer.js';
import { fromBrowserResult, fromMetadataResult, fromNetworkCandidate } from './reader-adapters.js';
import { appendAttempt } from './trace.js';

export async function tryBrowserEscalation(
    url: string,
    options: AdaptiveFetchOptions,
    deps: Record<string, unknown>,
    trace: AttemptTrace,
    challengeInfo: ChallengeInfo | null,
): Promise<Record<string, unknown> | null> {
    if (options.browserMode === 'never') return null;
    try {
        const result = await collectBrowserCandidate(url, {
            browserDeps: deps,
            browserSession: options.browserSession as 'none' | 'isolated' | 'existing',
            timeoutMs: options.timeoutMs,
            selector: options.selector,
            allowPrivateNetwork: options.allowPrivateNetwork,
            challengeInfo,
        });
        appendScoredAttempt(trace, 'browser', fromBrowserResult(result), result);
        const metadataCandidate = collectBrowserMetadataCandidate(result);
        if (metadataCandidate) appendScoredAttempt(trace, 'metadata', fromMetadataResult(metadataCandidate), metadataCandidate);
        for (const structuredCandidate of collectBrowserStructuredResultCandidates(result)) {
            appendScoredAttempt(trace, 'browser', fromBrowserResult(structuredCandidate), structuredCandidate);
        }
        const defuddleCandidate = collectDefuddleCandidate(result);
        if (defuddleCandidate) appendScoredAttempt(trace, 'browser', fromBrowserResult(defuddleCandidate), defuddleCandidate);
        for (const networkCandidate of collectNetworkJsonCandidates(result)) {
            appendScoredAttempt(trace, 'network_api', fromNetworkCandidate(networkCandidate), networkCandidate);
        }
        return result;
    } catch (error: unknown) {
        if (error instanceof BrowserRequiredError || (error as Record<string, unknown>)?.['code'] === 'browser_required') {
            appendAttempt(trace, {
                source: 'browser',
                verdict: 'browser_required',
                url,
                reason: (error as Error).message,
            });
            return null;
        }
        throw error;
    }
}

function appendScoredAttempt(
    trace: AttemptTrace,
    source: string,
    candidate: ReturnType<typeof fromBrowserResult>,
    raw: Record<string, unknown>,
): void {
    const scored = scoreReaderCandidate(candidate);
    appendAttempt(trace, {
        source,
        verdict: scored.verdict,
        url: raw['finalUrl'] as string,
        status: raw['status'] as number,
        reason: `score:${scored.score}`,
        label: raw['label'] as string,
    });
}

import type { AdaptiveFetchOptions, AttemptTrace, ChallengeInfo } from './types.js';
import {
    collectBrowserCandidate,
    collectBrowserMetadataCandidate,
    collectBrowserStructuredResultCandidates,
    collectDefuddleCandidate,
    collectNetworkJsonCandidates,
} from './browser-escalation.js';
import { BrowserRequiredError } from './browser-runtime.js';
import { fetchViaCamoufox } from './camoufox-session.js';
import { scoreReaderCandidate } from './content-scorer.js';
import { extractStructuredContent } from './structured-extractor.js';
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

    const camoufoxResult = await fetchViaCamoufox(url, { timeoutMs: options.timeoutMs });
    if (camoufoxResult?.ok && camoufoxResult.html) {
        const structured = extractStructuredContent(camoufoxResult.html);
        const evidence = ['camoufox-stealth'];
        if (structured.tables.length) evidence.push(`structured:${structured.tables.length}-tables`);
        if (structured.jsonLd.length) evidence.push(`structured:${structured.jsonLd.length}-jsonld`);
        appendAttempt(trace, { source: 'camoufox', verdict: 'ok', url, reason: 'camoufox-stealth' });
        return { ok: true, status: 200, finalUrl: url, contentType: 'text/html', text: camoufoxResult.html, title: camoufoxResult.title, headers: {}, evidence, warnings: [], structured };
    }
    if (camoufoxResult === null) {
        appendAttempt(trace, { source: 'camoufox', verdict: 'skip', url, reason: 'camoufox-not-available' });
    }

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

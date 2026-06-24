import type { AdaptiveFetchOptions, AttemptTrace, ChallengeInfo, ReaderCandidate } from './types.js';
import { validateFetchUrl } from './safety.js';
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
    signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
    if (options.browserMode === 'never') return null;
    if (signal?.aborted) return null; // P0-6: overall deadline already fired

    const allCandidates: ReaderCandidate[] = [];

    const camoufoxResult = await fetchViaCamoufox(url, { timeoutMs: options.timeoutMs, ...(signal ? { signal } : {}) });
    if (camoufoxResult?.ok && camoufoxResult.html && isSafeFinalUrl(camoufoxResult.url || url, options)) {
        const structured = extractStructuredContent(camoufoxResult.html);
        const evidence = ['camoufox-stealth'];
        if (structured.tables.length) evidence.push(`structured:${structured.tables.length}-tables`);
        if (structured.jsonLd.length) evidence.push(`structured:${structured.jsonLd.length}-jsonld`);
        appendAttempt(trace, { source: 'camoufox', verdict: 'ok', url, reason: 'camoufox-stealth' });

        const camoufoxCandidate = fromBrowserResult({
            ok: true, status: 200, finalUrl: camoufoxResult.url || url,
            contentType: 'text/html', text: camoufoxResult.html,
            title: camoufoxResult.title, headers: {}, evidence, warnings: [],
            structured, label: 'camoufox-stealth',
        });
        const scored = scoreReaderCandidate(camoufoxCandidate);
        appendScoredAttempt(trace, 'camoufox', camoufoxCandidate, { finalUrl: camoufoxResult.url || url, status: 200, label: 'camoufox-stealth' });
        allCandidates.push(camoufoxCandidate);

        if (scored.verdict === 'strong_ok') {
            return buildBrowserFlowResult(url, camoufoxResult, structured, evidence, allCandidates);
        }
    } else if (camoufoxResult === null) {
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
            ...(signal ? { signal } : {}),
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
            if (allCandidates.length > 0) {
                return buildCandidateOnlyResult(url, allCandidates);
            }
            return null;
        }
        throw error;
    }
}

function buildBrowserFlowResult(
    url: string,
    camoufoxResult: { html: string; title: string; url: string },
    structured: { tables: unknown[]; jsonLd: unknown[] },
    evidence: string[],
    _candidates: ReaderCandidate[],
): Record<string, unknown> {
    return {
        ok: true, status: 200, finalUrl: camoufoxResult.url || url,
        contentType: 'text/html', text: camoufoxResult.html,
        title: camoufoxResult.title, headers: {}, evidence, warnings: [], structured,
    };
}

function buildCandidateOnlyResult(url: string, candidates: ReaderCandidate[]): Record<string, unknown> {
    const best = candidates[0];
    if (!best) return { ok: false, finalUrl: url, text: '', title: '', status: 0, evidence: [], warnings: [] };
    return {
        ok: best.ok, status: best.status, finalUrl: best.finalUrl,
        contentType: best.contentType, text: best.text,
        title: best.title, headers: {}, evidence: best.evidence, warnings: best.warnings,
    };
}

function isSafeFinalUrl(finalUrl: string, options: AdaptiveFetchOptions): boolean {
    try {
        validateFetchUrl(finalUrl, { allowPrivateNetwork: options.allowPrivateNetwork });
        return true;
    } catch {
        return false;
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

import type { AdaptiveFetchOptions, CandidateUrl, ChallengeInfo, ReaderCandidate } from './types.js';
import type { StageContext, AdaptiveFetchFinalResult } from './stage-types.js';
import type { ScoredResult } from './content-scorer.js';
import { validateFetchUrl } from './safety.js';
import { appendAttempt, createAttemptTrace, summarizeAttempts } from './trace.js';
import { resolvePublicEndpointCandidates } from './endpoint-resolvers.js';
import { fetchTextCandidate } from './fetcher.js';
import { tlsFetch } from './tls-fetch.js';
import { ytdlpMetadata, ytdlpSubtitles, formatYtdlpEvidence } from './ytdlp-reader.js';
import { fromFetchResult, fromUserSessionResult, fromHumanResolvedResult } from './reader-adapters.js';
import { chooseBestReaderCandidate, scoreReaderCandidate } from './content-scorer.js';
import { fetchThirdPartyReaderCandidate } from './third-party-readers.js';
import {
    collectBrowserMetadataCandidate,
    collectBrowserStructuredResultCandidates,
    collectDefuddleCandidate,
    collectNetworkJsonCandidates,
} from './browser-escalation.js';
import { tryBrowserEscalation } from './browser-flow.js';
import { fromBrowserResult, fromMetadataResult, fromNetworkCandidate } from './reader-adapters.js';
import { classifyChallengeType } from './challenge-detector.js';
import { shouldTryUserSession, navigateInUserSession } from './browser-session.js';
import { humanResolve } from './human-loop.js';
import { bm25Filter } from './bm25-filter.js';

export async function executeAdaptiveFetch(
    options: AdaptiveFetchOptions,
    deps: Record<string, unknown> = {},
): Promise<AdaptiveFetchFinalResult> {
    const parsed = validateFetchUrl(options.url, { allowPrivateNetwork: options.allowPrivateNetwork });
    const trace = createAttemptTrace({
        url: options.url,
        browserMode: options.browserMode,
        browserSession: options.browserSessionRaw || options.browserSession,
    });
    const fetchImpl = deps['fetch'] as typeof fetch | undefined;
    const fetchOpt = { ...(fetchImpl ? { fetchImpl } : {}), ...(options.proxy ? { proxy: options.proxy } : {}) };

    appendAttempt(trace, {
        source: 'validation',
        verdict: 'weak_ok',
        url: parsed.href,
        reason: 'url-valid',
    });

    const ctx: StageContext = {
        url: parsed,
        options,
        deps,
        trace,
        candidates: [],
        challenge: null,
        fetchedUrls: new Set<string>(),
        fetchOpt,
        chromeUsed: false,
    };

    runEndpointStage(ctx);
    await runDirectFetchStage(ctx);
    await runDiscoveredEndpointStage(ctx);
    await runJinaStage(ctx);

    const earlyBest = evaluateEarlyExit(ctx);
    if (earlyBest) return finalize(ctx, earlyBest);

    await runBrowserStages(ctx);

    const finalBest = chooseBestReaderCandidate(ctx.candidates);
    if (finalBest) return finalize(ctx, finalBest);

    return finalize(ctx, null);
}

function runEndpointStage(ctx: StageContext): void {
    if (ctx.options.browserMode === 'required' || !ctx.options.publicEndpoints) return;

    const resolved = resolvePublicEndpointCandidates(ctx.url);
    for (const candidate of resolved) {
        (candidate as CandidateUrl).source = 'public_endpoint';
    }
}

async function runDirectFetchStage(ctx: StageContext): Promise<void> {
    const candidateUrls: CandidateUrl[] = [];

    if (ctx.options.browserMode !== 'required' && ctx.options.publicEndpoints) {
        candidateUrls.push(...resolvePublicEndpointCandidates(ctx.url).map(candidate => ({
            ...candidate,
            source: 'public_endpoint',
        })));
    }
    if (ctx.options.browserMode !== 'required') {
        candidateUrls.push({ label: 'direct-fetch', url: ctx.url.href, source: 'fetch' });
    }

    for (const candidate of candidateUrls) {
        let fetched: Record<string, unknown>;

        if (candidate.source === 'ytdlp') {
            try {
                const meta = await ytdlpMetadata(candidate.url, { timeoutMs: ctx.options.timeoutMs });
                if (meta) {
                    const subs = await ytdlpSubtitles(candidate.url, 'en', { timeoutMs: ctx.options.timeoutMs });
                    const text = formatYtdlpEvidence(meta, subs);
                    const evidence = subs ? ['ytdlp-metadata', 'ytdlp-transcript'] : ['ytdlp-metadata'];
                    fetched = { ok: true, status: 200, finalUrl: candidate.url, contentType: 'text/plain', text, headers: {}, evidence, warnings: [] };
                    appendAttempt(ctx.trace, { source: 'ytdlp', verdict: 'ok', url: candidate.url, reason: subs ? 'ytdlp-metadata+transcript' : 'ytdlp-metadata' });
                } else {
                    appendAttempt(ctx.trace, { source: 'ytdlp', verdict: 'skip', url: candidate.url, reason: 'ytdlp-not-available' });
                    continue;
                }
            } catch (error: unknown) {
                appendAttempt(ctx.trace, { source: 'ytdlp', verdict: 'error', url: candidate.url, reason: (error as Error).message || 'ytdlp-error' });
                continue;
            }
        } else {
            try {
                fetched = await fetchTextCandidate(candidate.url, {
                    maxBytes: ctx.options.maxBytes,
                    timeoutMs: ctx.options.timeoutMs,
                    allowPrivateNetwork: ctx.options.allowPrivateNetwork,
                    identity: ctx.options.identity,
                    ...ctx.fetchOpt,
                }) as unknown as Record<string, unknown>;
            } catch (error: unknown) {
                appendAttempt(ctx.trace, {
                    source: candidate.source,
                    verdict: 'error',
                    url: candidate.url,
                    reason: (error as Error).message || 'fetch-candidate-error',
                });
                continue;
            }
        }
        ctx.fetchedUrls.add((fetched['finalUrl'] as string) || candidate.url);

        if (candidate.source === 'fetch' && !fetched['ok']) {
            const challengeResult = classifyChallengeType({
                status: fetched['status'] as number,
                headers: fetched['headers'] as Record<string, string>,
                body: fetched['text'] as string,
            });
            if (challengeResult.type) {
                ctx.challenge = challengeResult as unknown as ChallengeInfo;
                appendAttempt(ctx.trace, {
                    source: candidate.source,
                    verdict: challengeResult.type,
                    url: fetched['finalUrl'] as string,
                    status: fetched['status'] as number,
                    reason: `challenge:${challengeResult.type}`,
                });
            }
        }

        if (candidate.source === 'fetch' && !fetched['ok'] && (fetched['status'] === 403 || fetched['status'] === 429 || ctx.challenge)) {
            const tlsOpts: { timeoutMs?: number; maxBytes?: number; proxy?: string } = { timeoutMs: ctx.options.timeoutMs, maxBytes: ctx.options.maxBytes };
            if (ctx.options.proxy) tlsOpts.proxy = ctx.options.proxy;
            const tlsResult = await tlsFetch(candidate.url, tlsOpts);
            if (tlsResult?.ok) {
                appendAttempt(ctx.trace, { source: 'tls-fetch', verdict: 'ok', url: candidate.url, status: tlsResult.status, reason: `tls-profile:${tlsResult.profile}` });
                fetched = { ok: true, status: tlsResult.status, finalUrl: candidate.url, contentType: tlsResult.headers['content-type'] || '', text: tlsResult.body, headers: tlsResult.headers, evidence: [`tls-fetch:${tlsResult.profile}`], warnings: [] };
            }
        }

        const readerCandidate = fromFetchResult(fetched, {
            source: candidate.source,
            label: candidate.label,
        });
        if (ctx.challenge && candidate.source === 'fetch') {
            readerCandidate.challenge = ctx.challenge;
        }
        const scored = scoreReaderCandidate(readerCandidate);
        appendAttempt(ctx.trace, {
            source: readerCandidate.source,
            verdict: scored.verdict,
            url: fetched['finalUrl'] as string,
            status: fetched['status'] as number,
            reason: `score:${scored.score}`,
        });
        if (readerCandidate.text || readerCandidate.title) ctx.candidates.push(readerCandidate);
    }
}

async function runDiscoveredEndpointStage(ctx: StageContext): Promise<void> {
    if (ctx.options.browserMode === 'required' || !ctx.options.publicEndpoints) return;

    const discoveredFeedUrls: string[] = [];
    const discoveredOembedUrls: string[] = [];
    for (const c of ctx.candidates) {
        const metadata = c.metadata;
        for (const feedUrl of ((metadata as Record<string, unknown> | null)?.['feedUrls'] as string[]) || []) {
            if (!ctx.fetchedUrls.has(feedUrl) && !discoveredFeedUrls.includes(feedUrl)) discoveredFeedUrls.push(feedUrl);
        }
        for (const oEmbedUrl of ((metadata as Record<string, unknown> | null)?.['oEmbedUrls'] as string[]) || []) {
            if (!ctx.fetchedUrls.has(oEmbedUrl) && !discoveredOembedUrls.includes(oEmbedUrl)) discoveredOembedUrls.push(oEmbedUrl);
        }
    }

    for (const discovered of [
        ...discoveredFeedUrls.map(url => ({ url, label: 'rss-atom-discovered' })),
        ...discoveredOembedUrls.map(url => ({ url, label: 'oembed-discovered' })),
    ]) {
        let fetched: Record<string, unknown>;
        try {
            fetched = await fetchTextCandidate(discovered.url, {
                maxBytes: ctx.options.maxBytes,
                timeoutMs: ctx.options.timeoutMs,
                allowPrivateNetwork: ctx.options.allowPrivateNetwork,
                identity: ctx.options.identity,
                ...ctx.fetchOpt,
            }) as unknown as Record<string, unknown>;
        } catch (error: unknown) {
            appendAttempt(ctx.trace, {
                source: 'public_endpoint',
                verdict: 'error',
                url: discovered.url,
                reason: (error as Error).message || `${discovered.label}-error`,
            });
            continue;
        }
        ctx.fetchedUrls.add((fetched['finalUrl'] as string) || discovered.url);
        const readerCandidate = fromFetchResult(fetched, {
            source: 'public_endpoint',
            label: discovered.label,
        });
        const scored = scoreReaderCandidate(readerCandidate);
        appendAttempt(ctx.trace, {
            source: readerCandidate.source,
            verdict: scored.verdict,
            url: fetched['finalUrl'] as string,
            status: fetched['status'] as number,
            reason: `score:${scored.score}`,
        });
        if (readerCandidate.text || readerCandidate.title) ctx.candidates.push(readerCandidate);
    }
}

async function runJinaStage(ctx: StageContext): Promise<void> {
    if (!ctx.options.allowThirdPartyReader) return;

    let fetched: ReaderCandidate | null = null;
    try {
        fetched = await fetchThirdPartyReaderCandidate(ctx.url.href, {
            allowThirdPartyReader: true,
            maxBytes: ctx.options.maxBytes,
            timeoutMs: ctx.options.timeoutMs,
            ...ctx.fetchOpt,
        });
    } catch (error: unknown) {
        appendAttempt(ctx.trace, {
            source: 'third_party_reader',
            verdict: 'error',
            url: ctx.url.href,
            reason: (error as Error).message || 'third-party-reader-error',
        });
    }
    if (fetched) {
        const readerCandidate = fromFetchResult(fetched as unknown as Record<string, unknown>, {
            source: 'third_party_reader',
            label: 'jina-reader',
        });
        const scored = scoreReaderCandidate(readerCandidate);
        appendAttempt(ctx.trace, {
            source: readerCandidate.source,
            verdict: scored.verdict,
            url: (fetched as unknown as Record<string, unknown>)['readerUrl'] as string || fetched.finalUrl,
            status: fetched.status,
            reason: `score:${scored.score}`,
        });
        if (readerCandidate.text || readerCandidate.title) ctx.candidates.push(readerCandidate);
    }
}

async function runBrowserStages(ctx: StageContext): Promise<void> {
    const browserResult = await tryBrowserEscalation(ctx.url.href, ctx.options, ctx.deps, ctx.trace, ctx.challenge);
    if (browserResult) {
        ctx.chromeUsed = true;
        ctx.candidates.push(fromBrowserResult(browserResult));
        const metadataCandidate = collectBrowserMetadataCandidate(browserResult);
        if (metadataCandidate) ctx.candidates.push(fromMetadataResult(metadataCandidate));
        for (const structuredCandidate of collectBrowserStructuredResultCandidates(browserResult)) {
            ctx.candidates.push(fromBrowserResult(structuredCandidate));
        }
        const defuddleCandidate = collectDefuddleCandidate(browserResult);
        if (defuddleCandidate) ctx.candidates.push(fromBrowserResult(defuddleCandidate));
        for (const networkCandidate of collectNetworkJsonCandidates(browserResult)) {
            ctx.candidates.push(fromNetworkCandidate(networkCandidate));
        }
        const best = chooseBestReaderCandidate(ctx.candidates);
        if (best && best.verdict === 'strong_ok') {
            return;
        }
    }

    await runUserSessionStage(ctx);
    await runHumanLoopStage(ctx);
}

async function runUserSessionStage(ctx: StageContext): Promise<void> {
    const sessionDecision = shouldTryUserSession(ctx.candidates, { ...ctx.options, browserDeps: ctx.deps });
    if (sessionDecision !== true) return;

    try {
        const userResult = await navigateInUserSession(ctx.url.href, {
            browserDeps: ctx.deps,
            timeoutMs: ctx.options.timeoutMs,
            selector: ctx.options.selector,
            allowPrivateNetwork: ctx.options.allowPrivateNetwork,
        });
        ctx.candidates.push(fromUserSessionResult(userResult as unknown as Record<string, unknown>));
        ctx.chromeUsed = true;
        appendAttempt(ctx.trace, {
            source: 'browser_user',
            verdict: 'strong_ok',
            url: (userResult as unknown as Record<string, unknown>)['finalUrl'] as string,
            reason: 'user-session-render',
        });
    } catch (error: unknown) {
        appendAttempt(ctx.trace, {
            source: 'browser_user',
            verdict: 'error',
            url: ctx.url.href,
            reason: (error as Error).message || 'user-session-error',
        });
    }
}

async function runHumanLoopStage(ctx: StageContext): Promise<void> {
    const best = chooseBestReaderCandidate(ctx.candidates);
    if (!ctx.options.humanLoop || !hasUnresolvedChallenge(ctx.candidates, best)) return;

    const challengeInfo = ctx.challenge || { type: 'challenge' };
    try {
        const humanResult = await humanResolve(ctx.url.href, {
            ...ctx.options,
            browserDeps: ctx.deps,
        }, challengeInfo) as Record<string, unknown>;
        if (humanResult['ok'] !== false) {
            ctx.candidates.push(fromHumanResolvedResult(humanResult));
            ctx.chromeUsed = true;
            appendAttempt(ctx.trace, {
                source: 'human_resolved',
                verdict: 'strong_ok',
                url: (humanResult['finalUrl'] as string) || ctx.url.href,
                reason: 'human-resolved',
            });
        } else {
            appendAttempt(ctx.trace, {
                source: 'human_resolved',
                verdict: (humanResult['verdict'] as string) || 'blocked',
                url: ctx.url.href,
                reason: (humanResult['actionMessage'] as string) || 'human-action-needed',
            });
        }
    } catch (error: unknown) {
        appendAttempt(ctx.trace, {
            source: 'human_resolved',
            verdict: 'error',
            url: ctx.url.href,
            reason: (error as Error).message || 'human-loop-error',
        });
    }
}

function evaluateEarlyExit(ctx: StageContext): ScoredResult | null {
    const best = chooseBestReaderCandidate(ctx.candidates);
    if (shouldReturnWithoutBrowser(best, ctx.options)) return best;
    return null;
}

function finalize(ctx: StageContext, scored: ScoredResult | null): AdaptiveFetchFinalResult {
    if (scored) {
        const result = resultFromScoredCandidate(scored);
        if (ctx.options.userSessionExplicit) {
            result.safetyFlags = [...result.safetyFlags, 'user_session_used'];
        }
        return buildFinalResult(result, ctx);
    }
    return buildFinalResult({
        ok: false,
        verdict: ctx.options.browserMode === 'required' ? 'browser_required' : 'blocked',
        source: ctx.options.browserMode === 'required' ? 'browser' : 'fetch',
        finalUrl: ctx.url.href,
        title: null,
        content: '',
        summary: 'No public endpoint, fetch, or metadata attempt produced readable content.',
        evidence: [],
        warnings: [],
        safetyFlags: [],
        metadata: null,
    }, ctx);
}

function buildFinalResult(
    result: {
        ok: boolean;
        verdict: string;
        source: string;
        finalUrl: string;
        title: string | null;
        content: string;
        summary: string;
        evidence: string[];
        warnings: string[];
        safetyFlags: string[];
        metadata: Record<string, unknown> | null;
    },
    ctx: StageContext,
): AdaptiveFetchFinalResult {
    let content = result.content;
    const evidence = [...result.evidence];
    if (ctx.options.query && content.length > 5000) {
        content = bm25Filter(content, { query: ctx.options.query, topK: 15 });
        evidence.push('bm25-filtered');
    }
    return {
        ok: result.ok,
        verdict: result.verdict as AdaptiveFetchFinalResult['verdict'],
        source: result.source,
        finalUrl: result.finalUrl,
        browserMode: ctx.options.browserMode,
        browserSession: ctx.options.browserSessionRaw || ctx.options.browserSession,
        identity: ctx.options.identity || 'auto',
        chromeUsed: ctx.chromeUsed,
        chromeRequired: result.verdict === 'browser_required' || (ctx.options.browserMode === 'required' && !result.ok),
        title: result.title,
        content,
        summary: result.summary,
        attempts: ctx.options.trace ? ctx.trace.attempts : [],
        safetyFlags: result.safetyFlags,
        evidence,
        warnings: [...(ctx.options.optionWarnings || []), ...result.warnings],
        metadata: result.metadata,
        _traceSummary: summarizeAttempts(ctx.trace.attempts),
    };
}

function resultFromScoredCandidate(scored: ScoredResult): {
    ok: boolean;
    verdict: string;
    source: string;
    finalUrl: string;
    title: string | null;
    content: string;
    summary: string;
    evidence: string[];
    warnings: string[];
    safetyFlags: string[];
    metadata: Record<string, unknown> | null;
} {
    const candidate = scored.candidate;
    return {
        ok: candidate.ok !== false && ['strong_ok', 'weak_ok'].includes(scored.verdict as string),
        verdict: scored.verdict,
        source: candidate.source,
        finalUrl: candidate.finalUrl,
        title: candidate.title || null,
        content: candidate.text || '',
        summary: `${candidate.label || candidate.source} selected with ${scored.verdict} (score ${scored.score}).`,
        evidence: scored.evidence,
        warnings: candidate.warnings || [],
        safetyFlags: candidate.safetyFlags || [],
        metadata: candidate.metadata || null,
    };
}

function shouldReturnWithoutBrowser(best: ScoredResult | null, options: AdaptiveFetchOptions): boolean {
    if (options.browserMode === 'required') return false;
    if (options.browserMode === 'never') return Boolean(best);
    return Boolean(best && best.verdict === 'strong_ok');
}

function hasUnresolvedChallenge(candidates: ReaderCandidate[], best: ScoredResult | null): boolean {
    if (best && best.verdict === 'strong_ok') return false;
    return candidates.some(c =>
        c.challenge?.type === 'challenge' ||
        c.challenge?.type === 'auth_required' ||
        c.challenge?.type === 'paywall'
    ) || (best != null && ['challenge', 'auth_required', 'paywall', 'blocked'].includes(best.verdict as string));
}


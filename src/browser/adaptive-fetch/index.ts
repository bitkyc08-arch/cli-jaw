// Mirrored from agbrowse adaptive-fetch v2; keep runtime behavior aligned while cli-jaw mirror remains experimental.

import type { AdaptiveFetchOptions, BrowserMode, IdentityMode, CandidateUrl, ReaderCandidate, ChallengeInfo, AttemptTrace } from './types.js';
import { parseArgs } from 'node:util';
import { validateFetchUrl, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS } from './safety.js';
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
import { compactAdaptiveFetchResult, writeStdoutLine } from './output.js';

// @strict-allow-any(mirrored adaptive-fetch scorer result shape is intentionally duck-typed)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ScoredResult = any;

const BROWSER_MODES = new Set(['auto', 'never', 'required']);
const BROWSER_SESSIONS = new Set(['none', 'isolated', 'existing', 'user', 'interactive']);
const IDENTITY_MODES = new Set(['auto', 'minimal', 'chrome']);

export function normalizeAdaptiveFetchOptions(raw: Record<string, unknown> = {}): AdaptiveFetchOptions {
    const browserMode = normalizeEnum(raw['browserMode'] || raw['browser'], BROWSER_MODES, 'auto', 'browser') as BrowserMode;
    const rawSession = raw['browserSession'];
    const browserSession = normalizeEnum(rawSession, BROWSER_SESSIONS, browserMode === 'never' ? 'none' : 'isolated', 'browserSession');
    const identity = normalizeEnum(raw['identity'], IDENTITY_MODES, 'auto', 'identity') as IdentityMode;
    const userSessionExplicit = browserSession === 'user' || browserSession === 'interactive';
    const humanLoop = browserSession === 'interactive';
    return {
        url: typeof raw['url'] === 'string' ? raw['url'] : '',
        json: Boolean(raw['json']),
        trace: Boolean(raw['trace']),
        browserMode,
        browserSession: userSessionExplicit ? 'existing' : browserSession,
        identity,
        userSessionExplicit,
        humanLoop,
        browserSessionRaw: browserSession,
        maxBytes: positiveInteger(raw['maxBytes'], DEFAULT_MAX_BYTES),
        timeoutMs: positiveInteger(raw['timeoutMs'], DEFAULT_TIMEOUT_MS),
        selector: typeof raw['selector'] === 'string' ? raw['selector'] : null,
        publicEndpoints: raw['publicEndpoints'] !== false,
        allowPrivateNetwork: Boolean(raw['allowPrivateNetwork']),
        allowThirdPartyReader: Boolean(raw['allowThirdPartyReader']),
        allowArchive: Boolean(raw['allowArchive']),
        interactive: Boolean(raw['interactive']),
        optionWarnings: raw['allowArchive'] ? ['archive-fallback-deferred'] : [],
    };
}

export async function runAdaptiveFetch(input: Record<string, unknown>, deps: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const options = normalizeAdaptiveFetchOptions(input);
    const trace = createAttemptTrace({
        url: options.url,
        browserMode: options.browserMode,
        browserSession: options.browserSessionRaw || options.browserSession,
    });
    const fetchImpl = (deps['fetch'] || input['fetchImpl']) as typeof fetch | undefined;
    const fetchOpt = fetchImpl ? { fetchImpl } : {};
    const parsed = validateFetchUrl(options.url, { allowPrivateNetwork: options.allowPrivateNetwork });
    appendAttempt(trace, {
        source: 'validation',
        verdict: 'weak_ok',
        url: parsed.href,
        reason: 'url-valid',
    });

    const candidateUrls: CandidateUrl[] = [];
    if (options.browserMode !== 'required' && options.publicEndpoints) {
        candidateUrls.push(...resolvePublicEndpointCandidates(parsed).map(candidate => ({
            ...candidate,
            source: 'public_endpoint',
        })));
    }
    if (options.browserMode !== 'required') {
        candidateUrls.push({ label: 'direct-fetch', url: parsed.href, source: 'fetch' });
    }

    const readerCandidates: ReaderCandidate[] = [];
    const fetchedUrls = new Set<string>();
    const discoveredFeedUrls: string[] = [];
    const discoveredOembedUrls: string[] = [];
    let detectedChallenge: ChallengeInfo | null = null;

    for (const candidate of candidateUrls) {
        let fetched: Record<string, unknown>;

        if (candidate.source === 'ytdlp') {
            try {
                const meta = await ytdlpMetadata(candidate.url, { timeoutMs: options.timeoutMs });
                if (meta) {
                    const subs = await ytdlpSubtitles(candidate.url, 'en', { timeoutMs: options.timeoutMs });
                    const text = formatYtdlpEvidence(meta, subs);
                    const evidence = subs ? ['ytdlp-metadata', 'ytdlp-transcript'] : ['ytdlp-metadata'];
                    fetched = { ok: true, status: 200, finalUrl: candidate.url, contentType: 'text/plain', text, headers: {}, evidence, warnings: [] };
                    appendAttempt(trace, { source: 'ytdlp', verdict: 'ok', url: candidate.url, reason: subs ? 'ytdlp-metadata+transcript' : 'ytdlp-metadata' });
                } else {
                    appendAttempt(trace, { source: 'ytdlp', verdict: 'skip', url: candidate.url, reason: 'ytdlp-not-available' });
                    continue;
                }
            } catch (error: unknown) {
                appendAttempt(trace, { source: 'ytdlp', verdict: 'error', url: candidate.url, reason: (error as Error).message || 'ytdlp-error' });
                continue;
            }
        } else {
        try {
            fetched = await fetchTextCandidate(candidate.url, {
                maxBytes: options.maxBytes,
                timeoutMs: options.timeoutMs,
                allowPrivateNetwork: options.allowPrivateNetwork,
                identity: options.identity,
                ...fetchOpt,
            }) as unknown as Record<string, unknown>;
        } catch (error: unknown) {
            appendAttempt(trace, {
                source: candidate.source,
                verdict: 'error',
                url: candidate.url,
                reason: (error as Error).message || 'fetch-candidate-error',
            });
            continue;
        }
        }
        fetchedUrls.add((fetched['finalUrl'] as string) || candidate.url);

        if (candidate.source === 'fetch' && !fetched['ok']) {
            const challengeResult = classifyChallengeType({
                status: fetched['status'] as number,
                headers: fetched['headers'] as Record<string, string>,
                body: fetched['text'] as string,
            });
            if (challengeResult.type) {
                detectedChallenge = challengeResult as unknown as ChallengeInfo;
                appendAttempt(trace, {
                    source: candidate.source,
                    verdict: challengeResult.type,
                    url: fetched['finalUrl'] as string,
                    status: fetched['status'] as number,
                    reason: `challenge:${challengeResult.type}`,
                });
            }
        }

        if (candidate.source === 'fetch' && !fetched['ok'] && (fetched['status'] === 403 || fetched['status'] === 429 || detectedChallenge)) {
            const tlsResult = await tlsFetch(candidate.url, { timeoutMs: options.timeoutMs, maxBytes: options.maxBytes });
            if (tlsResult?.ok) {
                appendAttempt(trace, { source: 'tls-fetch', verdict: 'ok', url: candidate.url, status: tlsResult.status, reason: `tls-profile:${tlsResult.profile}` });
                fetched = { ok: true, status: tlsResult.status, finalUrl: candidate.url, contentType: tlsResult.headers['content-type'] || '', text: tlsResult.body, headers: tlsResult.headers, evidence: [`tls-fetch:${tlsResult.profile}`], warnings: [] };
            }
        }

        const readerCandidate = fromFetchResult(fetched, {
            source: candidate.source,
            label: candidate.label,
        });
        if (detectedChallenge && candidate.source === 'fetch') {
            readerCandidate.challenge = detectedChallenge;
        }
        const metadata = readerCandidate.metadata;
        for (const feedUrl of ((metadata as Record<string, unknown> | null)?.['feedUrls'] as string[]) || []) {
            if (!fetchedUrls.has(feedUrl) && !discoveredFeedUrls.includes(feedUrl)) discoveredFeedUrls.push(feedUrl);
        }
        for (const oEmbedUrl of ((metadata as Record<string, unknown> | null)?.['oEmbedUrls'] as string[]) || []) {
            if (!fetchedUrls.has(oEmbedUrl) && !discoveredOembedUrls.includes(oEmbedUrl)) discoveredOembedUrls.push(oEmbedUrl);
        }
        const scored = scoreReaderCandidate(readerCandidate);
        appendAttempt(trace, {
            source: readerCandidate.source,
            verdict: scored.verdict,
            url: fetched['finalUrl'] as string,
            status: fetched['status'] as number,
            reason: `score:${scored.score}`,
        });
        if (readerCandidate.text || readerCandidate.title) readerCandidates.push(readerCandidate);
    }

    if (options.browserMode !== 'required' && options.publicEndpoints) {
        for (const discovered of [
            ...discoveredFeedUrls.map(url => ({ url, label: 'rss-atom-discovered' })),
            ...discoveredOembedUrls.map(url => ({ url, label: 'oembed-discovered' })),
        ]) {
            let fetched: Record<string, unknown>;
            try {
                fetched = await fetchTextCandidate(discovered.url, {
                    maxBytes: options.maxBytes,
                    timeoutMs: options.timeoutMs,
                    allowPrivateNetwork: options.allowPrivateNetwork,
                    identity: options.identity,
                    ...fetchOpt,
                }) as unknown as Record<string, unknown>;
            } catch (error: unknown) {
                appendAttempt(trace, {
                    source: 'public_endpoint',
                    verdict: 'error',
                    url: discovered.url,
                    reason: (error as Error).message || `${discovered.label}-error`,
                });
                continue;
            }
            fetchedUrls.add((fetched['finalUrl'] as string) || discovered.url);
            const readerCandidate = fromFetchResult(fetched, {
                source: 'public_endpoint',
                label: discovered.label,
            });
            const scored = scoreReaderCandidate(readerCandidate);
            appendAttempt(trace, {
                source: readerCandidate.source,
                verdict: scored.verdict,
                url: fetched['finalUrl'] as string,
                status: fetched['status'] as number,
                reason: `score:${scored.score}`,
            });
            if (readerCandidate.text || readerCandidate.title) readerCandidates.push(readerCandidate);
        }
    }

    if (options.allowThirdPartyReader) {
        let fetched: ReaderCandidate | null = null;
        try {
            fetched = await fetchThirdPartyReaderCandidate(parsed.href, {
                allowThirdPartyReader: true,
                maxBytes: options.maxBytes,
                timeoutMs: options.timeoutMs,
                ...fetchOpt,
            });
        } catch (error: unknown) {
            appendAttempt(trace, {
                source: 'third_party_reader',
                verdict: 'error',
                url: parsed.href,
                reason: (error as Error).message || 'third-party-reader-error',
            });
        }
        if (fetched) {
            const readerCandidate = fromFetchResult(fetched as unknown as Record<string, unknown>, {
                source: 'third_party_reader',
                label: 'jina-reader',
            });
            const scored = scoreReaderCandidate(readerCandidate);
            appendAttempt(trace, {
                source: readerCandidate.source,
                verdict: scored.verdict,
                url: (fetched as unknown as Record<string, unknown>)['readerUrl'] as string || fetched.finalUrl,
                status: fetched.status,
                reason: `score:${scored.score}`,
            });
            if (readerCandidate.text || readerCandidate.title) readerCandidates.push(readerCandidate);
        }
    }

    let best: ScoredResult = chooseBestReaderCandidate(readerCandidates);
    if (shouldReturnWithoutBrowser(best, options)) return finishResult(resultFromReaderCandidate(best), options, trace);

    const browserResult = await tryBrowserEscalation(parsed.href, options, deps, trace, detectedChallenge);
    if (browserResult) {
        readerCandidates.push(fromBrowserResult(browserResult));
        const metadataCandidate = collectBrowserMetadataCandidate(browserResult);
        if (metadataCandidate) readerCandidates.push(fromMetadataResult(metadataCandidate));
        for (const structuredCandidate of collectBrowserStructuredResultCandidates(browserResult)) {
            readerCandidates.push(fromBrowserResult(structuredCandidate));
        }
        const defuddleCandidate = collectDefuddleCandidate(browserResult);
        if (defuddleCandidate) readerCandidates.push(fromBrowserResult(defuddleCandidate));
        for (const networkCandidate of collectNetworkJsonCandidates(browserResult)) {
            readerCandidates.push(fromNetworkCandidate(networkCandidate));
        }
        best = chooseBestReaderCandidate(readerCandidates);
        if (best && best.verdict === 'strong_ok') {
            const result = resultFromReaderCandidate(best);
            if (options.userSessionExplicit) {
                result['safetyFlags'] = [...((result['safetyFlags'] as string[]) || []), 'user_session_used'];
            }
            return finishResult(result, options, trace, { chromeUsed: true });
        }
    }

    const sessionDecision = shouldTryUserSession(readerCandidates, { ...options, browserDeps: deps });
    if (sessionDecision === true) {
        try {
            const userResult = await navigateInUserSession(parsed.href, {
                browserDeps: deps,
                timeoutMs: options.timeoutMs,
                selector: options.selector,
                allowPrivateNetwork: options.allowPrivateNetwork,
            });
            readerCandidates.push(fromUserSessionResult(userResult as unknown as Record<string, unknown>));
            appendAttempt(trace, {
                source: 'browser_user',
                verdict: 'strong_ok',
                url: (userResult as unknown as Record<string, unknown>)['finalUrl'] as string,
                reason: 'user-session-render',
            });
            best = chooseBestReaderCandidate(readerCandidates);
            if (best && best.verdict === 'strong_ok') {
                return finishResult(resultFromReaderCandidate(best), options, trace, { chromeUsed: true });
            }
        } catch (error: unknown) {
            appendAttempt(trace, {
                source: 'browser_user',
                verdict: 'error',
                url: parsed.href,
                reason: (error as Error).message || 'user-session-error',
            });
        }
    }

    if (options.humanLoop && hasUnresolvedChallenge(readerCandidates, best)) {
        const challengeInfo = detectedChallenge || { type: 'challenge' };
        try {
            const humanResult = await humanResolve(parsed.href, {
                ...options,
                browserDeps: deps,
            }, challengeInfo) as Record<string, unknown>;
            if (humanResult['ok'] !== false) {
                readerCandidates.push(fromHumanResolvedResult(humanResult));
                appendAttempt(trace, {
                    source: 'human_resolved',
                    verdict: 'strong_ok',
                    url: (humanResult['finalUrl'] as string) || parsed.href,
                    reason: 'human-resolved',
                });
                best = chooseBestReaderCandidate(readerCandidates);
                if (best) return finishResult(resultFromReaderCandidate(best), options, trace, { chromeUsed: true });
            } else {
                appendAttempt(trace, {
                    source: 'human_resolved',
                    verdict: (humanResult['verdict'] as string) || 'blocked',
                    url: parsed.href,
                    reason: (humanResult['actionMessage'] as string) || 'human-action-needed',
                });
            }
        } catch (error: unknown) {
            appendAttempt(trace, {
                source: 'human_resolved',
                verdict: 'error',
                url: parsed.href,
                reason: (error as Error).message || 'human-loop-error',
            });
        }
    }

    if (best) return finishResult(resultFromReaderCandidate(best), options, trace, { chromeUsed: Boolean(browserResult) });
    return finishResult({
        ok: false,
        verdict: options.browserMode === 'required' ? 'browser_required' : 'blocked',
        source: options.browserMode === 'required' ? 'browser' : 'fetch',
        finalUrl: parsed.href,
        title: null,
        content: '',
        summary: 'No public endpoint, fetch, or metadata attempt produced readable content.',
        reason: 'no-readable-content',
        evidence: [],
        warnings: [],
    }, options, trace);
}

export async function runAdaptiveFetchCli(args: string[], deps: Record<string, unknown> = {}): Promise<void> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: false,
        options: {
            json: { type: 'boolean', default: false },
            trace: { type: 'boolean', default: false },
            browser: { type: 'string', default: 'auto' },
            'browser-session': { type: 'string' },
            identity: { type: 'string', default: 'auto' },
            'no-browser': { type: 'boolean', default: false },
            'max-bytes': { type: 'string' },
            'timeout-ms': { type: 'string' },
            selector: { type: 'string' },
            'no-public-endpoints': { type: 'boolean', default: false },
            'allow-third-party-reader': { type: 'boolean', default: true },
            'allow-archive': { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false },
        },
    });
    if (values.help || positionals.length === 0) {
        console.log(formatAdaptiveFetchHelp());
        return;
    }
    const result = await runAdaptiveFetch({
        url: positionals[0],
        json: values.json,
        trace: values.trace,
        browser: values['no-browser'] ? 'never' : values.browser,
        browserSession: values['browser-session'],
        identity: values.identity,
        maxBytes: values['max-bytes'],
        timeoutMs: values['timeout-ms'],
        selector: values.selector,
        publicEndpoints: !values['no-public-endpoints'],
        allowThirdPartyReader: values['allow-third-party-reader'],
        allowArchive: values['allow-archive'],
    }, deps);
    if (values.json) {
        const { _traceSummary, ...jsonResult } = result;
        await writeStdoutLine(JSON.stringify(compactAdaptiveFetchResult(jsonResult), null, 2), deps['stdout'] as { write: (chunk: string, cb?: (error?: Error | null) => void) => boolean } | undefined);
    } else {
        await writeStdoutLine(formatAdaptiveFetchHuman(result), deps['stdout'] as { write: (chunk: string, cb?: (error?: Error | null) => void) => boolean } | undefined);
    }
}

export function formatAdaptiveFetchHelp(): string {
    return `agbrowse fetch <url> [--json] [--trace] [--browser auto|never|required]
            [--browser-session none|isolated|existing|user|interactive]
            [--identity auto|minimal|chrome]

Read one URL through a 6-phase adaptive escalation ladder.
Not generic search — use search tools to find URLs first.

Options:
  --json                         Output JSON
  --trace                        Include attempt trace
  --browser auto|never|required  Browser escalation mode
  --no-browser                   Alias for --browser never
  --browser-session <mode>       Session mode:
      none       fresh cookie jar, no browser (HTTP phases)
      isolated   fresh Chrome profile, no cookies (browser phases)
      existing   reuse existing Chrome session
      user       user's authenticated browser session (explicit opt-in)
      interactive  user session + human-in-the-loop challenge resolution
  --identity auto|minimal|chrome Request identity headers
  --max-bytes N                  Maximum response bytes per read
  --timeout-ms N                 Per-attempt timeout
  --selector CSS                 Browser text extraction selector
  --allow-third-party-reader     Use Jina Reader as fallback (default: on)
  --no-allow-third-party-reader  Disable Jina Reader fallback
  --no-public-endpoints          Skip known public endpoint resolvers
  --allow-archive                Accepted but deferred; emits a warning
`;
}

export function formatAdaptiveFetchHuman(result: Record<string, unknown>): string {
    return [
        `ok: ${result['ok']}`,
        `verdict: ${result['verdict']}`,
        `source: ${result['source']}`,
        `final_url: ${result['finalUrl']}`,
        `browser: ${result['browserMode']}/${result['browserSession']} identity=${result['identity']}`,
        `summary: ${result['summary']}`,
    ].join('\n');
}

function normalizeEnum(value: unknown, allowed: Set<string>, fallback: string, name: string): string {
    if (value === undefined || value === null || value === '') return fallback;
    const text = String(value);
    if (!allowed.has(text)) throw new Error(`invalid ${name}: ${text}`);
    return text;
}

function positiveInteger(value: unknown, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function resultFromReaderCandidate(scored: ScoredResult): Record<string, unknown> {
    const candidate = scored.candidate as ReaderCandidate;
    return {
        ok: candidate.ok !== false && ['strong_ok', 'weak_ok'].includes(scored.verdict as string),
        verdict: scored.verdict,
        source: candidate.source,
        finalUrl: candidate.finalUrl,
        title: candidate.title || null,
        content: candidate.text || '',
        summary: `${candidate.label || candidate.source} selected with ${scored.verdict} (score ${scored.score}).`,
        reason: `score:${scored.score}`,
        evidence: scored.evidence,
        warnings: candidate.warnings || [],
        safetyFlags: candidate.safetyFlags || [],
        metadata: candidate.metadata || null,
    };
}

function finishResult(result: Record<string, unknown>, options: AdaptiveFetchOptions, trace: AttemptTrace, runtime: { chromeUsed?: boolean } = {}): Record<string, unknown> {
    return {
        ok: result['ok'],
        verdict: result['verdict'],
        source: result['source'],
        finalUrl: result['finalUrl'],
        browserMode: options.browserMode,
        browserSession: options.browserSessionRaw || options.browserSession,
        identity: options.identity || 'auto',
        chromeUsed: Boolean(runtime.chromeUsed),
        chromeRequired: result['verdict'] === 'browser_required' || (options.browserMode === 'required' && !result['ok']),
        title: result['title'],
        content: result['content'],
        summary: result['summary'],
        attempts: options.trace ? trace.attempts : [],
        safetyFlags: Array.isArray(result['safetyFlags']) ? result['safetyFlags'] : [],
        evidence: (result['evidence'] as unknown[]) || [],
        warnings: [...(options.optionWarnings || []), ...((result['warnings'] as string[]) || [])],
        metadata: result['metadata'] || null,
        _traceSummary: summarizeAttempts(trace.attempts),
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

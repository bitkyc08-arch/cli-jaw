// Mirrored from agbrowse adaptive-fetch v2; keep runtime behavior aligned while cli-jaw mirror remains experimental.

import type { BrowserCandidateOptions } from './types.js';
import { closeFetchBrowserPage, getFetchBrowserPage } from './browser-runtime.js';
import { classifyAccessBoundary, detectChallengeMarkers } from './challenge-detector.js';
import { runDefuddleInPage } from './defuddle-extractor.js';
import { validateFetchUrl } from './safety.js';
import { classifyBoundarySignals } from './validators.js';

// @strict-allow-any(playwright page/response mirror boundary from agbrowse adaptive-fetch)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPage = any;

export async function collectBrowserCandidate(url: string, options: BrowserCandidateOptions = {}): Promise<Record<string, unknown>> {
    const pageRef = await getFetchBrowserPage({
        ...(options.browserDeps ? { browserDeps: options.browserDeps } : {}),
        browserSession: options.browserSession || 'isolated',
    });
    const page: AnyPage = pageRef.page;
    const networkCandidates: Record<string, unknown>[] = [];
    const onResponse = async (response: AnyPage) => {
        try {
            const finalUrl = validateFetchUrl(response.url?.() || url, {
                ...(options.allowPrivateNetwork != null ? { allowPrivateNetwork: options.allowPrivateNetwork } : {}),
            }).href;
            if (isTrackingEndpoint(finalUrl) || isAuthEndpoint(finalUrl)) return;
            const contentType = response.headers?.()['content-type'] || '';
            if (!/\bjson\b/i.test(contentType)) return;
            const text = await response.text();
            if (!text || text.length > 200000) return;
            networkCandidates.push({
                source: 'network_api',
                finalUrl,
                title: '',
                text,
                contentType,
                status: response.status?.() || 0,
                ok: response.ok?.() !== false,
                evidence: ['browser-network-json'],
                warnings: [],
            });
        } catch {
            // Network candidate collection is best-effort; failures are silently dropped.
        }
    };
    try {
        if (typeof page.on === 'function') page.on('response', onResponse);
        let navStatus = 200;
        let navOk = true;
        let navContentType = 'text/plain';
        if (typeof page.goto === 'function') {
            const navResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs || 15000 });
            if (navResponse) {
                navStatus = Number(navResponse.status?.() || 0) || 0;
                navOk = navResponse.ok?.() !== false && navStatus > 0 && navStatus < 400;
                navContentType = navResponse.headers?.()?.['content-type'] || 'text/plain';
            }
        }

        const challengeInfo = options.challengeInfo;
        if ((challengeInfo as AnyPage)?.primary?.behavior?.jsChallengeSolvable) {
            await waitForChallengeResolution(page, 10000);
        } else if (typeof page.waitForTimeout === 'function') {
            await page.waitForTimeout(300).catch(() => undefined);
        }

        const finalUrl: string = typeof page.url === 'function' ? page.url() : url;
        try {
            validateFetchUrl(finalUrl, { ...(options.allowPrivateNetwork != null ? { allowPrivateNetwork: options.allowPrivateNetwork } : {}) });
        } catch (error: unknown) {
            return {
                source: 'browser',
                label: 'browser-render',
                finalUrl,
                title: '',
                text: '',
                contentType: 'text/plain',
                status: 0,
                ok: false,
                metadata: null,
                evidence: ['browser-final-url-rejected'],
                warnings: [(error as AnyPage).code || 'browser-final-url-rejected'],
                networkCandidates,
            };
        }
        const title: string = typeof page.title === 'function' ? await page.title() : '';
        const text = await readVisibleText(page, options.selector);
        const markers = detectChallengeMarkers({ url: finalUrl, title, text, status: navStatus });
        const boundary = classifyAccessBoundary(markers);
        const statusBoundary = classifyBoundarySignals({ status: navStatus, text: `${title}\n${text}`, url: finalUrl }).verdict;
        const defuddle = await runDefuddleInPage(page);
        const defuddleCandidate: Record<string, unknown> | null = defuddle.parsed
            ? {
                source: 'browser',
                label: 'browser-defuddle',
                finalUrl,
                title: defuddle.parsed.title || title,
                text: defuddle.parsed.content || '',
                contentType: 'text/markdown',
                status: navStatus,
                ok: navOk && statusBoundary === null,
                metadata: defuddle.parsed.author || defuddle.parsed.published
                    ? { author: defuddle.parsed.author || '', published: defuddle.parsed.published || '' }
                    : null,
                evidence: ['browser-defuddle', navStatus ? `http-${navStatus}` : null].filter(Boolean),
                warnings: markers.map(marker => `marker:${marker.kind}`),
            }
            : null;
        return {
            source: 'browser',
            label: 'browser-render',
            finalUrl,
            title,
            text,
            contentType: navContentType,
            status: navStatus,
            ok: navOk && boundary === null && statusBoundary === null,
            metadata: null,
            evidence: [
                'browser-render',
                navStatus ? `http-${navStatus}` : null,
                boundary ? `boundary:${boundary}` : null,
                statusBoundary ? `status-boundary:${statusBoundary}` : null,
            ].filter(Boolean),
            warnings: [
                ...markers.map(marker => `marker:${marker.kind}`),
                ...(defuddle.reason ? [defuddle.reason] : []),
            ],
            networkCandidates,
            defuddleCandidate,
        };
    } finally {
        if (typeof page.off === 'function') page.off('response', onResponse);
        await closeFetchBrowserPage(pageRef);
    }
}

async function readVisibleText(page: AnyPage, selector: string | null | undefined): Promise<string> {
    if (selector && typeof page.locator === 'function') {
        const locator = page.locator(selector).first();
        return locator.innerText({ timeout: 2000 }).catch(() => '');
    }
    if (typeof page.evaluate === 'function') {
        return page.evaluate(() => document.body?.innerText || document.documentElement?.innerText || '');
    }
    return '';
}

export function collectNetworkJsonCandidates(browserResult: Record<string, unknown>): Record<string, unknown>[] {
    return Array.isArray(browserResult['networkCandidates']) ? browserResult['networkCandidates'] as Record<string, unknown>[] : [];
}

export function collectDefuddleCandidate(browserResult: Record<string, unknown> | null): Record<string, unknown> | null {
    return (browserResult?.['defuddleCandidate'] as Record<string, unknown> | undefined) || null;
}

async function waitForChallengeResolution(page: AnyPage, timeoutMs: number): Promise<boolean> {
    if (typeof page.evaluate !== 'function') return false;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const hasChallenge = await page.evaluate(() => {
            return !!document.querySelector('[id*="challenge"]') ||
                (document.title || '').includes('Just a moment');
        }).catch(() => false);
        if (!hasChallenge) return true;
        if (typeof page.waitForTimeout === 'function') {
            await page.waitForTimeout(500).catch(() => undefined);
        } else {
            await new Promise<void>(r => setTimeout(r, 500));
        }
    }
    return false;
}

function isTrackingEndpoint(url: string): boolean {
    return /analytics|tracking|telemetry|beacon|pixel|statsig|feature[-_]?flag|experiment|optimizely|launchdarkly|config|metrics|events?|collect|sentry|datadog|segment|braze|adservice|doubleclick|log\b/i.test(url);
}

function isAuthEndpoint(url: string): boolean {
    return /\/auth[\/\?]|\/login[\/\?]|\/token[\/\?]|\/session[\/\?]|\/oauth[\/\?]|\/signin[\/\?]/i.test(url);
}

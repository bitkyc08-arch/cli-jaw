// Parity catalog 102 (navigation-ready, upgraded P2→P1). Strict-TS port of agbrowse
// web-ai/navigation-ready.mjs. A stale CDP target can appear in /json/list but leave
// Playwright page APIs wedged after reconnect; the driveability guard treats such a
// target as non-reusable so send/query creates a fresh tab instead of hanging before
// the provider timeout applies. Pure helpers (isProviderUrl /
// shouldNavigateToRequestedProviderUrl) are fully unit-testable; the async guards use
// minimal structural page interfaces so a real Playwright Page is assignable.

const CONVERSATION_URL_PATTERN = /\/c\/[a-f0-9-]+/;
const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';

export const PROVIDER_HOSTS = new Set<string>([
    'chatgpt.com', 'chat.openai.com',
    'gemini.google.com',
    'grok.com',
]);

interface NavReadyLocator {
    first(): NavReadyLocator;
    waitFor(options?: { state?: string; timeout?: number }): Promise<unknown>;
    count(): Promise<number>;
}

export interface NavReadyPage {
    url(): string;
    locator(selector: string): NavReadyLocator;
    waitForTimeout(timeout: number): Promise<void>;
    waitForLoadState?(state?: string, options?: { timeout?: number }): Promise<void>;
    title?(): Promise<string>;
}

/**
 * Wait until the conversation DOM has settled: on a /c/<id> URL, wait for the first
 * assistant node to attach, then poll the assistant count until it is stable across
 * two reads (or an 8s deadline). Best-effort — never throws.
 */
export async function waitForConversationReady(page: NavReadyPage, url: string | null | undefined): Promise<void> {
    const finalUrl = page.url();
    const checkUrl = finalUrl || url;
    if (CONVERSATION_URL_PATTERN.test(checkUrl || '')) {
        await page.locator(ASSISTANT_SELECTOR).first()
            .waitFor({ state: 'attached', timeout: 10_000 })
            .catch(() => undefined);
    }
    let previous = -1;
    let stableReads = 0;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
        const count = await page.locator(ASSISTANT_SELECTOR).count().catch(() => 0);
        if (count === previous) stableReads++;
        else stableReads = 0;
        previous = count;
        if (stableReads >= 2) return;
        await page.waitForTimeout(500).catch(() => undefined);
    }
}

/** Resolve the page's URL, waiting for a load state first when it is not yet known. */
export async function waitForPageUrl(
    page: NavReadyPage,
    options: { timeoutMs?: number; state?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle' } = {},
): Promise<string> {
    const currentUrl = page?.url?.() || '';
    if (currentUrl) return currentUrl;
    await page?.waitForLoadState?.(options.state || 'domcontentloaded', {
        timeout: options.timeoutMs || 10_000,
    }).catch(() => undefined);
    return page?.url?.() || '';
}

/**
 * Decide whether a CDP-attached provider page is actually driveable (reusable) or a
 * stale/wedged target that must be replaced by a fresh tab. Returns false when the
 * page would need navigation to the requested URL, or when a bounded `title()` probe
 * fails/times out.
 */
export async function isProviderPageDriveable(
    page: NavReadyPage,
    requestedUrl: string | null | undefined,
    options: { urlTimeoutMs?: number; probeTimeoutMs?: number } = {},
): Promise<boolean> {
    const currentUrl = await waitForPageUrl(page, { timeoutMs: options.urlTimeoutMs || 2_000 });
    if (shouldNavigateToRequestedProviderUrl(currentUrl, requestedUrl)) return false;
    if (typeof page?.title !== 'function') return true;
    return withTimeout(
        page.title().then(() => true).catch(() => false),
        options.probeTimeoutMs || 2_000,
        false,
    );
}

export function isProviderUrl(url: string | null | undefined): boolean {
    if (!url) return false;
    try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        return PROVIDER_HOSTS.has(host);
    } catch {
        return false;
    }
}

/**
 * True when the current page must navigate to reach the requested provider URL:
 * blank/unknown page, different origin, different normalized path, or a requested
 * query string the current page lacks.
 */
export function shouldNavigateToRequestedProviderUrl(
    currentUrl: string | null | undefined,
    requestedUrl: string | null | undefined,
): boolean {
    if (!requestedUrl) return false;
    if (!currentUrl || currentUrl === 'about:blank') return true;
    try {
        const current = new URL(currentUrl);
        const requested = new URL(requestedUrl);
        if (current.href === requested.href) return false;
        if (current.origin !== requested.origin) return true;
        const currentPath = normalizeProviderPath(current.pathname);
        const requestedPath = normalizeProviderPath(requested.pathname);
        if (currentPath !== requestedPath) return true;
        return Boolean(requested.search) && current.search !== requested.search;
    } catch {
        return true;
    }
}

function normalizeProviderPath(pathname: string): string {
    return pathname === '' ? '/' : pathname;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((resolve) => {
                timer = setTimeout(() => resolve(fallback), Math.max(1, timeoutMs));
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

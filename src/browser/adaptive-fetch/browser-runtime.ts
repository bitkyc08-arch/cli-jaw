// Mirrored from agbrowse adaptive-fetch v2; keep runtime behavior aligned while cli-jaw mirror remains experimental.

export class BrowserRequiredError extends Error {
    code: string;
    constructor(message: string) {
        super(message);
        this.name = 'BrowserRequiredError';
        this.code = 'browser_required';
    }
}

interface PooledPage {
    page: unknown;
    cleanup: () => Promise<void>;
    isolated: boolean;
    returnedAt: number;
}

const warmPool: PooledPage[] = [];
const POOL_MAX = 3;
const POOL_TTL_MS = 30_000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanupTimer(): void {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
        const now = performance.now();
        while (warmPool.length > 0 && (now - (warmPool[0]?.returnedAt ?? 0)) > POOL_TTL_MS) {
            const expired = warmPool.shift();
            expired?.cleanup().catch(() => undefined);
        }
        if (warmPool.length === 0 && cleanupTimer) {
            clearInterval(cleanupTimer);
            cleanupTimer = null;
        }
    }, 10_000);
    if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
        (cleanupTimer as NodeJS.Timeout).unref();
    }
}

export async function getFetchBrowserPage(options: { browserDeps?: Record<string, unknown>; browserSession?: 'none' | 'isolated' | 'existing' } = {}): Promise<{ page: unknown; cleanup: () => Promise<void>; isolated: boolean }> {
    const deps = options.browserDeps || {};
    if (options.browserSession === 'none') {
        throw new BrowserRequiredError('browser session mode is none');
    }
    if (options.browserSession === 'existing') {
        if (typeof deps['getPage'] !== 'function') throw new BrowserRequiredError('browser getPage dependency is unavailable');
        return { page: await (deps['getPage'] as () => Promise<unknown>)(), cleanup: async () => undefined, isolated: false };
    }

    const warm = warmPool.pop();
    if (warm && (performance.now() - warm.returnedAt) < POOL_TTL_MS) {
        return { page: warm.page, cleanup: warm.cleanup, isolated: warm.isolated };
    }
    if (warm) {
        await warm.cleanup().catch(() => undefined);
    }

    if (typeof deps['createIsolatedPage'] === 'function') {
        return (deps['createIsolatedPage'] as () => Promise<{ page: unknown; cleanup: () => Promise<void>; isolated: boolean }>)();
    }
    throw new BrowserRequiredError('isolated browser page dependency is unavailable');
}

export async function releaseFetchBrowserPage(pageRef: { page?: unknown; cleanup?: () => Promise<void> | void; isolated?: boolean }): Promise<void> {
    if (!pageRef.cleanup) return;
    if (warmPool.length < POOL_MAX) {
        warmPool.push({
            page: pageRef.page ?? null,
            cleanup: pageRef.cleanup as () => Promise<void>,
            isolated: pageRef.isolated ?? true,
            returnedAt: performance.now(),
        });
        startCleanupTimer();
        return;
    }
    if (typeof pageRef.cleanup === 'function') await pageRef.cleanup();
}

export async function closeFetchBrowserPage(pageRef: { cleanup?: () => Promise<void> | void }): Promise<void> {
    if (typeof pageRef?.cleanup === 'function') await pageRef.cleanup();
}

export async function drainPool(): Promise<void> {
    while (warmPool.length > 0) {
        const page = warmPool.pop();
        if (page) await page.cleanup().catch(() => undefined);
    }
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
}

export function getPoolSize(): number {
    return warmPool.length;
}

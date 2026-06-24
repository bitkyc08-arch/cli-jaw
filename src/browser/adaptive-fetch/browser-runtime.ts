export class BrowserRequiredError extends Error {
    code: string;
    constructor(message: string) {
        super(message);
        this.name = 'BrowserRequiredError';
        this.code = 'browser_required';
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

    if (typeof deps['createIsolatedPage'] === 'function') {
        return (deps['createIsolatedPage'] as () => Promise<{ page: unknown; cleanup: () => Promise<void>; isolated: boolean }>)();
    }
    throw new BrowserRequiredError('isolated browser page dependency is unavailable');
}

export async function releaseFetchBrowserPage(pageRef: { page?: unknown; cleanup?: () => Promise<void> | void; isolated?: boolean }): Promise<void> {
    if (typeof pageRef.cleanup === 'function') await pageRef.cleanup();
}

export async function closeFetchBrowserPage(pageRef: { cleanup?: () => Promise<void> | void }): Promise<void> {
    if (typeof pageRef?.cleanup === 'function') await pageRef.cleanup();
}

export async function drainPool(): Promise<void> {
    // no-op: isolated page pooling removed for state isolation safety
}

export function getPoolSize(): number {
    return 0;
}

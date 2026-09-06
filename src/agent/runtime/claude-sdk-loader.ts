import type { query as QueryFactory } from '@anthropic-ai/claude-agent-sdk';

type SdkModule = { query: typeof QueryFactory };
type SdkImporter = () => Promise<unknown>;
const importSdk: SdkImporter = () => import('@anthropic-ai/claude-agent-sdk');
const pending = new WeakMap<SdkImporter, Promise<SdkModule>>();

/** Optional SDK absence affects native selection only. Failed loads remain retryable. */
export function loadClaudeSdk(importer: SdkImporter = importSdk): Promise<SdkModule> {
    const existing = pending.get(importer);
    if (existing) return existing;
    const loading = Promise.resolve().then(importer).then(mod => {
        if (!mod || typeof mod !== 'object' || !('query' in mod) || typeof mod.query !== 'function') {
            throw new Error('Selected Claude native SDK has no query export');
        }
        // The public export's callable shape is checked before exposing its SDK declaration.
        return { query: mod.query as typeof QueryFactory };
    }).catch(() => {
        pending.delete(importer);
        throw new Error('Claude native SDK unavailable; install the vetted optional dependency or select print');
    });
    pending.set(importer, loading);
    return loading;
}

import { createHash } from 'node:crypto';
import type { ConcreteCorpus, SearchQuery, SearchResultEnvelope, SearchWarning } from './contract.js';
import type { SearchProvider, SearchProviderRegistry } from './provider.js';

type ProviderCursorState = { offset: number; exhausted: boolean };
type CursorV1 = { v: 1; hash: string; providers: Record<string, ProviderCursorState> };
const CORPORA: ConcreteCorpus[] = ['chat', 'memory', 'wiki'];
const MAX_CURSOR_CHARS = 4096;
const MAX_CURSOR_PROVIDERS = 32;
const MAX_PROVIDER_ID_CHARS = 128;
const MAX_CURSOR_OFFSET = 1_000_000;
const invalidCursor = (): Error & { statusCode: number; code: string } =>
    Object.assign(new Error('invalid_cursor'), { statusCode: 400, code: 'invalid_cursor' });
// This SHA-256 binds a cursor to its query. It is not an HMAC or a tamper-resistance boundary.
const hashOf = (query: Omit<SearchQuery, 'cursor'>): string =>
    createHash('sha256').update(JSON.stringify(query)).digest('hex');

function decodeCursor(raw?: string): CursorV1 {
    if (!raw) return { v: 1, hash: '', providers: {} };
    try {
        if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw invalidCursor();
        // Bound the work before decoding: the cursor is client-supplied, and an
        // oversized payload otherwise buys unbounded decode/parse/traversal.
        if (raw.length > MAX_CURSOR_CHARS) throw invalidCursor();
        const decoded = Buffer.from(raw, 'base64url');
        if (decoded.toString('base64url') !== raw) throw invalidCursor();
        const value = JSON.parse(decoded.toString('utf8')) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidCursor();
        const row = value as Record<string, unknown>;
        if (row['v'] !== 1 || typeof row['hash'] !== 'string' ||
            !row['providers'] || typeof row['providers'] !== 'object' || Array.isArray(row['providers'])) {
            throw invalidCursor();
        }
        const providers = row['providers'] as Record<string, unknown>;
        const providerIds = Object.keys(providers);
        if (providerIds.length > MAX_CURSOR_PROVIDERS) throw invalidCursor();
        for (const id of providerIds) {
            if (id.length > MAX_PROVIDER_ID_CHARS) throw invalidCursor();
            const state = providers[id];
            if (!state || typeof state !== 'object' || Array.isArray(state)) throw invalidCursor();
            const item = state as Record<string, unknown>;
            // Number.isInteger(1e100) is true, so an absurd offset would sail
            // through and reach the provider as a SQL OFFSET.
            if (!Number.isSafeInteger(item['offset']) || Number(item['offset']) < 0 ||
                Number(item['offset']) > MAX_CURSOR_OFFSET ||
                typeof item['exhausted'] !== 'boolean') throw invalidCursor();
            for (const key of Object.keys(item)) {
                if (key !== 'offset' && key !== 'exhausted') throw invalidCursor();
            }
        }
        return row as CursorV1;
    } catch (error) {
        if ((error as { code?: string }).code === 'invalid_cursor') throw error;
        throw invalidCursor();
    }
}

const encodeCursor = (cursor: CursorV1): string =>
    Buffer.from(JSON.stringify(cursor)).toString('base64url');
const returnedCount = (page: SearchResultEnvelope): number =>
    page.groups.reduce((sum, group) => sum + group.hits.length, 0);
/**
 * Provider errors can carry SQL, filesystem paths, upstream bodies, or
 * credentials. Log the detail server-side; return a stable message.
 */
const failureWarning = (provider: SearchProvider, reason: unknown): SearchWarning => {
    console.error('[search:provider]', provider.id, reason instanceof Error ? reason.message : String(reason));
    return { code: 'provider_failed', provider: provider.id, message: 'search provider failed' };
};

export class SearchCoordinator {
    constructor(private readonly registry: SearchProviderRegistry) {}

    async search(input: SearchQuery): Promise<SearchResultEnvelope> {
        const query: SearchQuery = {
            ...input,
            query: input.query.trim(),
            limit: Math.min(input.limit ?? 20, 100),
        };
        if (!query.query) throw Object.assign(new Error('q is required'), { statusCode: 400 });
        const { cursor: _cursor, ...base } = query;
        const hash = hashOf(base);
        const cursor = decodeCursor(input.cursor);
        if (input.cursor && cursor.hash !== hash) throw invalidCursor();

        const requested = input.corpus === 'all' ? CORPORA : [input.corpus as ConcreteCorpus];
        const registered = input.corpus === 'all'
            ? this.registry.list() : this.registry.list(input.corpus as ConcreteCorpus);
        const missingWarnings: SearchWarning[] = requested
            .filter(corpus => !registered.some(provider => provider.corpus === corpus))
            .map(corpus => ({
                code: 'provider_failed', provider: corpus,
                message: `${corpus} search provider is not registered`,
            }));

        const states = { ...cursor.providers };
        // Every non-ready provider must be terminalized BEFORE hasMore is computed.
        // hasMore asks "is any registered provider unexhausted?", so a provider that
        // never appears in cursor state reads as unexhausted forever and offers a
        // next page that can never contain anything.
        const offProviders = registered.filter(provider => provider.status() === 'off');
        const erroredProviders = registered.filter(provider => provider.status() === 'error');
        for (const provider of [...offProviders, ...erroredProviders]) {
            states[provider.id] = { offset: 0, exhausted: true };
        }
        const ready = registered.filter(provider =>
            provider.status() === 'ready' && !cursor.providers[provider.id]?.exhausted);
        const perProvider = Math.max(1, Math.ceil((query.limit ?? 20) / Math.max(1, ready.length)));
        const settled = await Promise.allSettled(ready.map(provider => provider.search(query, {
            limit: perProvider,
            offset: cursor.providers[provider.id]?.offset ?? 0,
            ...(query.instances !== undefined ? { instanceIds: query.instances } : {}),
        })));
        const pages = settled.flatMap((result, index) => result.status === 'fulfilled'
            ? [{ provider: ready[index]!, page: result.value }] : []);
        const rejected = settled.flatMap((result, index) => result.status === 'rejected'
            ? [{ provider: ready[index]!, reason: result.reason }] : []);
        settled.forEach((result, index) => {
            const provider = ready[index]!;
            const previous = states[provider.id] ?? { offset: 0, exhausted: false };
            states[provider.id] = result.status === 'rejected'
                ? { ...previous, exhausted: true }
                : { offset: previous.offset + returnedCount(result.value), exhausted: !result.value.page.hasMore };
        });

        const hasMore = registered.some(provider => !states[provider.id]?.exhausted);
        return {
            query: base,
            groups: pages.flatMap(({ page }) => page.groups),
            warnings: [
                ...missingWarnings,
                ...rejected.map(({ provider, reason }) => failureWarning(provider, reason)),
                ...offProviders.map(provider => ({
                    code: 'provider_off' as const, provider: provider.id,
                    message: `${provider.corpus} search provider is disabled`,
                })),
                ...erroredProviders.map(provider => ({
                    code: 'provider_failed' as const, provider: provider.id,
                    message: 'search provider failed',
                })),
                ...pages.flatMap(({ page }) => page.warnings),
            ],
            page: { hasMore, nextCursor: hasMore ? encodeCursor({ v: 1, hash, providers: states }) : null },
            providers: [
                ...pages.flatMap(({ page }) => page.providers),
                ...rejected.map(({ provider }) => ({ id: provider.id, corpus: provider.corpus, status: 'error' as const })),
                ...offProviders.map(provider => ({ id: provider.id, corpus: provider.corpus, status: 'off' as const })),
                ...erroredProviders.map(provider => ({ id: provider.id, corpus: provider.corpus, status: 'error' as const })),
            ],
        };
    }
}

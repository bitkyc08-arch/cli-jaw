import type {
    ConcreteCorpus, ProviderStatus, SafeSearchFailureCode, SearchHit, SearchQuery,
    SearchResultEnvelope, SearchWarning,
} from './contract.js';

export type ProviderSearchOptions = {
    limit: number;
    offset: number;
    signal?: AbortSignal;
    instanceIds?: string[];
};

export interface SearchProvider {
    readonly id: string;
    readonly corpus: ConcreteCorpus;
    status(): ProviderStatus;
    safeFailureCode?(): SafeSearchFailureCode | null;
    search(query: SearchQuery, opts: ProviderSearchOptions): Promise<SearchResultEnvelope>;
}

export function providerEnvelope(
    provider: SearchProvider,
    query: SearchQuery,
    hits: SearchHit[],
    warnings: SearchWarning[] = [],
    hasMore = false,
): SearchResultEnvelope {
    const { cursor: _cursor, ...base } = query;
    return {
        query: base,
        groups: [{ corpus: provider.corpus, ranking: hits[0]?.ranking.mode ?? 'like', hits }],
        warnings,
        page: { nextCursor: null, hasMore },
        providers: [{ id: provider.id, corpus: provider.corpus, status: provider.status() }],
    };
}

export function createOffProvider(id: string, corpus: ConcreteCorpus): SearchProvider {
    const provider: SearchProvider = {
        id,
        corpus,
        status: () => 'off',
        async search(query) {
            return providerEnvelope(provider, query, [], [{
                code: 'provider_off', provider: id, message: `${corpus} search provider is disabled`,
            }]);
        },
    };
    return provider;
}

export class SearchProviderRegistry {
    private readonly providers = new Map<string, SearchProvider>();

    register(provider: SearchProvider): () => void {
        if (this.providers.has(provider.id)) {
            throw new Error(`duplicate search provider: ${provider.id}`);
        }
        this.providers.set(provider.id, provider);
        return () => {
            if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id);
        };
    }

    list(corpus?: ConcreteCorpus): SearchProvider[] {
        return [...this.providers.values()].filter(provider => !corpus || provider.corpus === corpus);
    }
}

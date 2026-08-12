export type SearchCorpus = 'chat' | 'memory' | 'wiki' | 'all';
export type ConcreteCorpus = Exclude<SearchCorpus, 'all'>;
export type ProviderStatus = 'ready' | 'off' | 'error';
export type SafeSearchFailureCode = 'notes_search_unavailable';
export type RankingMode = 'recency' | 'rrf' | 'bm25' | 'trigram' | 'like';

export type SearchWarning = {
    code: 'provider_off' | 'provider_failed' | 'engine_fallback' |
        'legacy_response' | 'invalid_cursor' | 'session_filter_ignored' |
        SafeSearchFailureCode;
    message: string;
    provider?: string;
    instanceId?: string;
};

export interface SearchQuery {
    query: string;
    corpus: SearchCorpus;
    sessionFilter?: string;
    instances?: string[];
    limit?: number;
    cursor?: string;
    days?: number;
    recent?: number;
    context?: number;
}

export interface SearchHit {
    corpus: ConcreteCorpus;
    provider: string;
    key: string;
    instance?: { id: string; label?: string | null; port?: number };
    session?: string;
    timestamp?: string;
    location?: { path?: string; startLine?: number; endLine?: number };
    snippet: string;
    ranking: { mode: RankingMode; sourceRank: number; sourceScore?: number };
    metadata?: Record<string, unknown>;
}

export interface SearchResultEnvelope {
    query: Omit<SearchQuery, 'cursor'>;
    groups: Array<{ corpus: ConcreteCorpus; ranking: RankingMode; hits: SearchHit[] }>;
    warnings: SearchWarning[];
    page: { nextCursor: string | null; hasMore: boolean };
    providers: Array<{ id: string; corpus: ConcreteCorpus; status: ProviderStatus }>;
}

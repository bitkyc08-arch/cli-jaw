import { searchIndexForProvider } from '../../memory/indexing.js';
import type { ProviderStatus, SearchHit, SearchQuery, SearchWarning } from '../contract.js';
import { providerEnvelope, type ProviderSearchOptions, type SearchProvider } from '../provider.js';

export class MemorySearchProvider implements SearchProvider {
    readonly id = 'local-memory';
    readonly corpus = 'memory' as const;

    constructor(private readonly enabled = true) {}

    status(): ProviderStatus {
        return this.enabled ? 'ready' : 'off';
    }

    async search(query: SearchQuery, opts: ProviderSearchOptions) {
        if (!this.enabled) {
            return providerEnvelope(this, query, [], [{
                code: 'provider_off', provider: this.id, message: 'memory search provider is disabled',
            }]);
        }

        const result = searchIndexForProvider(query.query, opts);
        const warnings: SearchWarning[] = [
            ...result.degraded.map(name => ({
                code: 'engine_fallback' as const,
                provider: this.id,
                message: `memory index degraded: ${name}`,
            })),
            ...(query.sessionFilter !== undefined ? [{
                code: 'session_filter_ignored' as const,
                provider: this.id,
                message: 'memory is shared; sessionFilter does not restrict memory results',
            }] : []),
        ];
        const hits: SearchHit[] = result.hits.map((hit, index) => ({
            corpus: 'memory',
            provider: this.id,
            key: `${hit.relpath}:${hit.source_start_line}`,
            ...(hit.sessionId ? { session: hit.sessionId } : {}),
            location: {
                path: hit.relpath || hit.path,
                startLine: hit.source_start_line,
                endLine: hit.source_end_line,
            },
            snippet: hit.snippet,
            ranking: {
                mode: 'rrf',
                sourceRank: opts.offset + index + 1,
                sourceScore: hit.score,
            },
            metadata: { kind: hit.kind, relpath: hit.relpath },
        }));
        return providerEnvelope(this, query, hits, warnings, result.hasMore);
    }
}

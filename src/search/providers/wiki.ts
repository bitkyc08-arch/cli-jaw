// ─── Wiki search provider (devlog 040 §9) ─────────────
// Reads the opt-in vault through the shared note search. Only search is reused: the
// link graph and vault index stay with the manager, because this provider needs neither.

import { searchNotes } from '../../notes/search.js';
import type { ProviderStatus, SearchHit, SearchQuery, SearchWarning } from '../contract.js';
import { providerEnvelope, type ProviderSearchOptions, type SearchProvider } from '../provider.js';
import { readWikiConfig, wikiProviderStatus, type WikiConfig } from '../../wiki/config.js';

// The shared note search refuses a request for more than this many results, so a page
// deep enough to ask for more would throw rather than return an empty tail. Wiki search
// therefore stops at that boundary and says so, instead of pretending a next page exists
// that it can never fetch (040 §0c R3).
export const WIKI_SEARCH_RESULT_CAP = 100;

export class WikiSearchProvider implements SearchProvider {
    readonly id = 'local-wiki';
    readonly corpus = 'wiki' as const;

    // The config is read per call rather than captured, because enabling the vault must
    // take effect without restarting the process that registered this provider.
    constructor(private readonly readConfig: () => WikiConfig = readWikiConfig) {}

    private config(): WikiConfig {
        try {
            return this.readConfig();
        } catch {
            // An unusable root is a configuration error, not a crash: status() reports it.
            return { enabled: false, root: '', promptDigest: false };
        }
    }

    status(): ProviderStatus {
        return wikiProviderStatus(this.config());
    }

    async search(query: SearchQuery, opts: ProviderSearchOptions) {
        const config = this.config();
        const status = wikiProviderStatus(config);
        if (status !== 'ready') {
            // A disabled vault performs no filesystem read at all, which is what makes
            // "off by default" mean something on disk and not just in the UI.
            return providerEnvelope(this, query, [], [{
                code: status === 'off' ? 'provider_off' : 'provider_failed',
                provider: this.id,
                message: status === 'off'
                    ? 'wiki search provider is disabled'
                    : 'wiki vault is unavailable',
            }]);
        }

        const warnings: SearchWarning[] = query.sessionFilter === undefined ? [] : [{
            code: 'session_filter_ignored',
            provider: this.id,
            message: 'the wiki is shared; sessionFilter does not restrict wiki results',
        }];

        // Ask for one more than this page needs so hasMore is observed rather than
        // guessed, but never ask the shared search for more than it accepts.
        const want = Math.min(opts.offset + opts.limit + 1, WIKI_SEARCH_RESULT_CAP);
        const rows = await searchNotes(config.root, query.query, { limit: want });
        const page = rows.slice(opts.offset, opts.offset + opts.limit);
        const hasMore = rows.length > opts.offset + opts.limit;
        if (!hasMore && rows.length >= WIKI_SEARCH_RESULT_CAP) {
            warnings.push({
                code: 'engine_fallback',
                provider: this.id,
                message: `wiki search stops at ${WIKI_SEARCH_RESULT_CAP} results`,
            });
        }

        const hits: SearchHit[] = page.map((row, index) => ({
            corpus: 'wiki' as const,
            provider: this.id,
            key: `${row.path}:${row.line}`,
            location: { path: row.path, startLine: row.line, endLine: row.line },
            snippet: row.context || row.content,
            ranking: { mode: 'like' as const, sourceRank: opts.offset + index },
            metadata: { kind: row.kind },
        }));

        return providerEnvelope(this, query, hits, warnings, hasMore);
    }
}

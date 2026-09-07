// ─── Wiki search provider ─────────────
// Reads the opt-in vault through the shared note search. Only search is reused: the
// link graph and vault index stay with the manager, because this provider needs neither.

import { searchNotes } from '../../notes/search.js';
import type { ProviderStatus, SafeSearchFailureCode, SearchHit, SearchQuery, SearchWarning } from '../contract.js';
import { providerEnvelope, type ProviderSearchOptions, type SearchProvider } from '../provider.js';
import { forbiddenWikiRoots, readUsableWikiConfig, wikiProviderHealth, type WikiConfig } from '../../wiki/config.js';

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
    // Reads the validated view rather than the raw one: the generic settings API can
    // write this block without going through the enable route, so a root that route
    // would have refused must not become readable by that back door.
    constructor(private readonly readConfig: () => WikiConfig = () => readUsableWikiConfig(forbiddenWikiRoots())) {}

    private config(): WikiConfig {
        try {
            return this.readConfig();
        } catch {
            // An unusable root is a configuration error, not a crash: status() reports it.
            return { enabled: false, root: '', promptDigest: false };
        }
    }

    private health(config: WikiConfig = this.config()) {
        return wikiProviderHealth(config);
    }

    status(): ProviderStatus {
        return this.health().status;
    }

    safeFailureCode(): SafeSearchFailureCode | null {
        return this.health().safeFailureCode ?? null;
    }

    async search(query: SearchQuery, opts: ProviderSearchOptions) {
        const config = this.config();
        const health = this.health(config);
        if (health.status !== 'ready') {
            // A disabled vault performs no filesystem read at all, which is what makes
            // "off by default" mean something on disk and not just in the UI.
            const warning = health.safeFailureCode === 'notes_search_unavailable'
                ? { code: 'notes_search_unavailable' as const, provider: this.id,
                    message: 'ripgrep (rg) is not installed' }
                : { code: health.status === 'off' ? 'provider_off' as const : 'provider_failed' as const,
                    provider: this.id,
                    message: health.status === 'off'
                        ? 'wiki search provider is disabled'
                        : 'wiki vault is unavailable' };
            return providerEnvelope(this, query, [], [warning]);
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

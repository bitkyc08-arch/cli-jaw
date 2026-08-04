import {
    searchChatCandidates,
    type ChatSearchCandidateEngine,
    type ChatSearchCandidateRow,
} from '../../core/db.js';
import type { ProviderStatus, RankingMode, SearchHit, SearchQuery, SearchWarning } from '../contract.js';
import { providerEnvelope, type ProviderSearchOptions, type SearchProvider } from '../provider.js';

const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const WHITESPACE_PATTERN = /\s/u;

function escapeLike(value: string): string {
    return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function ftsPhrase(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}

function toHits(rows: ChatSearchCandidateRow[], ranking: RankingMode, offset: number): SearchHit[] {
    return rows.map((row, index) => ({
        corpus: 'chat',
        provider: 'local-chat',
        key: String(row.id),
        session: row.session_id,
        timestamp: row.created_at,
        snippet: row.content,
        ranking: {
            mode: ranking,
            sourceRank: offset + index + 1,
            ...(typeof row.source_score === 'number' ? { sourceScore: row.source_score } : {}),
        },
        metadata: {
            role: row.role,
            cli: row.cli,
            match_field: row.match_field,
            tool_log: row.tool_log,
        },
    }));
}

export class ChatSearchProvider implements SearchProvider {
    readonly id = 'local-chat';
    readonly corpus = 'chat' as const;

    constructor(
        private readonly engine: 'fts5' | 'like' = 'like',
        private readonly enabled = true,
    ) {}

    status(): ProviderStatus {
        return this.enabled ? 'ready' : 'off';
    }

    async search(query: SearchQuery, opts: ProviderSearchOptions) {
        if (!this.enabled) {
            return providerEnvelope(this, query, [], [{
                code: 'provider_off', provider: this.id, message: 'chat search provider is disabled',
            }]);
        }

        const text = query.query.trim();
        const params = {
            match: ftsPhrase(text),
            like: escapeLike(text),
            session_id: query.sessionFilter ?? null,
            days: query.days ?? null,
            recent: query.recent ?? null,
            limit: opts.limit + 1,
            offset: opts.offset,
        };
        let candidateEngine: ChatSearchCandidateEngine = 'like';
        let ranking: RankingMode = 'like';
        let warnings: SearchWarning[] = [];
        let rows: ChatSearchCandidateRow[];

        if (this.engine === 'like' || Array.from(text).length < 3) {
            rows = searchChatCandidates('like', params);
        } else if (CJK_PATTERN.test(text)) {
            if (WHITESPACE_PATTERN.test(text)) {
                rows = searchChatCandidates('like', params);
            } else {
                candidateEngine = 'trigram';
                ranking = 'trigram';
                try {
                    rows = searchChatCandidates(candidateEngine, params);
                    if (rows.length === 0) {
                        candidateEngine = 'like';
                        ranking = 'like';
                        rows = searchChatCandidates(candidateEngine, params);
                    }
                } catch (error) {
                    candidateEngine = 'like';
                    ranking = 'like';
                    rows = searchChatCandidates(candidateEngine, params);
                    warnings = [{
                        code: 'engine_fallback',
                        provider: this.id,
                        message: `chat FTS unavailable; LIKE fallback used: ${error instanceof Error ? error.message : String(error)}`,
                    }];
                }
            }
        } else {
            candidateEngine = 'unicode61';
            ranking = 'bm25';
            try {
                rows = searchChatCandidates(candidateEngine, params);
            } catch (error) {
                candidateEngine = 'like';
                ranking = 'like';
                rows = searchChatCandidates(candidateEngine, params);
                warnings = [{
                    code: 'engine_fallback',
                    provider: this.id,
                    message: `chat FTS unavailable; LIKE fallback used: ${error instanceof Error ? error.message : String(error)}`,
                }];
            }
        }

        const selected = rows.slice(0, opts.limit);
        return providerEnvelope(this, query, toHits(selected, ranking, opts.offset), warnings,
            rows.length > selected.length);
    }
}

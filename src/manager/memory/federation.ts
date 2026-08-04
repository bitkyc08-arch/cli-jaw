import { searchIndexReadOnly } from '../../memory/indexing.js';
import { listSearchableInstances } from './instance-discovery.js';
import { rerankAcrossInstances } from './result-rerank.js';
import { searchChatFederatedEnriched } from './chat-federation.js';
import type { SearchHit } from '../../memory/shared.js';
import type { SearchQuery, SearchResultEnvelope, SearchWarning } from '../../search/contract.js';
import type {
    FederatedSearchResult,
    FederationWarning,
    InstanceMemoryRef,
} from './types.js';

export interface FederatedSearchOptions {
    instanceFilter?: string[];
    perInstanceLimit?: number;
    globalLimit?: number;
    instances?: InstanceMemoryRef[];
}

export interface FederatedEnvelopeSearchOptions {
    instances: InstanceMemoryRef[];
    instanceFilter?: string[];
    limit?: number;
    days?: number;
    sessionFilter?: string;
}

export function searchFederated(query: string, opts: FederatedSearchOptions = {}): FederatedSearchResult {
    const trimmed = String(query || '').trim();
    if (!trimmed) return { hits: [], warnings: [], instancesQueried: 0, instancesSucceeded: 0 };

    const all = opts.instances ?? listSearchableInstances();
    const filter = opts.instanceFilter;
    const filtered = filter?.length ? all.filter(r => filter.includes(r.instanceId)) : all;

    const warnings: FederationWarning[] = [];
    const perInstanceHits: Array<{ ref: InstanceMemoryRef; hits: SearchHit[] }> = [];
    let succeeded = 0;

    for (const ref of filtered) {
        if (!ref.hasDb) {
            warnings.push({
                instanceId: ref.instanceId,
                code: 'missing_db',
                message: `No index.sqlite at ${ref.dbPath}`,
            });
            continue;
        }
        try {
            const { hits, degraded } = searchIndexReadOnly(ref.dbPath, trimmed);
            if (degraded.length) {
                warnings.push({
                    instanceId: ref.instanceId,
                    code: 'schema_mismatch',
                    message: `Older schema: degraded ${degraded.join(', ')}`,
                    detail: { degraded },
                });
            }
            perInstanceHits.push({ ref, hits });
            succeeded++;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const code: FederationWarning['code'] =
                /NODE_MODULE_VERSION/.test(msg) ? 'native_module_mismatch'
                : /malformed|corrupt/i.test(msg) ? 'corrupt'
                : /unable to open/i.test(msg) ? 'open_failed'
                : 'query_failed';
            warnings.push({ instanceId: ref.instanceId, code, message: msg });
        }
    }

    const reranked = rerankAcrossInstances(perInstanceHits, {
        perInstanceLimit: opts.perInstanceLimit ?? 10,
        globalLimit: opts.globalLimit ?? 50,
    });

    return {
        hits: reranked,
        warnings,
        instancesQueried: filtered.length,
        instancesSucceeded: succeeded,
    };
}

export function searchFederatedEnvelope(
    query: string,
    opts: FederatedEnvelopeSearchOptions,
): SearchResultEnvelope {
    const trimmed = String(query || '').trim();
    const limit = opts.limit ?? 50;
    const chatOpts: import('./chat-federation.js').EnrichedChatFederatedSearchOptions = {
        instances: opts.instances,
        limit,
    };
    if (opts.instanceFilter !== undefined) chatOpts.instanceFilter = opts.instanceFilter;
    if (opts.days !== undefined) chatOpts.days = opts.days;
    if (opts.sessionFilter !== undefined) chatOpts.sessionFilter = opts.sessionFilter;

    const result = searchChatFederatedEnriched(trimmed, chatOpts);
    const warnings: SearchWarning[] = [];
    const providers: SearchResultEnvelope['providers'] = [];

    for (const peer of result.peers) {
        const provider = `instance:${peer.ref.instanceId}:chat`;
        const degradedSchema = peer.warning?.code === 'schema_mismatch' &&
            peer.warning.detail?.missing?.includes('messages.tool_log');
        const fatalWarning = peer.warning && !degradedSchema;
        const sessionUnsupported = opts.sessionFilter !== undefined &&
            !peer.hasSessionId && !fatalWarning;
        const status = sessionUnsupported || fatalWarning ? 'error' : 'ready';
        providers.push({ id: provider, corpus: 'chat', status });

        if (fatalWarning) {
            warnings.push({
                code: 'provider_failed',
                provider,
                instanceId: peer.ref.instanceId,
                message: `${peer.ref.instanceId}: chat search provider failed (${peer.warning!.code})`,
            });
            continue;
        }
        if (sessionUnsupported) {
            warnings.push({
                code: 'legacy_response',
                provider,
                instanceId: peer.ref.instanceId,
                message: `${peer.ref.instanceId}: session filtering unsupported on this instance`,
            });
            continue;
        }
        if (!peer.hasSessionId || peer.warning?.code === 'schema_mismatch') {
            warnings.push({
                code: 'legacy_response',
                provider,
                instanceId: peer.ref.instanceId,
                message: `${peer.ref.instanceId}: legacy chat schema does not provide full search provenance`,
            });
        }
    }

    const merged = result.hits;
    const selected = merged.slice(0, limit);
    const refsByInstance = new Map(result.peers.map(peer => [peer.ref.instanceId, peer.ref] as const));
    const hits = selected.map((row, index) => {
        const provider = `instance:${row.instanceId}:chat`;
        return {
            corpus: 'chat' as const,
            provider,
            key: String(row.id),
            instance: {
                id: row.instanceId,
                label: row.instanceLabel,
                port: refsByInstance.get(row.instanceId)!.port,
            },
            ...(row.session_id !== undefined ? { session: row.session_id } : {}),
            timestamp: row.created_at,
            snippet: row.content,
            ranking: { mode: 'recency' as const, sourceRank: index + 1 },
            metadata: {
                role: row.role,
                cli: row.cli,
                match_field: row.match_field,
            },
        };
    });
    const baseQuery: Omit<SearchQuery, 'cursor'> = {
        query: trimmed,
        corpus: 'chat',
        limit,
    };
    if (opts.instanceFilter !== undefined) baseQuery.instances = opts.instanceFilter;
    if (opts.days !== undefined) baseQuery.days = opts.days;
    if (opts.sessionFilter !== undefined) baseQuery.sessionFilter = opts.sessionFilter;

    return {
        query: baseQuery,
        groups: [{ corpus: 'chat', ranking: 'recency', hits }],
        warnings,
        page: {
            nextCursor: null,
            hasMore: merged.length > limit || result.peers.some(peer => peer.truncated),
        },
        providers,
    };
}

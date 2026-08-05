import Database from 'better-sqlite3';
import type {
    InstanceMemoryRef,
    ChatSearchHit,
    ChatFederatedResult,
    FederationWarning,
} from './types.js';

interface ChatColumnInfo {
    hasToolLog: boolean;
    hasSessionId: boolean;
}

function probeSchema(db: Database.Database): ChatColumnInfo | null {
    try {
        const rows = db.pragma('table_info(messages)') as Array<{ name: string }>;
        if (!rows.length) return null;
        const cols = new Set(rows.map(r => r.name));
        if (!cols.has('content')) return null;
        return {
            hasToolLog: cols.has('tool_log'),
            hasSessionId: cols.has('session_id'),
        };
    } catch {
        return null;
    }
}

type EnrichedChatRow = ChatSearchHit & { session_id?: string };

interface SearchInstanceOptions {
    limit: number;
    resultLimit?: number;
    days?: number;
    sessionFilter?: string;
}

interface EnrichedInstanceResult {
    hits: EnrichedChatRow[];
    warning?: FederationWarning;
    hasSessionId: boolean;
    truncated: boolean;
}

function queryInstance(
    ref: InstanceMemoryRef,
    query: string,
    opts: SearchInstanceOptions,
    enriched: boolean,
): EnrichedInstanceResult {
    let db: Database.Database;
    try {
        db = new Database(ref.chatDbPath, { readonly: true, fileMustExist: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code: FederationWarning['code'] =
            /NODE_MODULE_VERSION/.test(msg) ? 'native_module_mismatch'
            : /unable to open/i.test(msg) ? 'open_failed'
            : 'open_failed';
        return {
            hits: [],
            warning: { instanceId: ref.instanceId, code, message: msg },
            hasSessionId: false,
            truncated: false,
        };
    }

    try {
        const schema = probeSchema(db);
        if (!schema) {
            return {
                hits: [],
                warning: {
                    instanceId: ref.instanceId,
                    code: 'schema_mismatch',
                    message: 'messages table missing or no content column',
                    detail: { missing: ['messages.content'] },
                },
                hasSessionId: false,
                truncated: false,
            };
        }

        if (enriched && opts.sessionFilter !== undefined && !schema.hasSessionId) {
            return { hits: [], hasSessionId: false, truncated: false };
        }

        let warning: FederationWarning | undefined;
        if (!schema.hasToolLog) {
            warning = {
                instanceId: ref.instanceId,
                code: 'schema_mismatch',
                message: 'tool_log column missing — content-only search',
                detail: { missing: ['messages.tool_log'] },
            };
        }

        const words = query.split(/\s+/).filter(w => w.length >= 2).slice(0, 5);
        if (!words.length) {
            return { hits: [], hasSessionId: schema.hasSessionId, truncated: false };
        }
        const conditions: string[] = [];
        const params: Record<string, unknown> = { limit: opts.limit };

        const escapeLike = (s: string) => s.replace(/%/g, '\\%').replace(/_/g, '\\_');
        const likeParts: string[] = [];
        words.forEach((w, i) => {
            const key = `w${i}`;
            params[key] = `%${escapeLike(w)}%`;
            if (schema.hasToolLog) {
                likeParts.push(`(content LIKE @${key} ESCAPE '\\' OR tool_log LIKE @${key} ESCAPE '\\')`);
            } else {
                likeParts.push(`content LIKE @${key} ESCAPE '\\'`);
            }
        });
        conditions.push(`(${likeParts.join(' OR ')})`);

        if (opts.days && opts.days > 0) {
            conditions.push("created_at >= datetime('now', @daysOffset)");
            params['daysOffset'] = `-${opts.days} days`;
        }
        if (enriched && opts.sessionFilter !== undefined) {
            conditions.push('session_id = @sessionFilter');
            params['sessionFilter'] = opts.sessionFilter;
        }

        const where = conditions.join(' AND ');
        const matchField = schema.hasToolLog
            ? `CASE WHEN tool_log LIKE @w0 ESCAPE '\\' THEN 'tool_log' ELSE 'content' END`
            : "'content'";

        const sessionProjection = enriched && schema.hasSessionId ? ', session_id' : '';
        const sql = `SELECT id, role, content, cli, created_at, ${matchField} as match_field${sessionProjection}
            FROM messages
            WHERE ${where}
            ORDER BY created_at DESC
            LIMIT @limit`;

        const rows = db.prepare(sql).all(params) as Array<{
            id: number; role: string; content: string;
            cli: string | null; created_at: string; match_field: string;
            session_id?: string;
        }>;

        const truncated = opts.resultLimit !== undefined && rows.length > opts.resultLimit;
        const selectedRows = truncated ? rows.slice(0, opts.resultLimit) : rows;
        const result: EnrichedInstanceResult = {
            hits: selectedRows.map(r => ({
                id: r.id,
                role: r.role,
                content: r.content,
                cli: r.cli,
                created_at: r.created_at,
                match_field: r.match_field as 'content' | 'tool_log',
                instanceId: ref.instanceId,
                instanceLabel: ref.label,
                ...(enriched && schema.hasSessionId && typeof r.session_id === 'string'
                    ? { session_id: r.session_id }
                    : {}),
            })),
            hasSessionId: schema.hasSessionId,
            truncated,
        };
        if (warning) result.warning = warning;
        return result;
    } catch (err) {
        return {
            hits: [],
            warning: {
                instanceId: ref.instanceId,
                code: 'query_failed',
                message: err instanceof Error ? err.message : String(err),
            },
            hasSessionId: false,
            truncated: false,
        };
    } finally {
        db.close();
    }
}

function searchInstance(
    ref: InstanceMemoryRef,
    query: string,
    opts: { limit: number; days?: number },
): { hits: ChatSearchHit[]; warning?: FederationWarning } {
    const result = queryInstance(ref, query, opts, false);
    const legacy: { hits: ChatSearchHit[]; warning?: FederationWarning } = { hits: result.hits };
    if (result.warning) legacy.warning = result.warning;
    return legacy;
}

export function searchInstanceEnriched(
    ref: InstanceMemoryRef,
    query: string,
    opts: SearchInstanceOptions,
): EnrichedInstanceResult {
    return queryInstance(ref, query, {
        ...opts,
        limit: opts.limit + 1,
        resultLimit: opts.limit,
    }, true);
}

export interface ChatFederatedSearchOptions {
    instances: InstanceMemoryRef[];
    instanceFilter?: string[];
    limit?: number;
    days?: number;
}

export interface EnrichedChatFederatedSearchOptions extends ChatFederatedSearchOptions {
    sessionFilter?: string;
}

export interface EnrichedChatPeerResult extends EnrichedInstanceResult {
    ref: InstanceMemoryRef;
}

export interface EnrichedChatFederatedResult {
    hits: EnrichedChatRow[];
    peers: EnrichedChatPeerResult[];
    instancesQueried: number;
    instancesSucceeded: number;
}

function selectTargets(opts: ChatFederatedSearchOptions): InstanceMemoryRef[] {
    const filter = opts.instanceFilter;
    return filter?.length
        ? opts.instances.filter(ref => filter.includes(ref.instanceId))
        : opts.instances;
}

export function searchChatFederated(
    query: string,
    opts: ChatFederatedSearchOptions,
): ChatFederatedResult {
    const trimmed = String(query || '').trim();
    if (!trimmed) return { hits: [], warnings: [], instancesQueried: 0, instancesSucceeded: 0 };

    const targets = selectTargets(opts);

    const limit = opts.limit ?? 50;
    const perInstanceLimit = Math.max(10, Math.ceil(limit / Math.max(1, targets.length)) * 2);
    const warnings: FederationWarning[] = [];
    const allHits: ChatSearchHit[] = [];
    let succeeded = 0;

    for (const ref of targets) {
        if (!ref.hasChatDb) {
            warnings.push({
                instanceId: ref.instanceId,
                code: 'missing_db',
                message: `No jaw.db at ${ref.chatDbPath}`,
            });
            continue;
        }

        const searchOpts: { limit: number; days?: number } = { limit: perInstanceLimit };
        if (opts.days != null) searchOpts.days = opts.days;
        const result = searchInstance(ref, trimmed, searchOpts);
        if (result.warning) warnings.push(result.warning);
        if (result.hits.length > 0) {
            allHits.push(...result.hits);
            succeeded++;
        } else if (!result.warning) {
            succeeded++;
        }
    }

    allHits.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const trimmedHits = allHits.slice(0, limit);

    return {
        hits: trimmedHits,
        warnings,
        instancesQueried: targets.length,
        instancesSucceeded: succeeded,
    };
}

export function searchChatFederatedEnriched(
    query: string,
    opts: EnrichedChatFederatedSearchOptions,
): EnrichedChatFederatedResult {
    const trimmed = String(query || '').trim();
    if (!trimmed) return { hits: [], peers: [], instancesQueried: 0, instancesSucceeded: 0 };

    const targets = selectTargets(opts);
    const limit = opts.limit ?? 50;
    const perInstanceLimit = Math.max(10, Math.ceil(limit / Math.max(1, targets.length)) * 2);
    const peers: EnrichedChatPeerResult[] = [];
    const allHits: EnrichedChatRow[] = [];
    let succeeded = 0;

    for (const ref of targets) {
        if (!ref.hasChatDb) {
            peers.push({
                ref,
                hits: [],
                warning: {
                    instanceId: ref.instanceId,
                    code: 'missing_db',
                    message: `No jaw.db at ${ref.chatDbPath}`,
                },
                hasSessionId: false,
                truncated: false,
            });
            continue;
        }

        const searchOpts: SearchInstanceOptions = { limit: perInstanceLimit };
        if (opts.days != null) searchOpts.days = opts.days;
        if (opts.sessionFilter !== undefined) searchOpts.sessionFilter = opts.sessionFilter;
        const result = searchInstanceEnriched(ref, trimmed, searchOpts);
        peers.push({ ref, ...result });
        if (result.hits.length > 0) {
            succeeded++;
        } else if (!result.warning && !(opts.sessionFilter !== undefined && !result.hasSessionId)) {
            succeeded++;
        }
        allHits.push(...result.hits);
    }

    allHits.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return {
        hits: allHits,
        peers,
        instancesQueried: targets.length,
        instancesSucceeded: succeeded,
    };
}

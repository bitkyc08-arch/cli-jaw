import type { SearchHit } from '../../memory/shared.js';

export interface InstanceMemoryRef {
    instanceId: string;
    homePath: string;
    homeSource: 'profile' | 'default-port';
    port: number;
    label: string | null;
    dbPath: string;
    hasDb: boolean;
    chatDbPath: string;
    hasChatDb: boolean;
    /** How this ref entered the list. `registry` entries are operator-declared and
     *  survive being offline; `scan` entries only appear while the port answers.
     *  federation uses it to decide whether a missing index is worth a warning (#436). */
    origin: 'registry' | 'scan';
}

export interface FederatedHit extends SearchHit {
    instanceId: string;
    instanceLabel: string | null;
    instancePort: number;
    rrfScore: number;
}

export interface FederationWarning {
    instanceId: string;
    code:
        | 'missing_db'
        | 'open_failed'
        | 'query_failed'
        | 'corrupt'
        | 'native_module_mismatch'
        | 'schema_mismatch';
    message: string;
    detail?: { missing?: string[]; degraded?: string[] };
}

export interface FederatedSearchResult {
    hits: FederatedHit[];
    warnings: FederationWarning[];
    instancesQueried: number;
    instancesSucceeded: number;
}

export interface ChatSearchHit {
    id: number;
    role: string;
    content: string;
    cli: string | null;
    created_at: string;
    match_field: 'content' | 'tool_log';
    instanceId: string;
    instanceLabel: string | null;
}

export interface ChatFederatedResult {
    hits: ChatSearchHit[];
    warnings: FederationWarning[];
    instancesQueried: number;
    instancesSucceeded: number;
}

export interface ScanItemForFederation {
    port: number;
    profileId?: string | null;
    homeDisplay?: string | null;
    /** True only for an instance that answered. Offline/timeout rows must not
     *  become federation entries (#436). */
    ok?: boolean;
}

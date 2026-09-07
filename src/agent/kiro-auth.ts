import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export interface KiroProfile {
    arn: string;
    name?: string;
}

export interface KiroSocialToken {
    accessToken: string;
    profileArn?: string;
}

function readKv(db: Database.Database, table: 'auth_kv' | 'state', key: string): string | null {
    try {
        const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key) as { value?: Buffer | string } | undefined;
        if (!row?.value) return null;
        return typeof row.value === 'string' ? row.value : row.value.toString('utf8');
    } catch {
        return null;
    }
}

export function resolveKiroDataPath(homedir = os.homedir()): string {
    const override = process.env['KIRO_CLI_DATA_DIR']?.trim();
    if (override) return join(override, 'data.sqlite3');

    if (process.platform === 'darwin') {
        return join(homedir, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3');
    }
    if (process.platform === 'win32') {
        const appData = process.env['APPDATA'] || join(homedir, 'AppData', 'Roaming');
        return join(appData, 'kiro-cli', 'data.sqlite3');
    }
    return join(homedir, '.local', 'share', 'kiro-cli', 'data.sqlite3');
}

export function readKiroAuthFromStore(dataPath = resolveKiroDataPath()): {
    token: KiroSocialToken | null;
    profile: KiroProfile | null;
} {
    if (!fs.existsSync(dataPath)) {
        return { token: null, profile: null };
    }

    let db: Database.Database | null = null;
    try {
        db = new Database(dataPath, { readonly: true, fileMustExist: true });
        const tokenRaw = readKv(db, 'auth_kv', 'kirocli:social:token');
        const profileRaw = readKv(db, 'state', 'api.codewhisperer.profile');

        const token = parseKiroSocialToken(tokenRaw);
        const profile = parseKiroProfile(profileRaw);
        return { token, profile };
    } catch {
        return { token: null, profile: null };
    } finally {
        try {
            db?.close();
        } catch { /* ignore */ }
    }
}

function parseKiroSocialToken(raw: string | null): KiroSocialToken | null {
    if (!raw?.trim()) return null;
    try {
        const data = JSON.parse(raw) as Record<string, unknown>;
        const accessToken = typeof data['access_token'] === 'string'
            ? data['access_token']
            : typeof data['accessToken'] === 'string'
                ? data['accessToken']
                : '';
        if (!accessToken.trim()) return null;
        const profileArn = typeof data['profileArn'] === 'string'
            ? data['profileArn']
            : typeof data['profile_arn'] === 'string'
                ? data['profile_arn']
                : undefined;
        return profileArn
            ? { accessToken, profileArn }
            : { accessToken };
    } catch {
        return null;
    }
}

function parseKiroProfile(raw: string | null): KiroProfile | null {
    if (!raw?.trim()) return null;
    try {
        const data = JSON.parse(raw) as Record<string, unknown>;
        const arn = typeof data['arn'] === 'string' ? data['arn'] : '';
        if (!arn.trim()) return null;
        const name = typeof data['name'] === 'string' ? data['name'] : undefined;
        return name ? { arn, name } : { arn };
    } catch {
        return null;
    }
}

export function resolveKiroProfileArn(
    token: KiroSocialToken | null,
    profile: KiroProfile | null,
): string | null {
    return profile?.arn || token?.profileArn || null;
}

export function regionFromProfileArn(profileArn: string): string {
    const parts = profileArn.split(':');
    return parts[3] || 'us-east-1';
}

/**
 * kiro-cli persists `chat --no-interactive` sessions in the v2 store
 * (`conversations_v2`), keyed by the canonical (realpath-resolved) cwd —
 * NOT in the legacy `~/.kiro/sessions/cli/*.json` file store. Resume only
 * works if we read the id back from the store kiro-cli actually writes to.
 */
function kiroCwdKeys(cwd: string): string[] {
    const raw = cwd.trim();
    const keys = new Set<string>();
    if (raw) {
        keys.add(raw);
        try { keys.add(fs.realpathSync(raw)); } catch { /* cwd may not exist yet */ }
    }
    return [...keys];
}

/** Snapshot conversation ids for a cwd before a fresh kiro-cli spawn. */
export function listKiroConversationIdsForCwd(
    cwd: string,
    dataPath = resolveKiroDataPath(),
): Set<string> {
    const ids = new Set<string>();
    if (!fs.existsSync(dataPath)) return ids;
    const keys = kiroCwdKeys(cwd);
    if (keys.length === 0) return ids;

    let db: Database.Database | null = null;
    try {
        db = new Database(dataPath, { readonly: true, fileMustExist: true });
        const placeholders = keys.map(() => '?').join(',');
        const rows = db.prepare(
            `SELECT conversation_id FROM conversations_v2 WHERE key IN (${placeholders})`,
        ).all(...keys) as { conversation_id?: string }[];
        for (const row of rows) {
            if (row.conversation_id?.trim()) ids.add(row.conversation_id.trim());
        }
    } catch {
        return ids;
    } finally {
        try { db?.close(); } catch { /* ignore */ }
    }
    return ids;
}

function pickNewestKiroConversationId(
    cwd: string,
    conversationIds: string[],
    updatedAfterMs: number,
    dataPath: string,
): string | null {
    if (conversationIds.length === 0) return null;
    if (!fs.existsSync(dataPath)) return conversationIds[0] ?? null;
    const keys = kiroCwdKeys(cwd);
    if (keys.length === 0) return conversationIds[0] ?? null;

    let db: Database.Database | null = null;
    try {
        db = new Database(dataPath, { readonly: true, fileMustExist: true });
        const keyPh = keys.map(() => '?').join(',');
        const idPh = conversationIds.map(() => '?').join(',');
        const row = db.prepare(
            `SELECT conversation_id AS id FROM conversations_v2
             WHERE key IN (${keyPh}) AND conversation_id IN (${idPh}) AND updated_at >= ?
             ORDER BY updated_at DESC LIMIT 1`,
        ).get(...keys, ...conversationIds, updatedAfterMs) as { id?: string } | undefined;
        return row?.id ?? conversationIds[0] ?? null;
    } catch {
        return conversationIds[0] ?? null;
    } finally {
        try { db?.close(); } catch { /* ignore */ }
    }
}

/**
 * After a **fresh** `--no-interactive` spawn, resolve the conversation id kiro-cli
 * created for this cwd. Prefer set-diff over "latest row" to avoid cross-dispatch races.
 */
export type KiroSpawnIdResolution =
    | { kind: 'exact'; id: string }
    | { kind: 'none' }
    // More than one conversation appeared under this working directory while we were
    // running, so the store cannot say which one is ours. Picking the newest would hand
    // one session another session's conversation, and nothing downstream could detect
    // that — so ambiguity ends the search rather than guessing.
    | { kind: 'ambiguous'; candidates: readonly string[] };

export function resolveKiroSpawnIdentity(
    cwd: string,
    beforeIds: ReadonlySet<string>,
    updatedAfterMs = 0,
    dataPath = resolveKiroDataPath(),
): KiroSpawnIdResolution {
    const afterIds = listKiroConversationIdsForCwd(cwd, dataPath);
    const novel = [...afterIds].filter((id) => !beforeIds.has(id));
    if (novel.length === 1 && novel[0]) return { kind: 'exact', id: novel[0] };
    if (novel.length > 1) return { kind: 'ambiguous', candidates: novel };
    const stored = extractKiroSessionIdFromV2Store(cwd, updatedAfterMs, dataPath);
    return stored ? { kind: 'exact', id: stored } : { kind: 'none' };
}

export function resolveKiroSessionIdAfterSpawn(
    cwd: string,
    beforeIds: ReadonlySet<string>,
    updatedAfterMs = 0,
    dataPath = resolveKiroDataPath(),
): string | null {
    const afterIds = listKiroConversationIdsForCwd(cwd, dataPath);
    const novel = [...afterIds].filter((id) => !beforeIds.has(id));
    if (novel.length === 1) return novel[0] ?? null;
    if (novel.length > 1) {
        return pickNewestKiroConversationId(cwd, novel, updatedAfterMs, dataPath);
    }
    return extractKiroSessionIdFromV2Store(cwd, updatedAfterMs, dataPath);
}

export function extractKiroSessionIdFromV2Store(
    cwd: string,
    updatedAfterMs = 0,
    dataPath = resolveKiroDataPath(),
): string | null {
    if (!fs.existsSync(dataPath)) return null;
    const keys = kiroCwdKeys(cwd);
    if (keys.length === 0) return null;

    let db: Database.Database | null = null;
    try {
        db = new Database(dataPath, { readonly: true, fileMustExist: true });
        const placeholders = keys.map(() => '?').join(',');
        const row = db.prepare(
            `SELECT conversation_id AS id FROM conversations_v2
             WHERE key IN (${placeholders}) AND updated_at >= ?
             ORDER BY updated_at DESC LIMIT 1`,
        ).get(...keys, updatedAfterMs) as { id?: string } | undefined;
        return row?.id ?? null;
    } catch {
        return null;
    } finally {
        try { db?.close(); } catch { /* ignore */ }
    }
}

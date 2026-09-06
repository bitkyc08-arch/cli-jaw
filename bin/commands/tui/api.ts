/**
 * API helpers shared across TUI modules.
 */
import { APP_VERSION } from '../../../src/core/config.js';
import { getCliAuthToken, authHeaders } from '../../../src/cli/api-auth.js';
import { cliColor, cliLabel, c, type TuiContext } from './types.js';
import { homedir } from 'node:os';
import { asRecord, fieldString, type JsonRecord } from '../../_http-client.js';
import { parseActivityIdentity } from '../../../src/shared/presentation.js';
import { activityHttpRead } from './activity-http.js';

type TuiApiInit = Omit<RequestInit, 'body' | 'headers'> & {
    body?: unknown;
    headers?: Record<string, string>;
};

export async function apiJson<T = JsonRecord>(ctx: Pick<TuiContext, 'apiUrl'>, path: string, init: TuiApiInit = {}, timeoutMs = 10000): Promise<T> {
    const headers: Record<string, string> = { ...authHeaders(), ...(init.headers || {}) };
    const { body: initBody, headers: _headers, ...rest } = init;
    const timeout = AbortSignal.timeout(timeoutMs);
    const req: RequestInit = { ...rest, headers, signal: rest.signal ? AbortSignal.any([rest.signal, timeout]) : timeout };
    if (initBody !== undefined && typeof initBody !== 'string') {
        req.body = JSON.stringify(initBody);
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    } else if (typeof initBody === 'string') {
        req.body = initBody;
    }
    const resp = await fetch(`${ctx.apiUrl}${path}`, req);
    const data = asRecord(await resp.json().catch(() => ({})));
    if (!resp.ok) {
        const msg = fieldString(data["error"]) || fieldString(data["message"]) || `${resp.status} ${resp.statusText}`;
        throw new Error(msg);
    }
    return data as T;
}

/** No inferred local/default session: old or unavailable servers stay unbound. */
export async function refreshActivityIdentity(
    ctx: Pick<TuiContext, 'apiUrl' | 'activityIdentity' | 'activitySettlementIdentity' | 'activityIdentityGeneration'
        | 'activityActiveRunId' | 'onActivityIdentityChanged' | 'isRaw'>,
): Promise<void> {
    const generation = (ctx.activityIdentityGeneration ?? 0) + 1;
    ctx.activityIdentityGeneration = generation;
    if (ctx.activityIdentity) ctx.activitySettlementIdentity = ctx.activityIdentity;
    ctx.activityIdentity = null;
    if (ctx.isRaw) return;
    try {
        const response = asRecord(await activityHttpRead(ctx)('/api/orchestrate/snapshot', AbortSignal.timeout(2000)));
        if (ctx.activityIdentityGeneration !== generation) return;
        const snapshot = asRecord(response['data'] ?? response);
        const previous = ctx.activitySettlementIdentity ?? null;
        ctx.activityIdentity = parseActivityIdentity(snapshot['activityIdentity']);
        if (ctx.activityIdentity) {
            ctx.activitySettlementIdentity = ctx.activityIdentity;
            ctx.activityActiveRunId = fieldString(asRecord(snapshot['activeRun'])['traceRunId']) || null;
            ctx.onActivityIdentityChanged?.(previous, ctx.activityIdentity);
        }
    } catch {
        // A missing/failed snapshot must not authorize another conversation's events.
    }
}

export async function refreshInfo(ctx: TuiContext): Promise<boolean> {
    const generation = (ctx.settingsRefreshGeneration ?? 0) + 1;
    ctx.settingsRefreshGeneration = generation;
    if (ctx.activityIdentity) ctx.activitySettlementIdentity = ctx.activityIdentity;
    // A settings refresh supersedes an older snapshot even before this refresh
    // reaches its own snapshot request (the /api/session read may still wait).
    ctx.activityIdentityGeneration = (ctx.activityIdentityGeneration ?? 0) + 1;
    ctx.activityIdentity = null;
    let freshSettings = false;
    try {
        await getCliAuthToken(ctx.apiUrl);
        const r = await fetch(`${ctx.apiUrl}/api/settings`, { headers: authHeaders(), signal: AbortSignal.timeout(2000) });
        if (r.ok) {
            const res = asRecord(await r.json());
            if (ctx.settingsRefreshGeneration !== generation) return false;
            const s = asRecord(res["data"] || res);
            const cli = fieldString(s["cli"], 'codex');
            const perCli = asRecord(s["perCli"]);
            const cliSettings = asRecord(perCli[cli]);
            ctx.settingsSnapshot = s;
            freshSettings = true;
            ctx.info = { cli, workingDir: fieldString(s["workingDir"], '~'), model: fieldString(cliSettings["model"]) };
            if (typeof s["locale"] === 'string') ctx.runtimeLocale = s["locale"];
            if (s["tui"] && typeof s["tui"] === 'object') ctx.tuiConfig = { ...ctx.tuiConfig, ...asRecord(s["tui"]) };
            const pDirs = s["projectDirs"];
            if (Array.isArray(pDirs) && pDirs.length > 0 && typeof pDirs[0] === 'string') ctx.projectRoot = pDirs[0];
            if (typeof s["port"] === 'number') ctx.serverPort = s["port"];
        }
        const sr = await fetch(`${ctx.apiUrl}/api/session`, { headers: authHeaders(), signal: AbortSignal.timeout(2000) });
        if (sr.ok) {
            const ses = asRecord(await sr.json());
            if (ctx.settingsRefreshGeneration !== generation) return false;
            const sd = asRecord(ses["data"] || ses);
            if (typeof sd["model"] === 'string') ctx.info.model = sd["model"];
        }
    } catch { /* keep current info on fetch failure */ }
    if (ctx.settingsRefreshGeneration !== generation) return false;
    ctx.accent = cliColor[ctx.info.cli] || c.red;
    ctx.label = cliLabel[ctx.info.cli] || ctx.info.cli;
    ctx.dir = ctx.info.workingDir.replace(homedir(), '~');
    await refreshActivityIdentity(ctx);
    return ctx.settingsRefreshGeneration === generation && freshSettings;
}

export function makeCliCommandCtx(ctx: TuiContext) {
    const api = <T = JsonRecord>(path: string, init?: TuiApiInit, timeout?: number) => apiJson<T>(ctx, path, init, timeout);
    return {
        interface: 'cli',
        locale: ctx.runtimeLocale,
        version: APP_VERSION,
        getSession: () => api('/api/session'),
        getSettings: () => api('/api/settings'),
        updateSettings: (patch: JsonRecord) => api('/api/settings', { method: 'PUT', body: patch }),
        getRuntime: () => api('/api/runtime').catch(() => null),
        getSkills: () => api('/api/skills').catch(() => []),
        clearSession: () => api('/api/clear', { method: 'POST' }),
        getCliStatus: () => api('/api/cli-status').catch(() => null),
        getMcp: () => api('/api/mcp'),
        syncMcp: () => api('/api/mcp/sync', { method: 'POST' }),
        installMcp: () => api('/api/mcp/install', { method: 'POST' }, 120000),
        listMemory: () => api<{ files?: unknown[] }>('/api/jaw-memory/list').then((d) => d.files || []),
        searchMemory: (q: string) => api<{ result?: string }>(`/api/jaw-memory/search?q=${encodeURIComponent(q)}`).then((d) => d.result || '(no results)'),
        getBrowserStatus: () => api('/api/browser/status'),
        getBrowserTabs: () => api('/api/browser/tabs'),
        resetEmployees: () => api('/api/employees/reset', { method: 'POST' }),
        resetEmployeeSessions: () => api('/api/employees/sessions/reset', { method: 'POST' }),
        getPrompt: () => api('/api/prompt'),
        resetSkills: () => api('/api/skills/reset', { method: 'POST' }).catch(() => { }),
    };
}

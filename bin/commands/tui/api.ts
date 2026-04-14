/**
 * API helpers shared across TUI modules.
 */
import { APP_VERSION } from '../../../src/core/config.js';
import { getCliAuthToken, authHeaders } from '../../../src/cli/api-auth.js';
import { cliColor, cliLabel, c, type TuiContext } from './types.js';

export async function apiJson(ctx: TuiContext, path: string, init: Record<string, any> = {}, timeoutMs = 10000) {
    const headers: Record<string, string> = { ...authHeaders(), ...(init.headers || {}) };
    const req: Record<string, any> = { ...init, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (req.body && typeof req.body !== 'string') {
        req.body = JSON.stringify(req.body);
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
    const resp = await fetch(`${ctx.apiUrl}${path}`, req);
    const data = await resp.json().catch(() => ({})) as Record<string, any>;
    if (!resp.ok) {
        const msg = data?.error || data?.message || `${resp.status} ${resp.statusText}`;
        throw new Error(msg);
    }
    return data;
}

export async function refreshInfo(ctx: TuiContext): Promise<void> {
    try {
        await getCliAuthToken(ctx.apiUrl);
        const r = await fetch(`${ctx.apiUrl}/api/settings`, { headers: authHeaders(), signal: AbortSignal.timeout(2000) });
        if (r.ok) {
            const res = await r.json() as Record<string, any>;
            const s = res.data || res;
            const cli = s.cli || 'codex';
            ctx.info = { cli, workingDir: s.workingDir || '~', model: s.perCli?.[cli]?.model || '' };
            if (s.locale) ctx.runtimeLocale = s.locale;
            if (s.tui && typeof s.tui === 'object') ctx.tuiConfig = { ...ctx.tuiConfig, ...s.tui };
        }
        const sr = await fetch(`${ctx.apiUrl}/api/session`, { headers: authHeaders(), signal: AbortSignal.timeout(2000) });
        if (sr.ok) {
            const ses = await sr.json() as Record<string, any>;
            const sd = ses.data || ses;
            if (sd.model) ctx.info.model = sd.model;
        }
    } catch { /* keep current info on fetch failure */ }
    ctx.accent = cliColor[ctx.info.cli] || c.red;
    ctx.label = cliLabel[ctx.info.cli] || ctx.info.cli;
    ctx.dir = ctx.info.workingDir.replace(process.env.HOME || '', '~');
}

export function makeCliCommandCtx(ctx: TuiContext) {
    const api = (path: string, init?: Record<string, any>, timeout?: number) => apiJson(ctx, path, init, timeout);
    return {
        interface: 'cli',
        locale: ctx.runtimeLocale,
        version: APP_VERSION,
        getSession: () => api('/api/session'),
        getSettings: () => api('/api/settings'),
        updateSettings: (patch: any) => api('/api/settings', { method: 'PUT', body: patch }),
        getRuntime: () => api('/api/runtime').catch(() => null),
        getSkills: () => api('/api/skills').catch(() => []),
        clearSession: () => api('/api/clear', { method: 'POST' }),
        getCliStatus: () => api('/api/cli-status').catch(() => null),
        getMcp: () => api('/api/mcp'),
        syncMcp: () => api('/api/mcp/sync', { method: 'POST' }),
        installMcp: () => api('/api/mcp/install', { method: 'POST' }, 120000),
        listMemory: () => api('/api/jaw-memory/list').then((d: any) => d.files || []),
        searchMemory: (q: string) => api(`/api/jaw-memory/search?q=${encodeURIComponent(q)}`).then((d: any) => d.result || '(no results)'),
        getBrowserStatus: () => api('/api/browser/status'),
        getBrowserTabs: () => api('/api/browser/tabs'),
        resetEmployees: () => api('/api/employees/reset', { method: 'POST' }),
        getPrompt: () => api('/api/prompt'),
        resetSkills: () => api('/api/skills/reset', { method: 'POST' }).catch(() => { }),
    };
}

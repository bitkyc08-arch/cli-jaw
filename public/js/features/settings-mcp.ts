// ── MCP Server Settings ──
import { api, apiJson } from '../api.js';
import { escapeHtml } from '../render.js';
import { t } from './i18n.js';
import { ICONS } from '../icons.js';

interface McpData { servers: Record<string, { command: string; args?: string[] }>; }
interface McpSyncResult { results: Record<string, boolean>; }
interface McpInstallEntry { status: string; bin?: string; }
interface McpInstallResult { results: Record<string, McpInstallEntry>; }

export async function loadMcpServers(): Promise<void> {
    try {
        const d = await api<McpData>('/api/mcp');
        if (!d) return;
        const el = document.getElementById('mcpServerList');
        if (!el) return;
        const names = Object.entries(d.servers || {});
        if (!names.length) { el.textContent = t('mcp.noServers'); return; }
        el.innerHTML = names.map(([n, s]) =>
            `<div style="padding:2px 0">• <b>${escapeHtml(n)}</b> <span style="opacity:.6">${escapeHtml(s.command)} ${(s.args || []).slice(0, 2).map(a => escapeHtml(a)).join(' ')}</span></div>`
        ).join('');
    } catch { }
}

export async function syncMcpServers(): Promise<void> {
    const resultEl = document.getElementById('mcpSyncResult');
    if (!resultEl) return;
    resultEl.style.display = 'block';
    resultEl.textContent = t('mcp.syncing');
    try {
        const d = await apiJson('/api/mcp/sync', 'POST', {}) as McpSyncResult | null;
        if (!d) { resultEl.innerHTML = `${ICONS.error} sync failed`; return; }
        const r = d.results || {};
        resultEl.innerHTML = Object.entries(r).map(([k, v]) =>
            `${v ? ICONS.check : ICONS.skip} ${escapeHtml(k)}`
        ).join(' &nbsp; ');
    } catch (e) { resultEl.innerHTML = `${ICONS.error} ${escapeHtml((e as Error).message)}`; }
}

export async function installMcpGlobal(): Promise<void> {
    const resultEl = document.getElementById('mcpSyncResult');
    if (!resultEl) return;
    resultEl.style.display = 'block';
    resultEl.textContent = t('mcp.installing');
    try {
        const d = await apiJson('/api/mcp/install', 'POST', {}) as McpInstallResult | null;
        if (!d) { resultEl.innerHTML = `${ICONS.error} install failed`; return; }
        resultEl.innerHTML = Object.entries(d.results || {}).map(([k, v]) => {
            const ic = v.status === 'installed' ? ICONS.check : v.status === 'skip' ? ICONS.skip : ICONS.error;
            return `${ic} <b>${escapeHtml(k)}</b>: ${escapeHtml(v.status)}${v.bin ? ` ${ICONS.arrowRight} ` + escapeHtml(v.bin) : ''}`;
        }).join('<br>');
        loadMcpServers();
    } catch (e) { resultEl.innerHTML = `${ICONS.error} ${escapeHtml((e as Error).message)}`; }
}

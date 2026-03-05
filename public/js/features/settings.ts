// ── Settings Feature ──
import { MODEL_MAP, loadCliRegistry, getCliKeys, getCliMeta } from '../constants.js';
import type { CliEntry } from '../constants.js';
import { escapeHtml } from '../render.js';
import { syncStoredLocale } from '../locale.js';
import { t } from './i18n.js';
import { api, apiJson, apiFire } from '../api.js';

interface PerCliConfig { model?: string; effort?: string; }
interface TelegramConfig { enabled?: boolean; token?: string; allowedChatIds?: number[]; forwardAll?: boolean; }
interface QuotaWindow { label: string; percent: number; }
interface QuotaEntry {
    account?: { email?: string; type?: string; plan?: string; tier?: string };
    windows?: QuotaWindow[];
    authenticated?: boolean;
    error?: boolean;
}
interface SettingsData {
    cli: string; workingDir: string; permissions: string; locale?: string;
    perCli?: Record<string, PerCliConfig>;
    activeOverrides?: Record<string, PerCliConfig>;
    telegram?: TelegramConfig;
    fallbackOrder?: string[];
    memory?: { cli?: string };
}

function toCap(cli: string): string {
    return cli.charAt(0).toUpperCase() + cli.slice(1);
}

function getModelSelect(cli: string): HTMLSelectElement | null {
    return document.getElementById('model' + toCap(cli)) as HTMLSelectElement | null;
}

function getCustomModelInput(cli: string): HTMLInputElement | null {
    return document.getElementById('customModel' + toCap(cli)) as HTMLInputElement | null;
}

function getEffortSelect(cli: string): HTMLSelectElement | null {
    return document.getElementById('effort' + toCap(cli)) as HTMLSelectElement | null;
}

function setSelectOptions(selectEl: HTMLSelectElement | null, values: string[], { includeCustom = false, includeDefault = false, selected = '' } = {}): void {
    if (!selectEl) return;
    const defaultHtml = includeDefault ? '<option value="default">default</option>' : '';
    const customHtml = includeCustom ? `<option value="__custom__">${t('model.customOption')}</option>` : '';
    const opts = (values || []).map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    selectEl.innerHTML = defaultHtml + opts + customHtml;

    if (selected && Array.from(selectEl.options).some(o => o.value === selected)) {
        selectEl.value = selected;
    }
}

function appendCustomOption(selectEl: HTMLSelectElement | null, value: string): void {
    if (!selectEl || !value) return;
    if (Array.from(selectEl.options).some(o => o.value === value)) return;
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    const customOpt = selectEl.querySelector('option[value="__custom__"]');
    if (customOpt) selectEl.insertBefore(opt, customOpt);
    else selectEl.appendChild(opt);
}

function syncCliOptionSelects(settings: SettingsData | null = null): void {
    const cliKeys = getCliKeys();

    const selCli = document.getElementById('selCli') as HTMLSelectElement | null;
    if (selCli) {
        const current = settings?.cli || selCli.value || cliKeys[0] || 'claude';
        selCli.innerHTML = cliKeys.map(cli => {
            const label = getCliMeta(cli)?.label || cli;
            return `<option value="${escapeHtml(cli)}">${escapeHtml(label)}</option>`;
        }).join('');
        if (Array.from(selCli.options).some(o => o.value === current)) selCli.value = current;
    }

    const memCli = document.getElementById('memCli') as HTMLSelectElement | null;
    if (memCli) {
        const current = settings?.memory?.cli || memCli.value || '';
        memCli.innerHTML = '<option value="">(active CLI)</option>' +
            cliKeys.map(cli => `<option value="${escapeHtml(cli)}">${escapeHtml(cli)}</option>`).join('');
        if (Array.from(memCli.options).some(o => o.value === current)) memCli.value = current;
    }
}

function syncPerCliModelAndEffortControls(settings: SettingsData | null = null): void {
    for (const cli of getCliKeys()) {
        const modelSel = getModelSelect(cli);
        if (modelSel) {
            const selected = settings?.perCli?.[cli]?.model || modelSel.value || '';
            setSelectOptions(modelSel, MODEL_MAP[cli] || [], { includeCustom: true, selected });
            if (selected && !Array.from(modelSel.options).some(o => o.value === selected)) {
                appendCustomOption(modelSel, selected);
                modelSel.value = selected;
            }
        }

        const effortSel = getEffortSelect(cli);
        if (effortSel) {
            const meta = getCliMeta(cli);
            const options = [''].concat(meta?.efforts || []);
            const selected = settings?.perCli?.[cli]?.effort || effortSel.value || '';
            const unique = [...new Set(options)];
            const noneLabel = (meta?.efforts?.length === 0 && meta?.effortNote) ? meta.effortNote : '— none';
            effortSel.innerHTML = unique.map(v => {
                if (!v) return `<option value="">${escapeHtml(noneLabel)}</option>`;
                return `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`;
            }).join('');
            if (meta?.effortNote) effortSel.title = meta.effortNote;
            effortSel.disabled = (meta?.efforts?.length === 0 && !!meta?.effortNote);
            if (Array.from(effortSel.options).some(o => o.value === selected)) effortSel.value = selected;
        }
    }
}

function syncActiveEffortOptions(cli: string, selected = ''): void {
    const selEffort = document.getElementById('selEffort') as HTMLSelectElement | null;
    if (!selEffort) return;
    const meta = getCliMeta(cli);
    if (meta?.effortNote) {
        // Effort managed externally (e.g. Copilot config.json) — show hint, disable
        selEffort.innerHTML = `<option value="">${escapeHtml(meta.effortNote)}</option>`;
        selEffort.title = meta.effortNote;
        selEffort.disabled = true;
        return;
    }
    const efforts = [''].concat(meta?.efforts || []);
    const unique = [...new Set(efforts)];
    selEffort.innerHTML = unique.map(v => {
        if (!v) return '<option value="">— none</option>';
        return `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`;
    }).join('');
    selEffort.disabled = false;
    selEffort.title = '';
    if (Array.from(selEffort.options).some(o => o.value === selected)) selEffort.value = selected;
}

export async function loadSettings(): Promise<void> {
    await loadCliRegistry();
    const s = await api<SettingsData>('/api/settings');
    if (!s) return;
    syncStoredLocale(s.locale ?? '');
    syncCliOptionSelects(s);
    syncPerCliModelAndEffortControls(s);

    const selCli = document.getElementById('selCli') as HTMLSelectElement | null;
    if (selCli && Array.from(selCli.options).some(o => o.value === s.cli)) {
        selCli.value = s.cli;
    }
    const cwdEl = document.getElementById('inpCwd');
    if (cwdEl) cwdEl.textContent = s.workingDir;
    const headerEl = document.getElementById('headerCli');
    if (headerEl) headerEl.textContent = s.cli;
    setPerm(s.permissions, false);

    if (s.perCli) {
        for (const [cli, cfg] of Object.entries(s.perCli) as [string, PerCliConfig][]) {
            const modelEl = getModelSelect(cli);
            const effortEl = getEffortSelect(cli);
            if (modelEl && cfg.model) {
                appendCustomOption(modelEl, cfg.model);
                modelEl.value = cfg.model;
            }
            if (effortEl) effortEl.value = cfg.effort || '';
        }
    }

    onCliChange(false);
    const ao = s.activeOverrides?.[s.cli] || {};
    const pc = s.perCli?.[s.cli] || {};
    const activeModel = ao.model || pc.model;
    const activeEffort = ao.effort || pc.effort || '';
    const selModel = document.getElementById('selModel') as HTMLSelectElement | null;
    if (activeModel && selModel) selModel.value = activeModel;
    syncActiveEffortOptions(s.cli, activeEffort);

    loadTelegramSettings(s);
    loadFallbackOrder(s);
    loadMcpServers();
}

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
            `<div style="padding:2px 0">• <b>${n}</b> <span style="opacity:.6">${s.command} ${(s.args || []).slice(0, 2).join(' ')}</span></div>`
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
        if (!d) { resultEl.textContent = '❌ sync failed'; return; }
        const r = d.results || {};
        resultEl.innerHTML = Object.entries(r).map(([k, v]) =>
            `${v ? '✅' : '⏭️'} ${k}`
        ).join(' &nbsp; ');
    } catch (e) { resultEl.textContent = '❌ ' + (e as Error).message; }
}

export async function installMcpGlobal(): Promise<void> {
    const resultEl = document.getElementById('mcpSyncResult');
    if (!resultEl) return;
    resultEl.style.display = 'block';
    resultEl.textContent = t('mcp.installing');
    try {
        const d = await apiJson('/api/mcp/install', 'POST', {}) as McpInstallResult | null;
        if (!d) { resultEl.textContent = '❌ install failed'; return; }
        resultEl.innerHTML = Object.entries(d.results || {}).map(([k, v]) => {
            const icon = v.status === 'installed' ? '✅' : v.status === 'skip' ? '⏭️' : '❌';
            return `${icon} <b>${k}</b>: ${v.status}${v.bin ? ' → ' + v.bin : ''}`;
        }).join('<br>');
        loadMcpServers();
    } catch (e) { resultEl.textContent = '❌ ' + (e as Error).message; }
}

export async function updateSettings(): Promise<void> {
    const s = {
        cli: (document.getElementById('selCli') as HTMLSelectElement)?.value || 'claude',
    };
    const hdr = document.getElementById('headerCli');
    if (hdr) hdr.textContent = s.cli;
    await apiJson('/api/settings', 'PUT', s);
}

export function setPerm(_p: string, save = true): void {
    // Auto-fixed since Phase 3.1 — no UI toggle, just persist
    if (save) apiFire('/api/settings', 'PUT', { permissions: 'auto' });
}

export function getModelValue(cli: string): string {
    const sel = getModelSelect(cli);
    if (!sel) return 'default';
    if (sel.value === '__custom__') {
        const inp = getCustomModelInput(cli);
        return inp?.value?.trim() || sel.options[0]?.value || 'default';
    }
    return sel.value;
}

export function handleModelSelect(cli: string, selectEl: HTMLSelectElement): void {
    const customInput = getCustomModelInput(cli);
    if (!customInput) return;
    if (selectEl.value === '__custom__') {
        customInput.style.display = 'block';
        customInput.focus();
    } else {
        customInput.style.display = 'none';
        savePerCli();
    }
}

export function applyCustomModel(cli: string, inputEl: HTMLInputElement): void {
    const val = inputEl.value.trim();
    if (!val) return;
    const select = getModelSelect(cli);
    if (!select) return;
    appendCustomOption(select, val);
    select.value = val;
    inputEl.style.display = 'none';
    savePerCli();
}

export async function savePerCli(): Promise<void> {
    const perCli: Record<string, PerCliConfig> = {};
    for (const cli of getCliKeys()) {
        const modelEl = getModelSelect(cli);
        if (!modelEl) continue;
        const effortEl = getEffortSelect(cli);
        perCli[cli] = {
            model: getModelValue(cli),
            effort: effortEl ? effortEl.value : '',
        };
    }
    await apiJson('/api/settings', 'PUT', { perCli });
}

export function onCliChange(save = true): void {
    const cli = (document.getElementById('selCli') as HTMLSelectElement)?.value || 'claude';
    const models = MODEL_MAP[cli] || [];
    const modelSel = document.getElementById('selModel') as HTMLSelectElement | null;
    setSelectOptions(modelSel, models, { includeCustom: true, includeDefault: true });
    const hdrCli = document.getElementById('headerCli');
    if (hdrCli) hdrCli.textContent = cli;
    syncActiveEffortOptions(cli);

    const oldInput = document.getElementById('selModelCustom');
    if (oldInput) oldInput.remove();
    const inp = document.createElement('input');
    inp.type = 'text'; inp.id = 'selModelCustom';
    inp.className = 'custom-model-input';
    inp.placeholder = t('model.placeholder');
    inp.style.display = 'none';
    inp.onchange = function () {
        const val = (this as HTMLInputElement).value.trim();
        if (!val || !modelSel) return;
        appendCustomOption(modelSel, val);
        modelSel.value = val;
        (this as HTMLInputElement).style.display = 'none';
        saveActiveCliSettings();
    };
    if (!modelSel) { if (save) updateSettings(); return; }
    modelSel.parentElement?.appendChild(inp);
    modelSel.onchange = function () {
        if ((this as HTMLSelectElement).value === '__custom__') {
            inp.style.display = 'block';
            inp.focus();
        } else {
            inp.style.display = 'none';
            saveActiveCliSettings();
        }
    };

    api<SettingsData>('/api/settings').then(s => {
        if (!s) return;
        const ao = s.activeOverrides?.[cli] || {};
        const pc = s.perCli?.[cli] || {};
        const model = ao.model || pc.model;
        const effort = ao.effort || pc.effort || '';
        if (model && modelSel) {
            appendCustomOption(modelSel, model);
            modelSel.value = model;
        }
        syncActiveEffortOptions(cli, effort);
    });

    if (save) updateSettings();
}

export async function saveActiveCliSettings(): Promise<void> {
    const cli = (document.getElementById('selCli') as HTMLSelectElement)?.value || 'claude';
    const modelSel = document.getElementById('selModel') as HTMLSelectElement | null;
    let model = modelSel?.value || 'default';
    if (model === '__custom__') {
        model = (document.getElementById('selModelCustom') as HTMLInputElement | null)?.value?.trim() || 'default';
    }
    const effortEl = document.getElementById('selEffort') as HTMLSelectElement | null;
    const overrides: Record<string, PerCliConfig> = {};
    overrides[cli] = { model };
    if (effortEl && !effortEl.disabled) overrides[cli].effort = effortEl.value || '';
    await apiJson('/api/settings', 'PUT', { activeOverrides: overrides });
}

// ── Telegram ──
export async function saveTelegramSettings(): Promise<void> {
    const token = (document.getElementById('tgToken') as HTMLInputElement)?.value.trim() || '';
    const chatIdsRaw = (document.getElementById('tgChatIds') as HTMLInputElement)?.value.trim() || '';
    const allowedChatIds = chatIdsRaw
        ? chatIdsRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
        : [];
    await apiJson('/api/settings', 'PUT', { telegram: { token, allowedChatIds } });
}

export async function setTelegram(enabled: boolean): Promise<void> {
    document.getElementById('tgOn')?.classList.toggle('active', enabled);
    document.getElementById('tgOff')?.classList.toggle('active', !enabled);
    await apiJson('/api/settings', 'PUT', { telegram: { enabled } });
}

export async function setForwardAll(enabled: boolean): Promise<void> {
    document.getElementById('tgForwardOn')?.classList.toggle('active', enabled);
    document.getElementById('tgForwardOff')?.classList.toggle('active', !enabled);
    await apiJson('/api/settings', 'PUT', { telegram: { forwardAll: enabled } });
}

function loadTelegramSettings(s: SettingsData): void {
    if (!s.telegram) return;
    const tg = s.telegram;
    document.getElementById('tgOn')?.classList.toggle('active', !!tg.enabled);
    document.getElementById('tgOff')?.classList.toggle('active', !tg.enabled);
    const tgToken = document.getElementById('tgToken') as HTMLInputElement | null;
    if (tg.token && tgToken) tgToken.value = tg.token;
    const tgChatIds = document.getElementById('tgChatIds') as HTMLInputElement | null;
    if (tg.allowedChatIds?.length && tgChatIds) {
        tgChatIds.value = tg.allowedChatIds.join(', ');
    }
    const fwdOn = tg.forwardAll !== false;
    document.getElementById('tgForwardOn')?.classList.toggle('active', fwdOn);
    document.getElementById('tgForwardOff')?.classList.toggle('active', !fwdOn);
}

// ── Fallback Order ──
export function loadFallbackOrder(s: SettingsData): void {
    const container = document.getElementById('fallbackOrderList');
    if (!container) return;
    const allClis = Object.keys(s.perCli || {});
    const active = s.fallbackOrder || [];
    const slotCount = Math.min(allClis.length - 1, 3);

    let html = '';
    for (let i = 0; i < slotCount; i++) {
        const current = active[i] || '';
        const opts = allClis.map(cli =>
            `<option value="${cli}" ${cli === current ? 'selected' : ''}>${cli}</option>`
        ).join('');
        html += `
            <div class="settings-row sub-row">
                <label style="min-width:60px">Fallback ${i + 1}</label>
                <select id="fallback${i}"
                    style="font-size:11px;padding:4px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:4px;flex:1">
                    <option value="">${t('settings.none')}</option>
                    ${opts}
                </select>
            </div>`;
    }
    container.innerHTML = html;
}

export async function saveFallbackOrder(): Promise<void> {
    const selects = document.querySelectorAll<HTMLSelectElement>('#fallbackOrderList select');
    const fallbackOrder = [...selects].map(s => s.value).filter(Boolean);
    await apiJson('/api/settings', 'PUT', { fallbackOrder });
}

// ── CLI Status ──
import { state } from '../state.js';

export async function loadCliStatus(force = false): Promise<void> {
    const interval = Number(localStorage.getItem('cliStatusInterval') || 300);
    if (!force && state.cliStatusCache && interval > 0 && (Date.now() - state.cliStatusTs) < interval * 1000) {
        renderCliStatus({ cliStatus: (state.cliStatusCache as Record<string, unknown>)?.cliStatus as Record<string, { available: boolean }> | null, quota: (state.cliStatusCache as Record<string, unknown>)?.quota as Record<string, QuotaEntry> | null });
        return;
    }

    const el = document.getElementById('cliStatusList');
    if (el) el.innerHTML = '<div style="color:var(--text-dim);font-size:11px">Loading...</div>';

    const [cliStatus, quota] = await Promise.all([
        api<Record<string, { available: boolean }>>('/api/cli-status'),
        api<Record<string, QuotaEntry>>('/api/quota'),
    ]);

    state.cliStatusCache = { cliStatus, quota } as Record<string, unknown>;
    state.cliStatusTs = Date.now();
    renderCliStatus({ cliStatus, quota });
}

function renderCliStatus(data: { cliStatus: Record<string, { available: boolean }> | null; quota: Record<string, QuotaEntry> | null }): void {
    const { cliStatus, quota } = data;
    const el = document.getElementById('cliStatusList');

    const AUTH_HINTS: Record<string, { install: string; auth: string }> = {
        claude: { install: 'npm i -g @anthropic-ai/claude-code', auth: 'claude auth' },
        codex: { install: 'npm i -g @openai/codex', auth: 'codex login' },
        gemini: { install: 'npm i -g @google/gemini-cli', auth: `gemini  (${t('cli.gemini.auth')})` },
        opencode: { install: 'npm i -g opencode-ai', auth: 'opencode auth' },
        copilot: { install: 'npm i -g copilot', auth: 'copilot login 또는 gh auth login' },
    };

    let html = '';

    if (!cliStatus || typeof cliStatus !== 'object') {
        if (el) el.innerHTML = '<div style="color:var(--text-dim);font-size:11px">Failed to load CLI status</div>';
        return;
    }

    for (const [name, info] of Object.entries(cliStatus)) {
        const q = quota?.[name];
        // 3-state: ok (installed+authed), warn (installed+no-auth), missing (not installed)
        let dotClass: string;
        if (!info.available) {
            dotClass = 'missing';
        } else if (!q || q.error) {
            dotClass = 'ok'; // transient error or no data — keep green
        } else if (q.authenticated === false) {
            dotClass = 'warn'; // explicitly unauthenticated
        } else {
            dotClass = 'ok';
        }

        let accountLine = '';
        if (q?.account) {
            const parts = [];
            if (q.account.email) parts.push(q.account.email);
            if (q.account.type) parts.push(q.account.type);
            if (q.account.plan) parts.push(q.account.plan);
            if (q.account.tier) parts.push(q.account.tier);
            if (parts.length) accountLine = `<div style="font-size:10px;color:var(--text-dim);margin:2px 0 4px 16px">${escapeHtml(parts.join(' · '))}</div>`;
        }

        // Copilot: keychain refresh button (always visible, outside account check)
        if (name === 'copilot') {
            accountLine += `<button id="copilotKeychainBtn" style="font-size:10px;margin:2px 0 4px 16px;padding:2px 8px;background:var(--border);color:var(--text);border:1px solid var(--text-dim);border-radius:4px;cursor:pointer" title="${t('copilot.keychainHint')}">${t('copilot.keychain')}</button>`;
        }

        // Auth hint when CLI is not available OR not authenticated
        let authHint = '';
        if (!info.available || dotClass === 'warn') {
            const hint = AUTH_HINTS[name];
            if (hint) {
                const isNotInstalled = !info.available;
                const title = isNotInstalled ? t('cli.authRequired') : t('cli.notAuthenticated');
                const borderColor = isNotInstalled ? '#ef4444' : '#fbbf24';
                authHint = `
                    <div style="font-size:10px;margin:4px 0 2px 16px;padding:6px 8px;background:var(--bg-dim, #1e1e2e);border-radius:4px;border-left:2px solid ${borderColor}">
                        <div style="color:${borderColor};margin-bottom:3px">${title}</div>
                        ${isNotInstalled ? `<div style="color:var(--text-dim)"><code style="font-size:10px;background:var(--border);padding:1px 4px;border-radius:2px">${escapeHtml(hint.install)}</code></div>` : ''}
                        <div style="color:var(--text-dim)${isNotInstalled ? ';margin-top:2px' : ''}"><code style="font-size:10px;background:var(--border);padding:1px 4px;border-radius:2px">${escapeHtml(hint.auth)}</code></div>
                    </div>
                `;
            }
        }

        let windowsHtml = '';
        if (q?.windows?.length) {
            windowsHtml = q.windows.map(w => {
                const pct = Math.round(w.percent);
                const barColor = pct > 80 ? '#ef4444' : pct > 50 ? '#fbbf24' : '#38bdf8';
                return `
                    <div style="display:flex;align-items:center;gap:6px;margin-left:16px;font-size:10px;color:var(--text-dim)">
                        <span style="width:42px">${w.label}</span>
                        <div style="flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden">
                            <div style="width:${pct}%;height:100%;background:${barColor};border-radius:2px"></div>
                        </div>
                        <span style="width:28px;text-align:right">${pct}%</span>
                    </div>
                `;
            }).join('');
        }

        html += `
            <div class="settings-group" style="margin-bottom:6px;padding:8px 10px">
                <div class="cli-status-row">
                    <span class="cli-dot ${dotClass}"></span>
                    <span class="cli-name" style="font-weight:600">${name}</span>
                </div>
                ${accountLine}
                ${authHint}
                ${windowsHtml}
            </div>
        `;
    }

    if (el) el.innerHTML = html;

    // Copilot keychain refresh handler — shows each token source result
    const kcBtn = document.getElementById('copilotKeychainBtn');
    if (kcBtn) {
        kcBtn.addEventListener('click', async () => {
            const btn = kcBtn as HTMLButtonElement;
            btn.disabled = true;
            btn.textContent = '🔍 조회 중…';

            try {
                const res = await api<{ ok: boolean; account?: any; steps: Array<{ source: string; status: string; detail?: string }> }>('/api/copilot/refresh', { method: 'POST' });
                if (!res?.steps) { btn.textContent = '❌'; btn.disabled = false; return; }

                // Show each step result sequentially
                for (let i = 0; i < res.steps.length; i++) {
                    const s = res.steps[i];
                    const icon = s.status === 'hit' ? '✅' : s.status === 'error' ? '❌' : '⬜';
                    btn.textContent = `${i + 1}. ${s.source} ${icon}`;
                    await new Promise(r => setTimeout(r, 500));
                }

                if (res.ok) {
                    btn.textContent = '✅ 완료!';
                    await loadCliStatus(true);
                } else {
                    btn.textContent = '❌ 토큰 없음';
                }
            } catch {
                btn.textContent = '❌ 실패';
            }
            setTimeout(() => { btn.textContent = t('copilot.keychain'); btn.disabled = false; }, 3000);
        });
    }
}

// ── Prompt Modal ──
export function openPromptModal(): void {
    api<{ content?: string }>('/api/prompt').then(data => {
        if (!data) return;
        const editor = document.getElementById('modalPromptEditor') as HTMLTextAreaElement | null;
        if (editor) editor.value = data.content || '';
        document.getElementById('promptModal')?.classList.add('open');
    });
}

export function closePromptModal(e?: Event): void {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('promptModal')?.classList.remove('open');
}

export async function savePromptFromModal(): Promise<void> {
    const editor = document.getElementById('modalPromptEditor') as HTMLTextAreaElement | null;
    const content = editor?.value || '';
    await apiJson('/api/prompt', 'PUT', { content });
    document.getElementById('promptModal')?.classList.remove('open');
}

// ── Template Modal (Node Map + Editor) ──

interface TemplateInfo { id: string; filename: string; content: string; }
interface TreeNode { id: string; label: string; emoji: string; children: string[]; }
let _templates: TemplateInfo[] = [];
let _devMode = false;

export async function openTemplateModal(): Promise<void> {
    const data = await api<{ templates: TemplateInfo[]; tree: TreeNode[] }>('/api/prompt-templates');
    if (!data) return;
    _templates = data.templates;
    _devMode = false;
    renderTree(data.tree);
    showTemplateView('tree');
    document.getElementById('templateModal')?.classList.add('open');
}

function renderTree(tree: TreeNode[]): void {
    const container = document.getElementById('templateTree');
    if (!container) return;
    container.innerHTML = '';
    for (const group of tree) {
        const main = document.createElement('div');
        main.style.cssText = 'background:var(--bg);border:1px solid var(--accent);border-radius:6px;padding:8px 10px;margin:8px 0 4px;font-size:12px;color:var(--accent);font-weight:600';
        main.textContent = `${group.emoji} ${group.label}`;
        container.appendChild(main);
        for (const childId of group.children) {
            const tmpl = _templates.find(t => t.id === childId);
            if (!tmpl) continue;
            const node = document.createElement('div');
            node.style.cssText = 'background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;margin:2px 0 2px 24px;font-size:12px;cursor:pointer;transition:border-color .15s';
            node.textContent = `📄 ${tmpl.filename}`;
            node.addEventListener('mouseenter', () => { node.style.borderColor = 'var(--accent2)'; });
            node.addEventListener('mouseleave', () => { node.style.borderColor = 'var(--border)'; });
            node.addEventListener('click', () => { openTemplateEditor(tmpl); });
            container.appendChild(node);
        }
    }
}

function openTemplateEditor(tmpl: TemplateInfo): void {
    const editor = document.getElementById('templateEditor') as HTMLTextAreaElement;
    editor.value = tmpl.content;
    editor.dataset.templateId = tmpl.id;
    editor.readOnly = true;
    _devMode = false;
    const label = document.getElementById('templateEditorLabel');
    if (label) label.textContent = `📄 ${tmpl.filename}`;
    const vars = tmpl.content.match(/\{\{[A-Z_]+\}\}/g);
    const varsEl = document.getElementById('templateVars');
    if (varsEl) varsEl.textContent = vars ? `vars: ${[...new Set(vars)].join(', ')}` : 'no variables';
    const saveBtn = document.getElementById('templateSaveBtn');
    if (saveBtn) saveBtn.style.display = 'none';
    const toggle = document.getElementById('templateDevToggle');
    if (toggle) { toggle.style.color = 'var(--text-dim)'; toggle.style.borderColor = 'var(--border)'; toggle.textContent = '🔧 개발자 모드'; }
    const title = document.getElementById('templateModalTitle');
    if (title) title.textContent = `📄 ${tmpl.filename}`;
    showTemplateView('editor');
}

export function toggleDevMode(): void {
    if (!_devMode) {
        if (!confirm('⚠️ 프롬프트를 직접 수정하면 예상치 못한 동작이 발생할 수 있습니다.\n계속하시겠습니까?')) return;
    }
    _devMode = !_devMode;
    const editor = document.getElementById('templateEditor') as HTMLTextAreaElement;
    editor.readOnly = !_devMode;
    const saveBtn = document.getElementById('templateSaveBtn');
    if (saveBtn) saveBtn.style.display = _devMode ? '' : 'none';
    const toggle = document.getElementById('templateDevToggle');
    if (toggle) {
        toggle.style.color = _devMode ? 'var(--stop-btn)' : 'var(--text-dim)';
        toggle.style.borderColor = _devMode ? 'var(--stop-btn)' : 'var(--border)';
        toggle.textContent = _devMode ? '🔓 개발자 모드 ON' : '🔧 개발자 모드';
    }
}

export async function saveTemplateFromModal(): Promise<void> {
    const editor = document.getElementById('templateEditor') as HTMLTextAreaElement;
    const id = editor.dataset.templateId;
    if (!id) return;
    await apiJson(`/api/prompt-templates/${id}`, 'PUT', { content: editor.value });
    const label = document.getElementById('templateEditorLabel');
    if (label) { label.textContent = '✅ 저장 + 핫리로드 완료!'; setTimeout(() => { label.textContent = `📄 ${id}.md`; }, 2000); }
    const t = _templates.find(x => x.id === id);
    if (t) t.content = editor.value;
}

function showTemplateView(view: 'tree' | 'editor'): void {
    const treeView = document.getElementById('templateTreeView');
    const editorView = document.getElementById('templateEditorView');
    if (treeView) treeView.style.display = view === 'tree' ? '' : 'none';
    if (editorView) editorView.style.display = view === 'editor' ? 'flex' : 'none';
    const title = document.getElementById('templateModalTitle');
    if (title && view === 'tree') title.textContent = '📝 프롬프트 구조';
}

export function templateGoBack(): void { showTemplateView('tree'); }

export function closeTemplateModal(e?: Event): void {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('templateModal')?.classList.remove('open');
}

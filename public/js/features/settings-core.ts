// ── Settings Core ──
import { MODEL_MAP, loadCliRegistry, getCliKeys, getCliMeta } from '../constants.js';
import { escapeHtml } from '../render.js';
import { syncStoredLocale } from '../locale.js';
import { t } from './i18n.js';
import { api, apiJson, apiFire } from '../api.js';
import type { PerCliConfig, SettingsData } from './settings-types.js';
import { initSttSettings } from './settings-stt.js';
import { loadTelegramSettings } from './settings-telegram.js';
import { loadDiscordSettings } from './settings-discord.js';
import { loadActiveChannel, loadFallbackOrder } from './settings-channel.js';
import { loadMcpServers } from './settings-mcp.js';
import { providerIcon } from '../provider-icons.js';

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

function normalizeModelForDisplay(cli: string, model: string): string {
    if (cli !== 'claude') return model;
    switch ((model || '').trim()) {
        case 'claude-sonnet-4-6': return 'sonnet';
        case 'claude-opus-4-6': return 'opus';
        case 'claude-sonnet-4-6[1m]': return 'sonnet[1m]';
        case 'claude-opus-4-6[1m]': return 'opus[1m]';
        default: return model;
    }
}

function syncPerCliModelAndEffortControls(settings: SettingsData | null = null): void {
    for (const cli of getCliKeys()) {
        const modelSel = getModelSelect(cli);
        if (modelSel) {
            const raw = settings?.perCli?.[cli]?.model || modelSel.value || '';
            const selected = normalizeModelForDisplay(cli, raw);
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
    if (headerEl) {
        const icon = providerIcon(s.cli);
        headerEl.innerHTML = icon ? `${icon} ${escapeHtml(s.cli)}` : escapeHtml(s.cli);
    }
    setPerm(s.permissions, false);

    if (s.perCli) {
        for (const [cli, cfg] of Object.entries(s.perCli) as [string, PerCliConfig][]) {
            const modelEl = getModelSelect(cli);
            const effortEl = getEffortSelect(cli);
            if (modelEl && cfg.model) {
                const displayModel = normalizeModelForDisplay(cli, cfg.model);
                appendCustomOption(modelEl, displayModel);
                modelEl.value = displayModel;
            }
            if (effortEl) effortEl.value = cfg.effort || '';
            if (cli === 'codex' && cfg.fastMode !== undefined) {
                document.getElementById('codexFastOn')?.classList.toggle('active', cfg.fastMode);
                document.getElementById('codexFastOff')?.classList.toggle('active', !cfg.fastMode);
            }
            if (cli === 'codex') {
                const ctxOn = !!cfg.contextWindow;
                document.getElementById('codexCtxOn')?.classList.toggle('active', ctxOn);
                document.getElementById('codexCtxOff')?.classList.toggle('active', !ctxOn);
                const valDiv = document.getElementById('codexCtxValues');
                if (valDiv) valDiv.style.display = ctxOn ? '' : 'none';
                const winInput = document.getElementById('codexCtxWindow') as HTMLInputElement | null;
                const compInput = document.getElementById('codexCtxCompact') as HTMLInputElement | null;
                if (winInput && cfg.contextWindowSize) winInput.value = String(cfg.contextWindowSize);
                if (compInput && cfg.contextCompactLimit) compInput.value = String(cfg.contextCompactLimit);
            }
            if (cli === 'claude') {
                const is1m = !!(cfg.model && String(cfg.model).endsWith('[1m]'));
                document.getElementById('claude1mOn')?.classList.toggle('active', is1m);
                document.getElementById('claude1mOff')?.classList.toggle('active', !is1m);
            }
        }
    }

    onCliChange(false);
    const ao = s.activeOverrides?.[s.cli] || {};
    const pc = s.perCli?.[s.cli] || {};
    const activeModel = ao.model || pc.model;
    const activeEffort = ao.effort || pc.effort || '';
    const selModel = document.getElementById('selModel') as HTMLSelectElement | null;
    if (activeModel && selModel) {
        const displayModel = normalizeModelForDisplay(s.cli, activeModel);
        if (displayModel && !Array.from(selModel.options).some(o => o.value === displayModel)) {
            appendCustomOption(selModel, displayModel);
        }
        selModel.value = displayModel;
    }
    syncActiveEffortOptions(s.cli, activeEffort);

    loadTelegramSettings(s);
    loadDiscordSettings(s);
    loadActiveChannel(s);
    loadFallbackOrder(s);
    loadMcpServers();
    initSttSettings(s.stt || {});
}

export async function updateSettings(): Promise<void> {
    const s = {
        cli: (document.getElementById('selCli') as HTMLSelectElement)?.value || 'claude',
    };
    const hdr = document.getElementById('headerCli');
    if (hdr) {
        const ico = providerIcon(s.cli);
        hdr.innerHTML = ico ? `${ico} ${escapeHtml(s.cli)}` : escapeHtml(s.cli);
    }
    await apiJson('/api/settings', 'PUT', s);
}

export function setPerm(_p: string, save = true): void {
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
        if (cli === 'claude') syncClaude1mToggle(selectEl.value);
        savePerCli();
    }
}

/** Sync Claude 1M toggle button state to match current model value */
function syncClaude1mToggle(model: string): void {
    const is1m = !!(model && model.endsWith('[1m]'));
    document.getElementById('claude1mOn')?.classList.toggle('active', is1m);
    document.getElementById('claude1mOff')?.classList.toggle('active', !is1m);
}

export function applyCustomModel(cli: string, inputEl: HTMLInputElement): void {
    const val = inputEl.value.trim();
    if (!val) return;
    const select = getModelSelect(cli);
    if (!select) return;
    appendCustomOption(select, val);
    select.value = val;
    inputEl.style.display = 'none';
    if (cli === 'claude') syncClaude1mToggle(val);
    savePerCli();
}

export async function savePerCli(): Promise<void> {
    const perCli: Record<string, PerCliConfig> = {};
    for (const cli of getCliKeys()) {
        const modelEl = getModelSelect(cli);
        if (!modelEl) continue;
        const effortEl = getEffortSelect(cli);
        const entry: PerCliConfig = {
            model: getModelValue(cli),
            effort: effortEl ? effortEl.value : '',
        };
        if (cli === 'codex') {
            const onBtn = document.getElementById('codexFastOn');
            entry.fastMode = onBtn?.classList.contains('active') ?? false;
            const ctxOn = document.getElementById('codexCtxOn');
            entry.contextWindow = ctxOn?.classList.contains('active') ?? false;
            const winInput = document.getElementById('codexCtxWindow') as HTMLInputElement | null;
            const compInput = document.getElementById('codexCtxCompact') as HTMLInputElement | null;
            entry.contextWindowSize = parseInt(winInput?.value || '1000000', 10);
            entry.contextCompactLimit = parseInt(compInput?.value || '900000', 10);
        }
        perCli[cli] = entry;
    }
    await apiJson('/api/settings', 'PUT', { perCli });
}

export function onCliChange(save = true): void {
    const cli = (document.getElementById('selCli') as HTMLSelectElement)?.value || 'claude';
    const models = MODEL_MAP[cli] || [];
    const modelSel = document.getElementById('selModel') as HTMLSelectElement | null;
    setSelectOptions(modelSel, models, { includeCustom: true, includeDefault: true });
    const hdrCli = document.getElementById('headerCli');
    if (hdrCli) {
        const ico = providerIcon(cli);
        hdrCli.innerHTML = ico ? `${ico} ${escapeHtml(cli)}` : escapeHtml(cli);
    }
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
            const displayModel = normalizeModelForDisplay(cli, model);
            appendCustomOption(modelSel, displayModel);
            modelSel.value = displayModel;
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

// ── Flush Agent Sidebar ──

export function onFlushCliChange(): void {
    const flushCli = (document.getElementById('flushCli') as HTMLSelectElement)?.value || '';
    const effectiveCli = flushCli || (document.getElementById('selCli') as HTMLSelectElement)?.value || 'claude';
    const models = MODEL_MAP[effectiveCli] || [];
    const flushModelSel = document.getElementById('flushModel') as HTMLSelectElement | null;
    setSelectOptions(flushModelSel, models, { includeDefault: true });
    updateFlushBadge();
    saveFlushAgentSettings();
}

export async function loadFlushAgentSidebar(): Promise<void> {
    const data = await api<{ cli?: string; model?: string }>('/api/memory-files');
    if (!data) return;
    const flushCliSel = document.getElementById('flushCli') as HTMLSelectElement | null;
    const flushModelSel = document.getElementById('flushModel') as HTMLSelectElement | null;
    if (flushCliSel && data.cli) flushCliSel.value = data.cli;

    const effectiveCli = data.cli || (document.getElementById('selCli') as HTMLSelectElement)?.value || 'claude';
    const models = MODEL_MAP[effectiveCli] || [];
    setSelectOptions(flushModelSel, models, { includeDefault: true });
    if (flushModelSel && data.model) {
        appendCustomOption(flushModelSel, data.model);
        flushModelSel.value = data.model;
    }
    updateFlushBadge();
}

async function saveFlushAgentSettings(): Promise<void> {
    const cli = (document.getElementById('flushCli') as HTMLSelectElement)?.value || '';
    const model = (document.getElementById('flushModel') as HTMLSelectElement)?.value || '';
    await apiJson('/api/memory-files/settings', 'PUT', { cli, model });
}

function updateFlushBadge(): void {
    const badge = document.getElementById('flushAgentBadge');
    if (!badge) return;
    const cli = (document.getElementById('flushCli') as HTMLSelectElement)?.value || '';
    const model = (document.getElementById('flushModel') as HTMLSelectElement)?.value || '';
    const parts: string[] = [];
    if (cli) parts.push(cli);
    if (model && model !== 'default') parts.push(model);
    badge.textContent = parts.length ? `(${parts.join(' / ')})` : '';
}

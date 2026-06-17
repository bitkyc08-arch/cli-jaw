// ── Settings Core ──
import { MODEL_MAP, loadCliRegistry, getCliKeys, getCliMeta, PRIMARY_CLIS } from '../constants.js';
import { escapeHtml } from '../render.js';
import { syncStoredLocale } from '../locale.js';
import { t } from './i18n.js';
import { api, apiJson, apiFire } from '../api.js';
import type { PerCliConfig, SettingsData } from './settings-types.js';
import { setCachedPi, syncPiProviderDropdown, syncPiModelDropdown, piDiscoveredModels } from './pi-settings.js';
import { initSttSettings } from './settings-stt.js';
import { loadTelegramSettings } from './settings-telegram.js';
import { loadDiscordSettings } from './settings-discord.js';
import { loadActiveChannel, loadFallbackOrder } from './settings-channel.js';
import { loadMcpServers } from './settings-mcp.js';
import { providerIcon, providerLabel } from '../provider-icons.js';
import { postPreviewInvalidate } from '../preview-parent-origin.js';
import { formatProjectLabel } from './project-label.js';
import { loadHeaderGitStatus, refreshHeaderGitStatusFromSettingsChange } from './project-git-status.js';

let activeSettingsSave: Promise<void> | null = null;

function setHeaderCli(cli: string): void {
    const hdr = document.getElementById('headerCli');
    if (!hdr) return;
    const ico = providerIcon(cli);
    const label = cliDisplayLabel(cli);
    hdr.innerHTML = ico ? `${ico} ${escapeHtml(label)}` : escapeHtml(label);
}

function setHeaderProject(dirs: readonly string[] | null | undefined): void {
    const el = document.getElementById('headerProject');
    if (!el) return;
    ensureHeaderProjectPicker(el);
    el.hidden = false;
    const label = formatProjectLabel(dirs);
    if (!label) {
        el.classList.add('is-empty');
        el.textContent = 'Project: not set';
        el.title = 'Click to choose the project root folder';
        return;
    }
    el.classList.remove('is-empty');
    el.textContent = `Project ${label.text}`;
    el.title = `${label.title}\n(click to change)`;
}

// #233 follow-up: the label doubles as a button — the server opens the OS
// folder chooser (Finder) and applies the picked folder as projectDirs.
function ensureHeaderProjectPicker(el: HTMLElement): void {
    if (el.dataset['pickerBound']) return;
    el.dataset['pickerBound'] = '1';
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    const pick = async (): Promise<void> => {
        if (el.classList.contains('is-picking')) return;
        el.classList.add('is-picking');
        const prevText = el.textContent;
        el.textContent = 'Choosing folder…';
        try {
            const result = await apiJson<{ projectDirs?: string[] | null; cancelled?: boolean }>('/api/project/pick', 'POST', {});
            if (result && !result.cancelled && 'projectDirs' in result) {
                el.classList.remove('is-picking');
                setHeaderProject(result.projectDirs);
                return;
            }
        } catch { /* fall through to restore */ }
        el.classList.remove('is-picking');
        el.textContent = prevText;
    };
    el.addEventListener('click', () => { void pick(); });
    el.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') { e.preventDefault(); void pick(); }
    });
}

/** SSE settings_change payload → header-only refresh (#233). Never re-runs
 *  loadSettings(): the event may fire on every settings save. */
export function refreshHeaderFromSettingsChange(msg: { cli?: string; projectDirs?: string[] | null }): void {
    if (typeof msg.cli === 'string' && msg.cli) setHeaderCli(msg.cli);
    if ('projectDirs' in msg) setHeaderProject(msg.projectDirs);
    refreshHeaderGitStatusFromSettingsChange(msg);
}

function cliDisplayLabel(cli: string): string {
    return getCliMeta(cli)?.label || providerLabel(cli) || cli;
}

function trackSettingsSave(promise: Promise<void>): Promise<void> {
    const tracked = promise.finally(() => {
        if (activeSettingsSave === tracked) activeSettingsSave = null;
    });
    activeSettingsSave = tracked;
    return tracked;
}

export async function waitForSettingsSaveIdle(): Promise<void> {
    const pending = activeSettingsSave;
    if (pending) await pending;
}

function toDomSuffix(cli: string): string {
    return cli
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

function getModelSelect(cli: string): HTMLSelectElement | null {
    return document.getElementById('model' + toDomSuffix(cli)) as HTMLSelectElement | null;
}

function getCustomModelInput(cli: string): HTMLInputElement | null {
    return document.getElementById('customModel' + toDomSuffix(cli)) as HTMLInputElement | null;
}

function getEffortSelect(cli: string): HTMLSelectElement | null {
    return document.getElementById('effort' + toDomSuffix(cli)) as HTMLSelectElement | null;
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
        const isPrimary = (cli: string) => PRIMARY_CLIS.includes(cli);
        const currentIsSecondary = !isPrimary(current) && cliKeys.includes(current);
        const wasExpanded = selCli.dataset['expanded'] === '1';
        const primary = cliKeys.filter(isPrimary);
        const secondary = cliKeys.filter(c => !isPrimary(c));
        const showAll = primary.length === 0 || currentIsSecondary || wasExpanded;

        let html = primary.map(cli => {
            const label = getCliMeta(cli)?.label || cli;
            return `<option value="${escapeHtml(cli)}">${escapeHtml(label)}</option>`;
        }).join('');

        if (secondary.length > 0) {
            if (showAll) {
                html += '<option disabled>──────</option>';
                html += secondary.map(cli => {
                    const label = getCliMeta(cli)?.label || cli;
                    return `<option value="${escapeHtml(cli)}">${escapeHtml(label)}</option>`;
                }).join('');
            } else {
                html += `<option value="__show_more__">${t('cli.showMore')}</option>`;
            }
        }
        selCli.innerHTML = html;
        if (Array.from(selCli.options).some(o => o.value === current)) selCli.value = current;
    }

    const flushCli = document.getElementById('flushCli') as HTMLSelectElement | null;
    if (flushCli) {
        const current = settings?.memory?.cli || flushCli.value || '';
        flushCli.innerHTML = '<option value="">(active CLI)</option>' +
            cliKeys.map(cli => `<option value="${escapeHtml(cli)}">${escapeHtml(cliDisplayLabel(cli))}</option>`).join('');
        if (Array.from(flushCli.options).some(o => o.value === current)) flushCli.value = current;
    }
}

function normalizeModelForDisplay(_cli: string, model: string): string {
    // Backend passes Claude model strings through unchanged so user-typed
    // pinned IDs (e.g. claude-opus-4-7) survive a refresh and reach
    // `claude --model` literally. The frontend just trims; it must not rewrite.
    return (model || '').trim();
}

function syncPerCliModelAndEffortControls(settings: SettingsData | null = null): void {
    for (const cli of getCliKeys()) {
        const meta = getCliMeta(cli);
        const aiEProvider = cli === 'ai-e' ? getSelectedAiEProvider() : '';
        const modelSel = getModelSelect(cli);
        if (modelSel) {
            if (meta?.modelNote) {
                modelSel.innerHTML = `<option value="">${escapeHtml(meta.modelNote)}</option>`;
                modelSel.title = meta.modelNote;
                modelSel.disabled = true;
            } else {
                const raw = settings?.perCli?.[cli]?.model || modelSel.value || '';
                const selected = normalizeModelForDisplay(cli, raw);
                const piProvider = cli === 'pi' ? (settings?.perCli?.['pi']?.provider || '') : '';
                const piModels = cli === 'pi' && piProvider ? piDiscoveredModels(settings?.pi, piProvider) : [];
                const models = cli === 'pi' && piModels.length
                    ? piModels
                    : cli === 'ai-e'
                    ? (meta?.modelsByProvider?.[aiEProvider] || MODEL_MAP[cli] || [])
                    : (MODEL_MAP[cli] || []);
                setSelectOptions(modelSel, models, { includeCustom: true, selected });
                if (selected && !Array.from(modelSel.options).some(o => o.value === selected)) {
                    appendCustomOption(modelSel, selected);
                    modelSel.value = selected;
                }
                modelSel.disabled = false;
            }
        }

        const effortSel = getEffortSelect(cli);
        if (effortSel) {
            const providerEfforts = cli === 'ai-e' && aiEProvider
                ? (meta?.effortsByProvider?.[aiEProvider] || [])
                : null;
            const options = [''].concat(providerEfforts || meta?.efforts || []);
            const selected = settings?.perCli?.[cli]?.effort ?? effortSel.value ?? '';
            const unique = [...new Set(options)];
            const noneLabel = (unique.length === 1 && !unique[0] && meta?.effortNote) ? meta.effortNote : '— none';
            effortSel.innerHTML = unique.map(v => {
                if (!v) return `<option value="">${escapeHtml(noneLabel)}</option>`;
                return `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`;
            }).join('');
            if (meta?.effortNote) effortSel.title = meta.effortNote;
            effortSel.disabled = (unique.length === 1 && !unique[0] && !!meta?.effortNote);
            if (Array.from(effortSel.options).some(o => o.value === selected)) effortSel.value = selected;
        }
    }
}

function syncActiveEffortOptions(cli: string, selected = ''): void {
    const selEffort = document.getElementById('selEffort') as HTMLSelectElement | null;
    if (!selEffort) return;
    const meta = getCliMeta(cli);
    const aiEProvider = getSelectedAiEProvider();
    const providerEfforts = cli === 'ai-e' && aiEProvider
        ? (meta?.effortsByProvider?.[aiEProvider] || [])
        : null;
    const effortsList = providerEfforts || meta?.efforts || [];
    if (meta?.effortNote && effortsList.length === 0) {
        selEffort.innerHTML = `<option value="">${escapeHtml(meta.effortNote)}</option>`;
        selEffort.title = meta.effortNote;
        selEffort.disabled = true;
        return;
    }
    const efforts = [''].concat(effortsList);
    const unique = [...new Set(efforts)];
    selEffort.innerHTML = unique.map(v => {
        if (!v) return '<option value="">— none</option>';
        return `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`;
    }).join('');
    selEffort.disabled = false;
    selEffort.title = meta?.effortNote || '';
    if (Array.from(selEffort.options).some(o => o.value === selected)) selEffort.value = selected;
}

function syncAiEProviderOptions(select: HTMLSelectElement | null, current: string, providers: string[]): string {
    if (!select) return current;
    select.innerHTML = providers.map(provider => (
        `<option value="${escapeHtml(provider)}">${escapeHtml(providerLabel(provider) || provider)}</option>`
    )).join('');
    if (Array.from(select.options).some(o => o.value === current)) select.value = current;
    else if (select.options.length > 0) select.value = select.options[0]?.value || current;
    return select.value || current;
}

function getSelectedAiEProvider(): string {
    const select = document.getElementById('selAiEProvider') as HTMLSelectElement | null;
    const perCliSelect = document.getElementById('providerAiE') as HTMLSelectElement | null;
    return select?.value || perCliSelect?.value || getCliMeta('ai-e')?.defaultProvider || 'claude';
}

function getPerCliAiEProvider(): string {
    const perCliSelect = document.getElementById('providerAiE') as HTMLSelectElement | null;
    return perCliSelect?.value || getSelectedAiEProvider();
}

function syncAiEProviderControl(settings: SettingsData | null, cli: string): string {
    const wrap = document.getElementById('aiEProviderWrap') as HTMLElement | null;
    const select = document.getElementById('selAiEProvider') as HTMLSelectElement | null;
    const perCliSelect = document.getElementById('providerAiE') as HTMLSelectElement | null;
    const meta = getCliMeta('ai-e');
    if (!meta?.providers?.length) return 'claude';
    const current = settings?.perCli?.['ai-e']?.provider
        || perCliSelect?.value
        || select?.value
        || meta.defaultProvider
        || 'claude';
    const selected = syncAiEProviderOptions(select, current, meta.providers);
    syncAiEProviderOptions(perCliSelect, selected, meta.providers);
    if (wrap) wrap.style.display = cli === 'ai-e' ? '' : 'none';
    return selected;
}

export async function loadSettings(): Promise<void> {
    await loadCliRegistry();
    const s = await api<SettingsData>('/api/settings');
    if (!s) return;
    syncStoredLocale(s.locale ?? '');
    syncCliOptionSelects(s);
    setCachedPi(s.pi);
    syncPiProviderDropdown(s.pi, s.perCli?.['pi']?.provider);
    if (s.perCli?.['pi']?.provider) syncPiModelDropdown(s.perCli['pi'].provider, s.pi);
    syncAiEProviderControl(s, s.cli || '');
    syncPerCliModelAndEffortControls(s);

    const selCli = document.getElementById('selCli') as HTMLSelectElement | null;
    if (selCli && Array.from(selCli.options).some(o => o.value === s.cli)) {
        selCli.value = s.cli;
        selCli.dataset['prev'] = s.cli;
    }
    const cwdEl = document.getElementById('inpCwd');
    if (cwdEl) cwdEl.textContent = s.workingDir;
    const headerEl = document.getElementById('headerCli');
    if (headerEl) {
        const icon = providerIcon(s.cli);
        const label = cliDisplayLabel(s.cli);
        headerEl.innerHTML = icon ? `${icon} ${escapeHtml(label)}` : escapeHtml(label);
    }
    setHeaderProject(s.projectDirs);
    await loadHeaderGitStatus();
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
    const activeEffort = ao.effort ?? pc.effort ?? '';
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
    const cli = (document.getElementById('selCli') as HTMLSelectElement)?.value || 'claude';
    const s: Record<string, unknown> = { cli };
    if (cli === 'ai-e') s['perCli'] = { 'ai-e': { provider: getSelectedAiEProvider() } };
    return trackSettingsSave((async () => {
        const result = await apiJson<SettingsData>('/api/settings', 'PUT', s);
        if (!result) {
            await loadSettings();
            return;
        }
        const confirmedCli = result.cli || cli;
        const selCli = document.getElementById('selCli') as HTMLSelectElement | null;
        if (selCli && Array.from(selCli.options).some(o => o.value === confirmedCli)) {
            selCli.value = confirmedCli;
            selCli.dataset['prev'] = confirmedCli;
        }
        setHeaderCli(confirmedCli);
        postPreviewInvalidate(['instances'], 'active-cli-changed');
    })());
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

export function onPerCliAiEProviderChange(): void {
    const provider = getPerCliAiEProvider();
    const activeProvider = document.getElementById('selAiEProvider') as HTMLSelectElement | null;
    if (activeProvider && Array.from(activeProvider.options).some(o => o.value === provider)) {
        activeProvider.value = provider;
    }
    syncPerCliModelAndEffortControls(null);
    const activeCli = (document.getElementById('selCli') as HTMLSelectElement | null)?.value || '';
    if (activeCli === 'ai-e') onCliChange(false);
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
        if (cli === 'ai-e') entry.provider = getPerCliAiEProvider();
        if (cli === 'pi') {
            const piProviderSel = document.getElementById('providerPi') as HTMLSelectElement | null;
            if (piProviderSel?.value) entry.provider = piProviderSel.value;
        }
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
    const selCli = document.getElementById('selCli') as HTMLSelectElement | null;
    if (!selCli) return;
    if (selCli.value === '__show_more__') {
        const prev = selCli.dataset['prev'] || getCliKeys()[0] || 'claude';
        selCli.dataset['expanded'] = '1';
        syncCliOptionSelects(null);
        if (Array.from(selCli.options).some(o => o.value === prev)) selCli.value = prev;
        try { selCli.showPicker(); } catch { /* user-gesture guard */ }
        return;
    }
    selCli.dataset['prev'] = selCli.value;
    const cli = selCli.value || 'claude';
    const aiEProvider = syncAiEProviderControl(null, cli);
    const meta = getCliMeta(cli);
    const models = cli === 'ai-e'
        ? (meta?.modelsByProvider?.[aiEProvider] || MODEL_MAP[cli] || [])
        : (MODEL_MAP[cli] || []);
    const modelSel = document.getElementById('selModel') as HTMLSelectElement | null;
    if (meta?.modelNote && modelSel) {
        modelSel.innerHTML = `<option value="">${escapeHtml(meta.modelNote)}</option>`;
        modelSel.title = meta.modelNote;
        modelSel.disabled = true;
    } else {
        setSelectOptions(modelSel, models, { includeCustom: true, includeDefault: true });
        if (modelSel) { modelSel.disabled = false; modelSel.title = ''; }
    }
    setHeaderCli(cli);
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
        const effort = ao.effort ?? pc.effort ?? '';
        if (model && modelSel) {
            if (cli === 'ai-e') {
                const savedProvider = s.perCli?.['ai-e']?.provider || 'claude';
                const currentProvider = getSelectedAiEProvider();
                if (savedProvider !== currentProvider) {
                    syncActiveEffortOptions(cli, effort);
                    return;
                }
            }
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
    const patch: Record<string, unknown> = { activeOverrides: overrides };
    if (cli === 'ai-e') patch['perCli'] = { 'ai-e': { provider: getSelectedAiEProvider() } };
    if (await apiJson('/api/settings', 'PUT', patch)) {
        postPreviewInvalidate(['instances'], 'active-cli-changed');
    }
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
    const effectiveCli = cli || (document.getElementById('selCli') as HTMLSelectElement)?.value || '';
    const parts: string[] = [];
    if (effectiveCli) parts.push(cli ? cliDisplayLabel(effectiveCli) : `${cliDisplayLabel(effectiveCli)}*`);
    if (model && model !== 'default') parts.push(model);
    badge.textContent = parts.length ? `(${parts.join(' / ')})` : '';
}

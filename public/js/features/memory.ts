// ── Memory Feature ──
import { escapeHtml } from '../render.js';
import { api, apiJson } from '../api.js';

interface MemoryFile {
    name: string;
    entries: number;
    size?: number;
}

interface MemoryData {
    enabled: boolean;
    flushEvery: number;
    cli?: string;
    model?: string;
    retentionDays: number;
    path: string;
    counter: number;
    files: MemoryFile[];
}

interface MemoryFileContent {
    name: string;
    content: string;
}

interface AdvancedMemoryStatus {
    enabled: boolean;
    provider: 'gemini' | 'vertex' | 'openai-compatible' | 'local' | string;
    state: string;
    initialized: boolean;
    storageRoot: string;
    routing?: { searchRead?: string; save?: string };
    indexState?: string;
    indexedFiles?: number;
    indexedChunks?: number;
    lastIndexedAt?: string | null;
    importStatus?: string;
    importedCounts?: { core?: number; markdown?: number; kv?: number; claude?: number };
    corruptedCount?: number;
    lastExpansion?: string[];
    lastError?: string;
}

interface AdvancedMemoryFiles {
    root: string;
    sections: Record<string, string[]>;
}

interface AdvancedMemoryConfig {
    enabled?: boolean;
    provider?: 'gemini' | 'vertex' | 'openai-compatible' | 'local' | string;
    model?: string;
    apiKeySet?: boolean;
    apiKeyLast4?: string;
    baseUrl?: string;
    vertexConfigSet?: boolean;
    bootstrap?: {
        useActiveCli?: boolean;
        cli?: string;
        model?: string;
    };
}

interface SettingsData {
    memoryAdvanced?: AdvancedMemoryConfig;
}

function $(id: string) {
    return document.getElementById(id);
}

function setText(id: string, value: string | number | null | undefined) {
    const el = $(id);
    if (el) el.textContent = value == null ? '' : String(value);
}

function setValue(id: string, value: string | number | null | undefined) {
    const el = $(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (el) el.value = value == null ? '' : String(value);
}

function setChecked(id: string, value: boolean) {
    const el = $(id) as HTMLInputElement | null;
    if (el) el.checked = !!value;
}

function syncSidebarBadge(status: AdvancedMemoryStatus | null, basicCount: number) {
    const sideBtn = $('memorySidebarBtn');
    if (!sideBtn) return;
    if (!status?.enabled) {
        sideBtn.textContent = `🧠 Memory (${basicCount})`;
        return;
    }
    const state = status.state === 'configured' ? 'Adv On' : status.state === 'not_initialized' ? 'Adv On' : status.state;
    sideBtn.textContent = `🧠 Memory · ${state}`;
}

function renderStatusBanner(status: AdvancedMemoryStatus | null) {
    const banner = $('advStatusBanner');
    if (!banner) return;
    if (!status?.enabled) {
        banner.style.display = 'none';
        banner.textContent = '';
        return;
    }
    banner.style.display = '';
    if (status.state === 'not_initialized') {
        banner.textContent = 'Advanced Memory is ON, but not initialized yet. Basic memory path is still active until initialization completes.';
        return;
    }
    if (status.indexState === 'not_indexed') {
        banner.textContent = 'Advanced Memory is configured. Search/Read will switch to advanced runtime after indexing becomes available.';
        return;
    }
    banner.textContent = `Advanced Memory active. search/read=${status.routing?.searchRead || 'basic'} / save=${status.routing?.save || 'basic'}`;
}

function renderBasicSettings(data: MemoryData) {
    $('memOn')?.classList.toggle('active', data.enabled);
    $('memOff')?.classList.toggle('active', !data.enabled);
    setValue('memFlushEvery', data.flushEvery);
    setValue('memCli', data.cli || '');
    setValue('memModel', data.model || '');
    setValue('memRetention', data.retentionDays);
    setText('memPath', data.path);
    setText('memCounter', data.counter);
    setText('memThreshold', data.flushEvery);
}

function toggleAdvancedProviderFields(provider: string) {
    const showGemini = provider === 'gemini';
    const showVertex = provider === 'vertex';
    const showOpenAi = provider === 'openai-compatible';
    document.querySelectorAll('.adv-gemini').forEach(el => (el as HTMLElement).style.display = showGemini ? '' : 'none');
    document.querySelectorAll('.adv-vertex').forEach(el => (el as HTMLElement).style.display = showVertex ? '' : 'none');
    document.querySelectorAll('.adv-openai').forEach(el => (el as HTMLElement).style.display = showOpenAi ? '' : 'none');
}

function toggleBootstrapFields() {
    const useActive = ($( 'advBootstrapUseActive') as HTMLInputElement | null)?.checked !== false;
    document.querySelectorAll('.adv-bootstrap-manual').forEach(el => (el as HTMLElement).style.display = useActive ? 'none' : '');
}

function renderAdvancedSetup(settings: SettingsData | null, status: AdvancedMemoryStatus | null) {
    const cfg = settings?.memoryAdvanced || {};
    const provider = cfg.provider || status?.provider || 'gemini';
    $('advOn')?.classList.toggle('active', !!status?.enabled);
    $('advOff')?.classList.toggle('active', !status?.enabled);
    setText('advEnabledBadge', status?.enabled ? `${status.state} (${status.indexState || '-'})` : 'disabled');
    setValue('advProvider', provider);
    toggleAdvancedProviderFields(String(provider));

    const geminiKey = $('advGeminiKey') as HTMLInputElement | null;
    if (geminiKey) geminiKey.placeholder = cfg.apiKeySet ? `✅ 입력됨 ····${cfg.apiKeyLast4 || ''}` : 'AIza...';
    const openaiKey = $('advOpenaiKey') as HTMLInputElement | null;
    if (openaiKey) openaiKey.placeholder = cfg.apiKeySet ? `✅ 입력됨 ····${cfg.apiKeyLast4 || ''}` : 'sk-...';

    const geminiModel = $('advGeminiModel') as HTMLSelectElement | null;
    const geminiModelCustom = $('advGeminiModelCustom') as HTMLInputElement | null;
    const savedGeminiModel = cfg.model || 'gemini-embedding-001';
    if (geminiModel) {
        const hasOption = Array.from(geminiModel.options).some(o => o.value === savedGeminiModel);
        if (hasOption) {
            geminiModel.value = savedGeminiModel;
            if (geminiModelCustom) geminiModelCustom.style.display = 'none';
        } else {
            geminiModel.value = '__custom__';
            if (geminiModelCustom) {
                geminiModelCustom.value = savedGeminiModel;
                geminiModelCustom.style.display = '';
            }
        }
    }
    setValue('advVertexConfig', cfg.vertexConfigSet ? '' : '');
    setValue('advVertexModel', cfg.model || 'gemini-embedding-001');
    setValue('advOpenaiBaseUrl', cfg.baseUrl || '');
    setValue('advOpenaiModel', cfg.model || '');
    setChecked('advBootstrapUseActive', cfg.bootstrap?.useActiveCli !== false);
    setValue('advBootstrapCli', cfg.bootstrap?.cli || '');
    setValue('advBootstrapModel', cfg.bootstrap?.model || '');
    toggleBootstrapFields();

    setChecked('advImportCore', true);
    setChecked('advImportMarkdown', true);
    setChecked('advImportKv', true);
    setChecked('advImportClaudeSession', true);
}

function renderAdvancedOps(status: AdvancedMemoryStatus | null) {
    setText('advIndexState', status?.indexState || status?.state || '-');
    setText('advStorageRoot', status?.storageRoot || '-');
    setText('advIndexedFiles', status?.indexedFiles || 0);
    setText('advIndexedChunks', status?.indexedChunks || 0);
    setText('advLastIndexedAt', status?.lastIndexedAt || '-');
    setText('advImportStatus', status?.importStatus || '-');
    setText('advCorruptedCount', status?.corruptedCount || 0);
    setText('advLastExpansion', (status?.lastExpansion || []).join(', ') || '-');
    setText('advLastError', status?.lastError || '-');
    const imported = status?.importedCounts || {};
    setText('advImportStatus', `${status?.importStatus || '-'} (core:${imported.core || 0} md:${imported.markdown || 0} kv:${imported.kv || 0} claude:${imported.claude || 0})`);
}

function renderBasicFiles(files: MemoryFile[]) {
    const container = $('basicMemoryFiles');
    if (!container) return;
    if (!files?.length) {
        container.innerHTML = '<p style="color:var(--text-dim);font-size:12px;text-align:center">No memory files yet</p>';
        return;
    }
    container.innerHTML = files.map(f => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border:1px solid var(--border);border-radius:4px;margin-bottom:4px;cursor:pointer"
             data-mem-view="${escapeHtml(f.name)}">
            <div>
                <span style="font-size:12px;font-family:monospace">${escapeHtml(f.name)}</span>
                <span style="font-size:10px;color:var(--accent);margin-left:6px">${f.entries} entries</span>
            </div>
            <button data-mem-delete="${escapeHtml(f.name)}" style="background:none;border:none;color:#f55;cursor:pointer;font-size:14px">🗑️</button>
        </div>
    `).join('');
}

function renderSimpleFileList(id: string, files: string[]) {
    const container = $(id);
    if (!container) return;
    if (!files?.length) {
        container.innerHTML = '<p style="color:var(--text-dim);font-size:12px;text-align:center">No files</p>';
        return;
    }
    container.innerHTML = files.map(f =>
        `<div style="padding:6px 8px;border:1px solid var(--border);border-radius:4px;margin-bottom:4px">
            <span style="font-size:12px;font-family:monospace">${escapeHtml(f)}</span>
        </div>`
    ).join('');
}

function renderAdvancedFiles(data: AdvancedMemoryFiles | null) {
    renderSimpleFileList('advancedMemoryFiles', [
        ...(data?.sections?.profile || []),
        ...(data?.sections?.shared || []),
        ...(data?.sections?.episodes || []),
        ...(data?.sections?.semantic || []),
        ...(data?.sections?.procedures || []),
        ...(data?.sections?.sessions || []),
    ]);
    renderSimpleFileList('corruptedMemoryFiles', data?.sections?.corrupted || []);
    renderSimpleFileList('legacyUnmappedFiles', data?.sections?.legacyUnmapped || []);
}

function getBootstrapOptions() {
    return {
        importCore: ($( 'advImportCore') as HTMLInputElement | null)?.checked !== false,
        importMarkdown: ($( 'advImportMarkdown') as HTMLInputElement | null)?.checked !== false,
        importKv: ($( 'advImportKv') as HTMLInputElement | null)?.checked !== false,
        importClaudeSession: ($( 'advImportClaudeSession') as HTMLInputElement | null)?.checked !== false,
    };
}

async function loadModalData() {
    const [basic, status, settings, files] = await Promise.all([
        api<MemoryData>('/api/memory-files'),
        api<AdvancedMemoryStatus>('/api/memory-advanced/status'),
        api<SettingsData>('/api/settings'),
        api<AdvancedMemoryFiles>('/api/memory-advanced/files'),
    ]);
    return { basic, status, settings, files };
}

export async function openMemoryModal(): Promise<void> {
    const { basic, status, settings, files } = await loadModalData();
    if (!basic) return;
    renderBasicSettings(basic);
    renderStatusBanner(status);
    renderAdvancedSetup(settings, status);
    renderAdvancedOps(status);
    renderBasicFiles(basic.files);
    renderAdvancedFiles(files);
    syncSidebarBadge(status, basic.files.length);
    $('memoryModal')?.classList.add('open');
}

export function closeMemoryModal(e?: Event): void {
    if (e && e.target !== e.currentTarget) return;
    $('memoryModal')?.classList.remove('open');
}

export function switchMemTab(tab: string): void {
    const tabs: Record<string, string> = {
        settings: 'memTabSettings',
        'adv-setup': 'memTabAdvSetup',
        'adv-ops': 'memTabAdvOps',
        files: 'memTabFiles',
    };
    for (const id of Object.values(tabs)) {
        const el = $(id);
        if (el) el.style.display = id === tabs[tab] ? '' : 'none';
    }
    $('memTabBtnSettings')?.classList.toggle('active', tab === 'settings');
    $('memTabBtnAdvSetup')?.classList.toggle('active', tab === 'adv-setup');
    $('memTabBtnAdvOps')?.classList.toggle('active', tab === 'adv-ops');
    $('memTabBtnFiles')?.classList.toggle('active', tab === 'files');
}

export async function setMemEnabled(v: boolean): Promise<void> {
    $('memOn')?.classList.toggle('active', v);
    $('memOff')?.classList.toggle('active', !v);
    await apiJson('/api/memory-files/settings', 'PUT', { enabled: v });
}

export async function saveMemSettings(): Promise<void> {
    const flushEl = $('memFlushEvery') as HTMLSelectElement | null;
    const cliEl = $('memCli') as HTMLSelectElement | null;
    const modelEl = $('memModel') as HTMLSelectElement | null;
    const retEl = $('memRetention') as HTMLSelectElement | null;
    await apiJson('/api/memory-files/settings', 'PUT', {
        flushEvery: +(flushEl?.value || 10),
        cli: cliEl?.value || '',
        model: modelEl?.value || '',
        retentionDays: +(retEl?.value || 30),
    });
    const thresholdEl = $('memThreshold');
    if (thresholdEl && flushEl) thresholdEl.textContent = flushEl.value;
}

export async function setAdvEnabled(v: boolean): Promise<void> {
    $('advOn')?.classList.toggle('active', v);
    $('advOff')?.classList.toggle('active', !v);
    await apiJson('/api/memory-advanced/settings', 'PUT', { enabled: v });
    await openMemoryModal();
}

export async function saveAdvancedMemorySettings(): Promise<void> {
    const provider = ( $('advProvider') as HTMLSelectElement | null)?.value || 'gemini';
    const patch: Record<string, any> = {
        provider,
        bootstrap: {
            useActiveCli: ( $('advBootstrapUseActive') as HTMLInputElement | null)?.checked !== false,
            cli: ( $('advBootstrapCli') as HTMLSelectElement | null)?.value || '',
            model: ( $('advBootstrapModel') as HTMLInputElement | null)?.value || '',
        },
    };

    if (provider === 'gemini') {
        const key = ( $('advGeminiKey') as HTMLInputElement | null)?.value || '';
        const sel = ( $('advGeminiModel') as HTMLSelectElement | null)?.value || 'gemini-embedding-001';
        const custom = ( $('advGeminiModelCustom') as HTMLInputElement | null)?.value || '';
        patch.model = sel === '__custom__' ? custom : sel;
        if (key) patch.apiKey = key;
    } else if (provider === 'vertex') {
        patch.vertexConfig = ( $('advVertexConfig') as HTMLTextAreaElement | null)?.value || '';
        patch.model = ( $('advVertexModel') as HTMLInputElement | null)?.value || 'gemini-embedding-001';
    } else if (provider === 'openai-compatible') {
        patch.baseUrl = ( $('advOpenaiBaseUrl') as HTMLInputElement | null)?.value || '';
        patch.model = ( $('advOpenaiModel') as HTMLInputElement | null)?.value || '';
        const key = ( $('advOpenaiKey') as HTMLInputElement | null)?.value || '';
        if (key) patch.apiKey = key;
    } else {
        patch.model = '';
    }

    const result = await apiJson<{ memoryAdvanced?: AdvancedMemoryConfig }>('/api/memory-advanced/settings', 'PUT', patch);
    const geminiKey = $('advGeminiKey') as HTMLInputElement | null;
    const openaiKey = $('advOpenaiKey') as HTMLInputElement | null;
    if (geminiKey?.value) {
        const l4 = geminiKey.value.slice(-4);
        geminiKey.value = '';
        geminiKey.placeholder = `✅ 입력됨 ····${l4}`;
    }
    if (openaiKey?.value) {
        const l4 = openaiKey.value.slice(-4);
        openaiKey.value = '';
        openaiKey.placeholder = `✅ 입력됨 ····${l4}`;
    }
    if (!result) return;
    await openMemoryModal();
}

export async function initializeAdvancedMemory(): Promise<void> {
    await apiJson('/api/memory-advanced/init', 'POST', {});
    await openMemoryModal();
    switchMemTab('adv-ops');
}

export async function rerunAdvancedBootstrap(): Promise<void> {
    const result = await apiJson<{ message?: string }>('/api/memory-advanced/bootstrap', 'POST', getBootstrapOptions());
    if (result?.message) alert(result.message);
    await openMemoryModal();
    switchMemTab('adv-ops');
}

export async function reindexAdvancedMemory(): Promise<void> {
    const result = await apiJson<{ message?: string }>('/api/memory-advanced/reindex', 'POST', {});
    if (result?.message) alert(result.message);
    await openMemoryModal();
    switchMemTab('adv-ops');
}

export function openCorruptedFolder(): void {
    const text = $('advStorageRoot')?.textContent || '';
    const path = text ? `${text}/corrupted` : 'JAW_HOME/memory-advanced/corrupted';
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(path).catch(() => { });
    }
    alert(`Corrupted folder path copied/shown:\n${path}`);
}

export async function deleteMemFile(name: string): Promise<void> {
    if (!confirm('Delete ' + name + '?')) return;
    await apiJson('/api/memory-files/' + name, 'DELETE', {});
    openMemoryModal();
}

export async function viewMemFile(name: string): Promise<void> {
    const data = await api<MemoryFileContent>('/api/memory-files/' + name);
    if (!data) return;
    const container = $('basicMemoryFiles');
    if (!container) return;
    container.innerHTML = `
        <div style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:12px;font-weight:600">${data.name}</span>
            <button data-mem-back style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:11px">← back</button>
        </div>
        <pre style="background:var(--bg);padding:8px;border-radius:4px;font-size:11px;white-space:pre-wrap;max-height:50vh;overflow-y:auto;color:var(--text)">${escapeHtml(data.content)}</pre>
    `;
}

export function bindAdvancedProviderUi(): void {
    const provider = $('advProvider') as HTMLSelectElement | null;
    provider?.addEventListener('change', () => toggleAdvancedProviderFields(provider.value));
    const geminiModel = $('advGeminiModel') as HTMLSelectElement | null;
    const custom = $('advGeminiModelCustom') as HTMLInputElement | null;
    geminiModel?.addEventListener('change', () => {
        if (!custom) return;
        custom.style.display = geminiModel.value === '__custom__' ? '' : 'none';
    });
    $('advBootstrapUseActive')?.addEventListener('change', toggleBootstrapFields);
}

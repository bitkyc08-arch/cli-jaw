// ── Memory Feature ──
import { escapeHtml } from '../render.js';
import { api, apiJson } from '../api.js';
import { ICONS } from '../icons.js';
import { t } from '../locale.js';
import { t as i18n } from './i18n.js';

interface MemoryFile {
    name: string;
    entries: number;
    size?: number;
}

interface MemoryData {
    enabled: boolean;
    flushEvery: number;
    retentionDays: number;
    flushLanguage?: string;
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
    // Phase 5-D: extended health fields
    profileFresh?: boolean;
    profileSourceHash?: string;
    coreSourceHash?: string;
    lastReflectedAt?: string | null;
    flushRunning?: boolean;
    migrationLocked?: boolean;
    staleWarnings?: string[];
    hasSoul?: boolean;
    soulSynthesized?: boolean;
}

interface AdvancedMemoryFiles {
    root: string;
    sections: Record<string, string[]>;
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
    if (status?.enabled && status?.hasSoul === false) {
        sideBtn.innerHTML = `${ICONS.brain} Memory · <span style="color:var(--accent)">${t('updateNeeded')}</span>`;
        return;
    }
    if (status?.enabled && status?.hasSoul && !status?.soulSynthesized) {
        sideBtn.innerHTML = `${ICONS.brain} Memory · <span style="color:var(--accent)">${i18n('memory.banner.soulOptimize')}</span>`;
        return;
    }
    const state = status?.indexState === 'ready'
        ? 'Ready'
        : status?.state === 'not_initialized'
            ? 'Indexing'
            : (status?.state || `(${basicCount})`);
    sideBtn.innerHTML = `${ICONS.brain} Memory · ${escapeHtml(state)}`;
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
    if (status.hasSoul === false) {
        banner.innerHTML = `<span>Memory structure upgrade available.</span>
            <button id="advUpgradeSoulBtn" class="btn-sm" style="margin-left:8px">${t('memoryUpdateBtn')}</button>`;
        return;
    }
    if (status.hasSoul && !status.soulSynthesized) {
        banner.innerHTML = `<span>Soul identity can be personalized with your active CLI.</span>
            <button id="advSynthesizeSoulBtn" class="btn-sm" style="margin-left:8px">${i18n('memory.banner.soulOptimize')}</button>`;
        return;
    }
    if (status.state === 'not_initialized') {
        banner.textContent = 'Integrated memory is preparing its index. Temporary fallback memory context is active until initialization completes.';
        return;
    }
    if (status.indexState === 'not_indexed') {
        banner.textContent = 'Integrated memory is configured. Indexed search/read will activate after indexing becomes available.';
        return;
    }
    banner.textContent = `Memory active. search/read=${status.routing?.searchRead || 'basic'} / save=${status.routing?.save || 'basic'}`;
}

function setAdvBanner(text: string, show = true) {
    const banner = $('advStatusBanner');
    if (!banner) return;
    banner.style.display = show ? '' : 'none';
    banner.textContent = text;
}

function setAdvBusy(busy: boolean) {
    const ids = ['advBootstrapBtn', 'advReindexBtn', 'advReimportBtn', 'advOpenCorruptedBtn'];
    for (const id of ids) {
        const el = $(id) as HTMLButtonElement | null;
        if (el) el.disabled = busy;
    }
}

function renderBasicSettings(data: MemoryData) {
    $('memOn')?.classList.toggle('active', data.enabled);
    $('memOff')?.classList.toggle('active', !data.enabled);
    setValue('memFlushEvery', data.flushEvery);
    setValue('memRetention', data.retentionDays);
    setValue('memFlushLang', data.flushLanguage || 'en');
    setText('memPath', data.path);
    setText('memCounter', data.counter);
    setText('memThreshold', data.flushEvery);
}

function updateBasicVisibility(status: AdvancedMemoryStatus | null) {
    const basicBtn = $('memTabBtnSettings') as HTMLElement | null;
    const basicTab = $('memTabSettings') as HTMLElement | null;
    if (!basicBtn || !basicTab) return;
    basicBtn.style.display = '';
    if (!basicTab.style.display) basicTab.style.display = '';
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

    // Phase 5-D: extended health fields
    setText('advProfileFresh', status?.profileFresh === false ? '⚠ stale' : '✓ fresh');
    setText('advLastReflectedAt', status?.lastReflectedAt || 'never');
    setText('advFlushRunning', status?.flushRunning ? 'running' : 'idle');
    setText('advMigrationLock', status?.migrationLocked ? '⚠ locked' : 'none');
    const warnings = status?.staleWarnings || [];
    setText('advWarnings', warnings.length ? warnings.join(', ') : 'none');
    setText('advSoulStatus', status?.hasSoul ? '✓ active' : '⚠ not created');
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
            <button data-mem-delete="${escapeHtml(f.name)}" style="background:none;border:none;color:#f55;cursor:pointer;font-size:14px">${ICONS.trash}</button>
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
        ...(data?.sections?.['profile'] || []),
        ...(data?.sections?.['shared'] || []),
        ...(data?.sections?.['episodes'] || []),
        ...(data?.sections?.['semantic'] || []),
        ...(data?.sections?.['procedures'] || []),
        ...(data?.sections?.['sessions'] || []),
    ]);
    renderSimpleFileList('corruptedMemoryFiles', data?.sections?.['corrupted'] || []);
    renderSimpleFileList('legacyUnmappedFiles', data?.sections?.['legacyUnmapped'] || []);
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
    const [basic, status, files] = await Promise.all([
        api<MemoryData>('/api/memory-files'),
        api<AdvancedMemoryStatus>('/api/memory/status'),
        api<AdvancedMemoryFiles>('/api/memory/files'),
    ]);
    return { basic, status, files };
}

export async function openMemoryModal(): Promise<void> {
    const { basic, status, files } = await loadModalData();
    if (!basic) return;
    renderBasicSettings(basic);
    updateBasicVisibility(status);
    renderStatusBanner(status);
    renderAdvancedOps(status);
    renderBasicFiles(basic.files);
    renderAdvancedFiles(files);
    syncSidebarBadge(status, basic.files.length);
    $('memoryModal')?.classList.add('open');
    switchMemTab('status');
}

export function closeMemoryModal(e?: Event): void {
    if (e && e.target !== e.currentTarget) return;
    $('memoryModal')?.classList.remove('open');
}

export function switchMemTab(tab: string): void {
    const tabs: Record<string, string> = {
        settings: 'memTabSettings',
        status: 'memTabAdvOps',
        files: 'memTabFiles',
    };
    for (const id of Object.values(tabs)) {
        const el = $(id);
        if (el) el.style.display = id === tabs[tab] ? '' : 'none';
    }
    $('memTabBtnSettings')?.classList.toggle('active', tab === 'settings');
    $('memTabBtnAdvOps')?.classList.toggle('active', tab === 'status');
    $('memTabBtnFiles')?.classList.toggle('active', tab === 'files');
    $('memTabBtnSettings')?.setAttribute('aria-selected', String(tab === 'settings'));
    $('memTabBtnAdvOps')?.setAttribute('aria-selected', String(tab === 'status'));
    $('memTabBtnFiles')?.setAttribute('aria-selected', String(tab === 'files'));
}

export async function setMemEnabled(v: boolean): Promise<void> {
    $('memOn')?.classList.toggle('active', v);
    $('memOff')?.classList.toggle('active', !v);
    await apiJson('/api/memory-files/settings', 'PUT', { enabled: v });
}

export async function saveMemSettings(): Promise<void> {
    const flushEl = $('memFlushEvery') as HTMLSelectElement | null;
    const retEl = $('memRetention') as HTMLSelectElement | null;
    const langEl = $('memFlushLang') as HTMLSelectElement | null;
    await apiJson('/api/memory-files/settings', 'PUT', {
        flushEvery: +(flushEl?.value || 10),
        retentionDays: +(retEl?.value || 30),
        flushLanguage: langEl?.value || 'en',
    });
    const thresholdEl = $('memThreshold');
    if (thresholdEl && flushEl) thresholdEl.textContent = flushEl.value;
}

export async function initializeAdvancedMemory(): Promise<void> {
    // legacy no-op path kept for compatibility; direct initialize button removed
    setAdvBanner('Integrated memory initializes automatically on startup.', true);
    switchMemTab('status');
}

export async function rerunAdvancedBootstrap(): Promise<void> {
    setAdvBusy(true);
    setAdvBanner(i18n('memory.banner.bootstrapRerun'), true);
    const result = await apiJson<{ message?: string }>('/api/memory/bootstrap', 'POST', getBootstrapOptions());
    setAdvBusy(false);
    if (result?.message) alert(result.message);
    await openMemoryModal();
    switchMemTab('status');
}

export async function upgradeSoulMemory(): Promise<void> {
    setAdvBusy(true);
    setAdvBanner(t('memoryUpdating'), true);
    const result = await apiJson<{
        activated: boolean;
        created: boolean;
        preview: string;
    }>('/api/jaw-memory/soul/activate', 'POST', {});
    setAdvBusy(false);
    if (result?.created) {
        setAdvBanner('✓ Soul identity created.');
    } else {
        setAdvBanner('✓ Soul already active.');
    }
    await openMemoryModal();
    switchMemTab('status');
    const freshStatus = await api<AdvancedMemoryStatus>('/api/memory/status');
    syncSidebarBadge(freshStatus, 0);
    renderStatusBanner(freshStatus);
}

export async function synthesizeSoul(): Promise<void> {
    setAdvBusy(true);
    setAdvBanner(i18n('memory.banner.soulOptimizing'), true);
    const result = await apiJson<{
        ok: boolean;
        reason?: string;
        action?: string;
    }>('/api/soul/bootstrap', 'POST', {});
    setAdvBusy(false);
    if (!result?.ok) {
        const msg = result?.reason === 'already_synthesized'
            ? '✓ Soul already optimized.'
            : result?.reason === 'no_active_agent'
                ? 'No active CLI agent. Please start an agent first.'
                : `Soul optimization failed: ${result?.reason || 'unknown'}`;
        setAdvBanner(msg);
        return;
    }
    setAdvBanner(i18n('memory.banner.soulPromptSent'));
    await openMemoryModal();
    switchMemTab('status');
    const freshStatus = await api<AdvancedMemoryStatus>('/api/memory/status');
    syncSidebarBadge(freshStatus, 0);
    renderStatusBanner(freshStatus);
}

export async function reindexAdvancedMemory(): Promise<void> {
    setAdvBusy(true);
    setAdvBanner(i18n('memory.banner.reindexing'), true);
    const result = await apiJson<{ message?: string }>('/api/memory/reindex', 'POST', {});
    setAdvBusy(false);
    if (result?.message) alert(result.message);
    await openMemoryModal();
    switchMemTab('status');
}

export function openCorruptedFolder(): void {
    const text = $('advStorageRoot')?.textContent || '';
    const path = text ? `${text}/corrupted` : 'JAW_HOME/memory/structured/corrupted';
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(path).catch(() => { });
    }
    alert(`Corrupted folder path copied/shown:\n${path}`);
}

export async function deleteMemFile(name: string): Promise<void> {
    if (!confirm('Delete ' + name + '?')) return;
    await apiJson('/api/memory-file?path=' + encodeURIComponent(name), 'DELETE', {});
    openMemoryModal();
}

export async function viewMemFile(name: string): Promise<void> {
    const data = await api<MemoryFileContent>('/api/memory-file?path=' + encodeURIComponent(name));
    if (!data) return;
    const container = $('basicMemoryFiles');
    if (!container) return;
    container.innerHTML = `
        <div style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:12px;font-weight:600">${escapeHtml(data.name)}</span>
            <button data-mem-back style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:11px">${ICONS.arrowLeft} back</button>
        </div>
        <pre style="background:var(--bg);padding:8px;border-radius:4px;font-size:11px;white-space:pre-wrap;max-height:50vh;overflow-y:auto;color:var(--text)">${escapeHtml(data.content)}</pre>
    `;
}

export function bindAdvancedProviderUi(): void {
    return;
}

/** Lightweight sidebar-only refresh triggered by WS memory_status events */
export async function refreshMemorySidebar(): Promise<void> {
    try {
        const [basic, status] = await Promise.all([
            api<MemoryData>('/api/memory-files'),
            api<AdvancedMemoryStatus>('/api/memory/status'),
        ]);
        syncSidebarBadge(status, basic?.files?.length || 0);
        renderStatusBanner(status);
    } catch { /* best effort */ }
}

export async function triggerFlushNow(): Promise<void> {
    const btn = $('memFlushNowBtn') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    const result = await apiJson('/api/jaw-memory/flush', 'POST', {});
    if (result) {
        if (btn) btn.textContent = '✅ Triggered';
        setTimeout(() => { if (btn) { btn.textContent = '🧠 Flush Now'; btn.disabled = false; } }, 2000);
    } else {
        if (btn) { btn.textContent = '❌ Failed'; btn.disabled = false; }
    }
}

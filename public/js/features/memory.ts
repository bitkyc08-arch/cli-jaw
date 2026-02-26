// ── Memory Feature ──
import { escapeHtml } from '../render.js';
import { api, apiJson } from '../api.js';

interface MemoryFile {
    name: string;
    entries: number;
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

export async function openMemoryModal(): Promise<void> {
    const data = await api<MemoryData>('/api/memory-files');
    if (!data) return;
    const $ = (id: string) => document.getElementById(id);

    $('memOn')?.classList.toggle('active', data.enabled);
    $('memOff')?.classList.toggle('active', !data.enabled);
    const flushEl = $('memFlushEvery') as HTMLSelectElement | null;
    if (flushEl) flushEl.value = String(data.flushEvery);
    const cliEl = $('memCli') as HTMLSelectElement | null;
    if (cliEl) cliEl.value = data.cli || '';
    const modelEl = $('memModel') as HTMLSelectElement | null;
    if (modelEl) modelEl.value = data.model || '';
    const retEl = $('memRetention') as HTMLSelectElement | null;
    if (retEl) retEl.value = String(data.retentionDays);
    const pathEl = $('memPath');
    if (pathEl) pathEl.textContent = data.path;
    const counterEl = $('memCounter');
    if (counterEl) counterEl.textContent = String(data.counter);
    const thresholdEl = $('memThreshold');
    if (thresholdEl) thresholdEl.textContent = String(data.flushEvery);
    renderMemFiles(data.files);
    const sideBtn = $('memorySidebarBtn');
    if (sideBtn) sideBtn.textContent = `🧠 Memory (${data.files.length})`;
    $('memoryModal')?.classList.add('open');
}

export function closeMemoryModal(e?: Event): void {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('memoryModal')?.classList.remove('open');
}

export function switchMemTab(tab: string): void {
    const settingsTab = document.getElementById('memTabSettings');
    const filesTab = document.getElementById('memTabFiles');
    if (settingsTab) settingsTab.style.display = tab === 'settings' ? '' : 'none';
    if (filesTab) filesTab.style.display = tab === 'files' ? '' : 'none';
    document.getElementById('memTabBtnSettings')?.classList.toggle('active', tab === 'settings');
    document.getElementById('memTabBtnFiles')?.classList.toggle('active', tab === 'files');
}

export async function setMemEnabled(v: boolean): Promise<void> {
    document.getElementById('memOn')?.classList.toggle('active', v);
    document.getElementById('memOff')?.classList.toggle('active', !v);
    await apiJson('/api/memory-files/settings', 'PUT', { enabled: v });
}

export async function saveMemSettings(): Promise<void> {
    const flushEl = document.getElementById('memFlushEvery') as HTMLSelectElement | null;
    const cliEl = document.getElementById('memCli') as HTMLSelectElement | null;
    const modelEl = document.getElementById('memModel') as HTMLSelectElement | null;
    const retEl = document.getElementById('memRetention') as HTMLSelectElement | null;
    await apiJson('/api/memory-files/settings', 'PUT', {
        flushEvery: +(flushEl?.value || 10),
        cli: cliEl?.value || '',
        model: modelEl?.value || '',
        retentionDays: +(retEl?.value || 30),
    });
    const thresholdEl = document.getElementById('memThreshold');
    if (thresholdEl && flushEl) thresholdEl.textContent = flushEl.value;
}

function renderMemFiles(files: MemoryFile[]): void {
    const container = document.getElementById('memFilesList');
    if (!container) return;
    if (!files || files.length === 0) {
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

export async function deleteMemFile(name: string): Promise<void> {
    if (!confirm('Delete ' + name + '?')) return;
    await apiJson('/api/memory-files/' + name, 'DELETE', null);
    openMemoryModal();
}

export async function viewMemFile(name: string): Promise<void> {
    const data = await api<MemoryFileContent>('/api/memory-files/' + name);
    if (!data) return;
    const container = document.getElementById('memFilesList');
    if (!container) return;
    container.innerHTML = `
        <div style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:12px;font-weight:600">${data.name}</span>
            <button data-mem-back style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:11px">← back</button>
        </div>
        <pre style="background:var(--bg);padding:8px;border-radius:4px;font-size:11px;white-space:pre-wrap;max-height:50vh;overflow-y:auto;color:var(--text)">${escapeHtml(data.content)}</pre>
    `;
}

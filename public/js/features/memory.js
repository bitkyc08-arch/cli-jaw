// ── Memory Feature ──
import { escapeHtml } from '../render.js';
import { api, apiJson, apiFire } from '../api.js';

export async function openMemoryModal() {
    const data = await api('/api/memory-files');
    if (!data) return;
    document.getElementById('memOn').classList.toggle('active', data.enabled);
    document.getElementById('memOff').classList.toggle('active', !data.enabled);
    document.getElementById('memFlushEvery').value = data.flushEvery;
    document.getElementById('memCli').value = data.cli || '';
    document.getElementById('memModel').value = data.model || '';
    document.getElementById('memRetention').value = data.retentionDays;
    document.getElementById('memPath').textContent = data.path;
    document.getElementById('memCounter').textContent = data.counter;
    document.getElementById('memThreshold').textContent = data.flushEvery;
    renderMemFiles(data.files);
    document.getElementById('memorySidebarBtn').textContent = `🧠 Memory (${data.files.length})`;
    document.getElementById('memoryModal').classList.add('open');
}

export function closeMemoryModal(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('memoryModal').classList.remove('open');
}

export function switchMemTab(tab) {
    document.getElementById('memTabSettings').style.display = tab === 'settings' ? '' : 'none';
    document.getElementById('memTabFiles').style.display = tab === 'files' ? '' : 'none';
    document.getElementById('memTabBtnSettings').classList.toggle('active', tab === 'settings');
    document.getElementById('memTabBtnFiles').classList.toggle('active', tab === 'files');
}

export async function setMemEnabled(v) {
    document.getElementById('memOn').classList.toggle('active', v);
    document.getElementById('memOff').classList.toggle('active', !v);
    await apiJson('/api/memory-files/settings', 'PUT', { enabled: v });
}

export async function saveMemSettings() {
    await apiJson('/api/memory-files/settings', 'PUT', {
        flushEvery: +document.getElementById('memFlushEvery').value,
        cli: document.getElementById('memCli').value,
        model: document.getElementById('memModel').value,
        retentionDays: +document.getElementById('memRetention').value,
    });
    document.getElementById('memThreshold').textContent = document.getElementById('memFlushEvery').value;
}

function renderMemFiles(files) {
    const container = document.getElementById('memFilesList');
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

export async function deleteMemFile(name) {
    if (!confirm('Delete ' + name + '?')) return;
    await apiJson('/api/memory-files/' + name, 'DELETE');
    openMemoryModal();
}

export async function viewMemFile(name) {
    const data = await api('/api/memory-files/' + name);
    if (!data) return;
    const container = document.getElementById('memFilesList');
    container.innerHTML = `
        <div style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:12px;font-weight:600">${data.name}</span>
            <button data-mem-back style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:11px">← back</button>
        </div>
        <pre style="background:var(--bg);padding:8px;border-radius:4px;font-size:11px;white-space:pre-wrap;max-height:50vh;overflow-y:auto;color:var(--text)">${escapeHtml(data.content)}</pre>
    `;
}

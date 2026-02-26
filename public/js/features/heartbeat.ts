// ── Heartbeat Feature ──
import { state } from '../state.js';
import { t } from './i18n.js';
import { api, apiJson } from '../api.js';
import { escapeHtml } from '../render.js';

interface HeartbeatJob {
    id: string;
    name?: string;
    enabled: boolean;
    schedule?: { kind?: string; minutes?: number };
    prompt?: string;
}

interface HeartbeatData {
    jobs: HeartbeatJob[];
}

export async function openHeartbeatModal(): Promise<void> {
    const data = await api<HeartbeatData>('/api/heartbeat');
    state.heartbeatJobs = data?.jobs || [];
    renderHeartbeatJobs();
    document.getElementById('heartbeatModal')?.classList.add('open');
}

export function closeHeartbeatModal(e?: Event): void {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('heartbeatModal')?.classList.remove('open');
}

export function renderHeartbeatJobs(): void {
    const container = document.getElementById('hbJobsList');
    if (!container) return;
    const jobs = state.heartbeatJobs as HeartbeatJob[];
    if (jobs.length === 0) {
        container.innerHTML = `<p style="color:var(--text-dim);font-size:12px;text-align:center">${t('hb.empty')}</p>`;
    } else {
        container.innerHTML = jobs.map((job, i) => `
            <div class="hb-job-card">
                <div class="hb-job-header">
                    <input type="text" value="${escapeHtml(job.name || '')}" placeholder="${t('hb.name')}"
                        data-hb-name="${i}">
                    <span style="font-size:11px;color:var(--text-dim)">every</span>
                    <input type="number" value="${job.schedule?.minutes || 5}" min="1"
                        data-hb-minutes="${i}">
                    <span style="font-size:11px;color:var(--text-dim)">min</span>
                    <button class="hb-toggle ${job.enabled ? 'on' : 'off'}"
                        data-hb-toggle="${i}"></button>
                    <button class="hb-del" data-hb-remove="${i}">✕</button>
                </div>
                <textarea class="hb-prompt" rows="2" placeholder="${t('hb.prompt')}"
                    data-hb-prompt="${i}">${escapeHtml(job.prompt || '')}</textarea>
            </div>
        `).join('');
    }
    const active = jobs.filter(j => j.enabled).length;
    const btn = document.getElementById('hbSidebarBtn');
    if (btn) btn.textContent = `💓 Heartbeat (${active})`;
}

export function addHeartbeatJob(): void {
    (state.heartbeatJobs as HeartbeatJob[]).push({
        id: 'hb_' + Date.now(),
        name: '',
        enabled: true,
        schedule: { kind: 'every', minutes: 5 },
        prompt: ''
    });
    renderHeartbeatJobs();
    saveHeartbeatJobs();
}

export function removeHeartbeatJob(i: number): void {
    state.heartbeatJobs.splice(i, 1);
    renderHeartbeatJobs();
    saveHeartbeatJobs();
}

export function toggleHeartbeatJob(i: number): void {
    const jobs = state.heartbeatJobs as HeartbeatJob[];
    jobs[i].enabled = !jobs[i].enabled;
    renderHeartbeatJobs();
    saveHeartbeatJobs();
}

export async function saveHeartbeatJobs(): Promise<void> {
    await apiJson('/api/heartbeat', 'PUT', { jobs: state.heartbeatJobs });
}

export async function initHeartbeatBadge(): Promise<void> {
    try {
        const d = await api<HeartbeatData>('/api/heartbeat');
        const active = (d?.jobs || []).filter(j => j.enabled).length;
        const btn = document.getElementById('hbSidebarBtn');
        if (btn) btn.textContent = `💓 Heartbeat (${active})`;
    } catch { /* ignore */ }
}

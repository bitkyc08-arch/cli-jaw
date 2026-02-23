// ── Heartbeat Feature ──
import { state } from '../state.js';

export async function openHeartbeatModal() {
    const r = await fetch('/api/heartbeat');
    const data = await r.json();
    state.heartbeatJobs = data.jobs || [];
    renderHeartbeatJobs();
    document.getElementById('heartbeatModal').classList.add('open');
}

export function closeHeartbeatModal(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('heartbeatModal').classList.remove('open');
}

export function renderHeartbeatJobs() {
    const container = document.getElementById('hbJobsList');
    if (state.heartbeatJobs.length === 0) {
        container.innerHTML = '<p style="color:var(--text-dim);font-size:12px;text-align:center">하트비트가 없습니다</p>';
    } else {
        container.innerHTML = state.heartbeatJobs.map((job, i) => `
            <div class="hb-job-card">
                <div class="hb-job-header">
                    <input type="text" value="${job.name || ''}" placeholder="이름"
                        data-hb-name="${i}">
                    <span style="font-size:11px;color:var(--text-dim)">every</span>
                    <input type="number" value="${job.schedule?.minutes || 5}" min="1"
                        data-hb-minutes="${i}">
                    <span style="font-size:11px;color:var(--text-dim)">min</span>
                    <button class="hb-toggle ${job.enabled ? 'on' : 'off'}"
                        data-hb-toggle="${i}"></button>
                    <button class="hb-del" data-hb-remove="${i}">✕</button>
                </div>
                <textarea class="hb-prompt" rows="2" placeholder="프롬프트..."
                    data-hb-prompt="${i}">${job.prompt || ''}</textarea>
            </div>
        `).join('');
    }
    const active = state.heartbeatJobs.filter(j => j.enabled).length;
    document.getElementById('hbSidebarBtn').textContent = `💓 Heartbeat (${active})`;
}

export function addHeartbeatJob() {
    state.heartbeatJobs.push({
        id: 'hb_' + Date.now(),
        name: '',
        enabled: true,
        schedule: { kind: 'every', minutes: 5 },
        prompt: ''
    });
    renderHeartbeatJobs();
    saveHeartbeatJobs();
}

export function removeHeartbeatJob(i) {
    state.heartbeatJobs.splice(i, 1);
    renderHeartbeatJobs();
    saveHeartbeatJobs();
}

export function toggleHeartbeatJob(i) {
    state.heartbeatJobs[i].enabled = !state.heartbeatJobs[i].enabled;
    renderHeartbeatJobs();
    saveHeartbeatJobs();
}

export async function saveHeartbeatJobs() {
    await fetch('/api/heartbeat', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobs: state.heartbeatJobs }),
    });
}

export async function initHeartbeatBadge() {
    try {
        const r = await fetch('/api/heartbeat');
        const d = await r.json();
        const active = (d.jobs || []).filter(j => j.enabled).length;
        document.getElementById('hbSidebarBtn').textContent = `💓 Heartbeat (${active})`;
    } catch { }
}

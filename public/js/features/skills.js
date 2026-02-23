// ── Skills Feature ──
import { state } from '../state.js';

export async function loadSkills() {
    try {
        const res = await fetch('/api/skills');
        state.allSkills = await res.json();
        renderSkills();
    } catch (e) {
        document.getElementById('skillsList').innerHTML =
            `<div style="color:var(--text-dim);font-size:11px">스킬 로드 실패</div>`;
    }
}

export function renderSkills() {
    const list = document.getElementById('skillsList');
    const count = document.getElementById('skillsCount');
    let filtered = state.allSkills;
    if (state.currentSkillFilter === 'installed') {
        filtered = state.allSkills.filter(s => s.enabled);
    } else if (state.currentSkillFilter !== 'all') {
        filtered = state.allSkills.filter(s => s.category === state.currentSkillFilter);
    }
    const enabledCount = state.allSkills.filter(s => s.enabled).length;
    count.textContent = `활성 ${enabledCount}개 / 전체 ${state.allSkills.length}개`;

    list.innerHTML = filtered.map(s => {
        const reqParts = [];
        if (s.requires?.env) reqParts.push('🔑 ' + s.requires.env.join(', '));
        if (s.requires?.bins) reqParts.push('⚙️ ' + s.requires.bins.join(', '));
        if (s.install) reqParts.push(s.install);
        return `
        <div class="skill-card ${s.enabled ? 'enabled' : ''}">
            <div class="skill-card-header">
                <span class="skill-emoji">${s.emoji || '🔧'}</span>
                <span class="skill-name">${s.name || s.id}</span>
                <button class="skill-toggle ${s.enabled ? 'on' : 'off'}"
                        data-skill-id="${s.id}" data-skill-enabled="${s.enabled}"></button>
            </div>
            <div class="skill-desc">${s.description || ''}</div>
            ${reqParts.length ? `<div class="skill-req">${reqParts.join(' · ')}</div>` : ''}
        </div>`;
    }).join('');
}

export async function toggleSkill(id, currentlyEnabled) {
    const endpoint = currentlyEnabled ? '/api/skills/disable' : '/api/skills/enable';
    try {
        await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
        await loadSkills();
    } catch (e) {
        console.error('toggleSkill error:', e);
    }
}

export function filterSkills(cat, btn) {
    state.currentSkillFilter = cat;
    document.querySelectorAll('.skill-filter').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderSkills();
}

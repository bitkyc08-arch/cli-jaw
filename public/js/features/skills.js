// ── Skills Feature ──
import { state } from '../state.js';
import { t, fetchWithLocale } from './i18n.js';
import { apiJson } from '../api.js';
import { escapeHtml } from '../render.js';

export async function loadSkills() {
    try {
        const res = await fetchWithLocale('/api/skills');
        state.allSkills = await res.json();
        renderSkills();
    } catch (e) {
        document.getElementById('skillsList').innerHTML =
            `<div style="color:var(--text-dim);font-size:11px">${t('skill.loadFail')}</div>`;
    }
}

const KNOWN_CATS = ['productivity', 'communication', 'devtools', 'ai-media', 'utility', 'smarthome', 'automation'];

export function renderSkills() {
    const list = document.getElementById('skillsList');
    const count = document.getElementById('skillsCount');
    let filtered = state.allSkills;
    if (state.currentSkillFilter === 'installed') {
        filtered = state.allSkills.filter(s => s.enabled);
    } else if (state.currentSkillFilter === 'other') {
        filtered = state.allSkills.filter(s => !KNOWN_CATS.includes(s.category));
    } else if (state.currentSkillFilter !== 'all') {
        filtered = state.allSkills.filter(s => s.category === state.currentSkillFilter);
    }
    const enabledCount = state.allSkills.filter(s => s.enabled).length;
    count.textContent = t('skill.count', { active: enabledCount, total: state.allSkills.length });

    list.innerHTML = filtered.map(s => {
        const reqParts = [];
        if (s.requires?.env) reqParts.push('🔑 ' + s.requires.env.join(', '));
        if (s.requires?.bins) reqParts.push('⚙️ ' + s.requires.bins.join(', '));
        if (s.install) reqParts.push(s.install);
        return `
        <div class="skill-card ${s.enabled ? 'enabled' : ''}">
            <div class="skill-card-header">
                <span class="skill-emoji">${escapeHtml(s.emoji || '🔧')}</span>
                <span class="skill-name">${escapeHtml(s.name || s.id)}</span>
                <button class="skill-toggle ${s.enabled ? 'on' : 'off'}"
                        data-skill-id="${escapeHtml(s.id)}" data-skill-enabled="${s.enabled}"></button>
            </div>
            <div class="skill-desc">${escapeHtml(s.description || '')}</div>
            ${reqParts.length ? `<div class="skill-req">${reqParts.join(' · ')}</div>` : ''}
        </div>`;
    }).join('');
}

export async function toggleSkill(id, currentlyEnabled) {
    const endpoint = currentlyEnabled ? '/api/skills/disable' : '/api/skills/enable';
    try {
        await apiJson(endpoint, 'POST', { id });
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

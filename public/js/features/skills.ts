// ── Skills Feature ──
import { state } from '../state.js';
import { t, fetchWithLocale } from './i18n.js';
import { apiJson } from '../api.js';
import { escapeHtml } from '../render.js';

interface SkillItem {
    id: string;
    name?: string;
    description?: string;
    emoji?: string;
    category?: string;
    enabled: boolean;
    requires?: { env?: string[]; bins?: string[] };
    install?: string;
}

const KNOWN_CATS = ['productivity', 'communication', 'devtools', 'ai-media', 'utility', 'smarthome', 'automation'];

export async function loadSkills(): Promise<void> {
    try {
        const res = await fetchWithLocale('/api/skills');
        state.allSkills = await res.json();
        renderSkills();
    } catch {
        const el = document.getElementById('skillsList');
        if (el) el.innerHTML = `<div style="color:var(--text-dim);font-size:11px">${t('skill.loadFail')}</div>`;
    }
}

export function renderSkills(): void {
    const list = document.getElementById('skillsList');
    const count = document.getElementById('skillsCount');
    if (!list || !count) return;
    const skills = state.allSkills as SkillItem[];
    let filtered = skills;
    if (state.currentSkillFilter === 'installed') {
        filtered = skills.filter(s => s.enabled);
    } else if (state.currentSkillFilter === 'other') {
        filtered = skills.filter(s => !KNOWN_CATS.includes(s.category || ''));
    } else if (state.currentSkillFilter !== 'all') {
        filtered = skills.filter(s => s.category === state.currentSkillFilter);
    }
    const enabledCount = skills.filter(s => s.enabled).length;
    count.textContent = t('skill.count', { active: enabledCount, total: skills.length });

    list.innerHTML = filtered.map(s => {
        const reqParts: string[] = [];
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

export async function toggleSkill(id: string, currentlyEnabled: boolean): Promise<void> {
    const endpoint = currentlyEnabled ? '/api/skills/disable' : '/api/skills/enable';
    try {
        await apiJson(endpoint, 'POST', { id });
        await loadSkills();
    } catch (e) {
        console.error('toggleSkill error:', e);
    }
}

export function filterSkills(cat: string, btn?: Element): void {
    state.currentSkillFilter = cat;
    document.querySelectorAll('.skill-filter').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderSkills();
}

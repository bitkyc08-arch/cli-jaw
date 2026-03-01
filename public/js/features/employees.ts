// ── Employees Feature ──
import { state } from '../state.js';
import { MODEL_MAP, ROLE_PRESETS, getCliKeys } from '../constants.js';
import type { RolePreset } from '../constants.js';
import { escapeHtml } from '../render.js';
import { getAgentPhase } from '../ws.js';
import { t } from './i18n.js';
import { api, apiJson, apiFire } from '../api.js';

interface Employee {
    id: string;
    name?: string;
    cli: string;
    model?: string;
    role?: string;
    status?: string;
    phase?: string;
    phaseLabel?: string;
}

const LEGACY_MAP: Record<string, string> = {
    'React/Vue 기반 UI 컴포넌트 개발, 스타일링': 'frontend',
    'API 서버, DB 스키마, 비즈니스 로직 구현': 'backend',
    '프론트엔드와 백엔드 모두 담당': 'frontend',
    'CI/CD, Docker, 인프라 자동화': 'backend',
    '테스트 작성, 버그 재현, 품질 관리': 'custom',
    '데이터 파이프라인, ETL, 분석 쿼리': 'data',
    'API 문서화, README, 가이드 작성': 'docs',
    'UI/UX 구현, CSS, 컴포넌트 개발': 'frontend',
    'API, DB, 서버 로직 구현': 'backend',
    '데이터 파이프라인, 분석, ML': 'data',
    '문서화, README, API docs': 'docs',
    'UI/UX, CSS, components': 'frontend',
    'API, DB, server logic': 'backend',
    'Data pipeline, analysis, ML': 'data',
    'Documentation, README, API docs': 'docs',
};

const PHASE_COLORS: Record<string, string> = {
    '1': '#60a5fa', '2': '#a78bfa', '3': '#34d399', '4': '#fbbf24', '5': '#f472b6'
};

export async function loadEmployees(): Promise<void> {
    const data = await api<Employee[]>('/api/employees');
    state.employees = data || [];
    renderEmployees();
}

export function renderEmployees(): void {
    const el = document.getElementById('employeesList');
    if (!el) return;
    const employees = state.employees as Employee[];
    if (employees.length === 0) {
        el.innerHTML = `<div style="color:var(--text-dim);font-size:11px;padding:4px 0">${t('emp.addPrompt')}</div>`;
        return;
    }
    const cliKeys = getCliKeys();
    el.innerHTML = employees.map(a => {
        const models = MODEL_MAP[a.cli] || [];
        const legacyVal = LEGACY_MAP[a.role || ''];
        const matched: RolePreset | undefined = legacyVal
            ? ROLE_PRESETS.find(r => r.value === legacyVal)
            : ROLE_PRESETS.find(r => r.prompt === a.role);
        const presetVal = matched ? matched.value : (a.role ? 'custom' : 'frontend');
        const isCustom = presetVal === 'custom';

        const ps = getAgentPhase(a.id);
        const p = ps?.phase || a.phase;
        const pl = ps?.phaseLabel || a.phaseLabel;
        const phaseBadge = p
            ? `<span style="background:${PHASE_COLORS[p] || '#888'};color:#000;padding:1px 6px;border-radius:9px;font-size:9px">${pl || 'P' + p}</span>`
            : '';

        return `
        <div class="settings-group" style="margin-bottom:8px;padding:8px 10px">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
                <span style="width:8px;height:8px;border-radius:50%;background:var(--accent);display:inline-block;flex-shrink:0"></span>
                <input style="flex:1;background:none;border:none;color:var(--text);font-size:12px;font-weight:600;font-family:inherit;outline:none"
                       value="${escapeHtml(a.name || 'Agent')}"
                       data-emp-name="${a.id}">
                <button style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:12px" data-emp-delete="${a.id}" title="${t('emp.delete')}">✕</button>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:4px">
                <div>
                    <label>CLI</label>
                    <select data-emp-cli="${a.id}">
                        ${cliKeys.map(c => `<option${a.cli === c ? ' selected' : ''}>${c}</option>`).join('')}
                    </select>
                </div>
                <div>
                    <label>Model</label>
                    <select data-emp-model="${a.id}">
                        <option value="default"${(!a.model || a.model === 'default') ? ' selected' : ''}>default</option>
                        ${models.map(m => `<option${a.model === m ? ' selected' : ''}>${m}</option>`).join('')}
                        ${a.model && a.model !== 'default' && !models.includes(a.model) ? `<option selected>${a.model}</option>` : ''}
                        <option value="__custom__">${t('emp.customModel')}</option>
                    </select>
                </div>
            </div>
            <div>
                <label>Role</label>
                <select data-emp-role="${a.id}">
                    ${ROLE_PRESETS.map(r => `<option value="${r.value}"${presetVal === r.value ? ' selected' : ''}>${r.label}</option>`).join('')}
                </select>
                <textarea data-emp-custom="${a.id}" style="display:${isCustom ? 'block' : 'none'};margin-top:4px;width:100%;height:40px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 6px;border-radius:4px;font-size:10px;font-family:inherit;resize:vertical"
                          placeholder="${t('emp.customRole')}">${isCustom ? escapeHtml(a.role || '') : ''}</textarea>
            </div>
            <div style="margin-top:4px;font-size:10px;display:flex;align-items:center;gap:6px">
                <span style="color:${a.status === 'running' ? '#fbbf24' : 'var(--green)'}">● ${a.status || 'idle'}</span>
                ${phaseBadge}
            </div>
        </div>`;
    }).join('');
}

export async function addEmployee(): Promise<void> {
    await apiJson('/api/employees', 'POST', {});
}

export async function updateEmployee(id: string, data: Partial<Employee>): Promise<void> {
    await apiJson(`/api/employees/${id}`, 'PUT', data);
}

export async function deleteEmployee(id: string): Promise<void> {
    apiFire(`/api/employees/${id}`, 'DELETE');
}

export function onEmpCliChange(id: string, cli: string): void {
    const models = MODEL_MAP[cli] || [];
    const sel = document.querySelector(`[data-emp-model="${id}"]`) as HTMLSelectElement | null;
    if (sel) {
        sel.innerHTML = `<option value="default" selected>default</option>` +
            models.map(m => `<option>${escapeHtml(m)}</option>`).join('') +
            `<option value="__custom__">${t('emp.customModel')}</option>`;
    }
    updateEmployee(id, { cli, model: 'default' });
}

export function onEmpRoleChange(id: string, presetVal: string): void {
    const preset = ROLE_PRESETS.find(r => r.value === presetVal);
    const customEl = document.querySelector(`[data-emp-custom="${id}"]`) as HTMLTextAreaElement | null;
    if (!customEl) return;
    if (presetVal === 'custom') {
        customEl.style.display = 'block';
        customEl.focus();
    } else {
        customEl.style.display = 'none';
        customEl.value = '';
        updateEmployee(id, { role: preset?.prompt || '' });
    }
}

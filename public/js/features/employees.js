// ── Employees (Sub-Agents) Feature ──
import { state } from '../state.js';
import { MODEL_MAP, ROLE_PRESETS } from '../constants.js';
import { escapeHtml } from '../render.js';

export async function loadEmployees() {
    state.employees = await (await fetch('/api/employees')).json();
    renderEmployees();
}

export function renderEmployees() {
    const el = document.getElementById('employeesList');
    if (state.employees.length === 0) {
        el.innerHTML = '<div style="color:var(--text-dim);font-size:11px;padding:4px 0">에이전트를 추가하세요</div>';
        return;
    }
    el.innerHTML = state.employees.map(a => {
        const models = MODEL_MAP[a.cli] || [];
        const matched = ROLE_PRESETS.find(r => r.prompt === a.role);
        const presetVal = matched ? matched.value : (a.role ? 'custom' : 'frontend');
        const isCustom = presetVal === 'custom';

        return `
        <div class="settings-group" style="margin-bottom:8px;padding:8px 10px">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
                <span>🤖</span>
                <input style="flex:1;background:none;border:none;color:var(--text);font-size:12px;font-weight:600;font-family:inherit;outline:none"
                       value="${escapeHtml(a.name || 'Agent')}"
                       data-emp-name="${a.id}">
                <button style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:12px" data-emp-delete="${a.id}" title="삭제">✕</button>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:4px">
                <div>
                    <label>CLI</label>
                    <select data-emp-cli="${a.id}">
                        ${['claude', 'codex', 'gemini', 'opencode'].map(c => `<option${a.cli === c ? ' selected' : ''}>${c}</option>`).join('')}
                    </select>
                </div>
                <div>
                    <label>Model</label>
                    <select data-emp-model="${a.id}">
                        <option value="default"${(!a.model || a.model === 'default') ? ' selected' : ''}>default</option>
                        ${models.map(m => `<option${a.model === m ? ' selected' : ''}>${m}</option>`).join('')}
                    </select>
                </div>
            </div>
            <div>
                <label>Role</label>
                <select data-emp-role="${a.id}">
                    ${ROLE_PRESETS.map(r => `<option value="${r.value}"${presetVal === r.value ? ' selected' : ''}>${r.label}</option>`).join('')}
                </select>
                <textarea data-emp-custom="${a.id}" style="display:${isCustom ? 'block' : 'none'};margin-top:4px;width:100%;height:40px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 6px;border-radius:4px;font-size:10px;font-family:inherit;resize:vertical"
                          placeholder="커스텀 역할...">${isCustom ? escapeHtml(a.role) : ''}</textarea>
            </div>
            <div style="margin-top:4px;font-size:10px;color:${a.status === 'running' ? '#fbbf24' : 'var(--green)'}">
                ● ${a.status || 'idle'}
            </div>
        </div>`;
    }).join('');
}

export async function addEmployee() {
    await fetch('/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
}

export async function updateEmployee(id, data) {
    await fetch(`/api/employees/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

export async function deleteEmployee(id) {
    await fetch(`/api/employees/${id}`, { method: 'DELETE' });
}

export function onEmpCliChange(id, cli) {
    const models = MODEL_MAP[cli] || [];
    const sel = document.querySelector(`[data-emp-model="${id}"]`);
    sel.innerHTML = `<option value="default" selected>default</option>` + models.map(m => `<option>${m}</option>`).join('') + `<option value="__custom__">✏️ 직접 입력...</option>`;
    updateEmployee(id, { cli, model: 'default' });
}

export function onEmpRoleChange(id, presetVal) {
    const preset = ROLE_PRESETS.find(r => r.value === presetVal);
    const customEl = document.querySelector(`[data-emp-custom="${id}"]`);
    if (presetVal === 'custom') {
        customEl.style.display = 'block';
        customEl.focus();
    } else {
        customEl.style.display = 'none';
        customEl.value = '';
        updateEmployee(id, { role: preset?.prompt || '' });
    }
}

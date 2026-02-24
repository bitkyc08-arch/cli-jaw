// ── UI Utilities ──
import { state } from './state.js';
import { renderMarkdown, escapeHtml } from './render.js';
import { getAppName } from './features/appname.js';
import { t } from './features/i18n.js';
import { api } from './api.js';

export function setStatus(s) {
    const badge = document.getElementById('statusBadge');
    const btn = document.getElementById('btnSend');
    state.agentBusy = s === 'running';
    document.getElementById('typingIndicator').classList.toggle('active', state.agentBusy);
    if (s === 'running') {
        badge.className = 'status-badge status-running';
        badge.textContent = '⏳ running';
        btn.textContent = '■';
        btn.title = t('btn.stop');
        btn.classList.add('stop-mode');
    } else {
        badge.className = 'status-badge status-idle';
        badge.textContent = '⚡ idle';
        btn.textContent = '➤';
        btn.title = 'Send';
        btn.classList.remove('stop-mode');
        updateQueueBadge(0);
    }
}

export function updateQueueBadge(count) {
    let el = document.getElementById('queueBadge');
    if (!el) {
        el = document.createElement('span');
        el.id = 'queueBadge';
        el.style.cssText = 'position:absolute;top:-6px;right:-6px;background:#f80;color:#fff;border-radius:50%;font-size:11px;min-width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-weight:bold';
        document.getElementById('btnSend').parentElement.style.position = 'relative';
        document.getElementById('btnSend').style.position = 'relative';
        document.getElementById('btnSend').appendChild(el);
    }
    el.textContent = count > 0 ? count : '';
    el.style.display = count > 0 ? 'flex' : 'none';
}

export function addSystemMsg(text, extraClass, type) {
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');
    const typeClass = type ? ` msg-type-${type}` : '';
    div.className = 'msg msg-system' + typeClass + (extraClass ? ' ' + extraClass : '');
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

export function appendAgentText(text) {
    if (!text) return;
    if (!state.currentAgentDiv) {
        state.currentAgentDiv = addMessage('agent', '');
    }
    const content = state.currentAgentDiv.querySelector('.msg-content');
    content.textContent += text;
    scrollToBottom();
}

let lastFinalizeTs = 0;

export function finalizeAgent(text, toolLog) {
    // Guard: prevent double-render when both agent_done + orchestrate_done fire
    const now = Date.now();
    if (!state.currentAgentDiv && now - lastFinalizeTs < 500) return;

    document.querySelectorAll('.msg-system.tool-activity').forEach(el => el.remove());
    if (text) {
        if (!state.currentAgentDiv) {
            state.currentAgentDiv = addMessage('agent', '');
        }
        const content = state.currentAgentDiv.querySelector('.msg-content');
        let toolHtml = '';
        if (toolLog && toolLog.length > 0) {
            const counts = {};
            toolLog.forEach(t => { counts[t.icon] = (counts[t.icon] || 0) + 1; });
            const summaryParts = Object.entries(counts).map(([icon, n]) => `${icon}×${n}`).join(' ');
            const logLines = toolLog.map(t => `${t.icon} ${escapeHtml(t.label)}`).join('\n');
            toolHtml = `<details class="tool-summary"><summary>${summaryParts}</summary><div class="tool-log">${logLines}</div></details>`;
        }
        content.innerHTML = toolHtml + renderMarkdown(text);
    }
    state.currentAgentDiv = null;
    lastFinalizeTs = Date.now();
    setStatus('idle');
    loadStats();
}

export function addMessage(role, text) {
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `msg msg-${role}`;
    const rendered = renderMarkdown(text);
    div.innerHTML = `<div class="msg-label">${role === 'user' ? t('msg.you') : getAppName()}</div><div class="msg-content">${rendered}</div>`;
    container.appendChild(div);
    scrollToBottom();
    return div;
}

export function scrollToBottom() {
    const c = document.getElementById('chatMessages');
    c.scrollTop = c.scrollHeight;
}

export function switchTab(name, targetBtn) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const tabMap = { agents: 'tabAgents', settings: 'tabSettings', skills: 'tabSkills' };
    document.getElementById(tabMap[name]).classList.add('active');
    if (targetBtn) targetBtn.classList.add('active');
    // Lazy-load tab content
    if (name === 'settings') { import('./features/settings.js').then(m => m.loadSettings()); }
    if (name === 'agents') { import('./features/employees.js').then(m => m.loadEmployees()); }
    if (name === 'skills') { import('./features/skills.js').then(m => m.loadSkills()); }
}

export function handleSave() {
    const isSettings = document.getElementById('tabSettings').classList.contains('active');
    if (isSettings) {
        import('./features/settings.js').then(m => m.savePerCli());
    } else {
        import('./features/settings.js').then(m => m.updateSettings());
    }
}

export async function loadStats() {
    const msgs = await api('/api/messages');
    if (!msgs) return;
    document.getElementById('statMsgs').textContent = t('stat.messages', { count: msgs.length });
}

export async function loadMessages() {
    const msgs = await api('/api/messages');
    if (!msgs) return;
    msgs.forEach(m => addMessage(m.role === 'assistant' ? 'agent' : m.role, m.content));
}

export async function loadMemory() {
    try {
        const items = await api('/api/memory');
        const list = document.getElementById('memoryList');
        if (!list) return;
        if (items.length === 0) {
            list.innerHTML = `<li style="color:var(--text-dim)">${t('mem.empty')}</li>`;
            return;
        }
        list.innerHTML = items.map(m =>
            `<li><span class="memory-key">${escapeHtml(m.key)}</span>: ${escapeHtml(m.value)}</li>`
        ).join('');
    } catch { }
}

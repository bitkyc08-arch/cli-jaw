// ── UI Utilities ──
import { state } from './state.js';
import { renderMarkdown, escapeHtml } from './render.js';
import { getAppName } from './features/appname.js';
import { t } from './features/i18n.js';
import { api } from './api.js';

interface ToolLogEntry { icon: string; label: string; }
interface MessageItem { role: string; content: string; }
interface MemoryItem { key: string; value: string; }

export function setStatus(s: string): void {
    const badge = document.getElementById('statusBadge');
    const btn = document.getElementById('btnSend');
    state.agentBusy = s === 'running';
    document.getElementById('typingIndicator')?.classList.toggle('active', state.agentBusy);
    if (s === 'running') {
        if (badge) { badge.className = 'status-badge status-running'; badge.textContent = '⏳ running'; }
        if (btn) { btn.textContent = '■'; btn.title = t('btn.stop'); btn.classList.add('stop-mode'); }
    } else {
        if (badge) { badge.className = 'status-badge status-idle'; badge.textContent = '⚡ idle'; }
        if (btn) { btn.textContent = '➤'; btn.title = 'Send'; btn.classList.remove('stop-mode'); }
        updateQueueBadge(0);
    }
}

export function updateQueueBadge(count: number): void {
    let el = document.getElementById('queueBadge');
    if (!el) {
        el = document.createElement('span');
        el.id = 'queueBadge';
        el.style.cssText = 'position:absolute;top:-6px;right:-6px;background:#f80;color:#fff;border-radius:50%;font-size:11px;min-width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-weight:bold';
        const sendBtn = document.getElementById('btnSend');
        if (sendBtn?.parentElement) sendBtn.parentElement.style.position = 'relative';
        if (sendBtn) { sendBtn.style.position = 'relative'; sendBtn.appendChild(el); }
    }
    el.textContent = count > 0 ? String(count) : '';
    el.style.display = count > 0 ? 'flex' : 'none';
}

export function addSystemMsg(text: string, extraClass?: string, type?: string): void {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    const div = document.createElement('div');
    const typeClass = type ? ` msg-type-${type}` : '';
    div.className = 'msg msg-system' + typeClass + (extraClass ? ' ' + extraClass : '');
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

export function appendAgentText(text: string): void {
    if (!text) return;
    if (!state.currentAgentDiv) {
        state.currentAgentDiv = addMessage('agent', '');
    }
    const content = (state.currentAgentDiv as HTMLElement)?.querySelector('.msg-content');
    if (content) content.textContent += text;
    scrollToBottom();
}

let lastFinalizeTs = 0;

export function finalizeAgent(text: string, toolLog?: ToolLogEntry[]): void {
    // Guard: prevent double-render when both agent_done + orchestrate_done fire
    const now = Date.now();
    if (!state.currentAgentDiv && now - lastFinalizeTs < 500) return;

    document.querySelectorAll('.msg-system.tool-activity').forEach(el => el.remove());
    if (text) {
        if (!state.currentAgentDiv) {
            state.currentAgentDiv = addMessage('agent', '');
        }
        const content = (state.currentAgentDiv as HTMLElement)?.querySelector('.msg-content');
        let toolHtml = '';
        if (toolLog && toolLog.length > 0) {
            const counts: Record<string, number> = {};
            toolLog.forEach(tl => { counts[tl.icon] = (counts[tl.icon] || 0) + 1; });
            const summaryParts = Object.entries(counts).map(([icon, n]) => `${icon}×${n}`).join(' ');
            const logLines = toolLog.map(tl => `${tl.icon} ${escapeHtml(tl.label)}`).join('\n');
            toolHtml = `<details class="tool-summary"><summary>${summaryParts}</summary><div class="tool-log">${logLines}</div></details>`;
        }
        if (content) content.innerHTML = toolHtml + renderMarkdown(text);
    }
    state.currentAgentDiv = null;
    lastFinalizeTs = Date.now();
    setStatus('idle');
    loadStats();
}

export function addMessage(role: string, text: string): HTMLDivElement {
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `msg msg-${role}`;
    const rendered = renderMarkdown(text);
    div.innerHTML = `<div class="msg-label">${role === 'user' ? t('msg.you') : getAppName()}</div><div class="msg-content">${rendered}</div><button class="msg-copy" title="Copy"></button>`;
    container?.appendChild(div);
    scrollToBottom();
    return div;
}

export function scrollToBottom(): void {
    const c = document.getElementById('chatMessages');
    if (c) c.scrollTop = c.scrollHeight;
}

export function switchTab(name: string, targetBtn: Element): void {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const tabMap: Record<string, string> = { agents: 'tabAgents', settings: 'tabSettings', skills: 'tabSkills' };
    document.getElementById(tabMap[name])?.classList.add('active');
    if (targetBtn) targetBtn.classList.add('active');
    // Lazy-load tab content
    if (name === 'settings') { import('./features/settings.js').then(m => m.loadSettings()); }
    if (name === 'agents') { import('./features/employees.js').then(m => m.loadEmployees()); }
    if (name === 'skills') { import('./features/skills.js').then(m => m.loadSkills()); }
}

export function handleSave(): void {
    const isSettings = document.getElementById('tabSettings')?.classList.contains('active');
    if (isSettings) {
        import('./features/settings.js').then(m => m.savePerCli());
    } else {
        import('./features/settings.js').then(m => m.updateSettings());
    }
}

export async function loadStats(): Promise<void> {
    const msgs = await api<MessageItem[]>('/api/messages');
    if (!msgs) return;
    const el = document.getElementById('statMsgs');
    if (el) el.textContent = t('stat.messages', { count: msgs.length });
}

export async function loadMessages(): Promise<void> {
    const msgs = await api<MessageItem[]>('/api/messages');
    if (!msgs) return;
    msgs.forEach(m => addMessage(m.role === 'assistant' ? 'agent' : m.role, m.content));
}

export async function loadMemory(): Promise<void> {
    try {
        const items = await api<MemoryItem[]>('/api/memory');
        const list = document.getElementById('memoryList');
        if (!list || !items) return;
        if (items.length === 0) {
            list.innerHTML = `<li style="color:var(--text-dim)">${t('mem.empty')}</li>`;
            return;
        }
        list.innerHTML = items.map(m =>
            `<li><span class="memory-key">${escapeHtml(m.key)}</span>: ${escapeHtml(m.value)}</li>`
        ).join('');
    } catch { }
}

// ── Message copy delegation ──
export function initMsgCopy(): void {
    document.getElementById('chatMessages')?.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement)?.closest('.msg-copy') as HTMLElement | null;
        if (!btn) return;
        const msg = btn.closest('.msg');
        const content = msg?.querySelector('.msg-content') as HTMLElement | null;
        if (!content) return;
        const text = content.innerText || content.textContent || '';
        navigator.clipboard.writeText(text).then(() => {
            btn.classList.add('copied');
            setTimeout(() => btn.classList.remove('copied'), 600);
        }).catch(() => { });
    });
}

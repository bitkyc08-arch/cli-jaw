// ── UI Utilities ──
import { state } from './state.js';
import { renderMarkdown, escapeHtml, stripOrchestration } from './render.js';
import { getAppName } from './features/appname.js';
import { t } from './features/i18n.js';
import { api } from './api.js';
import { cacheMessages, getCachedMessages, appendCachedMessage } from './features/idb-cache.js';
import { getVirtualScroll, VS_THRESHOLD } from './virtual-scroll.js';
import { createStreamRenderer, appendChunk, finalizeStream, type StreamState } from './streaming-render.js';
import { renderLiveToolActivity, cleanupToolElements, type ToolLogEntry } from './features/tool-ui.js';
import {
    createProcessBlock,
    addStep,
    updateStepStatus,
    collapseBlock,
    buildProcessBlockHtml,
    bindProcessBlockInteractions,
    type ProcessStep,
} from './features/process-block.js';
interface MessageItem { role: string; content: string; tool_log?: string | null; }

function parseToolLog(toolLog?: string | null): ToolLogEntry[] {
    if (!toolLog) return [];
    try {
        const parsed = JSON.parse(toolLog);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function toProcessSteps(tools: ToolLogEntry[]): ProcessStep[] {
    return tools.map((tool: any) => ({
        id: crypto.randomUUID(),
        icon: tool.icon || '🔧',
        label: tool.label || tool.name || 'tool',
        type: tool.toolType || 'tool',
        detail: tool.detail || '',
        status: tool.status || 'done',
        startTime: Date.now(),
    }));
}

export function setStatus(s: string): void {
    const badge = document.getElementById('statusBadge');
    const btn = document.getElementById('btnSend');
    state.agentBusy = s === 'running';
    document.getElementById('typingIndicator')?.classList.toggle('active', state.agentBusy);
    if (s === 'running') {
        if (badge) { badge.className = 'status-badge status-running'; badge.textContent = 'running'; }
        if (btn) { btn.textContent = '■'; btn.title = t('btn.stop'); btn.classList.add('stop-mode'); }
        showSkeleton();
    } else {
        if (badge) { badge.className = 'status-badge status-idle'; badge.textContent = 'idle'; }
        if (btn) { btn.textContent = '➤'; btn.title = 'Send'; btn.classList.remove('stop-mode'); }
        removeSkeleton();
        updateQueueBadge(0);
    }
}

export function updateQueueBadge(count: number): void {
    let el = document.getElementById('queueBadge');
    if (!el) {
        el = document.createElement('span');
        el.id = 'queueBadge';
        el.className = 'queue-badge';
        const sendBtn = document.getElementById('btnSend');
        if (sendBtn?.parentElement) sendBtn.parentElement.style.position = 'relative';
        if (sendBtn) { sendBtn.style.position = 'relative'; sendBtn.appendChild(el); }
    }
    el.textContent = count > 0 ? String(count) : '';
    el.style.display = count > 0 ? 'flex' : 'none';
}

function showSkeleton(): void {
    const container = document.getElementById('chatMessages');
    if (!container || container.querySelector('.skeleton-msg')) return;
    const vs = getVirtualScroll();
    if (vs.active) vs.flushToDOM();
    hideEmptyState();
    const skel = document.createElement('div');
    skel.className = 'skeleton-msg';
    skel.innerHTML = '<div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div>';
    container.appendChild(skel);
    scrollToBottom();
}

function removeSkeleton(): void {
    document.querySelectorAll('.skeleton-msg').forEach(el => el.remove());
}

function hideEmptyState(): void {
    document.getElementById('emptyState')?.classList.remove('visible');
}

function showEmptyState(): void {
    const container = document.getElementById('chatMessages');
    if (container && container.children.length === 0) {
        document.getElementById('emptyState')?.classList.add('visible');
    }
}

export function addSystemMsg(text: string, extraClass?: string, type?: string): void {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    const vs = getVirtualScroll();
    if (vs.active) vs.flushToDOM();
    hideEmptyState();
    const div = document.createElement('div');
    const typeClass = type ? ` msg-type-${type}` : '';
    div.className = 'msg msg-system' + typeClass + (extraClass ? ' ' + extraClass : '');
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

export function cleanupToolActivity(): void {
    cleanupToolElements();
    state.currentAgentDiv = null;
    state.currentProcessBlock = null;
}

export function showLiveToolActivity(label: string): void {
    removeSkeleton();
    if (!state.currentAgentDiv || !state.currentAgentDiv.isConnected) {
        state.currentAgentDiv = addMessage('agent', '');
    }
    renderLiveToolActivity(state.currentAgentDiv as HTMLElement, label);
    scrollToBottom();
}

export function showProcessStep(step: ProcessStep): void {
    removeSkeleton();
    if (!state.currentAgentDiv || !state.currentAgentDiv.isConnected) {
        state.currentAgentDiv = addMessage('agent', '');
        state.currentProcessBlock = null;
    }
    if (!state.currentProcessBlock) {
        const body = state.currentAgentDiv.querySelector('.agent-body') as HTMLElement;
        if (body) {
            state.currentProcessBlock = createProcessBlock(body);
        }
    }
    if (state.currentProcessBlock) {
        // Completion icons (✅/❌) update the last matching running step
        if (step.icon === '✅' || step.icon === '❌') {
            const status = step.icon === '✅' ? 'done' : 'error';
            // Prefer matching by stepRef (stable correlation), fall back to label
            const ref = step.stepRef;
            const match = ref
                ? [...state.currentProcessBlock.steps].reverse()
                    .find(s => s.status === 'running' && s.stepRef === ref)
                : [...state.currentProcessBlock.steps].reverse()
                    .find(s => s.status === 'running' && s.label === step.label);
            if (match) {
                updateStepStatus(state.currentProcessBlock, match.id, status);
                scrollToBottom();
                return;
            }
            // No matching running step — try any running step as fallback
            const anyRunning = [...state.currentProcessBlock.steps].reverse()
                .find(s => s.status === 'running');
            if (anyRunning) {
                updateStepStatus(state.currentProcessBlock, anyRunning.id, status);
                scrollToBottom();
                return;
            }
        }
        addStep(state.currentProcessBlock, step);
    }
    scrollToBottom();
}

let currentStream: StreamState | null = null;

export function appendAgentText(text: string): void {
    if (!text) return;
    removeSkeleton();
    if (!state.currentAgentDiv || !state.currentAgentDiv.isConnected) {
        state.currentAgentDiv = addMessage('agent', '');
        currentStream = null;
    }
    const content = (state.currentAgentDiv as HTMLElement)?.querySelector('.msg-content');
    if (content) {
        if (!currentStream) currentStream = createStreamRenderer(content as HTMLElement);
        appendChunk(currentStream, text);
    }
    scrollToBottom();
}

let lastFinalizeTs = 0;

export function finalizeAgent(text: string, toolLog?: ToolLogEntry[]): void {
    // Guard: prevent double-render when both agent_done + orchestrate_done fire
    const now = Date.now();
    if (!state.currentAgentDiv && now - lastFinalizeTs < 500) return;

    cleanupToolElements();
    removeSkeleton();
    const hadProcessBlock = !!state.currentProcessBlock;
    if (state.currentProcessBlock) {
        collapseBlock(state.currentProcessBlock);
        state.currentProcessBlock = null;
    }
    const hasTools = toolLog && toolLog.length > 0;
    if (text || hasTools) {
        if (!state.currentAgentDiv || !state.currentAgentDiv.isConnected) {
            state.currentAgentDiv = addMessage('agent', '');
        }
        const content = (state.currentAgentDiv as HTMLElement)?.querySelector('.msg-content');
        // Finalize rAF stream if active, otherwise use raw text
        const finalText = currentStream ? finalizeStream(currentStream) || text : text;
        currentStream = null;
        // Skip static tool HTML when process block already shows tool summary
        const toolHtml = hasTools && !hadProcessBlock ? buildProcessBlockHtml(toProcessSteps(toolLog!), true) : '';
        if (content) content.innerHTML = toolHtml + renderMarkdown(finalText);
        if (content) content.setAttribute('data-raw', stripOrchestration(finalText));
    }
    currentStream = null;
    state.currentAgentDiv = null;
    lastFinalizeTs = Date.now();
    setStatus('idle');
    loadStats();
    // Cache agent response for offline
    if (text) appendCachedMessage('assistant', text).catch(() => {});
}

export function addMessage(role: string, text: string): HTMLDivElement {
    const container = document.getElementById('chatMessages');
    const vs = getVirtualScroll();
    if (vs.active) vs.flushToDOM();
    hideEmptyState();
    removeSkeleton();

    const rendered = renderMarkdown(text);
    const label = escapeHtml(role === 'user' ? t('msg.you') : getAppName());

    const div = document.createElement('div');
    if (role === 'agent') {
        div.className = 'msg msg-agent';
        div.innerHTML = `<div class="agent-icon" aria-hidden="true">🦈</div><div class="agent-body"><div class="msg-content">${rendered}</div><button class="msg-copy" title="Copy" aria-label="Copy message"></button></div>`;
    } else {
        div.className = `msg msg-${role}`;
        div.innerHTML = `<div class="msg-label">${label}</div><div class="msg-content">${rendered}</div><button class="msg-copy" title="Copy" aria-label="Copy message"></button>`;
    }
    const contentEl = div.querySelector('.msg-content');
    if (contentEl) contentEl.setAttribute('data-raw', stripOrchestration(text));
    container?.appendChild(div);
    scrollToBottom();
    return div;
}

let scrollRAF: number | null = null;

export function scrollToBottom(): void {
    if (scrollRAF) return;
    scrollRAF = requestAnimationFrame(() => {
        scrollRAF = null;
        const c = document.getElementById('chatMessages');
        if (c) c.scrollTop = c.scrollHeight;
    });
}

export function switchTab(name: string, targetBtn: Element): void {
    document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const tabMap: Record<string, string> = { agents: 'tabAgents', settings: 'tabSettings', skills: 'tabSkills' };
    document.getElementById(tabMap[name])?.classList.add('active');
    if (targetBtn) {
        targetBtn.classList.add('active');
        targetBtn.setAttribute('aria-selected', 'true');
    }
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
    try {
        const msgs = await api<MessageItem[]>('/api/messages');
        if (msgs && msgs.length > 0) {
            const vs = getVirtualScroll();
            if (msgs.length >= VS_THRESHOLD) {
                // Bulk load via virtual scroll for large histories
                for (const m of msgs) {
                    const role = m.role === 'assistant' ? 'agent' : m.role;
                    const rendered = renderMarkdown(m.content);
                    const label = escapeHtml(role === 'user' ? t('msg.you') : getAppName());
                    const tools = m.role === 'assistant' ? parseToolLog(m.tool_log) : [];
                    const toolHtml = tools.length > 0 ? buildProcessBlockHtml(toProcessSteps(tools), true) : '';
                    const html = role === 'agent'
                        ? `<div class="msg msg-agent"><div class="agent-icon" aria-hidden="true">🦈</div><div class="agent-body">${toolHtml}<div class="msg-content" data-raw="${escapeHtml(stripOrchestration(m.content))}">${rendered}</div><button class="msg-copy" title="Copy" aria-label="Copy message"></button></div></div>`
                        : `<div class="msg msg-${role}"><div class="msg-label">${label}</div><div class="msg-content" data-raw="${escapeHtml(stripOrchestration(m.content))}">${rendered}</div><button class="msg-copy" title="Copy" aria-label="Copy message"></button></div>`;
                    vs.addItem(crypto.randomUUID(), html);
                }
                vs.scrollToBottom();
            } else {
                msgs.forEach(m => {
                    const div = addMessage(m.role === 'assistant' ? 'agent' : m.role, m.content);
                    // Reconstruct ProcessBlock from saved tool_log
                    if (m.role === 'assistant') {
                        const tools = parseToolLog(m.tool_log);
                        if (tools.length > 0) {
                            const body = div.querySelector('.agent-body') as HTMLElement;
                            if (body) {
                                const pb = createProcessBlock(body);
                                for (const tool of toProcessSteps(tools)) addStep(pb, tool);
                                collapseBlock(pb);
                            }
                        }
                    }
                });
            }
            // Cache for offline use
            cacheMessages(msgs.map(m => ({
                role: m.role, content: m.content, timestamp: Date.now(),
            }))).catch(() => {});
            showEmptyState();
            return;
        }
    } catch { /* server unreachable — try cache */ }

    // Offline fallback: load from IndexedDB
    const cached = await getCachedMessages();
    if (cached.length > 0) {
        cached.forEach(m => addMessage(m.role === 'assistant' ? 'agent' : m.role, m.content));
        addMessage('system', '📴 오프라인 모드 — 캐시된 메시지 표시 중');
    }
    showEmptyState();
}

// loadMemory removed — #memoryList element does not exist in HTML.
// Memory is now handled by features/memory.ts via the modal UI.

// ── Message copy delegation ──
export function initMsgCopy(): void {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;
    bindProcessBlockInteractions(chatMessages);
    chatMessages.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;

        // Tool group toggle (event delegation instead of inline onclick)
        const summary = target.closest('.tool-group-summary') as HTMLElement | null;
        if (summary) {
            const group = summary.closest('.tool-group');
            const details = summary.nextElementSibling as HTMLElement;
            if (group && details) {
                const isExpanding = !group.classList.contains('expanded');
                group.classList.toggle('expanded');
                details.classList.toggle('collapsed');
                summary.setAttribute('aria-expanded', isExpanding ? 'true' : 'false');
            }
            return;
        }

        // Message copy
        const btn = target.closest('.msg-copy') as HTMLElement | null;
        if (!btn) return;
        const msg = btn.closest('.msg');
        const content = msg?.querySelector('.msg-content') as HTMLElement | null;
        if (!content) return;
        const text = content.getAttribute('data-raw') || content.innerText || content.textContent || '';
        navigator.clipboard.writeText(text).then(() => {
            btn.classList.add('copied');
            btn.textContent = '✓';
            setTimeout(() => {
                btn.classList.remove('copied');
                btn.textContent = '';
            }, 600);
        }).catch(() => { });
    });
}

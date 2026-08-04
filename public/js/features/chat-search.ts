import { api } from '../api.js';
import { getVirtualScroll } from '../virtual-scroll.js';
import { escapeHtml } from '../render.js';
import { bootMessageQuery } from './message-history.js';
import { withCurrentSessionQuery } from './session-hub.js';

const IS_IFRAME = window.parent !== window;

interface SearchResult {
    id: number;
    role: string;
    content: string;
    cli?: string | null;
    match_field: 'content' | 'tool_log';
    tool_log?: string | null;
    created_at: string;
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastQuery = '';
let messageIdToVsIndex: Map<number, number> | null = null;

let chatSearchInitialized = false;

export function initChatSearch(): void {
    const input = document.getElementById('chatSearchInput') as HTMLInputElement | null;
    const closeBtn = document.getElementById('chatSearchClose');
    const resultsEl = document.getElementById('chatSearchResults');
    const countEl = document.getElementById('chatSearchCount');
    if (!input || !closeBtn || !resultsEl || !countEl) return;
    // window/message listeners stack if init ever re-runs (260613 06).
    if (chatSearchInitialized) return;
    chatSearchInitialized = true;

    window.addEventListener('message', (e) => {
        if (e.data?.type === 'jaw-preview-search') toggleChatSearch();
    });

    input.addEventListener('input', () => {
        const q = input.value.trim();
        if (debounceTimer) clearTimeout(debounceTimer);
        if (!q) {
            clearResults(resultsEl, countEl);
            return;
        }
        debounceTimer = setTimeout(() => void runSearch(q, resultsEl, countEl), 250);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { closeChatSearch(); return; }
        if (e.key === 'Enter') {
            e.preventDefault();
            const first = resultsEl.querySelector('.chat-search-result') as HTMLElement | null;
            first?.click();
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            focusNextResult(resultsEl, 1);
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            focusNextResult(resultsEl, -1);
        }
    });

    resultsEl.addEventListener('wheel', (e) => {
        const el = resultsEl;
        const atTop = el.scrollTop === 0 && e.deltaY < 0;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight && e.deltaY > 0;
        if (!atTop && !atBottom) e.stopPropagation();
        if (atTop || atBottom) e.preventDefault();
    }, { passive: false });

    closeBtn.addEventListener('click', closeChatSearch);
}

export function toggleChatSearch(): void {
    const wrap = document.getElementById('chatSearch');
    const input = document.getElementById('chatSearchInput') as HTMLInputElement | null;
    if (!wrap || !input) return;
    if (wrap.classList.contains('open')) {
        closeChatSearch();
    } else {
        wrap.classList.add('open');
        input.focus();
        buildMessageIndexMap();
    }
}

export function closeChatSearch(): void {
    const wrap = document.getElementById('chatSearch');
    const input = document.getElementById('chatSearchInput') as HTMLInputElement | null;
    const resultsEl = document.getElementById('chatSearchResults');
    const countEl = document.getElementById('chatSearchCount');
    if (!wrap) return;
    wrap.classList.remove('open');
    if (input) input.value = '';
    if (resultsEl && countEl) clearResults(resultsEl, countEl);
    lastQuery = '';
}

function buildMessageIndexMap(): void {
    messageIdToVsIndex = new Map();
    // Must mirror the rendered boot window so id→virtual-scroll index stays
    // aligned with what loadMessages() actually rendered.
    api<{ id: number }[]>(`/api/messages${bootMessageQuery()}`).then(msgs => {
        if (!msgs) return;
        messageIdToVsIndex = new Map();
        msgs.forEach((m, i) => messageIdToVsIndex!.set(m.id, i));
    }).catch(() => {});
}

async function runSearch(q: string, resultsEl: HTMLElement, countEl: HTMLElement): Promise<void> {
    lastQuery = q;
    const data = await api<SearchResult[]>(withCurrentSessionQuery(`/api/messages/search?q=${encodeURIComponent(q)}&limit=20`));
    if (!data || lastQuery !== q) return;
    countEl.textContent = data.length > 0 ? `${data.length} found` : 'no results';
    if (data.length === 0) {
        resultsEl.classList.remove('has-results');
        resultsEl.innerHTML = '';
        return;
    }
    resultsEl.innerHTML = data.map(r => buildResultHtml(r, q)).join('');
    resultsEl.classList.add('has-results');
    resultsEl.querySelectorAll('.chat-search-result').forEach(el => {
        el.addEventListener('click', () => {
            const msgId = Number((el as HTMLElement).dataset['msgId']);
            scrollToMessage(msgId);
        });
    });
}

function buildResultHtml(r: SearchResult, q: string): string {
    const role = r.role === 'assistant' ? 'agent' : r.role;
    const roleLabel = role === 'agent' ? (r.cli || 'agent') : 'you';
    const isToolMatch = r.match_field === 'tool_log';
    const badge = isToolMatch ? '<span class="chat-search-result-badge">tool</span>' : '';
    const sourceText = isToolMatch ? extractToolSnippet(r.tool_log, q) : r.content;
    const snippet = highlightSnippet(sourceText, q);
    const time = formatTime(r.created_at);
    return `<div class="chat-search-result" data-msg-id="${r.id}" tabindex="-1">
        <div class="chat-search-result-meta">
            <span class="chat-search-result-role ${role}">${escapeHtml(roleLabel)}</span>
            ${badge}
            <span>${escapeHtml(time)}</span>
        </div>
        <div class="chat-search-result-snippet">${snippet}</div>
    </div>`;
}

function extractToolSnippet(toolLog: string | null | undefined, q: string): string {
    if (!toolLog) return '';
    try {
        const entries = JSON.parse(toolLog) as { label?: string; detail?: string }[];
        const lower = q.toLowerCase();
        for (const e of entries) {
            const text = `${e.label || ''} ${e.detail || ''}`;
            if (text.toLowerCase().includes(lower)) return text;
        }
    } catch { /* raw fallback */ }
    return toolLog.slice(0, 300);
}

function highlightSnippet(text: string, q: string): string {
    const lower = text.toLowerCase();
    const idx = lower.indexOf(q.toLowerCase());
    if (idx === -1) return escapeHtml(text.slice(0, 120));
    const start = Math.max(0, idx - 40);
    const end = Math.min(text.length, idx + q.length + 80);
    const before = escapeHtml(text.slice(start, idx));
    const match = escapeHtml(text.slice(idx, idx + q.length));
    const after = escapeHtml(text.slice(idx + q.length, end));
    const prefix = start > 0 ? '&hellip;' : '';
    const suffix = end < text.length ? '&hellip;' : '';
    return `${prefix}${before}<mark>${match}</mark>${after}${suffix}`;
}

function scrollToMessage(dbId: number): void {
    if (!messageIdToVsIndex) return;
    const vsIndex = messageIdToVsIndex.get(dbId);
    if (vsIndex == null) return;
    const vs = getVirtualScroll();
    vs.scrollToIndex(vsIndex, 'center');
    requestAnimationFrame(() => {
        setTimeout(() => {
            const container = document.getElementById('chatMessages');
            if (!container) return;
            container.querySelectorAll('.msg.search-highlight').forEach(
                el => el.classList.remove('search-highlight'),
            );
            const msgs = container.querySelectorAll('.msg');
            for (const msg of msgs) {
                const turnIdx = msg.getAttribute('data-turn-index');
                if (turnIdx != null && Number(turnIdx) === vsIndex) {
                    msg.classList.add('search-highlight');
                    break;
                }
            }
        }, 150);
    });
}

function focusNextResult(resultsEl: HTMLElement, dir: 1 | -1): void {
    const items = Array.from(resultsEl.querySelectorAll('.chat-search-result')) as HTMLElement[];
    if (items.length === 0) return;
    const active = resultsEl.querySelector('.chat-search-result.active') as HTMLElement | null;
    let idx = active ? items.indexOf(active) + dir : 0;
    if (idx < 0) idx = items.length - 1;
    if (idx >= items.length) idx = 0;
    items.forEach(el => el.classList.remove('active'));
    items[idx].classList.add('active');
    items[idx].scrollIntoView({ block: 'nearest' });
    items[idx].click();
}

function clearResults(resultsEl: HTMLElement, countEl: HTMLElement): void {
    resultsEl.classList.remove('has-results');
    resultsEl.innerHTML = '';
    countEl.textContent = '';
}

function formatTime(iso: string): string {
    try {
        const d = new Date(iso);
        const now = new Date();
        if (d.toDateString() === now.toDateString()) {
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
            ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
}

import { state } from '../state.js';
import { api } from '../api.js';
import { ICONS } from '../icons.js';
import { t } from './i18n.js';
import { showSkeleton, removeSkeleton } from './chat-messages.js';
import { withCurrentSessionQuery } from './session-hub.js';

export function setStatus(s: string): void {
    const badge = document.getElementById('statusBadge');
    const btn = document.getElementById('btnSend');
    const label = document.getElementById('typingIndicator')?.querySelector('.label') as HTMLElement | null;
    state.agentBusy = s === 'running' || s === 'steering';
    if (btn) {
        btn.setAttribute('aria-label', state.agentBusy ? t('btn.stop') : 'Send message');
        if (state.agentBusy) btn.setAttribute('data-i18n-aria', 'btn.stop');
        else btn.removeAttribute('data-i18n-aria');
    }
    document.getElementById('typingIndicator')?.classList.toggle('active', state.agentBusy);
    if (s === 'running') {
        if (badge) { badge.className = 'status-badge status-running'; badge.textContent = 'running'; }
        if (btn) { btn.innerHTML = ICONS.stop; btn.title = t('btn.stop'); btn.classList.add('stop-mode'); }
        if (label) label.textContent = t('status.responding');
        showSkeleton();
    } else if (s === 'steering') {
        if (badge) { badge.className = 'status-badge status-steering'; badge.textContent = 'steering'; }
        if (btn) { btn.innerHTML = ICONS.stop; btn.title = 'Steering...'; btn.classList.add('stop-mode'); }
        if (label) label.textContent = 'Steering...';
    } else {
        if (badge) { badge.className = 'status-badge status-idle'; badge.textContent = 'idle'; }
        if (btn) { btn.innerHTML = ICONS.send; btn.title = 'Send'; btn.classList.remove('stop-mode'); }
        if (label) label.textContent = t('status.responding');
        removeSkeleton();
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

export function updateStatMsgs(count: number): void {
    const el = document.getElementById('statMsgs');
    if (el) el.textContent = t('stat.messages', { count });
}

export async function loadStats(): Promise<void> {
    const result = await api<{ count: number }>(withCurrentSessionQuery('/api/messages/count'));
    if (!result) return;
    updateStatMsgs(result.count);
}

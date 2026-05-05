// ── Pending Queue Stack ──
// Renders queued (pending) messages as thin one-line rows above the chat input
// with steer (interrupt + redirect) and trash (delete) buttons per item.
//
// Click-to-arm UX: each button arms a 3s countdown (visual fill).
// Re-clicking the same button cancels. Multiple buttons can be armed
// independently across rows or actions.

import { escapeHtml } from '../render.js';
import { ICONS } from '../icons.js';
import { apiJson } from '../api.js';
import { t } from './i18n.js';

export interface PendingItem {
    id: string;
    prompt: string;
    source?: string;
    ts?: number;
}

type Action = 'steer' | 'delete';
type ArmedSlot = { id: string; action: Action; timerId: ReturnType<typeof setTimeout> };

const ARM_DELAY_MS = 3000;
const armed = new Map<string, ArmedSlot>();
let lastItems: PendingItem[] = [];

const slotKey = (id: string, action: Action) => `${id}:${action}`;

export function renderPendingQueue(items: PendingItem[] = []): void {
    const host = document.getElementById('pendingQueue');
    if (!host) return;
    lastItems = items.slice();
    if (!items.length) {
        cancelOrphanedSlots(new Set());
        host.classList.remove('visible');
        host.innerHTML = '';
        return;
    }
    host.classList.add('visible');
    host.innerHTML = `
        <div class="pending-queue-header">
            <span class="pending-queue-title">${ICONS.hourglass} <span data-i18n="queue.pendingTitle">${escapeHtml(t('queue.pendingTitle'))}</span> <span class="pending-queue-count">${items.length}</span></span>
        </div>
        <div class="pending-queue-list">
            ${items.map(renderRow).join('')}
        </div>
    `;
    const liveIds = new Set(items.map(it => it.id));
    cancelOrphanedSlots(liveIds);
    reapplyArmedVisuals();
}

function renderRow(item: PendingItem): string {
    const preview = (item.prompt || '').replace(/\s+/g, ' ').trim();
    const truncated = preview.length > 140 ? preview.slice(0, 140) + '…' : preview;
    const source = item.source ? `<span class="pending-row-source">${escapeHtml(item.source)}</span>` : '';
    const steerLabel = escapeHtml(t('queue.steer'));
    const deleteLabel = escapeHtml(t('queue.delete'));
    return `<div class="pending-row" data-pending-id="${escapeHtml(item.id)}" title="${escapeHtml(preview)}">
        <span class="pending-row-text">${escapeHtml(truncated)}</span>
        ${source}
        <button class="pending-row-btn pending-row-steer" data-pending-action="steer" data-i18n-title="queue.steer" title="${steerLabel}" aria-label="${steerLabel}"><span class="pending-arm-fill" aria-hidden="true"></span><span class="pending-btn-content"><span class="pending-steer-arrow" aria-hidden="true">↳</span><span class="pending-steer-label">${steerLabel}</span></span></button>
        <button class="pending-row-btn pending-row-delete" data-pending-action="delete" data-i18n-title="queue.delete" title="${deleteLabel}" aria-label="${deleteLabel}"><span class="pending-arm-fill" aria-hidden="true"></span><span class="pending-btn-content">${ICONS.trash}</span></button>
    </div>`;
}

function findButton(id: string, action: Action): HTMLButtonElement | null {
    const row = document.querySelector(`.pending-row[data-pending-id="${CSS.escape(id)}"]`);
    if (!row) return null;
    return row.querySelector(`[data-pending-action="${action}"]`) as HTMLButtonElement | null;
}

function paintArmed(id: string, action: Action): void {
    const btn = findButton(id, action);
    if (!btn) return;
    btn.classList.add('armed');
    btn.setAttribute('title', t('queue.cancelArm'));
    // Force animation restart by toggling class on the fill element
    const fill = btn.querySelector('.pending-arm-fill') as HTMLElement | null;
    if (fill) {
        fill.style.animation = 'none';
        // Force reflow so the next assignment restarts the animation
        void fill.offsetWidth;
        fill.style.animation = '';
    }
}

function unpaintArmed(id: string, action: Action): void {
    const btn = findButton(id, action);
    if (!btn) return;
    btn.classList.remove('armed');
    btn.setAttribute('title', action === 'steer' ? t('queue.steer') : t('queue.delete'));
}

function reapplyArmedVisuals(): void {
    for (const slot of armed.values()) {
        const btn = findButton(slot.id, slot.action);
        if (!btn) continue;
        // Re-render replaced the DOM; just toggle class without restarting animation
        btn.classList.add('armed');
        btn.setAttribute('title', t('queue.cancelArm'));
    }
}

function cancelOrphanedSlots(liveIds: Set<string>): void {
    for (const [key, slot] of armed) {
        if (!liveIds.has(slot.id)) {
            clearTimeout(slot.timerId);
            armed.delete(key);
        }
    }
}

function arm(id: string, action: Action): void {
    const key = slotKey(id, action);
    const timerId = setTimeout(() => fire(id, action), ARM_DELAY_MS);
    armed.set(key, { id, action, timerId });
    paintArmed(id, action);
}

function cancelArm(id: string, action: Action): void {
    const key = slotKey(id, action);
    const slot = armed.get(key);
    if (!slot) return;
    clearTimeout(slot.timerId);
    armed.delete(key);
    unpaintArmed(id, action);
}

async function fire(id: string, action: Action): Promise<void> {
    armed.delete(slotKey(id, action));
    const path = action === 'steer'
        ? `/api/orchestrate/queue/${encodeURIComponent(id)}/steer`
        : `/api/orchestrate/queue/${encodeURIComponent(id)}`;
    const method = action === 'steer' ? 'POST' : 'DELETE';
    const result = await apiJson<{ pending: number }>(path, method, {});
    if (result == null) {
        // Server already removed the item or call failed — let snapshot resync.
        unpaintArmed(id, action);
        return;
    }
    // Optimistic local removal — queue_update broadcast will resync.
    lastItems = lastItems.filter(it => it.id !== id);
    renderPendingQueue(lastItems);
}

function handleClick(id: string, action: Action): void {
    if (armed.has(slotKey(id, action))) {
        cancelArm(id, action);
        return;
    }
    arm(id, action);
}

export function initPendingQueue(): void {
    const host = document.getElementById('pendingQueue');
    if (!host) return;
    host.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement)?.closest('[data-pending-action]') as HTMLElement | null;
        if (!btn) return;
        const row = btn.closest('.pending-row') as HTMLElement | null;
        const id = row?.dataset['pendingId'];
        if (!id) return;
        const action: Action = btn.dataset['pendingAction'] === 'steer' ? 'steer' : 'delete';
        handleClick(id, action);
    });
}

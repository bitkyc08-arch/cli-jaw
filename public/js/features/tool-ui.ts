// ── Tool Use UI ──
// Phase 4/8: Tool call group rendering for agent messages
// Extracted from ui.ts for modularity.

import { escapeHtml } from '../render.js';
import { ICONS } from '../icons.js';

export interface ToolLogEntry {
    icon: string;
    label: string;
    detail?: string;
    toolType?: string;
    stepRef?: string;
}

function hasExpandableDetail(tl: ToolLogEntry): boolean {
    const detail = (tl.detail || '').trim();
    if (!detail) return false;
    return detail !== (tl.label || '').trim();
}

function previewText(text: string, max = 100): string {
    const singleLine = text.replace(/\s+/g, ' ').trim();
    if (!singleLine) return '';
    return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

function renderToolItem(tl: ToolLogEntry, idx: number): string {
    const icon = escapeHtml(tl.icon);
    const label = escapeHtml(tl.label);
    const detail = tl.detail || '';
    const detailId = `tool-detail-${Date.now()}-${idx}`;

    if (hasExpandableDetail(tl)) {
        const snippet = previewText(detail);
        const snippetHtml = snippet
            ? `<span class="tool-item-snippet">${escapeHtml(snippet)}</span>`
            : '';
        return `<div class="tool-item tool-item-expandable">
            <button class="tool-item-toggle" aria-expanded="false" aria-controls="${detailId}">
                <span class="tool-item-icon">${icon}</span>
                <span class="tool-item-main">
                    <span class="tool-item-label">${label}</span>
                    ${snippetHtml}
                </span>
                <span class="tool-item-chevron">${ICONS.chevronRight}</span>
            </button>
            <div class="tool-item-details collapsed" id="${detailId}">
                <pre class="tool-item-full">${escapeHtml(detail)}</pre>
            </div>
        </div>`;
    }

    return `<div class="tool-item"><div class="tool-item-header"><span class="tool-item-icon">${icon}</span><span class="tool-item-label">${label}</span></div></div>`;
}

/** Build tool group HTML from finalized tool log entries */
export function buildToolGroupHtml(toolLog: ToolLogEntry[]): string {
    if (!toolLog || toolLog.length === 0) return '';

    const counts: Record<string, number> = {};
    toolLog.forEach(tl => {
        counts[tl.icon] = (counts[tl.icon] || 0) + 1;
    });

    const summaryParts = Object.entries(counts)
        .map(([icon, n]) => `${escapeHtml(icon)}&times;${n}`)
        .join(' ');

    const toolId = `td-${Date.now()}`;

    const logLines = toolLog.map((tl, i) => renderToolItem(tl, i)).join('');

    return `<div class="tool-group"><button class="tool-group-summary" aria-expanded="false" aria-controls="${toolId}"><span class="tool-status-dot done"></span><span class="tool-group-summary-text">${summaryParts}</span><span class="tool-group-chevron">${ICONS.chevronDown}</span></button><div class="tool-details collapsed" id="${toolId}">${logLines}</div></div>`;
}

/** Bind expand/collapse click handlers for tool items within a container */
export function bindToolItemInteractions(root: HTMLElement): void {
    if (root.dataset.toolItemBound === '1') return;
    root.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null;
        if (!target) return;
        const toggle = target.closest('.tool-item-toggle') as HTMLElement | null;
        if (!toggle) return;
        const wrapper = toggle.closest('.tool-item');
        const details = wrapper?.querySelector('.tool-item-details') as HTMLElement | null;
        const chevron = toggle.querySelector('.tool-item-chevron');
        if (!wrapper || !details) return;
        const expanding = details.classList.contains('collapsed');
        details.classList.toggle('collapsed', !expanding);
        wrapper.classList.toggle('expanded', expanding);
        toggle.setAttribute('aria-expanded', expanding ? 'true' : 'false');
        if (chevron) chevron.innerHTML = expanding ? ICONS.chevronDown : ICONS.chevronRight;
    });
    root.dataset.toolItemBound = '1';
}

/** Show live tool activity indicator inside the current agent message */
export function renderLiveToolActivity(msgDiv: HTMLElement, label: string): void {
    let liveEl = msgDiv.querySelector('.tool-activity-live') as HTMLElement | null;
    if (!liveEl) {
        liveEl = document.createElement('div');
        liveEl.className = 'tool-activity-live';
        const content = msgDiv.querySelector('.msg-content');
        if (content) content.before(liveEl);
    }
    liveEl.innerHTML = `<span class="tool-status-dot running"></span><span>${escapeHtml(label)}</span>`;
}

/** Clean up all live tool activity indicators */
export function cleanupToolElements(): void {
    document.querySelectorAll('.tool-activity-live').forEach(el => el.remove());
    document.querySelectorAll('.msg-system.tool-activity').forEach(el => el.remove());
}

// ── Process Block ──
// Collapsible panel showing tool/thinking activity during agent responses.

import { escapeHtml } from '../render.js';
import { ICONS } from '../icons.js';

export interface ProcessStep {
    id: string;
    type: 'tool' | 'thinking' | 'search';
    icon: string;
    label: string;
    detail?: string;
    stepRef?: string;
    status: 'running' | 'done' | 'error';
    startTime: number;
}

export interface ProcessBlockState {
    element: HTMLElement;
    steps: ProcessStep[];
    collapsed: boolean;
}

function buildSummaryText(steps: ProcessStep[]): string {
    const counts: Record<string, number> = {};
    for (const s of steps) {
        const key = s.type === 'thinking' ? `${ICONS.thinking} Thinking`
            : s.type === 'search' ? `${ICONS.search} Search`
            : `${ICONS.tool} Tool`;
        counts[key] = (counts[key] || 0) + 1;
    }
    return Object.entries(counts)
        .map(([k, n]) => n > 1 ? `${k}&times;${n}` : k)
        .join(' + ');
}

function previewText(text: string, max = 120): string {
    const singleLine = text.replace(/\s+/g, ' ').trim();
    if (!singleLine) return '';
    return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

function hasExpandableDetail(step: ProcessStep): boolean {
    const detail = (step.detail || '').trim();
    if (!detail) return false;
    return detail !== (step.label || '').trim();
}

function renderStep(step: ProcessStep): string {
    const dotClass = `process-step-dot ${step.status}`;
    const badgeClass = `process-step-badge ${step.type}`;
    const badgeText = step.type.toUpperCase();
    const label = escapeHtml(step.label || step.icon || '');
    const detail = step.detail || '';
    const detailId = `process-detail-${step.id}`;
    const detailPreview = hasExpandableDetail(step)
        ? previewText(detail, step.type === 'thinking' ? 120 : 100)
        : '';
    const snippetHtml = detailPreview
        ? `<span class="process-step-snippet">${escapeHtml(detailPreview)}</span>`
        : '';

    if (hasExpandableDetail(step)) {
        return `<div class="process-step process-step-expandable" data-step-id="${step.id}" data-type="${step.type}">
            <button class="process-step-toggle" aria-expanded="false" aria-controls="${detailId}">
                <span class="${dotClass}"></span>
                <span class="${badgeClass}">${badgeText}</span>
                <span class="process-step-main">
                    <span class="process-step-label">${label}</span>
                    ${snippetHtml}
                </span>
                <span class="process-step-chevron">${ICONS.chevronRight}</span>
            </button>
            <div class="process-step-details collapsed" id="${detailId}">
                <pre class="process-step-full">${escapeHtml(detail)}</pre>
            </div>
        </div>`;
    }

    return `<div class="process-step" data-step-id="${step.id}" data-type="${step.type}">
        <span class="${dotClass}"></span>
        <span class="${badgeClass}">${badgeText}</span>
        <span class="process-step-label">${label}</span>
    </div>`;
}

function blockShell(summaryText = '', collapsed = false): string {
    return `<div class="process-block${collapsed ? ' collapsed' : ''}">
        <button class="process-summary" aria-expanded="${collapsed ? 'false' : 'true'}">
            <span class="process-dot ${collapsed ? 'done' : 'running'}"></span>
            <span class="process-summary-text">${summaryText}</span>
            <span class="process-duration"></span>
            <span class="process-chevron">${collapsed ? ICONS.chevronRight : ICONS.chevronDown}</span>
        </button>
        <div class="process-details">
            <div class="process-steps-inner"></div>
        </div>
    </div>`;
}

function toggleStepDetails(toggle: HTMLElement): void {
    const wrapper = toggle.closest('.process-step');
    const details = wrapper?.querySelector('.process-step-details') as HTMLElement | null;
    const chevron = toggle.querySelector('.process-step-chevron');
    if (!wrapper || !details) return;
    const expanding = details.classList.contains('collapsed');
    details.classList.toggle('collapsed', !expanding);
    wrapper.classList.toggle('expanded', expanding);
    toggle.setAttribute('aria-expanded', expanding ? 'true' : 'false');
    if (chevron) chevron.innerHTML = expanding ? ICONS.chevronDown : ICONS.chevronRight;
}

export function bindProcessBlockInteractions(root: HTMLElement): void {
    if (root.dataset.processBlockBound === '1') return;
    root.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null;
        if (!target) return;

        const stepToggle = target.closest('.process-step-toggle') as HTMLElement | null;
        if (stepToggle) {
            toggleStepDetails(stepToggle);
            return;
        }

        const summary = target.closest('.process-summary') as HTMLElement | null;
        if (summary) {
            const block = summary.closest('.process-block');
            if (!block) return;
            const expanding = block.classList.contains('collapsed');
            block.classList.toggle('collapsed', !expanding);
            summary.setAttribute('aria-expanded', expanding ? 'true' : 'false');
            const chevron = summary.querySelector('.process-chevron');
            if (chevron) chevron.innerHTML = expanding ? ICONS.chevronDown : ICONS.chevronRight;
        }
    });
    root.dataset.processBlockBound = '1';
}

export function buildProcessBlockHtml(steps: ProcessStep[], collapsed = true): string {
    const summaryText = buildSummaryText(steps);
    const html = blockShell(summaryText, collapsed);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    const inner = wrapper.querySelector('.process-steps-inner');
    if (inner) inner.innerHTML = steps.map(renderStep).join('');
    const dot = wrapper.querySelector('.process-dot');
    if (dot) {
        const anyRunning = steps.some(step => step.status === 'running');
        dot.classList.toggle('running', anyRunning && !collapsed);
        dot.classList.toggle('done', !anyRunning || collapsed);
    }
    return wrapper.innerHTML;
}

function updateSummary(pb: ProcessBlockState): void {
    const summaryText = pb.element.querySelector('.process-summary-text');
    if (summaryText) summaryText.innerHTML = buildSummaryText(pb.steps);

    const anyRunning = pb.steps.some(s => s.status === 'running');
    const dot = pb.element.querySelector('.process-dot');
    if (dot) {
        dot.classList.toggle('running', anyRunning && !pb.collapsed);
        dot.classList.toggle('done', !anyRunning || pb.collapsed);
    }

    const elapsed = pb.steps.length > 0
        ? Math.round((Date.now() - pb.steps[0].startTime) / 1000)
        : 0;
    const dur = pb.element.querySelector('.process-duration');
    if (dur) dur.textContent = elapsed > 0 ? `${elapsed}s` : '';
}

export function createProcessBlock(parentEl: HTMLElement): ProcessBlockState {
    const host = document.createElement('div');
    host.innerHTML = blockShell('', false);
    const el = host.firstElementChild as HTMLElement;

    const content = parentEl.querySelector('.msg-content');
    if (content) content.before(el);
    else parentEl.appendChild(el);

    return { element: el, steps: [], collapsed: false };
}

export function addStep(pb: ProcessBlockState, step: ProcessStep): void {
    pb.steps.push(step);
    const inner = pb.element.querySelector('.process-steps-inner');
    if (inner) inner.insertAdjacentHTML('beforeend', renderStep(step));
    updateSummary(pb);
}

export function replaceStep(pb: ProcessBlockState, oldStepId: string, newStep: ProcessStep): void {
    const idx = pb.steps.findIndex(s => s.id === oldStepId);
    if (idx === -1) return;
    pb.steps[idx] = newStep;
    const oldEl = pb.element.querySelector(`[data-step-id="${oldStepId}"]`);
    if (oldEl) {
        const temp = document.createElement('div');
        temp.innerHTML = renderStep(newStep);
        const newEl = temp.firstElementChild;
        if (newEl) oldEl.replaceWith(newEl);
    }
    updateSummary(pb);
}

export function updateStepStatus(pb: ProcessBlockState, stepId: string, status: ProcessStep['status']): void {
    const step = pb.steps.find(s => s.id === stepId);
    if (!step) return;
    step.status = status;
    const stepEl = pb.element.querySelector(`[data-step-id="${stepId}"]`);
    if (stepEl) {
        const dot = stepEl.querySelector('.process-step-dot');
        if (dot) {
            dot.classList.remove('running', 'done', 'error');
            dot.classList.add(status);
        }
    }
    updateSummary(pb);
}

export function collapseBlock(pb: ProcessBlockState): void {
    pb.collapsed = true;
    pb.element.classList.add('collapsed');
    const btn = pb.element.querySelector('.process-summary');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    const chevron = pb.element.querySelector('.process-chevron');
    if (chevron) chevron.innerHTML = ICONS.chevronRight;

    for (const step of pb.steps) {
        if (step.status === 'running') step.status = 'done';
    }
    pb.element.querySelectorAll('.process-step-dot.running').forEach(dot => {
        dot.classList.remove('running');
        dot.classList.add('done');
    });
    updateSummary(pb);
}

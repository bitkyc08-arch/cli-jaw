import { escapeHtml } from '../render.js';
import { ICONS } from '../icons.js';
import { requestBoundedJson } from '../bounded-api.js';
import { parseActivityIdentity } from '../../../src/shared/presentation.js';
import { withCurrentSessionQuery } from './session-hub.js';
import {
    displayShellCommand,
    displayShellCommandDetail,
} from '../../../src/shared/shell-command-display.js';

declare global {
    interface Window {
        __jawProcessBlockLayoutMutation?: (anchor: Element | null, mutate: () => void) => void;
    }
}
export interface ProcessStep {
    id: string;
    type: 'tool' | 'thinking' | 'search' | 'subagent';
    icon: string;
    rawIcon?: string | undefined;
    label: string;
    isEmployee?: boolean | undefined;
    detail?: string;
    detailPreview?: string | undefined;
    detailLength?: number | undefined;
    detailTruncated?: boolean | undefined;
    stepRef?: string | undefined;
    traceRunId?: string | undefined; traceSeq?: number | undefined; detailAvailable?: boolean | undefined; detailBytes?: number | undefined; rawRetentionStatus?: string | undefined;
    status: 'running' | 'done' | 'error';
    startTime: number;
}
export interface ProcessBlockState {
    element: HTMLElement;
    steps: ProcessStep[];
    collapsed: boolean;
    /** When true, a long block renders ALL steps instead of the head/tail window —
     *  set by the "show N hidden steps" expander so a live long turn stays fully
     *  reachable. Persists across new live steps. */
    expandedSteps?: boolean;
    /** Authoritative run-start (server startedAt) for the elapsed timer — steps carry
     *  client-arrival startTime, which resets to ~0 on live updates (WP3 zero-seconds
     *  bug). When set, elapsed derives from this instead of steps[0].startTime. */
    startedAt?: number;
    _durationEl?: HTMLElement | null;
}
let _tickerHandle: ReturnType<typeof setInterval> | null = null;
let _tickerBlock: ProcessBlockState | null = null;
// Maps a live block's root element → its state so the delegated click handler can
// flip expandedSteps and re-render from pb.steps (which holds every step, uncapped).
const blockStatesByElement = new WeakMap<HTMLElement, ProcessBlockState>();
const PROCESS_DETAIL_PREVIEW_CHARS = 160;
const PROCESS_DETAIL_RETAIN_CHARS = 3000;
const PROCESS_DETAIL_COLLAPSE_CLEAR_CHARS = 1000;
const PROCESS_BLOCK_MAX_RENDERED_STEPS = 80;
const PROCESS_BLOCK_HEAD_STEPS = 24;
const PROCESS_BLOCK_TAIL_STEPS = 24;
let traceOpenIntent = 0;
let traceIdentityController: AbortController | null = null;

export interface StoredProcessStepMeta {
    id: string;
    type: ProcessStep['type'];
    icon: string;
    rawIcon?: string | undefined;
    label: string;
    isEmployee?: boolean | undefined;
    stepRef?: string | undefined;
    traceRunId?: string | undefined; traceSeq?: number | undefined; detailAvailable?: boolean | undefined; detailBytes?: number | undefined; rawRetentionStatus?: string | undefined;
    status: ProcessStep['status'];
    startTime: number;
    preview: string;
    detailLength: number;
    detailTruncated: boolean;
}
const processDetailStore = new Map<string, { detail: string; originalLength: number; truncated: boolean }>();
const processStepMetaStore = new Map<string, StoredProcessStepMeta>();

// Phase 30 (virtual-scroll/process-block measurement): observe the memory-policy
// hot paths without changing behavior. releaseProcessBlockDetails frees detail/meta
// when a block is recycled/collapsed; reconstructStepsFromBlock rebuilds an elided
// block from the persistent id list + meta store. These write-only counters make
// long-session/huge-block activity observable (no behavior change).
let releaseDetailsCalls = 0;
let releaseDetailsIdsCleared = 0;
let reconstructCalls = 0;
let reconstructStepsBuilt = 0;

export function getProcessBlockMetrics(): {
    releaseDetailsCalls: number;
    releaseDetailsIdsCleared: number;
    reconstructCalls: number;
    reconstructStepsBuilt: number;
} {
    return { releaseDetailsCalls, releaseDetailsIdsCleared, reconstructCalls, reconstructStepsBuilt };
}

export function resetProcessBlockMetrics(): void {
    releaseDetailsCalls = 0;
    releaseDetailsIdsCleared = 0;
    reconstructCalls = 0;
    reconstructStepsBuilt = 0;
}

function blockElapsedOrigin(pb: ProcessBlockState): number | null {
    return pb.startedAt ?? pb.steps[0]?.startTime ?? null;
}

function tickDuration(): void {
    const pb = _tickerBlock;
    if (!pb || pb.collapsed || pb.steps.length === 0) { stopBlockTicker(); return; }
    const el = pb._durationEl ?? (pb._durationEl = pb.element.querySelector('.process-duration') as HTMLElement | null);
    if (!el) return;
    const origin = blockElapsedOrigin(pb);
    if (origin === null) return;
    const elapsed = Math.round((Date.now() - origin) / 1000);
    el.textContent = elapsed > 0 ? `${elapsed}s` : '';
}
function ensureTicker(pb: ProcessBlockState): void {
    if (_tickerHandle && _tickerBlock === pb) return;
    stopBlockTicker();
    _tickerBlock = pb;
    _tickerHandle = setInterval(tickDuration, 3000);
}

export function stopBlockTicker(): void {
    if (_tickerHandle) { clearInterval(_tickerHandle); _tickerHandle = null; }
    _tickerBlock = null;
}
function buildSummaryText(steps: ProcessStep[]): string {
    const counts: Record<string, number> = {};
    for (const s of steps) {
        const key = s.type === 'thinking' ? `${ICONS.thinking} Thinking`
            : s.type === 'search' ? `${ICONS.search} Search`
            : s.type === 'subagent' ? `${ICONS.robot} Subagent`
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

function retainedDetail(text: string): { detail: string; truncated: boolean } {
    if (text.length <= PROCESS_DETAIL_RETAIN_CHARS) return { detail: text, truncated: false };
    const notice = `\n[detail truncated: kept ${PROCESS_DETAIL_RETAIN_CHARS} of ${text.length} chars]`;
    return {
        detail: `${text.slice(0, Math.max(0, PROCESS_DETAIL_RETAIN_CHARS - notice.length))}${notice}`,
        truncated: true,
    };
}

export function getStoredProcessStepDetail(stepId: string): string {
    return processDetailStore.get(stepId)?.detail || '';
}

function normalizeProcessStepForDisplay(step: ProcessStep): ProcessStep {
    if (step.type !== 'tool') return step;
    return {
        ...step,
        label: displayShellCommand(step.label || ''),
        detail: displayShellCommandDetail(step.detail || ''),
        detailPreview: step.detailPreview ? displayShellCommandDetail(step.detailPreview) : step.detailPreview,
    };
}

export function compactProcessStepForStorage(step: ProcessStep): ProcessStep {
    const displayStep = normalizeProcessStepForDisplay(step);
    const storedDetail = displayShellCommandDetail(getStoredProcessStepDetail(displayStep.id));
    const fullDetail = storedDetail || displayStep.detail || '';
    const retained = retainedDetail(fullDetail);
    const preview = displayStep.detailPreview || previewText(fullDetail, PROCESS_DETAIL_PREVIEW_CHARS);
    if (fullDetail) {
        processDetailStore.set(displayStep.id, {
            detail: retained.detail,
            originalLength: fullDetail.length,
            truncated: retained.truncated,
        });
    }
    processStepMetaStore.set(displayStep.id, {
        id: displayStep.id,
        type: displayStep.type,
        icon: displayStep.icon,
        rawIcon: displayStep.rawIcon,
        label: displayStep.label,
        isEmployee: displayStep.isEmployee,
        stepRef: displayStep.stepRef,
        traceRunId: displayStep.traceRunId, traceSeq: displayStep.traceSeq, detailAvailable: displayStep.detailAvailable,
        detailBytes: displayStep.detailBytes, rawRetentionStatus: displayStep.rawRetentionStatus,
        status: displayStep.status,
        startTime: displayStep.startTime,
        preview,
        detailLength: fullDetail.length,
        detailTruncated: retained.truncated,
    });
    return {
        ...displayStep,
        detail: preview,
        detailPreview: preview,
        detailLength: fullDetail.length,
        detailTruncated: retained.truncated,
    };
}

export function mergeStoredProcessStepDetail(stepId: string, incomingDetail?: string): string {
    const incoming = incomingDetail || '';
    const existing = getStoredProcessStepDetail(stepId);
    const merged = existing && incoming ? `${existing}\n${incoming}` : incoming || existing;
    const retained = retainedDetail(merged);
    if (merged) {
        processDetailStore.set(stepId, {
            detail: retained.detail,
            originalLength: merged.length,
            truncated: retained.truncated,
        });
    }
    const meta = processStepMetaStore.get(stepId);
    if (meta) {
        meta.preview = previewText(merged, PROCESS_DETAIL_PREVIEW_CHARS);
        meta.detailLength = merged.length;
        meta.detailTruncated = retained.truncated;
    }
    return meta?.preview || previewText(merged, PROCESS_DETAIL_PREVIEW_CHARS);
}

export function setStoredProcessStepDetail(stepId: string, incomingDetail?: string): string {
    const incoming = incomingDetail || getStoredProcessStepDetail(stepId);
    const retained = retainedDetail(incoming);
    if (incoming) {
        processDetailStore.set(stepId, {
            detail: retained.detail,
            originalLength: incoming.length,
            truncated: retained.truncated,
        });
    }
    const preview = previewText(incoming, PROCESS_DETAIL_PREVIEW_CHARS);
    const meta = processStepMetaStore.get(stepId);
    if (meta) {
        meta.preview = preview;
        meta.detailLength = incoming.length;
        meta.detailTruncated = retained.truncated;
    }
    return preview;
}

function updateStoredStepMeta(step: ProcessStep): void {
    const compact = compactProcessStepForStorage(step);
    processStepMetaStore.set(step.id, {
        id: compact.id,
        type: compact.type,
        icon: compact.icon,
        rawIcon: compact.rawIcon,
        label: compact.label,
        isEmployee: compact.isEmployee,
        stepRef: compact.stepRef,
        traceRunId: compact.traceRunId, traceSeq: compact.traceSeq, detailAvailable: compact.detailAvailable,
        detailBytes: compact.detailBytes, rawRetentionStatus: compact.rawRetentionStatus,
        status: compact.status,
        startTime: compact.startTime,
        preview: compact.detailPreview || compact.detail || '',
        detailLength: compact.detailLength || 0,
        detailTruncated: Boolean(compact.detailTruncated),
    });
}

function updateProcessBlockDetailIndex(pb: ProcessBlockState): void {
    pb.element.dataset['processStepIds'] = pb.steps.map(step => step.id).join(' ');
}

function visibleStepIndexes(steps: ProcessStep[], expandedSteps = false): Set<number> {
    const indexes = new Set<number>();
    if (expandedSteps || steps.length <= PROCESS_BLOCK_MAX_RENDERED_STEPS) {
        steps.forEach((_step, idx) => indexes.add(idx));
        return indexes;
    }
    steps.forEach((step, idx) => {
        if (idx < PROCESS_BLOCK_HEAD_STEPS || idx >= steps.length - PROCESS_BLOCK_TAIL_STEPS
            || step.status === 'running' || step.status === 'error') {
            indexes.add(idx);
        }
    });
    return indexes;
}

function renderTrustedIcon(icon: string | undefined): string {
    const value = icon || ICONS.tool;
    return value.trim().startsWith('<svg') ? value : escapeHtml(value);
}

function renderStep(step: ProcessStep): string {
    const dotClass = `process-step-dot ${step.status}`;
    const badgeClass = `process-step-badge ${step.type}`;
    const badgeText = step.type.toUpperCase();
    const label = escapeHtml(step.label || step.icon || '');
    const employeeMarker = step.isEmployee
        ? '<span class="process-step-origin" aria-label="Employee tool">(E)</span>'
        : '';
    const icon = renderTrustedIcon(step.icon);
    const detail = step.detailPreview || step.detail || '';
    const detailId = `process-detail-${step.id}`;
    const traceButton = step.detailAvailable && step.traceRunId && step.traceSeq ? `<span class="process-step-trace" role="button" tabindex="0" title="Open full trace" aria-label="Open full trace" data-trace-run-id="${escapeHtml(step.traceRunId)}" data-trace-seq="${String(step.traceSeq)}">Trace</span>` : '';

    const snippetPreview = previewText(detail, step.type === 'thinking' ? 120 : 80);
    const snippetHtml = snippetPreview
        ? `<span class="process-step-snippet">${escapeHtml(snippetPreview)}</span>`
        : '';
    return `<div class="process-step process-step-expandable"
        data-step-id="${step.id}"
        data-type="${escapeHtml(step.type)}"
        data-status="${escapeHtml(step.status)}"
        data-is-employee="${step.isEmployee ? 'true' : ''}"
        data-step-ref="${escapeHtml(step.stepRef || '')}"
        data-trace-run-id="${escapeHtml(step.traceRunId || '')}"
        data-trace-seq="${String(step.traceSeq || '')}"
        data-start-time="${String(step.startTime || Date.now())}">
        <button class="process-step-toggle" aria-expanded="false" aria-controls="${detailId}">
            <span class="${dotClass}"></span>
            <span class="process-step-icon" aria-hidden="true">${icon}</span>
            <span class="${badgeClass}">${badgeText}</span>
            <span class="process-step-main">
                ${employeeMarker}
                <span class="process-step-label">${label}</span>
                ${snippetHtml}
            </span>
            ${traceButton}
            <span class="process-step-chevron">${ICONS.chevronRight}</span>
        </button>
        <div class="process-step-details collapsed" id="${detailId}">
            <pre class="process-step-full" data-detail-lazy="true"${(step.detailLength || 0) > 0 ? ' data-had-detail="true"' : ''}></pre>
        </div>
    </div>`;
}

function renderOmittedStepSummary(count: number): string {
    // Clickable: reveals the elided middle (data is in pb.steps). Default-collapsed for
    // DOM/memory safety; expanding is an explicit opt-in.
    return `<button type="button" class="process-step process-step-omitted" data-expand-steps data-omitted-count="${count}">
        <span class="process-step-snippet">Show ${count} hidden tool step${count === 1 ? '' : 's'}</span>
    </button>`;
}

function renderSteps(steps: ProcessStep[], expandedSteps = false): string {
    const indexes = visibleStepIndexes(steps, expandedSteps);
    let omitted = 0;
    const parts: string[] = [];
    for (let idx = 0; idx < steps.length; idx++) {
        const step = steps[idx];
        if (!step) continue;
        if (indexes.has(idx)) {
            if (omitted > 0) {
                parts.push(renderOmittedStepSummary(omitted));
                omitted = 0;
            }
            parts.push(renderStep(step));
        } else {
            omitted++;
        }
    }
    if (omitted > 0) parts.push(renderOmittedStepSummary(omitted));
    return parts.join('');
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
    const pre = details?.querySelector('.process-step-full') as HTMLElement | null;
    const chevron = toggle.querySelector('.process-step-chevron');
    if (!wrapper || !details) return;
    const expanding = details.classList.contains('collapsed');
    if (expanding && pre?.dataset['detailLazy'] === 'true') {
        const detail = getStoredProcessStepDetail((wrapper as HTMLElement).dataset['stepId'] || '');
        const resolved = detail || processStepMetaStore.get((wrapper as HTMLElement).dataset['stepId'] || '')?.preview || '';
        // If the step HAD detail (data-had-detail, set at render from detailLength) but
        // both stores were released on recycle, show a hint instead of a blank <pre>.
        // Steps that never had detail keep the empty box (nothing to show — no misleading).
        pre.textContent = resolved || (pre.dataset['hadDetail'] === 'true'
            ? '(detail released to save memory — scroll this message back into view to reload)'
            : '');
        delete pre.dataset['detailLazy'];
    } else if (!expanding && pre && pre.textContent && pre.textContent.length > PROCESS_DETAIL_COLLAPSE_CLEAR_CHARS) {
        pre.textContent = '';
        pre.dataset['detailLazy'] = 'true';
    }
    details.classList.toggle('collapsed', !expanding);
    wrapper.classList.toggle('expanded', expanding);
    toggle.setAttribute('aria-expanded', expanding ? 'true' : 'false');
    if (chevron) chevron.innerHTML = expanding ? ICONS.chevronDown : ICONS.chevronRight;
}

function withProcessBlockLayoutMutation(anchor: Element | null, mutate: () => void): void {
    const hook = window.__jawProcessBlockLayoutMutation;
    if (typeof hook === 'function') {
        hook(anchor, mutate);
        return;
    }
    mutate();
}

function traceActionAllowed(trigger: HTMLElement): boolean {
    return trigger.getAttribute('aria-disabled') !== 'true' && !trigger.matches(':disabled');
}

export function bindProcessBlockInteractions(root: HTMLElement): void {
    if (root.dataset['processBlockBound'] === '1') return;
    root.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null;
        if (!target) return;
        const traceTrigger = target.closest('.process-step-trace') as HTMLElement | null;
        if (traceTrigger) {
            event.preventDefault();
            event.stopPropagation();
            if (!traceActionAllowed(traceTrigger)) return;
            const runId = traceTrigger.dataset['traceRunId'] || '';
            const seq = Number(traceTrigger.dataset['traceSeq'] || 0);
            const intent = ++traceOpenIntent;
            const path = withCurrentSessionQuery('/api/orchestrate/snapshot');
            traceIdentityController?.abort();
            const controller = new AbortController();
            traceIdentityController = controller;
            const snapshot = requestBoundedJson(path, {}, controller.signal, 16 * 1024 * 1024);
            Promise.all([import('./trace-drawer.js'), snapshot])
                .then(([m, data]) => {
                    if (intent !== traceOpenIntent || !traceTrigger.isConnected || !traceActionAllowed(traceTrigger)
                        || path !== withCurrentSessionQuery('/api/orchestrate/snapshot')) return;
                    const identity = parseActivityIdentity(data && typeof data === 'object' && !Array.isArray(data)
                        ? (data as Record<string, unknown>)['activityIdentity'] : null);
                    // Missing ownership is never guessed from the current tab.
                    return m.openTraceDrawer(runId, seq, identity?.sessionId ?? null);
                })
                .catch(error => console.warn('[trace-drawer] open failed:', error));
            return;
        }

        const expandTrigger = target.closest('[data-expand-steps]') as HTMLElement | null;
        if (expandTrigger) {
            event.preventDefault();
            const block = expandTrigger.closest('.process-block') as HTMLElement | null;
            if (!block) return;
            let pb = blockStatesByElement.get(block);
            if (!pb) {
                // Hydrated / virtual-scroll-recycled block: its live ProcessBlockState was
                // GC'd, so it is absent from blockStatesByElement. Reconstruct the full step
                // list from the persistent dataset.processStepIds + meta store (the elided
                // middle rows are NOT in the DOM) and register it so repeat clicks cache-hit.
                const steps = reconstructStepsFromBlock(block);
                if (steps.length === 0) return;
                pb = { element: block, steps, collapsed: block.classList.contains('collapsed') };
                blockStatesByElement.set(block, pb);
            }
            const state = pb;
            withProcessBlockLayoutMutation(block, () => {
                state.expandedSteps = true;
                const inner = state.element.querySelector('.process-steps-inner');
                if (inner) inner.innerHTML = renderSteps(state.steps, true);
            });
            return;
        }

        const stepToggle = target.closest('.process-step-toggle') as HTMLElement | null;
        if (stepToggle) {
            withProcessBlockLayoutMutation(stepToggle.closest('.process-step, .process-block'), () => {
                toggleStepDetails(stepToggle);
            });
            return;
        }

        const summary = target.closest('.process-summary') as HTMLElement | null;
        if (summary) {
            const block = summary.closest('.process-block');
            if (!block) return;
            withProcessBlockLayoutMutation(block, () => {
                const expanding = block.classList.contains('collapsed');
                block.classList.toggle('collapsed', !expanding);
                summary.setAttribute('aria-expanded', expanding ? 'true' : 'false');
                const chevron = summary.querySelector('.process-chevron');
                if (chevron) chevron.innerHTML = expanding ? ICONS.chevronDown : ICONS.chevronRight;
                // Keep the live state in sync with the DOM toggle so the elapsed
                // ticker starts on expand / stops on collapse (WP3: it previously
                // gated on a pb.collapsed that never changed).
                const pb = blockStatesByElement.get(block as HTMLElement);
                if (pb) {
                    pb.collapsed = !expanding;
                    updateSummary(pb);
                }
            });
        }
    });
    root.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const trigger = (event.target as HTMLElement | null)?.closest<HTMLElement>('.process-step-trace');
        if (!trigger) return;
        // Native buttons already synthesize click. The nested span needs an explicit
        // keyboard path that neither scrolls nor activates its parent step toggle.
        if (trigger.tagName === 'BUTTON' && traceActionAllowed(trigger) && !event.repeat) return;
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat && traceActionAllowed(trigger)) trigger.click();
    });
    root.dataset['processBlockBound'] = '1';
}

export function buildProcessBlockHtml(steps: ProcessStep[], collapsed = true): string {
    const compactSteps = steps.map(compactProcessStepForStorage);
    const summaryText = buildSummaryText(compactSteps);
    const html = blockShell(summaryText, collapsed);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    const block = wrapper.querySelector('.process-block') as HTMLElement | null;
    if (block) block.dataset['processStepIds'] = compactSteps.map(step => step.id).join(' ');
    const inner = wrapper.querySelector('.process-steps-inner');
    if (inner) inner.innerHTML = renderSteps(compactSteps);
    const dot = wrapper.querySelector('.process-dot');
    if (dot) {
        const anyRunning = compactSteps.some(step => step.status === 'running');
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

    const elapsedOrigin = blockElapsedOrigin(pb);
    const elapsed = elapsedOrigin !== null
        ? Math.round((Date.now() - elapsedOrigin) / 1000)
        : 0;
    const dur = pb._durationEl ?? (pb._durationEl = pb.element.querySelector('.process-duration') as HTMLElement | null);
    if (dur) dur.textContent = elapsed > 0 ? `${elapsed}s` : '';

    if (anyRunning && !pb.collapsed) ensureTicker(pb);
    else if (_tickerBlock === pb) stopBlockTicker();
}

/** Register a block state reconstructed outside createProcessBlock (e.g. from DOM by
 *  currentProcessBlockFromDom) so the delegated click handler can sync pb.collapsed
 *  and drive the elapsed ticker for hydrated/restored live blocks (WP3). */
export function registerProcessBlockState(state: ProcessBlockState): void {
    blockStatesByElement.set(state.element, state);
}

export function createProcessBlock(parentEl: HTMLElement): ProcessBlockState {
    const host = document.createElement('div');
    host.innerHTML = blockShell('', true);
    const el = host.firstElementChild as HTMLElement;

    const content = parentEl.querySelector('.msg-content');
    if (content) content.before(el);
    else parentEl.appendChild(el);

    const state: ProcessBlockState = { element: el, steps: [], collapsed: true };
    blockStatesByElement.set(el, state);
    return state;
}

// Incremental append support for the elided regime.
// Past PROCESS_BLOCK_MAX_RENDERED_STEPS the tail window shifts on EVERY append, so a
// full renderSteps() per event was O(steps^2) over a long run. Instead: append the new
// tail step, evict the one step that exits the tail window (kept if running/error, the
// same exception visibleStepIndexes makes), and patch the omitted-button count.
function updateOmittedButtonCount(btn: HTMLElement, count: number): void {
    btn.setAttribute('data-omitted-count', String(count));
    const snippet = btn.querySelector('.process-step-snippet');
    if (snippet) snippet.textContent = `Show ${count} hidden tool step${count === 1 ? '' : 's'}`;
}

function evictExitingTailStep(pb: ProcessBlockState, inner: Element): void {
    const len = pb.steps.length;
    const exitIdx = len - 1 - PROCESS_BLOCK_TAIL_STEPS;
    if (exitIdx < PROCESS_BLOCK_HEAD_STEPS) return;
    const exiting = pb.steps[exitIdx];
    if (!exiting || exiting.status === 'running' || exiting.status === 'error') return;
    const el = inner.querySelector(`[data-step-id="${exiting.id}"]`);
    if (!el) return; // already elided (e.g. mid-list step evicted earlier)
    const prev = el.previousElementSibling as HTMLElement | null;
    if (prev && prev.hasAttribute('data-expand-steps')) {
        updateOmittedButtonCount(prev, Number(prev.getAttribute('data-omitted-count') || '0') + 1);
        el.remove();
    } else {
        // Exiting step is not adjacent to an omitted segment (a kept-visible
        // running/error step precedes it) — start a new omitted segment here.
        const temp = document.createElement('div');
        temp.innerHTML = renderOmittedStepSummary(1);
        const marker = temp.firstElementChild;
        if (marker) el.replaceWith(marker);
    }
}

export function addStep(pb: ProcessBlockState, step: ProcessStep): void {
    const compactStep = compactProcessStepForStorage(step);
    pb.steps.push(compactStep);
    const inner = pb.element.querySelector('.process-steps-inner');
    if (inner) {
        if (pb.steps.length === PROCESS_BLOCK_MAX_RENDERED_STEPS + 1 && !pb.expandedSteps) {
            // First append past the cap: one full render establishes the
            // head / omitted-button / tail structure the incremental path patches.
            inner.innerHTML = renderSteps(pb.steps, pb.expandedSteps);
        } else if (pb.steps.length > PROCESS_BLOCK_MAX_RENDERED_STEPS && !pb.expandedSteps) {
            inner.insertAdjacentHTML('beforeend', renderStep(compactStep));
            evictExitingTailStep(pb, inner);
        } else {
            // Short block, or user-expanded long block: plain append keeps
            // every step visible (no elision to maintain).
            inner.insertAdjacentHTML('beforeend', renderStep(compactStep));
        }
    }
    updateProcessBlockDetailIndex(pb);
    updateSummary(pb);
}

export function replaceStep(pb: ProcessBlockState, oldStepId: string, newStep: ProcessStep): void {
    const idx = pb.steps.findIndex(s => s.id === oldStepId);
    if (idx === -1) return;
    if (oldStepId !== newStep.id) {
        processDetailStore.delete(oldStepId);
        processStepMetaStore.delete(oldStepId);
    }
    const compactStep = compactProcessStepForStorage(newStep);
    pb.steps[idx] = compactStep;
    const oldEl = pb.element.querySelector(`[data-step-id="${oldStepId}"]`);
    if (oldEl) {
        const temp = document.createElement('div');
        temp.innerHTML = renderStep(compactStep);
        const newEl = temp.firstElementChild;
        if (newEl) oldEl.replaceWith(newEl);
    } else if (pb.steps.length > PROCESS_BLOCK_MAX_RENDERED_STEPS) {
        const inner = pb.element.querySelector('.process-steps-inner');
        if (inner) inner.innerHTML = renderSteps(pb.steps, pb.expandedSteps);
    }
    updateProcessBlockDetailIndex(pb);
    updateSummary(pb);
}

export function updateStepStatus(pb: ProcessBlockState, stepId: string, status: ProcessStep['status']): void {
    const step = pb.steps.find(s => s.id === stepId);
    if (!step) return;
    step.status = status;
    updateStoredStepMeta(step);
    const stepEl = pb.element.querySelector(`[data-step-id="${stepId}"]`);
    if (stepEl) {
        (stepEl as HTMLElement).dataset['status'] = status;
        const dot = stepEl.querySelector('.process-step-dot');
        if (dot) {
            dot.classList.remove('running', 'done', 'error');
            dot.classList.add(status);
        }
    } else if (status === 'running' || status === 'error') {
        const inner = pb.element.querySelector('.process-steps-inner');
        if (inner) inner.innerHTML = renderSteps(pb.steps, pb.expandedSteps);
    }
    updateProcessBlockDetailIndex(pb);
    updateSummary(pb);
}

export function collapseBlock(pb: ProcessBlockState): void {
    if (_tickerBlock === pb) stopBlockTicker();
    pb.collapsed = true;
    pb.element.classList.add('collapsed');
    const btn = pb.element.querySelector('.process-summary');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    const chevron = pb.element.querySelector('.process-chevron');
    if (chevron) chevron.innerHTML = ICONS.chevronRight;

    for (const step of pb.steps) {
        if (step.status === 'running') {
            step.status = 'done';
            updateStoredStepMeta(step);
        }
    }
    pb.element.querySelectorAll('.process-step-dot.running').forEach(dot => {
        dot.classList.remove('running');
        dot.classList.add('done');
        const row = dot.closest('.process-step') as HTMLElement | null;
        if (row) row.dataset['status'] = 'done';
    });
    updateSummary(pb);
}

export function releaseProcessBlockDetails(rootOrState: HTMLElement | ProcessBlockState | null | undefined): void {
    if (!rootOrState) return;
    releaseDetailsCalls++;
    const ids = new Set<string>();
    if ('steps' in rootOrState) {
        rootOrState.steps.forEach(step => ids.add(step.id));
    } else {
        if (rootOrState.classList.contains('process-block')) {
            (rootOrState.dataset['processStepIds'] || '').split(/\s+/).filter(Boolean).forEach(id => ids.add(id));
        }
        rootOrState.querySelectorAll<HTMLElement>('.process-block[data-process-step-ids]').forEach(block => {
            (block.dataset['processStepIds'] || '').split(/\s+/).filter(Boolean).forEach(id => ids.add(id));
        });
        if (rootOrState.classList.contains('process-step')) {
            const id = rootOrState.dataset['stepId'];
            if (id) ids.add(id);
        }
        rootOrState.querySelectorAll<HTMLElement>('.process-step[data-step-id]').forEach(row => {
            const id = row.dataset['stepId'];
            if (id) ids.add(id);
        });
    }
    ids.forEach(id => {
        processDetailStore.delete(id);
        processStepMetaStore.delete(id);
    });
    releaseDetailsIdsCleared += ids.size;
}

export function processStepMetaFromStore(stepId: string): StoredProcessStepMeta | null {
    return processStepMetaStore.get(stepId) || null;
}

/** Rebuild the FULL step list for a block whose live ProcessBlockState was GC'd
 *  (hydrated from history / recycled by virtual-scroll, hence absent from the
 *  blockStatesByElement WeakMap). The elided middle steps of a long block are NOT
 *  in the DOM, so recover from the persistent id list (dataset.processStepIds) +
 *  meta store rather than scanning .process-step rows. Returns [] if the meta store
 *  was released (caller then no-ops, preserving prior behavior). */
export function reconstructStepsFromBlock(block: HTMLElement): ProcessStep[] {
    reconstructCalls++;
    const ids = (block.dataset['processStepIds'] || '').split(/\s+/).filter(Boolean);
    const steps: ProcessStep[] = [];
    for (const id of ids) {
        const meta = processStepMetaStore.get(id);
        if (!meta) continue;
        steps.push({
            id: meta.id,
            type: meta.type,
            icon: meta.icon,
            rawIcon: meta.rawIcon,
            label: meta.label,
            isEmployee: meta.isEmployee,
            detail: getStoredProcessStepDetail(id) || meta.preview || '',
            detailPreview: meta.preview,
            detailLength: meta.detailLength,
            detailTruncated: meta.detailTruncated,
            stepRef: meta.stepRef,
            traceRunId: meta.traceRunId,
            traceSeq: meta.traceSeq,
            detailAvailable: meta.detailAvailable,
            detailBytes: meta.detailBytes,
            rawRetentionStatus: meta.rawRetentionStatus,
            status: meta.status,
            startTime: meta.startTime,
        });
    }
    reconstructStepsBuilt += steps.length;
    return steps;
}

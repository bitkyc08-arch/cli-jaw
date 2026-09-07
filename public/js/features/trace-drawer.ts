import { requestBoundedJson } from '../bounded-api.js';
import { providerLabel } from '../provider-icons.js';
import { escapeHtml } from '../render.js';

interface TraceSummary {
    id: string; cli: string; model: string; agentLabel: string; status: string;
    rawRetentionStatus: string; eventCount: number; byteCount: number; startedAt: number;
}
interface TraceEventListItem {
    seq: number; source: string; event_type?: string; eventType?: string; preview?: string;
    bytes?: number; retention_status?: string; retentionStatus?: string; created_at?: number; createdAt?: number;
}
interface TraceEventDetail extends TraceEventListItem { runId: string; raw: string; }
interface TraceEventsPage { total: number; events: TraceEventListItem[]; }

const PAGE_SIZE = 80;
const MAX_READ_BYTES = 16 * 1024 * 1024;
let currentRunId = '';
let pageOffset = 0;
let pageLength = 0;
let pageLoaded = false;
let failedOffset: number | null = null;
let totalCount = 0;
let loading = false;
let openRequestId = 0;
let selectedSeq: number | null = null;
let traceSession: string | null = null;
let traceController: AbortController | null = null;
let detailController: AbortController | null = null;
let returnFocus: HTMLElement | null = null;

function eventTypeOf(event: TraceEventListItem): string { return event.eventType || event.event_type || 'event'; }
function isCurrentRequest(requestId: number, runId = currentRunId): boolean {
    return requestId === openRequestId && runId === currentRunId;
}

function tracePath(path: string): string {
    if (!traceSession) return path;
    return path + (path.includes('?') ? '&' : '?') + new URLSearchParams({session:traceSession});
}

async function readTrace<T>(path: string, signal: AbortSignal): Promise<T> {
    const response = await requestBoundedJson(path, { method: 'GET' }, signal, MAX_READ_BYTES);
    // Preserve the existing API wrapper's envelope/bare-response compatibility.
    if (response && typeof response === 'object' && 'ok' in response) {
        if (response.ok !== true || !('data' in response)) throw new Error('trace_unavailable');
        return response.data as T;
    }
    if (!response || typeof response !== 'object') throw new Error('trace_unavailable');
    return response as T;
}

function ensureDrawer(): HTMLElement {
    let overlay = document.getElementById('traceDrawerOverlay') as HTMLElement | null;
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'traceDrawerOverlay';
    overlay.className = 'trace-drawer-overlay';
    overlay.innerHTML = `<aside class="trace-drawer" role="dialog" aria-modal="true" aria-labelledby="traceDrawerTitle">
        <header class="trace-drawer-header">
            <div><p class="trace-drawer-kicker">Raw trace</p><h2 id="traceDrawerTitle">Trace</h2></div>
            <button class="trace-drawer-close" type="button" aria-label="Close trace drawer">×</button>
        </header>
        <section class="trace-drawer-meta" id="traceDrawerMeta"></section>
        <section class="trace-drawer-body">
            <div class="trace-event-list" id="traceEventList"></div>
            <pre class="trace-event-raw" id="traceEventRaw">Select an event.</pre>
        </section>
        <footer class="trace-drawer-footer">
            <button class="trace-page-button trace-page-previous" type="button" disabled>Previous</button>
            <span class="trace-page-status" role="status" aria-live="polite"></span>
            <button class="trace-page-button trace-page-retry" type="button" hidden>Retry</button>
            <button class="trace-page-button trace-load-more" type="button" disabled>Next</button>
        </footer>
    </aside>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', event => {
        const target = event.target as HTMLElement | null;
        if (!target) return;
        if (target === overlay || target.closest('.trace-drawer-close')) closeTraceDrawer();
        const row = target.closest('.trace-event-row') as HTMLElement | null;
        if (row) {
            const runId = row.dataset['runId'] || '';
            const seq = Number(row.dataset['seq'] || 0);
            selectedSeq = Number.isInteger(seq) && seq > 0 ? seq : null;
            markSelectedRow(selectedSeq);
            void loadEventDetail(runId, seq, openRequestId);
        }
        const pager = target.closest<HTMLButtonElement>('.trace-page-button');
        if (!pager || pager.disabled || loading) return;
        const offset = pager.classList.contains('trace-page-retry') ? failedOffset
            : pager.classList.contains('trace-page-previous') ? Math.max(0, pageOffset - PAGE_SIZE)
                : pageOffset + pageLength;
        if (offset !== null) void loadPage(openRequestId, currentRunId, offset, pager);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && overlay?.classList.contains('open')) closeTraceDrawer();
        if (event.key !== 'Tab' || !overlay?.classList.contains('open')) return;
        const controls = [...overlay.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex="0"]')]
            .filter(node => !node.closest('[hidden]') && node.getClientRects().length > 0);
        const first=controls[0], last=controls[controls.length-1];
        if (!first || !last) return;
        const active=document.activeElement;
        if (!overlay.contains(active) || (event.shiftKey && active===first) || (!event.shiftKey && active===last)) {
            event.preventDefault();(event.shiftKey?last:first).focus({preventScroll:true});
        }
    });
    return overlay;
}

function setRaw(text: string): void {
    const raw = document.getElementById('traceEventRaw');
    if (raw) raw.textContent = text;
}
export function closeTraceDrawer(): void {
    if (!document.getElementById('traceDrawerOverlay')?.classList.contains('open')) return;
    ++openRequestId;
    traceController?.abort(); traceController = null;
    detailController?.abort(); detailController = null;
    loading = false;
    document.getElementById('traceDrawerOverlay')?.classList.remove('open');
    if (returnFocus?.isConnected) returnFocus.focus({preventScroll:true});
    returnFocus = null;
}

function renderSummary(summary: TraceSummary): void {
    const title = document.getElementById('traceDrawerTitle');
    if (title) title.textContent = `${summary.cli ? providerLabel(summary.cli) : 'agent'} trace`;
    const meta = document.getElementById('traceDrawerMeta');
    if (!meta) return;
    meta.innerHTML = [
        ['run', summary.id], ['model', summary.model || '-'], ['agent', summary.agentLabel || '-'],
        ['status', summary.status], ['events', `${summary.eventCount}`], ['bytes', `${summary.byteCount}`],
        ['retention', summary.rawRetentionStatus],
    ].map(([label, value]) => `<span><b>${escapeHtml(label)}</b>${escapeHtml(value)}</span>`).join('');
}

function markSelectedRow(seq: number | null): void {
    document.querySelectorAll<HTMLElement>('.trace-event-row[aria-current="true"]').forEach(row => {
        row.removeAttribute('aria-current');
        row.classList.remove('selected');
    });
    if (!seq) return;
    const row = Array.from(document.querySelectorAll<HTMLElement>('.trace-event-row'))
        .find(candidate => Number(candidate.dataset['seq'] || 0) === seq) || null;
    if (!row) return;
    row.setAttribute('aria-current', 'true');
    row.classList.add('selected');
    row.scrollIntoView?.({ block: 'nearest' });
}

function renderEventRows(events: TraceEventListItem[], runId: string): void {
    const list = document.getElementById('traceEventList');
    if (!list) return;
    const html = events.map(event => {
        const seq = Number(event.seq || 0);
        const selected = selectedSeq === seq ? ' aria-current="true"' : '';
        const selectedClass = selectedSeq === seq ? ' selected' : '';
        return `<button class="trace-event-row${selectedClass}" type="button" data-run-id="${escapeHtml(runId)}" data-seq="${seq}"${selected}>
            <span class="trace-event-seq">#${seq}</span><span class="trace-event-source">${escapeHtml(event.source || 'trace')}</span>
            <span class="trace-event-type">${escapeHtml(eventTypeOf(event))}</span><span class="trace-event-preview">${escapeHtml(event.preview || '')}</span>
        </button>`;
    }).join('');
    list.innerHTML = html;
    markSelectedRow(selectedSeq);
}

function updatePager(message?: string): void {
    const previous = document.querySelector<HTMLButtonElement>('.trace-page-previous');
    const next = document.querySelector<HTMLButtonElement>('.trace-load-more');
    const retry = document.querySelector<HTMLButtonElement>('.trace-page-retry');
    if (previous) previous.disabled = !pageLoaded || pageOffset === 0;
    if (next) next.disabled = !pageLoaded || pageLength === 0 || pageOffset + pageLength >= totalCount;
    if (retry) retry.hidden = failedOffset === null;
    // Keep focus on the clicked button during a read; the click handler is singleflight.
    for (const button of [previous, next, retry]) button?.setAttribute('aria-disabled', String(loading || button.disabled));
    const status = document.querySelector('.trace-page-status');
    if (status) status.textContent = message ?? (pageLength
        ? `Events ${pageOffset + 1}–${pageOffset + pageLength} of ${totalCount}` : 'No retained events.');
}

function restorePageFocus(initiator: HTMLButtonElement | undefined, focused: Element | null): void {
    // Capture focus before replacement/disable: browsers may blur a disabled button.
    const lostControl = initiator && focused === initiator && (initiator.disabled || initiator.hidden);
    if (!lostControl && (!focused || focused.isConnected)) return;
    const target = document.querySelector<HTMLElement>('.trace-load-more:not([disabled])')
        ?? document.querySelector<HTMLElement>('.trace-page-previous:not([disabled])')
        ?? document.querySelector<HTMLElement>('.trace-drawer-close');
    target?.focus({ preventScroll: true });
}

async function loadPage(requestId: number, runId: string, offset: number, initiator?: HTMLButtonElement): Promise<void> {
    if (!runId || loading || !traceController || !isCurrentRequest(requestId, runId)) return;
    loading = true;
    updatePager('Loading trace events...');
    try {
        const page = await readTrace<TraceEventsPage>(tracePath(`/api/traces/${encodeURIComponent(runId)}/events?offset=${offset}&limit=${PAGE_SIZE}`), traceController.signal);
        if (!isCurrentRequest(requestId, runId)) return;
        if (!page || !Number.isSafeInteger(page.total) || page.total < 0 || !Array.isArray(page.events)
            || page.events.length > PAGE_SIZE || page.events.some(event => !event || !Number.isSafeInteger(event.seq)
                || event.seq < 1 || typeof event.source !== 'string')) throw new Error('invalid_trace_page');
        const focused = document.activeElement;
        // Commit navigation only after a successful bounded read. Selection/detail is independent.
        renderEventRows(page.events, runId);
        totalCount = page.total;
        pageOffset = offset; pageLength = page.events.length; pageLoaded = true; failedOffset = null;
        loading = false; updatePager(); restorePageFocus(initiator, focused);
    } catch {
        if (!isCurrentRequest(requestId, runId)) return;
        loading = false; failedOffset = offset;
        updatePager('Trace events could not be loaded. Retry this page.');
        return;
    }
    if (selectedSeq === null && pageLength > 0) {
        const first = document.querySelector<HTMLElement>('#traceEventList .trace-event-row');
        selectedSeq = Number(first?.dataset['seq']);
        markSelectedRow(selectedSeq);
        await loadEventDetail(runId, selectedSeq, requestId);
    } else if (selectedSeq === null) setRaw('No retained events.');
}

async function loadEventDetail(runId: string, seq: number, requestId = openRequestId): Promise<void> {
    if (!runId || !Number.isInteger(seq) || seq < 1) return;
    if (!isCurrentRequest(requestId, runId) || !traceController) return;
    detailController?.abort();
    const controller = new AbortController(); detailController = controller;
    const signal = AbortSignal.any([traceController.signal, controller.signal]);
    setRaw('Loading event...');
    try {
        const detail = await readTrace<TraceEventDetail>(tracePath(`/api/traces/${encodeURIComponent(runId)}/events/${seq}`), signal);
        if (!isCurrentRequest(requestId, runId) || selectedSeq !== seq || signal.aborted) return;
        if (!detail || detail.runId !== runId || detail.seq !== seq || typeof detail.raw !== 'string') throw new Error('invalid_trace_detail');
        setRaw(detail.raw || '(empty trace event)');
    } catch {
        if (isCurrentRequest(requestId, runId) && selectedSeq === seq && !signal.aborted)
            setRaw('Trace event could not be loaded. Select the event to retry.');
    } finally { if (detailController === controller) detailController = null; }
}

export async function openTraceDrawer(runId: string, seq?: number, sessionId: string | null = null): Promise<void> {
    const overlay = ensureDrawer();
    const requestId = ++openRequestId;
    // Sequence is a sparse trace identity, not an ordinal in the retained row list.
    traceController?.abort(); traceController = new AbortController();
    detailController?.abort(); detailController = null;
    traceSession = sessionId;
    if (!overlay.contains(document.activeElement)) {
        returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    currentRunId = runId;
    pageOffset = 0; pageLength = 0; pageLoaded = false; failedOffset = null;
    totalCount = 0;
    loading = false;
    selectedSeq = seq && Number.isInteger(seq) && seq > 0 ? seq : null;
    const list = document.getElementById('traceEventList');
    if (list) list.innerHTML = '';
    document.getElementById('traceDrawerMeta')?.replaceChildren();
    const title = document.getElementById('traceDrawerTitle');
    if (title) title.textContent = 'Trace';
    updatePager('Loading trace...');
    setRaw('Loading trace...');
    overlay.classList.add('open');
    overlay.querySelector<HTMLElement>('.trace-drawer-close')?.focus({preventScroll:true});
    try {
        const summary = await readTrace<TraceSummary>(tracePath(`/api/traces/${encodeURIComponent(runId)}`), traceController.signal);
        if (!isCurrentRequest(requestId, runId)) return;
        if (!summary || summary.id !== runId) throw new Error('invalid_trace_summary');
        renderSummary(summary);
        totalCount = summary.eventCount || 0;
    } catch {
        if (isCurrentRequest(requestId, runId)) {
            setRaw('Trace is unavailable or internal-only.'); updatePager('Trace is unavailable.');
        }
        return;
    }
    if (selectedSeq) {
        void loadEventDetail(runId, selectedSeq, requestId);
    }
    await loadPage(requestId, runId, 0);
}

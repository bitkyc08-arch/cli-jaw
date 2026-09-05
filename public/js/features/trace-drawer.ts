import { api } from '../api.js';
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
let currentRunId = '';
let loadedCount = 0;
let totalCount = 0;
let loading = false;
let openRequestId = 0;
let selectedSeq: number | null = null;
let traceSession: string | null = null;
let traceController: AbortController | null = null;
let returnFocus: HTMLElement | null = null;

function eventTypeOf(event: TraceEventListItem): string { return event.eventType || event.event_type || 'event'; }
function isCurrentRequest(requestId: number, runId = currentRunId): boolean {
    return requestId === openRequestId && runId === currentRunId;
}

function tracePath(path: string): string {
    if (!traceSession) return path;
    return path + (path.includes('?') ? '&' : '?') + new URLSearchParams({session:traceSession});
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
        <footer class="trace-drawer-footer"><button class="trace-load-more" type="button">Load more</button></footer>
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
        if (target.closest('.trace-load-more')) void loadNextPage(openRequestId, currentRunId);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && overlay?.classList.contains('open')) closeTraceDrawer();
    });
    return overlay;
}

function setRaw(text: string): void {
    const raw = document.getElementById('traceEventRaw');
    if (raw) raw.textContent = text;
}
export function closeTraceDrawer(): void {
    ++openRequestId;
    traceController?.abort(); traceController = null;
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
    list.insertAdjacentHTML('beforeend', html);
    markSelectedRow(selectedSeq);
}

async function loadNextPage(requestId = openRequestId, runId = currentRunId, offset = loadedCount): Promise<void> {
    if (!runId || loading || (loadedCount >= totalCount && totalCount > 0 && offset >= loadedCount)) return;
    loading = true;
    const page = await api<TraceEventsPage>(tracePath(`/api/traces/${encodeURIComponent(runId)}/events?offset=${offset}&limit=${PAGE_SIZE}`), {signal:traceController?.signal ?? null});
    if (!isCurrentRequest(requestId, runId)) return;
    loading = false;
    if (!page) {
        if (!selectedSeq) setRaw('Trace events could not be loaded.');
        return;
    }
    totalCount = page.total || 0;
    loadedCount = Math.max(loadedCount, offset + page.events.length);
    renderEventRows(page.events, runId);
    const more = document.querySelector('.trace-load-more') as HTMLButtonElement | null;
    if (more) more.disabled = loadedCount >= totalCount;
}

async function loadEventDetail(runId: string, seq: number, requestId = openRequestId): Promise<void> {
    if (!runId || !Number.isInteger(seq) || seq < 1) return;
    if (!isCurrentRequest(requestId, runId)) return;
    setRaw('Loading event...');
    const detail = await api<TraceEventDetail>(tracePath(`/api/traces/${encodeURIComponent(runId)}/events/${seq}`), {signal:traceController?.signal ?? null});
    if (!isCurrentRequest(requestId, runId) || selectedSeq !== seq) return;
    setRaw(detail?.raw || (detail ? '(empty trace event)' : 'Trace event could not be loaded.'));
}

export async function openTraceDrawer(runId: string, seq?: number, sessionId: string | null = null): Promise<void> {
    const overlay = ensureDrawer();
    const requestId = ++openRequestId;
    // Sequence is a sparse trace identity, not an ordinal in the retained row list.
    const startOffset = 0;
    traceController?.abort(); traceController = new AbortController();
    traceSession = sessionId;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    currentRunId = runId;
    loadedCount = startOffset;
    totalCount = 0;
    loading = false;
    selectedSeq = seq && Number.isInteger(seq) && seq > 0 ? seq : null;
    const list = document.getElementById('traceEventList');
    if (list) list.innerHTML = '';
    setRaw('Loading trace...');
    overlay.classList.add('open');
    overlay.querySelector<HTMLElement>('.trace-drawer-close')?.focus({preventScroll:true});
    const summary = await api<TraceSummary>(tracePath(`/api/traces/${encodeURIComponent(runId)}`), {signal:traceController.signal});
    if (!isCurrentRequest(requestId, runId)) return;
    if (!summary) { setRaw('Trace is unavailable or internal-only.'); return; }
    renderSummary(summary);
    totalCount = summary.eventCount || 0;
    if (selectedSeq) {
        void loadEventDetail(runId, selectedSeq, requestId);
    }
    await loadNextPage(requestId, runId, startOffset);
    if (!selectedSeq && totalCount > 0) {
        const firstRow = document.querySelector<HTMLElement>('.trace-event-row');
        const firstSeq = Number(firstRow?.dataset['seq'] || 0);
        if (firstSeq > 0) {
            selectedSeq = firstSeq;
            markSelectedRow(selectedSeq);
            await loadEventDetail(runId, firstSeq, requestId);
        }
    }
}

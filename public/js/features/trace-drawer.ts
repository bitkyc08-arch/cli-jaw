import { api, API_BASE, getAuthToken } from '../api.js';
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
interface TraceEventRange extends TraceEventListItem {
    runId: string; text: string; nextOffset: number; eof: boolean; totalBytes: number;
}
interface TraceDetailResponse<T> {
    ok: boolean; data?: T; error?: string; totalBytes?: number; rangeAvailable?: boolean; chunkSize?: number;
}
interface TraceEventsPage { total: number; events: TraceEventListItem[]; }

const PAGE_SIZE = 80;
const RANGE_CHUNK_BYTES = 262_144;
const RANGE_CHUNK_LIMIT = 16;
const RANGE_DISPLAY_BYTES = RANGE_CHUNK_BYTES * RANGE_CHUNK_LIMIT;
let currentRunId = '';
let loadedCount = 0;
let totalCount = 0;
let loading = false;
let openRequestId = 0;
let selectedSeq: number | null = null;

function eventTypeOf(event: TraceEventListItem): string { return event.eventType || event.event_type || 'event'; }
function isCurrentRequest(requestId: number, runId = currentRunId): boolean {
    return requestId === openRequestId && runId === currentRunId;
}

function requestedOffset(seq?: number): number {
    if (!seq || !Number.isInteger(seq) || seq < 1) return 0;
    return Math.floor((seq - 1) / PAGE_SIZE) * PAGE_SIZE;
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
function setNotice(text = ''): void {
    const notice = document.getElementById('traceEventNotice');
    if (!notice) return;
    notice.textContent = text;
    notice.hidden = !text;
}
function closeTraceDrawer(): void { document.getElementById('traceDrawerOverlay')?.classList.remove('open'); }

function renderSummary(summary: TraceSummary): void {
    const title = document.getElementById('traceDrawerTitle');
    if (title) title.textContent = `${summary.cli ? providerLabel(summary.cli) : 'agent'} trace`;
    const meta = document.getElementById('traceDrawerMeta');
    if (!meta) return;
    meta.innerHTML = [
        ['run', summary.id], ['model', summary.model || '-'], ['agent', summary.agentLabel || '-'],
        ['status', summary.status], ['events', `${summary.eventCount}`], ['bytes', `${summary.byteCount}`],
        ['retention', summary.rawRetentionStatus],
    ].map(([label, value]) => `<span><b>${escapeHtml(label)}</b>${escapeHtml(value)}</span>`).join('')
        + '<span id="traceEventNotice" hidden></span>';
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
    const page = await api<TraceEventsPage>(`/api/traces/${encodeURIComponent(runId)}/events?offset=${offset}&limit=${PAGE_SIZE}`);
    loading = false;
    if (!isCurrentRequest(requestId, runId)) return;
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
    setNotice();
    setRaw('Loading event...');
    const path = `/api/traces/${encodeURIComponent(runId)}/events/${seq}`;
    const token = await getAuthToken();
    let response: Response;
    try {
        response = await fetch(`${API_BASE}${path}`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
    } catch (error) {
        console.warn(`[trace-drawer] ${path} failed:`, (error as Error).message);
        if (isCurrentRequest(requestId, runId) && selectedSeq === seq) setRaw('Trace event could not be loaded.');
        return;
    }
    if (!isCurrentRequest(requestId, runId) || selectedSeq !== seq) return;
    const body = await response.json().catch(() => null) as TraceDetailResponse<TraceEventDetail> | TraceEventDetail | null;
    if (!isCurrentRequest(requestId, runId) || selectedSeq !== seq) return;
    if (response.ok) {
        const detail = body && 'ok' in body ? (body.ok ? body.data || null : null) : body;
        setRaw(detail?.raw || (detail ? '(empty trace event)' : 'Trace event could not be loaded.'));
        return;
    }
    if (response.status !== 413 || !body || !('rangeAvailable' in body) || !body.rangeAvailable) {
        setRaw('Trace event could not be loaded.');
        return;
    }

    let offset = 0;
    let text = '';
    let eof = false;
    let totalBytes = Number(body.totalBytes) || 0;
    const advertisedChunkSize = Number(body.chunkSize);
    const chunkLimit = advertisedChunkSize > 0 ? Math.min(advertisedChunkSize, RANGE_CHUNK_BYTES) : RANGE_CHUNK_BYTES;
    for (let chunk = 0; chunk < RANGE_CHUNK_LIMIT && !eof; chunk++) {
        const rangePath = `${path}?offset=${offset}&limit=${chunkLimit}`;
        let rangeResponse: Response;
        try {
            rangeResponse = await fetch(`${API_BASE}${rangePath}`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
            });
        } catch (error) {
            console.warn(`[trace-drawer] ${rangePath} failed:`, (error as Error).message);
            setRaw('Trace event could not be loaded.');
            return;
        }
        if (!isCurrentRequest(requestId, runId) || selectedSeq !== seq) return;
        const rangeBody = await rangeResponse.json().catch(() => null) as TraceDetailResponse<TraceEventRange> | null;
        if (!isCurrentRequest(requestId, runId) || selectedSeq !== seq) return;
        const range = rangeResponse.ok && rangeBody?.ok ? rangeBody.data : null;
        // nextOffset is null on the final (eof) chunk — only non-eof chunks must advance.
        if (!range || (!range.eof && (!Number.isFinite(range.nextOffset) || range.nextOffset <= offset))) {
            setRaw('Trace event could not be loaded.');
            return;
        }
        text += range.text || '';
        if (!range.eof && Number.isFinite(range.nextOffset)) offset = range.nextOffset;
        eof = range.eof;
        totalBytes = Number(range.totalBytes) || totalBytes;
    }
    setRaw(text || '(empty trace event)');
    if (!eof) {
        const totalMiB = totalBytes / (1024 * 1024);
        const formattedTotal = Number.isInteger(totalMiB) ? `${totalMiB}` : totalMiB.toFixed(1);
        setNotice(`출력이 잘렸습니다 — 전체 ${formattedTotal} MiB 중 ${RANGE_DISPLAY_BYTES / (1024 * 1024)} MiB 표시`);
    }
}

export async function openTraceDrawer(runId: string, seq?: number): Promise<void> {
    const overlay = ensureDrawer();
    const requestId = ++openRequestId;
    const startOffset = requestedOffset(seq);
    currentRunId = runId;
    loadedCount = startOffset;
    totalCount = 0;
    loading = false;
    selectedSeq = seq && Number.isInteger(seq) && seq > 0 ? seq : null;
    const list = document.getElementById('traceEventList');
    if (list) list.innerHTML = '';
    setNotice();
    setRaw('Loading trace...');
    overlay.classList.add('open');
    const summary = await api<TraceSummary>(`/api/traces/${encodeURIComponent(runId)}`);
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

import { escapeHtml } from './html.js';

type DataframeType = 'string' | 'number' | 'boolean' | 'date' | 'json';

export type DataframeSpec = {
    schemaVersion: 'dataframe-v1';
    title: string;
    columns: string[];
    types: DataframeType[];
    rows: string[][];
    pageSize: number;
};

type DataframeState = {
    spec: DataframeSpec;
    filter: string;
    sortColumn: number | null;
    sortDirection: 'asc' | 'desc';
    page: number;
};

const PENDING_SELECTOR = '.dataframe-pending';
const BLOCK_SELECTOR = '.dataframe-block';
const MAX_COLUMNS = 20;
const MAX_ROWS = 500;
const MAX_CELL = 240;
const DEFAULT_PAGE_SIZE = 25;
const dataframeStates = new WeakMap<HTMLElement, DataframeState>();
let delegatedDocument: Document | null = null;

function escapeAttr(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clampText(value: unknown, max = MAX_CELL): string {
    let text = '';
    if (value === null || value === undefined) text = '';
    else if (typeof value === 'object') text = JSON.stringify(value);
    else text = String(value);
    text = text.trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function parseSpec(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function encodeSpec(spec: DataframeSpec): string {
    return encodeURIComponent(JSON.stringify(spec));
}

function readSpecFromBlock(block: HTMLElement): DataframeSpec | null {
    const encoded = block.dataset['dataframeSpec'] || '';
    let decoded = '';
    try {
        decoded = decodeURIComponent(encoded);
    } catch {
        decoded = '';
    }
    return normalizeDataframeSpec(parseSpec(decoded));
}

function normalizePageSize(value: unknown): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_PAGE_SIZE;
    return Math.min(100, Math.max(5, n));
}

function normalizeType(value: unknown): DataframeType {
    if (value === 'number' || value === 'boolean' || value === 'date' || value === 'json') return value;
    return 'string';
}

export function normalizeDataframeSpec(raw: unknown): DataframeSpec | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (obj['schemaVersion'] !== 'dataframe-v1') return null;
    const rawColumns = Array.isArray(obj['columns']) ? obj['columns'] : [];
    const columns = rawColumns.map(col => clampText(col, 80)).filter(Boolean).slice(0, MAX_COLUMNS);
    if (columns.length === 0) return null;
    const sourceRows = Array.isArray(obj['rows']) ? obj['rows'] : Array.isArray(obj['data']) ? obj['data'] : [];
    const rows = sourceRows
        .filter((row): row is unknown[] => Array.isArray(row))
        .slice(0, MAX_ROWS)
        .map(row => columns.map((_col, index) => clampText(row[index])));
    const rawTypes = Array.isArray(obj['types']) ? obj['types'] : [];
    const types = columns.map((_col, index) => normalizeType(rawTypes[index]));
    return {
        schemaVersion: 'dataframe-v1',
        title: clampText(obj['title'], 120) || 'Dataframe',
        columns,
        types,
        rows,
        pageSize: normalizePageSize(obj['pageSize']),
    };
}

export function renderDataframePlaceholder(raw: string): string {
    const encoded = encodeURIComponent(raw);
    return `<div class="dataframe-pending" data-dataframe-kind="dataframe" data-dataframe-spec="${escapeAttr(encoded)}" role="status" aria-label="Dataframe loading">
        <div class="dataframe-loading">표를 준비하는 중...</div>
    </div>`;
}

function getPendingBlocks(root: ParentNode): HTMLElement[] {
    const blocks: HTMLElement[] = [];
    if (root instanceof HTMLElement && root.matches(PENDING_SELECTOR)) blocks.push(root);
    blocks.push(...Array.from(root.querySelectorAll<HTMLElement>(PENDING_SELECTOR)));
    return blocks;
}

function getRestorableBlocks(root: ParentNode): HTMLElement[] {
    const blocks: HTMLElement[] = [];
    const selector = `${BLOCK_SELECTOR}[data-dataframe-spec]`;
    if (root instanceof HTMLElement && root.matches(selector)) blocks.push(root);
    blocks.push(...Array.from(root.querySelectorAll<HTMLElement>(selector)));
    return blocks;
}

function filteredRows(state: DataframeState): string[][] {
    const filter = state.filter.trim().toLowerCase();
    let rows = state.spec.rows;
    if (filter) rows = rows.filter(row => row.some(cell => cell.toLowerCase().includes(filter)));
    if (state.sortColumn !== null) {
        const col = state.sortColumn;
        const dir = state.sortDirection === 'asc' ? 1 : -1;
        rows = [...rows].sort((a, b) => a[col]!.localeCompare(b[col]!, undefined, { numeric: true }) * dir);
    }
    return rows;
}

function renderTable(block: HTMLElement): void {
    const state = dataframeStates.get(block);
    if (!state) return;
    const rows = filteredRows(state);
    const pageCount = Math.max(1, Math.ceil(rows.length / state.spec.pageSize));
    state.page = Math.min(state.page, pageCount - 1);
    const start = state.page * state.spec.pageSize;
    const pageRows = rows.slice(start, start + state.spec.pageSize);
    const headers = state.spec.columns.map((col, index) => {
        const marker = state.sortColumn === index ? (state.sortDirection === 'asc' ? '↑' : '↓') : '';
        return `<th><button class="dataframe-sort-btn" type="button" data-dataframe-action="sort" data-column-index="${index}">${escapeHtml(col)} ${marker}</button></th>`;
    }).join('');
    const body = pageRows.length === 0
        ? `<tr><td class="dataframe-empty" colspan="${state.spec.columns.length}">표시할 행이 없습니다.</td></tr>`
        : pageRows.map(row => `<tr>${row.map(cell => `<td><button class="dataframe-cell" type="button" data-dataframe-action="copy-cell" data-cell-value="${escapeAttr(cell)}">${escapeHtml(cell)}</button></td>`).join('')}</tr>`).join('');
    block.querySelector('.dataframe-table-wrap')!.innerHTML = `<table class="dataframe-table"><thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table>`;
    block.querySelector('.dataframe-page-info')!.textContent = `${state.page + 1}/${pageCount} · ${rows.length} rows`;
    const prev = block.querySelector<HTMLButtonElement>('[data-dataframe-action="prev"]');
    const next = block.querySelector<HTMLButtonElement>('[data-dataframe-action="next"]');
    if (prev) prev.disabled = state.page === 0;
    if (next) next.disabled = state.page >= pageCount - 1;
}

function renderBlock(spec: DataframeSpec): string {
    return `
        <div class="dataframe-toolbar">
            <div class="dataframe-title">${escapeHtml(spec.title)}</div>
            <input class="dataframe-filter" type="search" placeholder="Filter" aria-label="Filter table">
        </div>
        <div class="dataframe-table-wrap"></div>
        <div class="dataframe-pagination">
            <button class="dataframe-page-btn" type="button" data-dataframe-action="prev">Prev</button>
            <span class="dataframe-page-info"></span>
            <button class="dataframe-page-btn" type="button" data-dataframe-action="next">Next</button>
        </div>`;
}

export function hydrateDataframeBlocks(root: ParentNode = document): void {
    for (const block of getPendingBlocks(root)) {
        if (block.dataset['dataframeHydrated'] === 'true') continue;
        block.dataset['dataframeHydrated'] = 'true';
        const spec = readSpecFromBlock(block);
        if (!spec) {
            console.warn('[dataframe] invalid dataframe spec');
            delete block.dataset['dataframeSpec'];
            block.className = 'dataframe-block dataframe-error';
            block.innerHTML = '<div class="dataframe-error-text">표 형식을 읽을 수 없습니다.</div>';
            continue;
        }
        block.className = 'dataframe-block';
        block.dataset['dataframeSpec'] = encodeSpec(spec);
        dataframeStates.set(block, { spec, filter: '', sortColumn: null, sortDirection: 'asc', page: 0 });
        block.innerHTML = renderBlock(spec);
        renderTable(block);
    }
    for (const block of getRestorableBlocks(root)) {
        if (dataframeStates.has(block)) continue;
        const spec = readSpecFromBlock(block);
        if (!spec) continue;
        const filter = block.querySelector<HTMLInputElement>('.dataframe-filter')?.value || '';
        dataframeStates.set(block, { spec, filter, sortColumn: null, sortDirection: 'asc', page: 0 });
        renderTable(block);
    }
}

function findBlock(target: EventTarget | null): HTMLElement | null {
    return target instanceof HTMLElement ? target.closest<HTMLElement>(BLOCK_SELECTOR) : null;
}

async function copyText(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
    }
}

function handleClick(event: MouseEvent): void {
    const actionEl = event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('[data-dataframe-action]')
        : null;
    if (!actionEl) return;
    const block = findBlock(actionEl);
    const state = block ? dataframeStates.get(block) : null;
    if (!block || !state) return;
    event.preventDefault();
    const action = actionEl.dataset['dataframeAction'];
    if (action === 'sort') {
        const col = Number(actionEl.dataset['columnIndex']);
        if (!Number.isInteger(col)) return;
        if (state.sortColumn === col) state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
        else {
            state.sortColumn = col;
            state.sortDirection = 'asc';
        }
        state.page = 0;
        renderTable(block);
    }
    if (action === 'prev') {
        state.page = Math.max(0, state.page - 1);
        renderTable(block);
    }
    if (action === 'next') {
        state.page += 1;
        renderTable(block);
    }
    if (action === 'copy-cell') void copyText(actionEl.dataset['cellValue'] || '');
}

function handleInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.classList.contains('dataframe-filter')) return;
    const block = findBlock(target);
    const state = block ? dataframeStates.get(block) : null;
    if (!block || !state) return;
    state.filter = (target as HTMLInputElement).value;
    state.page = 0;
    renderTable(block);
}

export function ensureDataframeDelegation(): void {
    if (delegatedDocument === document) return;
    document.addEventListener('click', handleClick);
    document.addEventListener('input', handleInput);
    delegatedDocument = document;
}

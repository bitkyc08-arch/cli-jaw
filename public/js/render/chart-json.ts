import { escapeHtml } from './html.js';

type ChartType = 'bar' | 'line' | 'pie';

export type ChartJsonSpec = {
    schemaVersion: 'chart-json-v1';
    type: ChartType;
    title: string;
    description: string;
    labels: string[];
    data: number[];
};

const PENDING_SELECTOR = '.chart-json-pending';
const MAX_POINTS = 24;
const COLORS = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ca8a04', '#0891b2'];

function escapeAttr(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clampText(value: unknown, max: number): string {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function parseSpec(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function normalizeType(value: unknown): ChartType {
    if (value === 'line' || value === 'pie') return value;
    return 'bar';
}

export function normalizeChartJsonSpec(raw: unknown): ChartJsonSpec | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (obj['schemaVersion'] !== 'chart-json-v1') return null;
    const labelsRaw = Array.isArray(obj['labels']) ? obj['labels'] : [];
    const dataRaw = Array.isArray(obj['data']) ? obj['data'] : [];
    const length = Math.min(labelsRaw.length, dataRaw.length, MAX_POINTS);
    const labels: string[] = [];
    const data: number[] = [];
    for (let i = 0; i < length; i += 1) {
        const n = Number(dataRaw[i]);
        if (!Number.isFinite(n)) continue;
        labels.push(clampText(labelsRaw[i], 40) || `Item ${i + 1}`);
        data.push(n);
    }
    if (labels.length === 0) return null;
    return {
        schemaVersion: 'chart-json-v1',
        type: normalizeType(obj['type']),
        title: clampText(obj['title'], 120) || 'Chart',
        description: clampText(obj['description'], 240),
        labels,
        data,
    };
}

export function renderChartJsonPlaceholder(raw: string): string {
    const encoded = encodeURIComponent(raw);
    return `<div class="chart-json-pending" data-chart-json-kind="chart-json" data-chart-json-spec="${escapeAttr(encoded)}" role="status" aria-label="Chart loading">
        <div class="chart-json-loading">차트를 준비하는 중...</div>
    </div>`;
}

function getPendingBlocks(root: ParentNode): HTMLElement[] {
    const blocks: HTMLElement[] = [];
    if (root instanceof HTMLElement && root.matches(PENDING_SELECTOR)) blocks.push(root);
    blocks.push(...Array.from(root.querySelectorAll<HTMLElement>(PENDING_SELECTOR)));
    return blocks;
}

function scaleValue(value: number, min: number, max: number): number {
    if (max === min) return 0.5;
    return (value - min) / (max - min);
}

function renderBar(spec: ChartJsonSpec): string {
    const max = Math.max(...spec.data, 1);
    const width = 360;
    const height = 170;
    const gap = 6;
    const barWidth = Math.max(8, (width - gap * (spec.data.length - 1)) / spec.data.length);
    const bars = spec.data.map((value, index) => {
        const h = Math.max(2, (value / max) * 130);
        const x = index * (barWidth + gap);
        const y = height - h - 24;
        return `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="3" fill="${COLORS[index % COLORS.length]}"><title>${escapeHtml(spec.labels[index]!)}: ${value}</title></rect>`;
    }).join('');
    return `<svg class="chart-json-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttr(spec.title)}">${bars}</svg>`;
}

function renderLine(spec: ChartJsonSpec): string {
    const width = 360;
    const height = 170;
    const min = Math.min(...spec.data);
    const max = Math.max(...spec.data);
    const points = spec.data.map((value, index) => {
        const x = spec.data.length === 1 ? width / 2 : (index / (spec.data.length - 1)) * width;
        const y = 145 - scaleValue(value, min, max) * 120;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const dots = points.map((point, index) => {
        const [x, y] = point.split(',');
        return `<circle cx="${x}" cy="${y}" r="3" fill="${COLORS[index % COLORS.length]}"><title>${escapeHtml(spec.labels[index]!)}: ${spec.data[index]}</title></circle>`;
    }).join('');
    return `<svg class="chart-json-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttr(spec.title)}"><polyline points="${points.join(' ')}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${dots}</svg>`;
}

function describeArc(cx: number, cy: number, r: number, start: number, end: number): string {
    const startX = cx + r * Math.cos(start);
    const startY = cy + r * Math.sin(start);
    const endX = cx + r * Math.cos(end);
    const endY = cy + r * Math.sin(end);
    const large = end - start > Math.PI ? 1 : 0;
    return `M ${cx} ${cy} L ${startX.toFixed(2)} ${startY.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${endX.toFixed(2)} ${endY.toFixed(2)} Z`;
}

function renderPie(spec: ChartJsonSpec): string {
    const total = spec.data.reduce((sum, value) => sum + Math.max(0, value), 0);
    if (total <= 0) return renderBar(spec);
    let cursor = -Math.PI / 2;
    const slices = spec.data.map((value, index) => {
        const size = (Math.max(0, value) / total) * Math.PI * 2;
        const path = describeArc(90, 85, 64, cursor, cursor + size);
        cursor += size;
        return `<path d="${path}" fill="${COLORS[index % COLORS.length]}"><title>${escapeHtml(spec.labels[index]!)}: ${value}</title></path>`;
    }).join('');
    return `<svg class="chart-json-svg" viewBox="0 0 180 170" role="img" aria-label="${escapeAttr(spec.title)}">${slices}</svg>`;
}

function renderLegend(spec: ChartJsonSpec): string {
    return spec.labels.map((label, index) => `<span class="chart-json-legend-item"><span class="chart-json-swatch chart-json-swatch-${index % COLORS.length}"></span>${escapeHtml(label)}</span>`).join('');
}

function renderChart(spec: ChartJsonSpec): string {
    const chart = spec.type === 'line' ? renderLine(spec) : spec.type === 'pie' ? renderPie(spec) : renderBar(spec);
    return `
        <div class="chart-json-header">
            <div class="chart-json-title">${escapeHtml(spec.title)}</div>
            ${spec.description ? `<div class="chart-json-description">${escapeHtml(spec.description)}</div>` : ''}
        </div>
        <div class="chart-json-frame">${chart}</div>
        <div class="chart-json-legend">${renderLegend(spec)}</div>`;
}

export function hydrateChartJsonBlocks(root: ParentNode = document): void {
    for (const block of getPendingBlocks(root)) {
        if (block.dataset['chartJsonHydrated'] === 'true') continue;
        block.dataset['chartJsonHydrated'] = 'true';
        const encoded = block.dataset['chartJsonSpec'] || '';
        let decoded = '';
        try {
            decoded = decodeURIComponent(encoded);
        } catch {
            decoded = '';
        }
        delete block.dataset['chartJsonSpec'];
        const spec = normalizeChartJsonSpec(parseSpec(decoded));
        if (!spec) {
            console.warn('[chart-json] invalid chart spec', { decodedChars: decoded.length });
            block.className = 'chart-json-block chart-json-error';
            block.innerHTML = '<div class="chart-json-error-text">차트 형식을 읽을 수 없습니다.</div>';
            continue;
        }
        block.className = 'chart-json-block';
        block.innerHTML = renderChart(spec);
    }
}

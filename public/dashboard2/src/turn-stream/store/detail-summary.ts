import type { TurnSegmentDetailRef } from '../../../../../src/shared/chat-events.js';

export type DetailStatus = 'running' | 'done' | 'error';

export interface FullDetail {
    tier: 'full';
    label: string;
    status: DetailStatus;
    detail: string;
    detailRef: TurnSegmentDetailRef | null;
}

export interface DetailPreview {
    tier: 'preview';
    label: string;
    status: DetailStatus;
    preview: string;
    lineCount: number;
    detailBytes: number;
    truncated: boolean;
    detailRef: TurnSegmentDetailRef | null;
}

export interface DetailSummary {
    tier: 'summary';
    label: string;
    status: DetailStatus;
    summary: string;
    lineCount: number;
    detailBytes: number;
    detailRef: TurnSegmentDetailRef | null;
}

export interface DetailSummaryAggregate {
    count: number;
    running: number;
    done: number;
    error: number;
    lineCount: number;
    detailBytes: number;
    label: string;
}

const DEFAULT_PREVIEW_BYTES = 8 * 1024;

export function estimateDetailBytes(detail: string): number {
    return new TextEncoder().encode(detail).byteLength;
}

function countLines(detail: string): number {
    if (!detail) return 0;
    return detail.split(/\r\n|\r|\n/).length;
}

function truncateUtf8(detail: string, maxBytes: number): string {
    if (maxBytes <= 0) return '';
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const bytes = encoder.encode(detail);
    if (bytes.byteLength <= maxBytes) return detail;
    return decoder.decode(bytes.slice(0, maxBytes)).replace(/\uFFFD$/u, '');
}

export function detailToPreview(full: FullDetail, maxBytes = DEFAULT_PREVIEW_BYTES): DetailPreview {
    const detailBytes = estimateDetailBytes(full.detail);
    const preview = truncateUtf8(full.detail, Math.max(0, Math.floor(maxBytes)));
    return {
        tier: 'preview',
        label: full.label,
        status: full.status,
        preview,
        lineCount: countLines(full.detail),
        detailBytes,
        truncated: estimateDetailBytes(preview) < detailBytes,
        detailRef: full.detailRef,
    };
}

export function previewToSummary(preview: DetailPreview): DetailSummary {
    const noun = preview.lineCount === 1 ? 'line' : 'lines';
    return {
        tier: 'summary',
        label: preview.label,
        status: preview.status,
        summary: `${preview.label} · ${preview.status} · ${preview.lineCount} ${noun} · ${preview.detailBytes} bytes`,
        lineCount: preview.lineCount,
        detailBytes: preview.detailBytes,
        detailRef: preview.detailRef,
    };
}

export function detailToSummary(full: FullDetail): DetailSummary {
    return previewToSummary(detailToPreview(full));
}

export function aggregateDetailSummaries(summaries: readonly DetailSummary[]): DetailSummaryAggregate {
    const labels = new Map<string, number>();
    let running = 0;
    let done = 0;
    let error = 0;
    let lineCount = 0;
    let detailBytes = 0;
    for (const item of summaries) {
        labels.set(item.label, (labels.get(item.label) || 0) + 1);
        if (item.status === 'running') running += 1;
        else if (item.status === 'error') error += 1;
        else done += 1;
        lineCount += item.lineCount;
        detailBytes += item.detailBytes;
    }
    const label = [...labels.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([name, count]) => count === 1 ? name : `${name} ×${count}`)
        .join(', ');
    return { count: summaries.length, running, done, error, lineCount, detailBytes, label };
}

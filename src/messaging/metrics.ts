// In-process messaging metrics.
//
// Labels are a closed set. Actor, event, conversation, and session ids are
// high-cardinality and belong on the trace, not here. There is no exporter
// in this cycle — snapshot() is what health/doctor read.

export const METRIC_LABEL_KEYS = ['channel', 'state', 'result'] as const;
export type MetricLabelKey = (typeof METRIC_LABEL_KEYS)[number];
export type MetricLabels = Partial<Record<MetricLabelKey, string>>;

export type MetricCounterSnapshot = {
    name: string;
    labels: MetricLabels;
    value: number;
};

export type MetricHistogramSnapshot = {
    name: string;
    labels: MetricLabels;
    count: number;
    sum: number;
    min: number;
    max: number;
};

export type MessagingMetricsSnapshot = {
    counters: MetricCounterSnapshot[];
    histograms: MetricHistogramSnapshot[];
};

const ALLOWED = new Set<string>(METRIC_LABEL_KEYS);

type HistogramAcc = { count: number; sum: number; min: number; max: number };

const counters = new Map<string, { name: string; labels: MetricLabels; value: number }>();
const histograms = new Map<string, { name: string; labels: MetricLabels } & HistogramAcc>();

function sanitizeLabels(labels: Record<string, unknown> | MetricLabels | undefined): MetricLabels {
    const out: MetricLabels = {};
    if (!labels) return out;
    for (const key of METRIC_LABEL_KEYS) {
        const value = (labels as Record<string, unknown>)[key];
        if (typeof value === 'string' && value.length > 0) out[key] = value;
    }
    return out;
}

function seriesKey(name: string, labels: MetricLabels): string {
    const parts = [name];
    for (const key of METRIC_LABEL_KEYS) {
        if (labels[key]) parts.push(`${key}=${labels[key]}`);
    }
    return parts.join('|');
}

export function inc(name: string, labels: Record<string, unknown> | MetricLabels = {}, by = 1): void {
    if (!Number.isFinite(by) || by === 0) return;
    const safe = sanitizeLabels(labels);
    const key = seriesKey(name, safe);
    const existing = counters.get(key);
    if (existing) {
        existing.value += by;
        return;
    }
    counters.set(key, { name, labels: safe, value: by });
}

export function observe(name: string, value: number, labels: Record<string, unknown> | MetricLabels = {}): void {
    if (!Number.isFinite(value)) return;
    const safe = sanitizeLabels(labels);
    const key = seriesKey(name, safe);
    const existing = histograms.get(key);
    if (existing) {
        existing.count += 1;
        existing.sum += value;
        existing.min = Math.min(existing.min, value);
        existing.max = Math.max(existing.max, value);
        return;
    }
    histograms.set(key, { name, labels: safe, count: 1, sum: value, min: value, max: value });
}

export function snapshotMetrics(): MessagingMetricsSnapshot {
    return {
        counters: [...counters.values()].map((row) => ({ ...row, labels: { ...row.labels } })),
        histograms: [...histograms.values()].map((row) => ({ ...row, labels: { ...row.labels } })),
    };
}

/** Test seam: the registry is process-global. */
export function __resetMessagingMetricsForTests(): void {
    counters.clear();
    histograms.clear();
}

// Keep the unused set referenced so a future label cannot be added silently.
void ALLOWED;

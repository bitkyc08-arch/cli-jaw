import type {
    TurnSegment,
    WidgetCapability,
    WidgetStorage,
    WidgetTurnSegmentDescriptor,
} from '../../../../../src/shared/chat-events.ts';

export type WidgetDescriptor = Omit<WidgetTurnSegmentDescriptor, 'widgetId' | 'title'> & {
    widgetId?: string;
    title: string;
    source?: string;
};

export interface AdaptedWidgetSegment {
    segment: TurnSegment;
    descriptor: WidgetDescriptor;
}

const FALLBACK_HEIGHT = 160;

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function descriptorCandidate(value: unknown): Record<string, unknown> | null {
    const source = record(value);
    if (!source) return null;
    for (const key of ['descriptor', 'widgetDescriptor', 'widget', 'metadata']) {
        const nested = record(source[key]);
        if (nested) return descriptorCandidate(nested) ?? nested;
    }
    return source;
}

function decodeSegmentDescriptor(segmentId: string): Record<string, unknown> | null {
    if (!segmentId.startsWith('widget:')) return null;
    try {
        const base64url = segmentId.slice('widget:'.length);
        const base64 = base64url.replaceAll('-', '+').replaceAll('_', '/');
        const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
        const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0));
        return record(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
        return null;
    }
}

function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function parseWidgetDescriptor(segment: TurnSegment, hydrationSource?: unknown): WidgetDescriptor {
    const segmentSource = decodeSegmentDescriptor(segment.segmentId) ?? descriptorCandidate(segment);
    const hydrated = descriptorCandidate(hydrationSource);
    const value = { ...(segmentSource ?? {}), ...(hydrated ?? {}) };
    const storage = value['storage'] === 'file' || value['storage'] === 'inline' ? value['storage'] : 'inline';
    const rawHeight = value['estimatedHeight'];
    const estimatedHeight = typeof rawHeight === 'number' && Number.isFinite(rawHeight) && rawHeight > 0
        ? rawHeight
        : FALLBACK_HEIGHT;
    const capabilities = Array.isArray(value['capabilities'])
        ? [...new Set(value['capabilities'].filter((item): item is WidgetCapability => item === 'interactive' || item === 'stateful'))]
        : [];

    return {
        widgetId: text(value['widgetId']) ?? segment.segmentId,
        ...(storage === 'inline' && text(value['source']) ? { source: text(value['source'])! } : {}),
        storage,
        revision: text(value['revision']) ?? 'legacy',
        title: text(value['title']) ?? 'Widget',
        estimatedHeight,
        capabilities,
    };
}

export function adaptWidgetSegment(segment: TurnSegment, hydrationSource?: unknown): AdaptedWidgetSegment | null {
    if (segment.type !== 'widget') return null;
    const candidate = descriptorCandidate(hydrationSource);
    if (candidate?.['kind'] === 'mermaid') return null;
    return { segment, descriptor: parseWidgetDescriptor(segment, hydrationSource) };
}

export function normalizeWidgetSlot(slot: unknown): WidgetDescriptor | null {
    const value = record(slot);
    if (!value || value['kind'] === 'mermaid' || value['kind'] !== 'widget') return null;
    const storage = value['storage'] === 'file' ? 'file' : 'inline';
    const capabilities = Array.isArray(value['capabilities'])
        ? value['capabilities'].filter((item): item is WidgetCapability => item === 'interactive' || item === 'stateful')
        : [];
    if (storage === 'file' && !text(value['widgetId'])) return null;
    if (storage === 'inline' && !text(value['source'])) return null;
    return {
        ...(storage === 'file' ? { widgetId: text(value['widgetId'])! } : { source: text(value['source'])! }),
        storage, revision: text(value['revision']) ?? 'manifest', title: text(value['title']) ?? 'Widget',
        estimatedHeight: typeof value['estimatedHeight'] === 'number' && value['estimatedHeight'] > 0 ? value['estimatedHeight'] : FALLBACK_HEIGHT,
        capabilities: [...new Set(capabilities)],
    };
}

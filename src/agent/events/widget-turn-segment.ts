import type {
    TurnSegment,
    TurnSegmentStatus,
    WidgetTurnSegmentDescriptor,
} from '../../shared/chat-events.js';
import type { SpawnContext } from '../../types/agent.js';
import { appendTurnMetadataSegment } from './helpers.js';

const WIDGET_SEGMENT_PREFIX = 'widget:';

function validateDescriptor(descriptor: WidgetTurnSegmentDescriptor): void {
    if (!descriptor.widgetId.trim()) throw new TypeError('widgetId must be a non-empty string');
    if (!descriptor.revision.trim()) throw new TypeError('revision must be a non-empty string');
    if (!descriptor.title.trim()) throw new TypeError('title must be a non-empty string');
    if (!Number.isSafeInteger(descriptor.estimatedHeight) || descriptor.estimatedHeight < 1) {
        throw new TypeError('estimatedHeight must be a positive safe integer');
    }
}

export function widgetSegmentId(descriptor: WidgetTurnSegmentDescriptor): string {
    validateDescriptor(descriptor);
    const encoded = Buffer.from(JSON.stringify(descriptor), 'utf8').toString('base64url');
    return `${WIDGET_SEGMENT_PREFIX}${encoded}`;
}

export function parseWidgetSegmentId(segmentId: string): WidgetTurnSegmentDescriptor | null {
    if (!segmentId.startsWith(WIDGET_SEGMENT_PREFIX)) return null;
    try {
        const parsed = JSON.parse(
            Buffer.from(segmentId.slice(WIDGET_SEGMENT_PREFIX.length), 'base64url').toString('utf8'),
        ) as WidgetTurnSegmentDescriptor;
        validateDescriptor(parsed);
        if (parsed.storage !== 'file' && parsed.storage !== 'inline') return null;
        if (!Array.isArray(parsed.capabilities)
            || parsed.capabilities.some(capability => capability !== 'interactive' && capability !== 'stateful')) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function publishWidgetTurnSegment(
    ctx: SpawnContext,
    descriptor: WidgetTurnSegmentDescriptor,
    status: TurnSegmentStatus = 'done',
): TurnSegment | null {
    // The current widget watcher only has chatId/widgetId and cannot identify an
    // owning turn. Wire this producer at the 06x dashboard2 widget migration
    // point where diagram parsing has the parent SpawnContext and revision.
    return appendTurnMetadataSegment(ctx, 'widget', status, widgetSegmentId(descriptor));
}

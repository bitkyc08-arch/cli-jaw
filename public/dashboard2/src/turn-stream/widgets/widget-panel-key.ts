import type { WidgetDescriptor } from './widget-segment-adapter.ts';

export type WidgetPromotionSource = 'turn-widget';

export interface WidgetRenderIdentity {
    scopeKey: string;
    turnId: string;
    segmentId: string;
}

export interface WidgetPanelPayload {
    kind: 'widget';
    source: WidgetPromotionSource;
    panelKey: string;
    rowKey: string;
    chatId: string;
    descriptor: WidgetDescriptor;
    identity: WidgetRenderIdentity;
}

function keyPart(value: string): string {
    return encodeURIComponent(value);
}

export function widgetPanelKey(chatId: string, widgetId: string): string {
    return `widget:${keyPart(chatId)}:${keyPart(widgetId)}`;
}

export function widgetRowKey(identity: WidgetRenderIdentity): string {
    return `widget-row:${keyPart(identity.scopeKey)}:${keyPart(identity.turnId)}:${keyPart(identity.segmentId)}`;
}

function isIdentity(value: unknown): value is WidgetRenderIdentity {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const identity = value as Record<string, unknown>;
    return typeof identity['scopeKey'] === 'string' && identity['scopeKey'].length > 0
        && typeof identity['turnId'] === 'string' && identity['turnId'].length > 0
        && typeof identity['segmentId'] === 'string' && identity['segmentId'].length > 0;
}

function isDescriptor(value: unknown): value is WidgetDescriptor {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const descriptor = value as Record<string, unknown>;
    const capabilities = descriptor['capabilities'];
    return typeof descriptor['widgetId'] === 'string' && descriptor['widgetId'].length > 0
        && typeof descriptor['title'] === 'string' && descriptor['title'].length > 0
        && typeof descriptor['revision'] === 'string' && descriptor['revision'].length > 0
        && (descriptor['storage'] === 'file' || descriptor['storage'] === 'inline')
        && typeof descriptor['estimatedHeight'] === 'number' && Number.isFinite(descriptor['estimatedHeight']) && descriptor['estimatedHeight'] > 0
        && Array.isArray(capabilities)
        && capabilities.every(capability => capability === 'interactive' || capability === 'stateful')
        && capabilities.includes('stateful')
        && (descriptor['storage'] !== 'inline' || typeof descriptor['source'] === 'string');
}

export function createWidgetPanelPayload(
    source: WidgetPromotionSource | undefined,
    chatId: string | undefined,
    descriptor: Partial<WidgetDescriptor>,
    identity: WidgetRenderIdentity | undefined,
): WidgetPanelPayload | null {
    const validDescriptor: WidgetDescriptor | null = isDescriptor(descriptor) ? descriptor : null;
    const validIdentity: WidgetRenderIdentity | null = isIdentity(identity) ? identity : null;
    const widgetId = validDescriptor?.widgetId;
    if (source !== 'turn-widget' || !chatId || !validDescriptor || !validIdentity || !widgetId) return null;
    return {
        kind: 'widget',
        source,
        panelKey: widgetPanelKey(chatId, widgetId),
        rowKey: widgetRowKey(validIdentity),
        chatId,
        descriptor: validDescriptor,
        identity: validIdentity,
    };
}

export function isWidgetPanelPayload(value: unknown): value is WidgetPanelPayload {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const payload = value as Record<string, unknown>;
    const descriptor: WidgetDescriptor | null = isDescriptor(payload['descriptor']) ? payload['descriptor'] : null;
    const identity: WidgetRenderIdentity | null = isIdentity(payload['identity']) ? payload['identity'] : null;
    const widgetId = descriptor?.widgetId;
    if (payload['kind'] !== 'widget' || payload['source'] !== 'turn-widget'
        || typeof payload['chatId'] !== 'string' || payload['chatId'].length === 0 || !descriptor || !identity || !widgetId) return false;
    const expectedPanelKey = widgetPanelKey(payload['chatId'], widgetId);
    const expectedRowKey = widgetRowKey(identity);
    return payload['panelKey'] === expectedPanelKey && payload['rowKey'] === expectedRowKey;
}

import { normalizePreviewUrlForCurrentHost } from './preview';
import type { DashboardScanResult } from './types';

export function allowedPreviewMessageOrigins(
    data: DashboardScanResult | null,
    currentHref = typeof window !== 'undefined' ? window.location.href : '',
): ReadonlySet<string> {
    const origins = new Set<string>();
    if (!currentHref) return origins;

    try {
        origins.add(new URL(currentHref).origin);
    } catch {
        return origins;
    }

    const previews = data?.manager.proxy.preview?.instances;
    if (!previews) return origins;
    for (const preview of Object.values(previews)) {
        if (preview.status !== 'ready' || !preview.url) continue;
        try {
            origins.add(new URL(normalizePreviewUrlForCurrentHost(preview.url, currentHref), currentHref).origin);
        } catch {
            // Invalid scan data must not widen the trusted origin set.
        }
    }
    return origins;
}

export function isAllowedPreviewMessage(
    event: Pick<MessageEvent, 'origin'>,
    allowedOrigins: ReadonlySet<string>,
): boolean {
    return Boolean(event.origin && event.origin !== 'null' && allowedOrigins.has(event.origin));
}

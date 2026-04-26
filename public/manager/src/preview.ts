import type { DashboardInstance, DashboardPreviewMode, DashboardScanResult } from './types';

export type PreviewState = {
    canPreview: boolean;
    src: string | null;
    reason: string | null;
};

export function buildPreviewState(
    instance: DashboardInstance | null,
    data: DashboardScanResult | null,
    mode: DashboardPreviewMode,
): PreviewState {
    if (!instance) {
        return { canPreview: false, src: null, reason: 'Select an online instance to preview.' };
    }

    if (!instance.ok) {
        return { canPreview: false, src: null, reason: 'Preview is only available for online instances.' };
    }

    if (mode === 'proxy') {
        const proxy = data?.manager.proxy;
        if (!proxy?.enabled) {
            return { canPreview: false, src: null, reason: 'Proxy preview is not available.' };
        }
        if (instance.port < proxy.allowedFrom || instance.port > proxy.allowedTo) {
            return { canPreview: false, src: null, reason: 'This port is outside the proxy allowlist.' };
        }
        const basePath = proxy.basePath || '/i';
        return { canPreview: true, src: `${basePath}/${instance.port}/`, reason: null };
    }

    return { canPreview: true, src: instance.url, reason: null };
}

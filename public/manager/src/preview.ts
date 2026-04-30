import type { DashboardInstance, DashboardScanResult } from './types';

export type PreviewState = {
    canPreview: boolean;
    src: string | null;
    reason: string | null;
    transport: PreviewTransport;
    warning: string | null;
};

export type PreviewTheme = 'dark' | 'light';
export type PreviewTransport = 'origin-port' | 'legacy-path' | 'none';

type PreviewArgument = PreviewTheme | 'proxy' | 'direct' | undefined;

function isPreviewTheme(value: PreviewArgument): value is PreviewTheme {
    return value === 'dark' || value === 'light';
}

export function appendPreviewTheme(src: string, theme: PreviewTheme | null | undefined): string {
    if (!theme) return src;
    const isRelative = src.startsWith('/');
    const url = new URL(src, 'http://jaw.local');
    url.searchParams.set('jawTheme', theme);
    if (isRelative) return `${url.pathname}${url.search}${url.hash}`;
    return url.toString();
}

export function buildPreviewState(
    instance: DashboardInstance | null,
    data: DashboardScanResult | null,
    previewArgument?: PreviewArgument,
): PreviewState {
    if (!instance) {
        return { canPreview: false, src: null, reason: 'Select an online instance to preview.', transport: 'none', warning: null };
    }

    if (!instance.ok) {
        return { canPreview: false, src: null, reason: 'Preview is only available for online instances.', transport: 'none', warning: null };
    }

    const proxy = data?.manager.proxy;
    if (!proxy?.enabled) {
        return { canPreview: false, src: null, reason: 'Proxy preview is not available.', transport: 'none', warning: null };
    }
    if (instance.port < proxy.allowedFrom || instance.port > proxy.allowedTo) {
        return { canPreview: false, src: null, reason: 'This port is outside the proxy allowlist.', transport: 'none', warning: null };
    }
    const originPreview = proxy.preview?.instances[String(instance.port)];
    const theme = isPreviewTheme(previewArgument) ? previewArgument : null;
    if (proxy.preview?.enabled && originPreview?.status === 'ready' && originPreview.url) {
        return {
            canPreview: true,
            src: appendPreviewTheme(originPreview.url, theme),
            reason: null,
            transport: 'origin-port',
            warning: 'origin proxy ready',
        };
    }
    const basePath = proxy.basePath || '/i';
    return {
        canPreview: true,
        src: appendPreviewTheme(`${basePath}/${instance.port}/`, theme),
        reason: null,
        transport: 'legacy-path',
        warning: 'legacy proxy fallback',
    };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreviewState, prefersLegacyPreviewTransport } from '../../public/manager/src/preview.ts';
import type { DashboardInstance, DashboardScanResult } from '../../public/manager/src/types.ts';

const onlineInstance: DashboardInstance = {
    port: 3457,
    ok: true,
    status: 'online',
    healthReason: null,
    home: '/Users/jun/.cli-jaw',
    version: '2.0.13',
    checkedAt: '2026-05-28T06:00:00.000Z',
};

const scanWithOriginPreview: DashboardScanResult = {
    manager: {
        port: 24576,
        checkedAt: '2026-05-28T06:00:00.000Z',
        proxy: {
            enabled: true,
            basePath: '/i',
            allowedFrom: 3457,
            allowedTo: 3506,
            preview: {
                enabled: true,
                kind: 'origin-port',
                previewFrom: 24602,
                previewTo: 24651,
                instances: {
                    '3457': {
                        targetPort: 3457,
                        previewPort: 24602,
                        url: 'http://127.0.0.1:24602/',
                        status: 'ready',
                        reason: null,
                    },
                },
            },
        },
    },
    instances: [onlineInstance],
};

test('prefersLegacyPreviewTransport detects Safari but not Chrome', () => {
    assert.equal(
        prefersLegacyPreviewTransport('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'),
        true,
    );
    assert.equal(
        prefersLegacyPreviewTransport('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'),
        false,
    );
});

test('buildPreviewState uses legacy path on Safari even when origin preview is ready', () => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
        },
    });
    try {
        const state = buildPreviewState(onlineInstance, scanWithOriginPreview, { theme: 'dark' });
        assert.equal(state.transport, 'legacy-path');
        assert.equal(state.src, '/i/3457/0?jawTheme=dark');
    } finally {
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: original });
    }
});

test('buildPreviewState keeps origin-port on Chrome-like user agents', () => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
    });
    try {
        const state = buildPreviewState(onlineInstance, scanWithOriginPreview, { theme: 'dark' });
        assert.equal(state.transport, 'origin-port');
        assert.match(state.src || '', /24602/);
    } finally {
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: original });
    }
});

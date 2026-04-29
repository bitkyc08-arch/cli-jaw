import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreviewState } from '../../public/manager/src/preview.js';
import type { DashboardInstance, DashboardScanResult } from '../../public/manager/src/types.js';

const online: DashboardInstance = {
    port: 3457,
    url: 'http://localhost:3457',
    status: 'online',
    ok: true,
    version: null,
    uptime: null,
    instanceId: 'default',
    homeDisplay: '/Users/jun/.cli-jaw',
    workingDir: '/Users/jun/.cli-jaw',
    currentCli: 'codex',
    currentModel: null,
    serviceMode: 'unknown',
    lastCheckedAt: '2026-04-26T00:00:00.000Z',
    healthReason: null,
};

const data: DashboardScanResult = {
    manager: {
        port: 24576,
        rangeFrom: 3457,
        rangeTo: 3506,
        checkedAt: '2026-04-26T00:00:00.000Z',
        proxy: {
            enabled: true,
            basePath: '/i',
            allowedFrom: 3457,
            allowedTo: 3506,
        },
    },
    instances: [online],
};

test('preview helper builds proxy preview url', () => {
    assert.deepEqual(buildPreviewState(online, data, 'proxy'), {
        canPreview: true,
        src: '/i/3457/',
        reason: null,
        transport: 'legacy-path',
        warning: 'legacy proxy fallback',
    });
});

test('preview helper prefers origin-port preview url', () => {
    assert.deepEqual(buildPreviewState(online, {
        ...data,
        manager: {
            ...data.manager,
            proxy: {
                ...data.manager.proxy,
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
    }, 'proxy'), {
        canPreview: true,
        src: 'http://127.0.0.1:24602/',
        reason: null,
        transport: 'origin-port',
        warning: 'origin proxy ready',
    });
});

test('preview helper falls back when origin-port preview is unavailable', () => {
    const state = buildPreviewState(online, {
        ...data,
        manager: {
            ...data.manager,
            proxy: {
                ...data.manager.proxy,
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
                            status: 'unavailable',
                            reason: 'EADDRINUSE',
                        },
                    },
                },
            },
        },
    }, 'proxy');

    assert.equal(state.src, '/i/3457/');
    assert.equal(state.transport, 'legacy-path');
});

test('preview helper ignores legacy direct mode argument and keeps proxy path', () => {
    const state = buildPreviewState(online, data, 'direct' as any);

    assert.equal(state.src, '/i/3457/');
    assert.equal(state.transport, 'legacy-path');
    assert.equal(state.warning, 'legacy proxy fallback');
});

test('preview helper rejects offline instances', () => {
    const offline: DashboardInstance = { ...online, ok: false, status: 'offline' };
    const state = buildPreviewState(offline, data, 'proxy');

    assert.equal(state.canPreview, false);
    assert.match(state.reason || '', /online/);
    assert.equal(state.transport, 'none');
});

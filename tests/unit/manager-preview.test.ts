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
    });
});

test('preview helper builds direct iframe url', () => {
    assert.equal(buildPreviewState(online, data, 'direct').src, 'http://localhost:3457');
});

test('preview helper rejects offline instances', () => {
    const offline: DashboardInstance = { ...online, ok: false, status: 'offline' };
    const state = buildPreviewState(offline, data, 'proxy');

    assert.equal(state.canPreview, false);
    assert.match(state.reason || '', /online/);
});

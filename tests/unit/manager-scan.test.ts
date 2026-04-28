import test from 'node:test';
import assert from 'node:assert/strict';
import { scanDashboardInstances } from '../../src/manager/scan.js';
import type { FetchLike } from '../../src/manager/types.js';

function response(body: unknown, ok = true, status = 200): Response {
    return {
        ok,
        status,
        json: async () => body,
    } as Response;
}

test('manager scan defaults to 3457-3506 range', async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
        seen.push(url);
        throw new Error('offline');
    };

    const result = await scanDashboardInstances({ fetchImpl, managerPort: 24576 });

    assert.equal(result.manager.port, 24576);
    assert.equal(result.manager.rangeFrom, 3457);
    assert.equal(result.manager.rangeTo, 3506);
    assert.equal(result.instances.length, 50);
    assert.ok(seen[0]?.includes('127.0.0.1:3457/api/health'));
    assert.ok(seen[49]?.includes('127.0.0.1:3506/api/health'));
});

test('manager scan returns proxy metadata for the scanned range', async () => {
    const fetchImpl: FetchLike = async () => {
        throw new Error('offline');
    };

    const result = await scanDashboardInstances({
        from: 3457,
        count: 2,
        fetchImpl,
        managerPort: 24576,
    });

    assert.deepEqual(result.manager.proxy, {
        enabled: true,
        basePath: '/i',
        allowedFrom: 3457,
        allowedTo: 3458,
    });
});

test('manager scan keeps health row when metadata fetch fails', async () => {
    const fetchImpl: FetchLike = async (url) => {
        if (url.includes('/api/health')) return response({ ok: true, version: '1.7.34', uptime: 12 });
        if (url.includes('/api/settings')) throw new Error('settings failed');
        if (url.includes('/api/runtime')) return response({ ok: true, data: { cli: 'codex', model: 'gpt-test' } });
        throw new Error('unexpected url');
    };

    const result = await scanDashboardInstances({ from: 3457, count: 1, fetchImpl, managerPort: 24576 });
    const row = result.instances[0]!;

    assert.equal(row.status, 'online');
    assert.equal(row.version, '1.7.34');
    assert.equal(row.uptime, 12);
    assert.equal(row.currentCli, 'codex');
    assert.equal(row.currentModel, 'gpt-test');
    assert.match(row.healthReason || '', /metadata unavailable/);
});

test('manager scan derives instance metadata from settings response', async () => {
    const fetchImpl: FetchLike = async (url) => {
        if (url.includes('/api/health')) return response({ ok: true, version: '1.7.34', uptime: 99 });
        if (url.includes('/api/settings')) {
            return response({
                ok: true,
                data: {
                    home: '/Users/jun/.cli-jaw',
                    workingDir: '/Users/jun/Developer/new/700_projects/cli-jaw',
                    cli: 'codex',
                    model: 'gpt-5.5',
                },
            });
        }
        if (url.includes('/api/runtime')) return response({ ok: true, data: {} });
        throw new Error('unexpected url');
    };

    const result = await scanDashboardInstances({ from: 3457, count: 1, fetchImpl });
    const row = result.instances[0]!;

    assert.equal(row.instanceId, 'default');
    assert.equal(row.homeDisplay, '/Users/jun/.cli-jaw');
    assert.equal(row.workingDir, '/Users/jun/Developer/new/700_projects/cli-jaw');
    assert.equal(row.currentCli, 'codex');
    assert.equal(row.currentModel, 'gpt-5.5');
    assert.equal(row.profileId, 'default');
    assert.equal(result.manager.profiles?.[0]?.profileId, 'default');
});

test('manager scan falls back to workingDir for instance id when home is absent', async () => {
    const fetchImpl: FetchLike = async (url) => {
        if (url.includes('/api/health')) return response({ ok: true, version: '1.7.34', uptime: 99 });
        if (url.includes('/api/settings')) {
            return response({
                ok: true,
                data: {
                    workingDir: '/Users/jun/.cli-jaw',
                    cli: 'opencode',
                },
            });
        }
        if (url.includes('/api/runtime')) return response({ ok: true, data: {} });
        throw new Error('unexpected url');
    };

    const result = await scanDashboardInstances({ from: 3457, count: 1, fetchImpl });
    const row = result.instances[0]!;

    assert.equal(row.instanceId, 'default');
    assert.equal(row.homeDisplay, '/Users/jun/.cli-jaw');
});

test('manager scan maps failed ports without failing whole scan', async () => {
    const fetchImpl: FetchLike = async (url) => {
        if (url.includes(':3457/')) return response({ ok: true, version: 'ok', uptime: 1 });
        throw new Error('connect refused');
    };

    const result = await scanDashboardInstances({ from: 3457, count: 2, fetchImpl });

    assert.equal(result.instances[0]?.status, 'online');
    assert.equal(result.instances[1]?.status, 'offline');
    assert.equal(result.instances.length, 2);
});

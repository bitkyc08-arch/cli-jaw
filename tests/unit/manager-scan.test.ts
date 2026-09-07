import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanDashboardInstances, scanSinglePort, scanPort, scanPeerDashboards } from '../../src/manager/scan.js';
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
    assert.equal(row.multiSession, false, 'an instance without the flag reads as single-session');
    assert.equal(result.manager.profiles?.[0]?.profileId, 'default');
});

// 072 §1.4 — the session tree can only be offered for instances that report running
// several sessions, so the scan has to carry that flag through instead of dropping it.
test('manager scan reports whether an instance runs several sessions', async () => {
    const fetchImpl: FetchLike = async (url) => {
        if (url.includes('/api/health')) return response({ ok: true, version: '1.7.34', uptime: 99 });
        if (url.includes('/api/settings')) {
            return response({
                ok: true,
                data: {
                    home: '/Users/jun/.cli-jaw',
                    workingDir: '/tmp/work',
                    cli: 'codex',
                    model: 'gpt-5.5',
                    multiSession: { enabled: true },
                },
            });
        }
        if (url.includes('/api/runtime')) return response({ ok: true, data: {} });
        throw new Error('unexpected url');
    };

    const result = await scanDashboardInstances({ from: 3457, count: 1, fetchImpl });
    assert.equal(result.instances[0]!.multiSession, true);
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

test('isolated QA admits W only at every public scan boundary, before any fetch', async () => {
    const original = { ...process.env };
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'jaw-qa-scan-')));
    const roots = {
        HOME: 'home', TMPDIR: 'tmp', CLI_JAW_HOME: 'manager', CLI_JAW_DASHBOARD_HOME: 'dashboard',
        XDG_CONFIG_HOME: 'xdg/config', XDG_CACHE_HOME: 'xdg/cache', XDG_DATA_HOME: 'xdg/data', XDG_STATE_HOME: 'xdg/state',
        CODEX_HOME: 'providers/codex', CLAUDE_CONFIG_DIR: 'providers/claude', PI_CODING_AGENT_DIR: 'providers/pi',
        USERPROFILE: 'home', APPDATA: 'xdg/data', LOCALAPPDATA: 'xdg/cache',
    };
    try {
        for (const suffix of [...Object.values(roots), 'worker', 'electron/userData', 'electron/sessionData', 'electron/logs', 'electron/crashDumps']) {
            mkdirSync(join(root, suffix), { recursive: true });
        }
        for (const [key, suffix] of Object.entries(roots)) process.env[key] = join(root, suffix);
        Object.assign(process.env, { CLI_JAW_ISOLATED_QA_ROOT: root, DASHBOARD_PORT: '25481',
            DASHBOARD_SCAN_FROM: '35481', DASHBOARD_SCAN_COUNT: '1', DASHBOARD_PREVIEW_FROM: '45481' });
        const seen: string[] = [];
        const fetchImpl: FetchLike = async url => { seen.push(url); return response({ ok: true }); };
        const options = { fetchImpl, managerPort: 25481 };
        for (const forbidden of [35480, 35482, 25481, 45481, 0, NaN]) {
            await assert.rejects(scanPort(forbidden, fetchImpl, 100, 'now'), /isolated_qa_scan_forbidden/);
            await assert.rejects(scanSinglePort(forbidden, options), /isolated_qa_scan_forbidden/);
            await assert.rejects(scanDashboardInstances({ ...options, from: forbidden, count: 1 }), /isolated_qa_scan_forbidden/);
        }
        for (const count of [0, 2, 50, NaN]) {
            await assert.rejects(scanDashboardInstances({ ...options, from: 35481, count }), /isolated_qa_scan_forbidden/);
        }
        assert.deepEqual(await scanPeerDashboards(25481, { fetchImpl }), []);
        assert.equal(seen.length, 0, 'forbidden scans must not be caught as offline or filtered after fetching');

        const result = await scanDashboardInstances(options);
        assert.equal(result.instances.length, 1);
        assert.equal(result.instances[0]?.port, 35481);
        await scanSinglePort(35481, options);
        await scanPort(35481, fetchImpl, 100, 'now');
        assert.equal(seen.length, 9);
        assert.ok(seen.every(url => new URL(url).port === '35481'));

        for (const malformed of ['', '0', 'not-a-port']) {
            process.env.DASHBOARD_SCAN_FROM = malformed;
            const before = seen.length;
            await assert.rejects(scanDashboardInstances(options), /isolated_qa_invalid/);
            await assert.rejects(scanSinglePort(35481, options), /isolated_qa_invalid/);
            await assert.rejects(scanPort(35481, fetchImpl, 100, 'now'), /isolated_qa_invalid/);
            await assert.rejects(scanPeerDashboards(25481, { fetchImpl }), /isolated_qa_invalid/);
            assert.equal(seen.length, before);
        }
    } finally {
        for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
        Object.assign(process.env, original);
        rmSync(root, { recursive: true, force: true });
    }
});

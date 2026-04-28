import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    applyDashboardRegistry,
    defaultDashboardRegistry,
    loadDashboardRegistry,
    patchDashboardRegistry,
} from '../../src/manager/registry.js';
import type { DashboardInstance, DashboardScanResult } from '../../src/manager/types.js';

function registryPath(name = 'manager-instances.json'): string {
    return join(mkdtempSync(join(tmpdir(), 'jaw-manager-registry-')), name);
}

function makeInstance(port: number): DashboardInstance {
    return {
        port,
        url: `http://localhost:${port}`,
        status: 'online',
        ok: true,
        version: '1.0.0',
        uptime: 1,
        instanceId: `instance-${port}`,
        homeDisplay: null,
        workingDir: null,
        currentCli: null,
        currentModel: null,
        serviceMode: 'unknown',
        profileId: `profile-${port}`,
        lastCheckedAt: '2026-04-27T00:00:00.000Z',
        healthReason: null,
    };
}

function makeScan(): DashboardScanResult {
    return {
        manager: {
            port: 24576,
            rangeFrom: 3457,
            rangeTo: 3458,
            checkedAt: '2026-04-27T00:00:00.000Z',
            proxy: { enabled: true, basePath: '/i', allowedFrom: 3457, allowedTo: 3458 },
        },
        instances: [makeInstance(3457), makeInstance(3458)],
    };
}

test('manager registry defaults when file is missing', () => {
    const path = registryPath();
    const loaded = loadDashboardRegistry({ path });

    assert.equal(loaded.registry.scan.from, 3457);
    assert.equal(loaded.registry.scan.count, 50);
    assert.equal(loaded.registry.ui.selectedTab, 'overview');
    assert.deepEqual(loaded.registry.profiles, {});
    assert.deepEqual(loaded.registry.activeProfileFilter, []);
    assert.equal(loaded.status.loaded, true);
    assert.equal(loaded.status.error, null);
});

test('manager registry falls back safely on invalid JSON', () => {
    const path = registryPath();
    writeFileSync(path, '{not-json');

    const loaded = loadDashboardRegistry({ path });

    assert.equal(loaded.status.loaded, false);
    assert.match(String(loaded.status.error), /JSON/);
    assert.deepEqual(loaded.registry, defaultDashboardRegistry());
});

test('manager registry clamps scan and UI values', () => {
    const path = registryPath();
    writeFileSync(path, JSON.stringify({
        scan: { from: -1, count: 5000 },
        ui: {
            selectedPort: 999999,
            selectedTab: 'bad',
            sidebarCollapsed: true,
            activityDockCollapsed: true,
            activityDockHeight: 9999,
        },
        instances: {
            3457: { label: ' main ', favorite: true, group: 'daily', hidden: false },
            bad: { label: 'ignored' },
        },
        profiles: {
            default: { label: ' Default ', homePath: '/Users/jun/.cli-jaw', pinned: true },
            bad_profile: { label: 'ignored' },
        },
        activeProfileFilter: ['default', 'BAD'],
    }));

    const loaded = loadDashboardRegistry({ path });

    assert.equal(loaded.registry.scan.from, 3457);
    assert.equal(loaded.registry.scan.count, 50);
    assert.equal(loaded.registry.ui.selectedPort, 65535);
    assert.equal(loaded.registry.ui.selectedTab, 'overview');
    assert.equal(loaded.registry.ui.sidebarCollapsed, true);
    assert.equal(loaded.registry.ui.activityDockHeight, 320);
    assert.equal(loaded.registry.instances['3457']?.label, 'main');
    assert.equal(loaded.registry.instances.bad, undefined);
    assert.equal(loaded.registry.profiles.default?.label, 'Default');
    assert.deepEqual(loaded.registry.activeProfileFilter, ['default']);
});

test('manager registry patch persists instance preferences', () => {
    const path = registryPath();
    const saved = patchDashboardRegistry({
        scan: { from: 3460, count: 8 },
        ui: { selectedPort: 3461, selectedTab: 'settings' },
        instances: { 3461: { label: 'worker', favorite: true, hidden: true } },
        profiles: { default: { label: 'Default', homePath: '/Users/jun/.cli-jaw', pinned: true } },
        activeProfileFilter: ['default'],
    }, { path });

    assert.equal(saved.registry.scan.from, 3460);
    assert.equal(saved.registry.scan.count, 8);
    assert.equal(saved.registry.ui.selectedTab, 'settings');
    assert.equal(saved.registry.instances['3461']?.label, 'worker');
    assert.equal(saved.registry.instances['3461']?.favorite, true);
    assert.equal(saved.registry.instances['3461']?.hidden, true);
    assert.equal(saved.registry.profiles.default?.pinned, true);
    assert.deepEqual(saved.registry.activeProfileFilter, ['default']);
});

test('manager registry overlays scan results and hides hidden rows by default', () => {
    const registry = defaultDashboardRegistry();
    registry.instances['3457'] = { label: 'main', favorite: true, group: 'daily', hidden: false };
    registry.instances['3458'] = { label: 'hidden', favorite: false, group: null, hidden: true };
    const status = { path: '/tmp/registry.json', loaded: true, error: null, ui: registry.ui };

    const visible = applyDashboardRegistry(makeScan(), registry, status);
    const withHidden = applyDashboardRegistry(makeScan(), registry, status, { showHidden: true });

    assert.deepEqual(visible.instances.map(instance => instance.port), [3457]);
    assert.equal(visible.instances[0]?.label, 'main');
    assert.equal(visible.instances[0]?.favorite, true);
    assert.ok(Array.isArray(visible.manager.profiles));
    assert.deepEqual(withHidden.instances.map(instance => instance.port), [3457, 3458]);
    assert.equal(withHidden.instances[1]?.hidden, true);
});

import '../setup/isolated-home.ts';
// #436: the federation list used to come only from the dashboard registry, so a
// home whose registry.json was absent produced instances: {} even while ports
// answered — the scan was consulted for home overrides and never as a source of
// rows. These pin both halves of the fix: live scan rows become entries, dead
// ones do not. The registry is injected so the test never reads the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSearchableInstancesFromScan } from '../../src/manager/memory/instance-discovery.ts';
import type { DashboardRegistry } from '../../src/manager/types.ts';

const home = mkdtempSync(join(tmpdir(), 'jaw-disc-'));
const emptyRegistry = { instances: {}, profiles: {} } as unknown as DashboardRegistry;

test('IDS-001: an online scanned port is searchable with no registry entry', () => {
    const refs = listSearchableInstancesFromScan(
        [{ port: 3457, ok: true, homeDisplay: join(home, 'a') }],
        { baseHome: home, registry: emptyRegistry },
    );
    assert.equal(refs.length, 1, 'a live instance must be searchable even when the registry is empty');
    assert.equal(refs[0]!.port, 3457);
    assert.equal(refs[0]!.origin, 'scan');
});

test('IDS-002: offline scan rows are dropped, so a 50-port sweep cannot flood the list', () => {
    const items = [{ port: 3457, ok: true, homeDisplay: join(home, 'a') }];
    for (let p = 3458; p < 3507; p++) items.push({ port: p, ok: false, homeDisplay: join(home, 'x' + p) });
    const refs = listSearchableInstancesFromScan(items, { baseHome: home, registry: emptyRegistry });
    assert.deepEqual(refs.map(r => r.port), [3457], 'only the port that answered belongs in the list');
});

test('IDS-003: a declared registry port survives being absent from the scan', () => {
    const registry = {
        instances: { '3459': { label: 'declared' } },
        profiles: {},
    } as unknown as DashboardRegistry;
    const refs = listSearchableInstancesFromScan(
        [{ port: 3457, ok: true, homeDisplay: join(home, 'a') }],
        { baseHome: home, registry },
    );
    const byPort = new Map(refs.map(r => [r.port, r.origin]));
    assert.equal(byPort.get(3459), 'registry', 'an operator-declared instance is not erased by being offline');
    assert.equal(byPort.get(3457), 'scan');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createRefRegistry,
    resolveRef,
    invalidateRefsOnDomChange,
    isRegistryStale,
} from '../../src/browser/web-ai/ref-registry.ts';
import { WebAiError } from '../../src/browser/web-ai/errors.ts';

test('REF-REG-001: createRefRegistry copies snapshot data', () => {
    const registry = createRefRegistry({
        snapshotId: 's1',
        axHash: 'ax1',
        domHash: 'dom1',
        refs: {
            '@e1': { ref: '@e1', role: 'button', name: 'OK', selector: null, framePath: [], shadowPath: [], signatureHash: 'x' },
        },
    });
    assert.equal(registry.snapshotId, 's1');
    assert.equal(registry.axHash, 'ax1');
    assert.equal(registry.domHash, 'dom1');
    assert.equal(registry.refs['@e1'].role, 'button');
    assert.equal(registry.stale, false);
    assert.equal(registry.invalidatedAt, null);
    assert.ok(registry.createdAt > 0);
});

test('REF-REG-002: createRefRegistry handles null/undefined', () => {
    const r1 = createRefRegistry(null);
    assert.equal(r1.snapshotId, null);
    assert.deepEqual(r1.refs, {});
    const r2 = createRefRegistry(undefined);
    assert.deepEqual(r2.refs, {});
});

test('REF-REG-003: resolveRef returns entry when fresh', async () => {
    const registry = createRefRegistry({
        snapshotId: 's1',
        refs: { '@e1': { ref: '@e1', role: 'button', name: 'OK', selector: null, framePath: [], shadowPath: [], signatureHash: 'x' } },
    });
    const entry = await resolveRef({}, registry, '@e1');
    assert.equal(entry.ref, '@e1');
    assert.equal(entry.role, 'button');
});

test('REF-REG-004: resolveRef throws for missing ref', async () => {
    const registry = createRefRegistry({ snapshotId: 's1', refs: {} });
    await assert.rejects(
        async () => resolveRef({}, registry, '@e99'),
        (err: unknown) => err instanceof WebAiError && (err as WebAiError).errorCode === 'snapshot.ref-not-found',
    );
});

test('REF-REG-005: resolveRef throws when stale', async () => {
    const registry = createRefRegistry({ snapshotId: 's1', refs: { '@e1': { ref: '@e1', role: 'button', name: 'OK', selector: null, framePath: [], shadowPath: [], signatureHash: 'x' } } });
    await assert.rejects(
        async () => resolveRef({}, registry, '@e1', { expectedSnapshotId: 's2' }),
        (err: unknown) => err instanceof WebAiError && (err as WebAiError).errorCode === 'snapshot.ref-stale',
    );
});

test('REF-REG-006: resolveRef allows stale when allowStale=true', async () => {
    const registry = createRefRegistry({ snapshotId: 's1', refs: { '@e1': { ref: '@e1', role: 'button', name: 'OK', selector: null, framePath: [], shadowPath: [], signatureHash: 'x' } } });
    const entry = await resolveRef({}, registry, '@e1', { expectedSnapshotId: 's2', allowStale: true });
    assert.equal(entry.ref, '@e1');
});

test('REF-REG-007: resolveRef normalizes ref without @ prefix', async () => {
    const registry = createRefRegistry({
        refs: { '@e1': { ref: '@e1', role: 'button', name: 'OK', selector: null, framePath: [], shadowPath: [], signatureHash: 'x' } },
    });
    const entry = await resolveRef({}, registry, 'e1');
    assert.equal(entry.ref, '@e1');
});

test('REF-REG-008: invalidateRefsOnDomChange marks stale and clears refs', () => {
    const registry = createRefRegistry({ snapshotId: 's1', domHash: 'd1', axHash: 'a1', refs: { '@e1': { ref: '@e1', role: 'button', name: 'OK', selector: null, framePath: [], shadowPath: [], signatureHash: 'x' } } });
    const changed = invalidateRefsOnDomChange(registry, { domHash: 'd2' });
    assert.equal(changed, true);
    assert.equal(registry.stale, true);
    assert.deepEqual(registry.refs, {});
    assert.ok(registry.invalidatedAt && registry.invalidatedAt > 0);
    assert.equal(registry.domHash, 'd2');
});

test('REF-REG-009: invalidateRefsOnDomChange returns false when unchanged', () => {
    const registry = createRefRegistry({ snapshotId: 's1', domHash: 'd1', axHash: 'a1', refs: {} });
    const changed = invalidateRefsOnDomChange(registry, { domHash: 'd1' });
    assert.equal(changed, false);
    assert.equal(registry.stale, false);
});

test('REF-REG-010: invalidateRefsOnDomChange handles null registry', () => {
    assert.equal(invalidateRefsOnDomChange(null, { domHash: 'd2' }), false);
    assert.equal(invalidateRefsOnDomChange(undefined, { domHash: 'd2' }), false);
});

test('REF-REG-011: isRegistryStale detects stale flag', () => {
    const registry = createRefRegistry({ snapshotId: 's1' });
    assert.equal(isRegistryStale(registry), false);
    registry.stale = true;
    assert.equal(isRegistryStale(registry), true);
});

test('REF-REG-012: isRegistryStale detects snapshotId mismatch', () => {
    const registry = createRefRegistry({ snapshotId: 's1' });
    assert.equal(isRegistryStale(registry, { expectedSnapshotId: 's1' }), false);
    assert.equal(isRegistryStale(registry, { expectedSnapshotId: 's2' }), true);
});

test('REF-REG-013: isRegistryStale detects domHash mismatch', () => {
    const registry = createRefRegistry({ snapshotId: 's1', domHash: 'd1' });
    assert.equal(isRegistryStale(registry, { currentDomHash: 'd1' }), false);
    assert.equal(isRegistryStale(registry, { currentDomHash: 'd2' }), true);
});

test('REF-REG-014: isRegistryStale detects axHash mismatch', () => {
    const registry = createRefRegistry({ snapshotId: 's1', axHash: 'a1' });
    assert.equal(isRegistryStale(registry, { currentAxHash: 'a1' }), false);
    assert.equal(isRegistryStale(registry, { currentAxHash: 'a2' }), true);
});

test('REF-REG-015: isRegistryStale handles null registry', () => {
    assert.equal(isRegistryStale(null), true);
    assert.equal(isRegistryStale(undefined), true);
});

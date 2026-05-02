import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildWebAiSnapshot,
    estimateSnapshotTokens,
    hashAccessibilitySnapshot,
    extractInteractiveRefs,
    summarizeSnapshotForDoctor,
    hashDoctorField,
    DEFAULT_SNAPSHOT_MAX_DEPTH,
    DEFAULT_INTERACTIVE_ROLES,
} from '../../src/browser/web-ai/ax-snapshot.ts';
import { WebAiError } from '../../src/browser/web-ai/errors.ts';

function makeMockPage(snapshotResult: unknown) {
    return {
        url: () => 'https://example.com/',
        accessibility: {
            snapshot: async () => snapshotResult,
        },
        locator: () => ({
            elementHandle: async () => null,
        }),
        evaluate: async () => null,
    };
}

const sampleAxTree = {
    role: 'document',
    name: '',
    children: [
        { role: 'button', name: 'Submit', focused: false },
        { role: 'link', name: 'About', children: [{ role: 'text', name: 'About' }] },
        { role: 'textbox', name: 'Search', value: 'hello' },
        { role: 'generic', name: 'Static text', children: [{ role: 'text', name: 'Static text' }] },
    ],
};

test('AX-SNAP-001: estimateSnapshotTokens divides length by 4', () => {
    assert.equal(estimateSnapshotTokens(''), 0);
    assert.equal(estimateSnapshotTokens('abcd'), 1);
    assert.equal(estimateSnapshotTokens('abcdefghij'), 3);
    assert.equal(estimateSnapshotTokens(null), 0);
});

test('AX-SNAP-002: hashAccessibilitySnapshot normalizes and hashes', () => {
    const h1 = hashAccessibilitySnapshot('hello world');
    const h2 = hashAccessibilitySnapshot('hello   world');
    assert.ok(h1.startsWith('sha256:'));
    assert.equal(h1, h2);
    assert.equal(h1.length, 'sha256:'.length + 16);
});

test('AX-SNAP-003: extractInteractiveRefs from snapshot object returns refs copy', () => {
    const refs = { '@e1': { ref: '@e1', role: 'button', name: 'OK', selector: null, framePath: [], shadowPath: [], signatureHash: 'sha256:abc' } };
    const extracted = extractInteractiveRefs({ refs } as any, '@e');
    assert.deepEqual(extracted, refs);
});

test('AX-SNAP-004: extractInteractiveRefs from tree walks and assigns refs', () => {
    const extracted = extractInteractiveRefs(sampleAxTree as any, '@e');
    const keys = Object.keys(extracted);
    assert.equal(keys.length, 3);
    assert.equal(extracted['@e1'].role, 'button');
    assert.equal(extracted['@e1'].name, 'Submit');
    assert.equal(extracted['@e2'].role, 'link');
    assert.equal(extracted['@e3'].role, 'textbox');
});

test('AX-SNAP-005: summarizeSnapshotForDoctor returns safe summary', () => {
    const snapshot = {
        snapshotId: 'snap-1',
        axHash: 'sha256:deadbeef',
        domHash: 'sha256:cafebabe',
        stats: { interactiveCount: 5, tokenEstimate: 42 },
        refs: {
            '@e1': { ref: '@e1', role: 'button', name: 'Click me', selector: null, framePath: [], shadowPath: [], signatureHash: 'x' },
            '@e2': { ref: '@e2', role: 'link', name: 'Home', selector: null, framePath: [], shadowPath: [], signatureHash: 'y' },
        },
    } as any;
    const summary = summarizeSnapshotForDoctor(snapshot, { maxRefs: 1 });
    assert.equal(summary.enabled, true);
    assert.equal(summary.contentSafe, true);
    assert.equal(summary.snapshotId, 'snap-1');
    assert.equal(summary.interactiveCount, 5);
    assert.equal(summary.topRefs.length, 1);
    assert.equal(summary.topRefs[0].role, 'button');
    assert.equal(summary.topRefs[0].nameChars, 8);
    assert.ok(summary.topRefs[0].nameHash?.startsWith('sha256:'));
});

test('AX-SNAP-006: hashDoctorField produces 12-char hex digest', () => {
    const h = hashDoctorField('secret');
    assert.ok(h.startsWith('sha256:'));
    assert.equal(h.length, 'sha256:'.length + 12);
});

test('AX-SNAP-007: buildWebAiSnapshot throws when accessibility unavailable', async () => {
    const page = makeMockPage(null);
    delete (page as any).accessibility;
    await assert.rejects(
        async () => buildWebAiSnapshot(page as any),
        (err: unknown) => err instanceof WebAiError && (err as WebAiError).errorCode === 'snapshot.unavailable',
    );
});

test('AX-SNAP-008: buildWebAiSnapshot returns snapshot with refs and stats', async () => {
    const page = makeMockPage(sampleAxTree);
    const snapshot = await buildWebAiSnapshot(page as any, { includeDomHash: false });
    assert.ok(snapshot.snapshotId);
    assert.equal(snapshot.url, 'https://example.com/');
    assert.ok(snapshot.axHash.startsWith('sha256:'));
    assert.ok(Object.keys(snapshot.refs).length >= 3);
    assert.ok(snapshot.stats.nodeCount >= 4);
    assert.ok(snapshot.stats.interactiveCount >= 3);
    assert.ok(snapshot.stats.tokenEstimate > 0);
});

test('AX-SNAP-009: DEFAULT_INTERACTIVE_ROLES contains expected roles', () => {
    assert.ok(DEFAULT_INTERACTIVE_ROLES.has('button'));
    assert.ok(DEFAULT_INTERACTIVE_ROLES.has('link'));
    assert.ok(DEFAULT_INTERACTIVE_ROLES.has('textbox'));
    assert.ok(!DEFAULT_INTERACTIVE_ROLES.has('generic'));
    assert.ok(!DEFAULT_INTERACTIVE_ROLES.has('document'));
});

test('AX-SNAP-010: DEFAULT_SNAPSHOT_MAX_DEPTH is 6', () => {
    assert.equal(DEFAULT_SNAPSHOT_MAX_DEPTH, 6);
});

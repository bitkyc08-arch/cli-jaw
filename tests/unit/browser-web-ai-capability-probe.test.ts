import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import {
    defineCapability,
    runCapabilities,
    worstCapabilityState,
    probeHostMatches,
    probeFirstVisibleSelector,
    type CapabilityDeps,
    type CapabilityRow,
} from '../../src/browser/web-ai/capability-probe.js';

const deps: CapabilityDeps = { getPage: async () => ({} as Page) };

// 104.8: the engine normalizes each probe into a {capabilityId,state,evidence,next} row.
test('BWAI-CAP-ENGINE-001: runCapabilities normalizes rows and defaults next=send', async () => {
    const caps = [
        defineCapability('a-ok', async () => ({ state: 'ok', evidence: { x: 1 }, next: 'send' })),
        defineCapability('b-bare', async () => ({ state: 'warn' } as never)),
    ];
    const rows = await runCapabilities(deps, caps);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { capabilityId: 'a-ok', state: 'ok', evidence: { x: 1 }, next: 'send' });
    assert.equal(rows[1]?.next, 'send');
    assert.equal(rows[1]?.evidence, null);
});

// 104.8: a throwing probe becomes an 'unknown' row with a re-snapshot hint — never crashes the run.
test('BWAI-CAP-ENGINE-002: a throwing probe degrades to unknown/re-snapshot', async () => {
    const caps = [defineCapability('boom', async () => { throw new Error('probe exploded'); })];
    const rows = await runCapabilities(deps, caps);
    assert.equal(rows[0]?.state, 'unknown');
    assert.equal(rows[0]?.next, 're-snapshot');
    assert.deepEqual(rows[0]?.evidence, { error: 'probe exploded' });
});

// 104.8: input.probe runs exactly one capability row.
test('BWAI-CAP-ENGINE-003: input.probe filters to a single capability', async () => {
    const caps = [
        defineCapability('one', async () => ({ state: 'ok', evidence: null, next: 'send' })),
        defineCapability('two', async () => ({ state: 'ok', evidence: null, next: 'send' })),
    ];
    const rows = await runCapabilities(deps, caps, { probe: 'two' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.capabilityId, 'two');
});

test('BWAI-CAP-ENGINE-004: defineCapability rejects a non-function probe', () => {
    assert.throws(() => defineCapability('bad', undefined as never), /requires a probe function/);
});

// 104.8: worst-state aggregation is fail > warn > ok > unknown.
test('BWAI-CAP-ENGINE-005: worstCapabilityState aggregates fail>warn>ok>unknown', () => {
    const row = (state: CapabilityRow['state']): CapabilityRow => ({ capabilityId: 'x', state, evidence: null, next: 'send' });
    assert.equal(worstCapabilityState([]), 'unknown');
    assert.equal(worstCapabilityState([row('ok'), row('ok')]), 'ok');
    assert.equal(worstCapabilityState([row('ok'), row('warn')]), 'warn');
    assert.equal(worstCapabilityState([row('warn'), row('fail')]), 'fail');
    assert.equal(worstCapabilityState([row('ok'), row('unknown')]), 'unknown');
});

// 104.8: host probe verifies the active tab's origin.
test('BWAI-CAP-ENGINE-006: probeHostMatches ok on match, fail (tab-switch) otherwise', async () => {
    const hosts = new Set(['gemini.google.com']);
    const ok = await probeHostMatches({ url: () => 'https://gemini.google.com/app' } as Page, hosts);
    assert.equal(ok.state, 'ok');
    const bad = await probeHostMatches({ url: () => 'https://example.com/' } as Page, hosts);
    assert.equal(bad.state, 'fail');
    assert.equal(bad.next, 'tab-switch');
    const broken = await probeHostMatches({ url: () => 'not a url' } as Page, hosts);
    assert.equal(broken.state, 'fail');
});

// 104.8: first-visible-selector probe returns the matched selector or a fail row.
test('BWAI-CAP-ENGINE-007: probeFirstVisibleSelector reports first visible / fail', async () => {
    const visiblePage = { locator: () => ({ first: () => ({ isVisible: async () => true }) }), waitForTimeout: async () => undefined } as unknown as Page;
    const okRes = await probeFirstVisibleSelector(visiblePage, ['#a', '#b']);
    assert.equal(okRes.state, 'ok');
    assert.deepEqual(okRes.evidence, { matched: '#a', visible: true });

    const hiddenPage = { locator: () => ({ first: () => ({ isVisible: async () => false }) }), waitForTimeout: async () => undefined } as unknown as Page;
    const failRes = await probeFirstVisibleSelector(hiddenPage, ['#a'], { timeoutMs: 50, failNext: 'inline-only', failState: 'warn' });
    assert.equal(failRes.state, 'warn');
    assert.equal(failRes.next, 'inline-only');
});

// Phase 8 — Browser/CDP page pure helpers.
//
// The page is mostly an interaction layer over `/api/browser/status` +
// start/stop/active-tab. The tests focus on the input-normalization helpers
// because the polling state machine can only be exercised via a DOM mount
// (not in scope here — Phase 1 deferred RTL setup).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    describeStatus,
    normalizeActiveTab,
    normalizeBrowserStatus,
} from '../../public/manager/src/settings/pages/Browser';

// ─── normalizeBrowserStatus ─────────────────────────────────────────

test('normalizeBrowserStatus: running:true with cdpUrl + tabs', () => {
    assert.deepEqual(
        normalizeBrowserStatus({
            running: true,
            tabs: 3,
            cdpUrl: 'http://127.0.0.1:9222',
        }),
        { running: true, tabs: 3, cdpUrl: 'http://127.0.0.1:9222' },
    );
});

test('normalizeBrowserStatus: stopped shape (running:false, no cdpUrl)', () => {
    assert.deepEqual(
        normalizeBrowserStatus({ running: false, tabs: 0 }),
        { running: false, tabs: 0 },
    );
});

test('normalizeBrowserStatus: garbage payload → defaults', () => {
    assert.deepEqual(normalizeBrowserStatus(null), {
        running: false,
        tabs: 0,
    });
    assert.deepEqual(normalizeBrowserStatus('nope'), {
        running: false,
        tabs: 0,
    });
    assert.deepEqual(normalizeBrowserStatus({ running: 'yes', tabs: '3' }), {
        running: false,
        tabs: 0,
    });
});

test('normalizeBrowserStatus: NaN tabs → 0', () => {
    assert.equal(
        normalizeBrowserStatus({ running: true, tabs: Number.NaN }).tabs,
        0,
    );
});

// ─── normalizeActiveTab ─────────────────────────────────────────────

test('normalizeActiveTab: ok payload with tab', () => {
    assert.deepEqual(
        normalizeActiveTab({
            ok: true,
            tab: { url: 'https://x.com/', title: 'X', targetId: 'abc' },
        }),
        {
            ok: true,
            tab: { url: 'https://x.com/', title: 'X', targetId: 'abc' },
        },
    );
});

test('normalizeActiveTab: failure payload', () => {
    assert.deepEqual(
        normalizeActiveTab({ ok: false, reason: 'unverified' }),
        { ok: false, reason: 'unverified', tab: null },
    );
});

test('normalizeActiveTab: garbage → null', () => {
    assert.equal(normalizeActiveTab(null), null);
    assert.equal(normalizeActiveTab(undefined), null);
    assert.equal(normalizeActiveTab('text'), null);
});

test('normalizeActiveTab: filters non-string fields on tab', () => {
    const r = normalizeActiveTab({
        ok: true,
        tab: { url: 42, title: null, targetId: 'ok' },
    });
    assert.deepEqual(r?.tab, { targetId: 'ok' });
});

// ─── describeStatus ─────────────────────────────────────────────────

test('describeStatus: running/stopped/unknown', () => {
    assert.equal(describeStatus({ running: true, tabs: 1 }), 'running');
    assert.equal(describeStatus({ running: false, tabs: 0 }), 'stopped');
    assert.equal(describeStatus(null), 'unknown');
});

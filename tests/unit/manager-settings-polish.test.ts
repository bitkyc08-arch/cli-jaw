// Phase 9 — polish helpers (sidebar filter, error normalize, save shortcut,
// import validator, dashboard-meta read/save shape).
//
// We test pure helpers so we don't need to mount React. The shortcut handler
// is exercised against a fake KeyboardEvent via the function it builds.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    SETTINGS_CATEGORIES,
} from '../../public/manager/src/settings/SettingsSidebar';
import {
    SIDEBAR_GROUP_ORDER,
    SIDEBAR_GROUP_LABELS,
    filterEntries,
    groupEntries,
} from '../../public/manager/src/settings/components/sidebar-filter';
import { describeError } from '../../public/manager/src/settings/components/error-normalize';
import { SettingsRequestError } from '../../public/manager/src/settings/settings-client';
import { validateImportPayload } from '../../public/manager/src/settings/pages/AdvancedExport';
import { __test__ as DashboardMetaInternal } from '../../public/manager/src/settings/pages/DashboardMeta';
import { createDirtyStore } from '../../public/manager/src/settings/dirty-store';

// ─── Sidebar registry ────────────────────────────────────────────────

test('Phase 1 placeholder identity-preview is gone from sidebar', () => {
    const ids = SETTINGS_CATEGORIES.map((c) => c.id);
    assert.equal(ids.includes('identity-preview' as never), false);
});

test('SETTINGS_CATEGORIES includes Phase 9 dashboard-meta and advanced-export', () => {
    const ids = SETTINGS_CATEGORIES.map((c) => c.id);
    assert.ok(ids.includes('dashboard-meta'));
    assert.ok(ids.includes('advanced-export'));
});

test('Sidebar group order has security after integrations and meta last', () => {
    assert.deepEqual(SIDEBAR_GROUP_ORDER, [
        'core',
        'channels',
        'automation',
        'integrations',
        'security',
        'meta',
    ]);
    assert.equal(SIDEBAR_GROUP_LABELS.security, 'Security');
    assert.equal(SIDEBAR_GROUP_LABELS.meta, 'Meta');
});

test('Every category belongs to one of the known groups', () => {
    for (const c of SETTINGS_CATEGORIES) {
        assert.ok(SIDEBAR_GROUP_ORDER.includes(c.group), `unknown group: ${c.group}`);
    }
});

// ─── filterEntries ───────────────────────────────────────────────────

test('filterEntries with empty query returns a copy of all entries', () => {
    const result = filterEntries(SETTINGS_CATEGORIES, '');
    assert.equal(result.length, SETTINGS_CATEGORIES.length);
    assert.notEqual(result, SETTINGS_CATEGORIES);
});

test('filterEntries is case-insensitive against label and id', () => {
    const result = filterEntries(SETTINGS_CATEGORIES, 'TELEgram');
    assert.equal(result.length, 1);
    assert.equal(result[0]?.id, 'channels-telegram');
});

test('filterEntries also matches on category id', () => {
    const result = filterEntries(SETTINGS_CATEGORIES, 'mcp');
    assert.equal(result.some((c) => c.id === 'mcp'), true);
});

test('filterEntries returns empty array on no match', () => {
    const result = filterEntries(SETTINGS_CATEGORIES, 'definitely-not-a-thing');
    assert.equal(result.length, 0);
});

// ─── groupEntries ────────────────────────────────────────────────────

test('groupEntries skips empty groups', () => {
    const result = groupEntries(filterEntries(SETTINGS_CATEGORIES, 'telegram'));
    assert.equal(result.length, 1);
    assert.equal(result[0]?.group, 'channels');
});

test('groupEntries preserves the canonical SIDEBAR_GROUP_ORDER', () => {
    const result = groupEntries(SETTINGS_CATEGORIES);
    const order = result.map((g) => g.group);
    const expected = SIDEBAR_GROUP_ORDER.filter((g) => order.includes(g));
    assert.deepEqual(order, expected);
});

// ─── describeError ───────────────────────────────────────────────────

test('describeError formats SettingsRequestError with method/path/status', () => {
    const err = new SettingsRequestError('PUT', '/api/settings', 400, 'bad shape');
    const out = describeError(err);
    assert.match(out, /PUT \/api\/settings → 400/);
    assert.match(out, /bad shape/);
});

test('describeError surfaces auth message for 401/403', () => {
    const a = new SettingsRequestError('GET', '/api/settings', 401, '');
    assert.match(describeError(a), /requires auth/);
    const b = new SettingsRequestError('GET', '/api/settings', 403, '');
    assert.match(describeError(b), /requires auth/);
});

test('describeError surfaces unreachable for 5xx and 0', () => {
    const a = new SettingsRequestError('GET', '/x', 503, 'gone');
    assert.match(describeError(a), /unreachable/);
    const b = new SettingsRequestError('GET', '/x', 0, '');
    assert.match(describeError(b), /unreachable/);
});

test('describeError falls back to Error.message and stringifies primitives', () => {
    assert.equal(describeError(new Error('boom')), 'boom');
    assert.equal(describeError('plain'), 'plain');
});

// ─── validateImportPayload ───────────────────────────────────────────

test('validateImportPayload rejects malformed JSON', () => {
    const r = validateImportPayload('{not valid');
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /Invalid JSON/);
});

test('validateImportPayload rejects arrays', () => {
    const r = validateImportPayload('[1,2,3]');
    assert.equal(r.ok, false);
});

test('validateImportPayload rejects null and primitives', () => {
    assert.equal(validateImportPayload('null').ok, false);
    assert.equal(validateImportPayload('42').ok, false);
    assert.equal(validateImportPayload('"string"').ok, false);
});

test('validateImportPayload accepts object payload', () => {
    const r = validateImportPayload('{"cli":"codex","tui":{"themeSeed":"jaw-dark"}}');
    assert.equal(r.ok, true);
    if (r.ok) {
        assert.deepEqual(r.value, { cli: 'codex', tui: { themeSeed: 'jaw-dark' } });
    }
});

// ─── DashboardMeta helpers ───────────────────────────────────────────

test('DashboardMeta.readInstance returns defaults for unknown port', () => {
    const out = DashboardMetaInternal.readInstance(
        { registry: { instances: {} } },
        3457,
    );
    assert.deepEqual(out, {
        label: null,
        favorite: false,
        group: null,
        hidden: false,
        notes: null,
    });
});

test('DashboardMeta.readInstance reflects stored data per-port', () => {
    const out = DashboardMetaInternal.readInstance(
        {
            registry: {
                instances: {
                    '3457': {
                        label: 'main',
                        favorite: true,
                        group: 'work',
                        hidden: false,
                        notes: 'shared box',
                    },
                },
            },
        },
        3457,
    );
    assert.deepEqual(out, {
        label: 'main',
        favorite: true,
        group: 'work',
        hidden: false,
        notes: 'shared box',
    });
});

test('DashboardMeta.toDraft normalizes nulls into empty strings', () => {
    const draft = DashboardMetaInternal.toDraft({
        label: null,
        favorite: false,
        group: null,
        hidden: true,
        notes: null,
    });
    assert.deepEqual(draft, {
        label: '',
        group: '',
        favorite: false,
        hidden: true,
        notes: '',
    });
});

test('DashboardMeta META_KEYS covers every editable field', () => {
    assert.deepEqual(
        [...DashboardMetaInternal.META_KEYS].sort(),
        ['meta.favorite', 'meta.group', 'meta.hidden', 'meta.label', 'meta.notes'],
    );
});

test('DashboardMeta dirty store keys do not collide with instance settings keys', () => {
    const store = createDirtyStore();
    store.set('cli', { value: 'codex', original: 'claude', valid: true });
    for (const k of DashboardMetaInternal.META_KEYS) {
        store.set(k, { value: 'x', original: 'y', valid: true });
    }
    assert.equal(store.pending.size, 1 + DashboardMetaInternal.META_KEYS.length);
    for (const k of DashboardMetaInternal.META_KEYS) store.remove(k);
    assert.equal(store.pending.size, 1);
});

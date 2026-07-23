import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    validateSettingsField,
    type SettingsFieldDefinition,
} from '../../public/dashboard2/src/features/settings/settings-types.ts';

const read = (path: string): string => readFileSync(path, 'utf8');

test('074 settings field validation blocks required and out-of-range values', () => {
    const required: SettingsFieldDefinition = {
        key: 'bindHost', label: 'Bind host', kind: 'text', required: true,
    };
    const bounded: SettingsFieldDefinition = {
        key: 'flushEvery', label: 'Flush every', kind: 'number', min: 1, max: 100, step: 1,
    };

    assert.equal(validateSettingsField(required, '   ', {}), 'Bind host is required.');
    assert.equal(validateSettingsField(bounded, 0, {}), 'Flush every must be at least 1.');
    assert.equal(validateSettingsField(bounded, 101, {}), 'Flush every must be at most 100.');
    assert.equal(validateSettingsField(bounded, 1.5, {}), 'Flush every must be a whole number.');
    assert.equal(validateSettingsField(bounded, 50, {}), null);
});

test('074 custom validation and unsupported fields follow the frontend-only contract', () => {
    const custom: SettingsFieldDefinition = {
        key: 'origin',
        label: 'Origin',
        kind: 'text',
        errorKey: 'public-origin',
        validate: value => value === 'https://jaw.example.com' ? null : 'Use the canonical origin.',
    };
    const unsupported: SettingsFieldDefinition = {
        ...custom,
        unsupported: 'No persistence slice exists.',
    };

    assert.equal(validateSettingsField(custom, 'http://wrong.example.com', {}), 'Use the canonical origin.');
    assert.equal(validateSettingsField(unsupported, 'http://wrong.example.com', {}), null);
});

test('074 ghost dashboard fields are disabled and the real persistence allowlist remains explicit', () => {
    const display = read('public/dashboard2/src/features/settings/pages/DisplayPage.tsx');
    const profile = read('public/dashboard2/src/features/settings/pages/ProfilePage.tsx');
    const browser = read('public/dashboard2/src/features/settings/pages/BrowserPage.tsx');
    const memory = read('public/dashboard2/src/features/settings/pages/MemoryPage.tsx');
    const network = read('public/dashboard2/src/features/settings/pages/NetworkPage.tsx');

    assert.match(display, /key: 'fontSize'.*unsupported:/s);
    for (const source of [profile, browser]) {
        const fieldCount = (source.match(/\{ key:/g) ?? []).length;
        assert.ok(fieldCount > 0);
        assert.equal((source.match(/unsupported:/g) ?? []).length, fieldCount);
    }
    assert.doesNotMatch(memory, /unsupported:/);
    assert.match(memory, /adapterId="memory"/);
    assert.doesNotMatch(network, /unsupported:/);
    assert.match(network, /adapterId="network"/);
});

test('074 Settings registers the shared leave guard and Workbench keeps both surfaces mounted', () => {
    const settings = read('public/dashboard2/src/features/settings/SettingsWorkspace.tsx');
    const workbench = read('public/dashboard2/src/shell/Workbench.tsx');

    assert.match(settings, /registerLeaveGuard\('settings'/);
    assert.match(settings, /registerDirtyCheck\('settings'/);
    assert.match(settings, /unregisterLeaveGuard\('settings'\)/);
    assert.match(settings, /unregisterDirtyCheck\('settings'\)/);
    assert.doesNotMatch(settings, /addEventListener\('beforeunload'/);
    assert.match(workbench, /data-workspace-surface="chat"/);
    assert.match(workbench, /data-workspace-surface="settings"/);
    assert.match(workbench, /display: workspaceMode === 'chat' \? 'grid' : 'none'/);
    assert.match(workbench, /display: workspaceMode === 'settings' \? 'grid' : 'none'/);
});

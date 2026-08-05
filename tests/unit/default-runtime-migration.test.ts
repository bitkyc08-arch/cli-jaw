import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
    chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cli-jaw-runtime-migration-'));
process.env['CLI_JAW_HOME'] = home;
after(() => rmSync(home, { recursive: true, force: true }));

let pickerCalls = 0;
mock.module(resolve(import.meta.dirname, '../../src/cli/readiness.js'), {
    exports: {
        pickFirstReadyCli: () => {
            pickerCalls += 1;
            return 'codex-app';
        },
    },
});

const config = await import('../../src/core/config.ts');
const runtime = await import('../../src/core/runtime-settings.ts');

function writeSettings(value: unknown): void {
    writeFileSync(config.SETTINGS_PATH, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function pending(fromCli = 'claude') {
    return {
        id: config.RUNTIME_DEFAULT_MIGRATION_ID,
        state: 'pending',
        fromCli,
        toCli: 'codex-app',
    };
}

test('DRM-001: ENOENT alone uses the clean-install picker and persists the current schema', () => {
    if (existsSync(config.SETTINGS_PATH)) unlinkSync(config.SETTINGS_PATH);
    pickerCalls = 0;
    const loaded = config.loadSettings();
    assert.equal(pickerCalls, 1);
    assert.equal(loaded.cli, 'codex-app');
    assert.equal(loaded.settingsSchemaVersion, config.SETTINGS_SCHEMA_VERSION);
    assert.equal(loaded.runtimeDefaultMigration, null);
    assert.equal(config.getSettingsPersistenceShape(), 'absent');
    assert.equal(JSON.parse(readFileSync(config.SETTINGS_PATH, 'utf8')).cli, 'codex-app');
});

for (const [name, input] of [
    ['missing', {}],
    ['invalid', { cli: 'not-a-runtime' }],
] as const) {
    test(`DRM-002 ${name}: v1 cli is normalized to legacy claude without picker`, () => {
        writeSettings(input);
        pickerCalls = 0;
        const loaded = config.loadSettings();
        assert.equal(pickerCalls, 0);
        assert.equal(loaded.cli, 'claude');
        assert.deepEqual(loaded.runtimeDefaultMigration, pending());
        assert.equal(loaded.settingsSchemaVersion, config.SETTINGS_SCHEMA_VERSION);
    });
}

test('DRM-003: v1 preserves explicit cli and never changes it during migration', () => {
    writeSettings({ cli: 'pi' });
    const loaded = config.loadSettings();
    assert.equal(loaded.cli, 'pi');
    assert.deepEqual(loaded.runtimeDefaultMigration, pending('pi'));

    writeSettings({ cli: 'codex-app' });
    const already = config.loadSettings();
    assert.equal(already.cli, 'codex-app');
    assert.equal(already.runtimeDefaultMigration.state, 'already-codex-app');
});

// A document already at the current schema is the one that must not be rewritten. A v2
// document no longer qualifies: the session-default migration rewrites it on the way to
// v3, which is the point of that migration.
test('DRM-004: a current-schema pending reload is not rewritten', () => {
    const document = {
        settingsSchemaVersion: config.SETTINGS_SCHEMA_VERSION,
        runtimeDefaultMigration: pending(),
        multiSessionDefaultMigration: { id: 'multi-session-default-v3', state: 'pending' },
        multiSession: { enabled: false, maxConcurrent: 1, midRunPolicy: 'steer', channels: { telegram: false, discord: false, slack: true } },
        cli: 'claude',
    };
    writeSettings(document);
    const before = readFileSync(config.SETTINGS_PATH, 'utf8');
    const loaded = config.loadSettings();
    assert.equal(loaded.runtimeDefaultMigration.state, 'pending');
    assert.equal(loaded.runtime.codexApp.multiplex, false);
    assert.equal(config.getSettingsPersistenceShape(), 'absent');
    assert.equal(readFileSync(config.SETTINGS_PATH, 'utf8'), before);
});

test('DRM-004b: explicit multiplex false is retained as present shape', () => {
    writeSettings({
        settingsSchemaVersion: 2,
        runtimeDefaultMigration: null,
        cli: 'codex-app',
        runtime: { codexApp: { multiplex: false } },
    });
    const loaded = config.loadSettings();
    assert.equal(loaded.runtime.codexApp.multiplex, false);
    assert.equal(config.getSettingsPersistenceShape(), 'present');
});

test('DRM-004c: replaceSettings commits value and shape together without persistence', (t) => {
    writeSettings({ settingsSchemaVersion: 2, runtimeDefaultMigration: null, cli: 'codex-app' });
    config.loadSettings();
    const previous = config.snapshotSettingsState();
    const beforeRaw = readFileSync(config.SETTINGS_PATH, 'utf8');
    t.after(() => config.commitCandidate(previous));

    const replacement = structuredClone(config.settings);
    replacement.runtime.codexApp.multiplex = false;
    config.replaceSettings(replacement, 'present');
    assert.equal(config.settings, replacement);
    assert.equal(config.getSettingsPersistenceShape(), 'present');
    assert.equal(readFileSync(config.SETTINGS_PATH, 'utf8'), beforeRaw);
});

test('DRM-005: corrupt JSON backs up the original, never calls picker, and fails safe to claude', () => {
    writeSettings('{broken-json');
    pickerCalls = 0;
    const loaded = config.loadSettings();
    assert.equal(pickerCalls, 0, 'corrupt settings must not invoke the clean-install picker');
    assert.equal(loaded.cli, 'claude');
    assert.equal(config.getSettingsPersistenceShape(), 'absent');
    assert.equal(readFileSync(config.SETTINGS_PATH, 'utf8'), '{broken-json', 'corrupt original must not be overwritten');
    const backups = readdirSync(home).filter((name) => name.startsWith('settings.json.corrupt-') && name.endsWith('.bak'));
    assert.ok(backups.length > 0);
    assert.equal(readFileSync(join(home, backups.at(-1)!), 'utf8'), '{broken-json');
});

test('DRM-006: unsupported future schema fails closed without down-migration', () => {
    writeSettings({ settingsSchemaVersion: 99, cli: 'codex-app' });
    pickerCalls = 0;
    const loaded = config.loadSettings();
    assert.equal(pickerCalls, 0);
    assert.equal(loaded.cli, 'claude');
    assert.equal(config.getSettingsPersistenceShape(), 'absent');
    assert.equal(JSON.parse(readFileSync(config.SETTINGS_PATH, 'utf8')).settingsSchemaVersion, 99);
});

test('DRM-006b: malformed v2 migration state fails closed instead of reconstructing terminal state', () => {
    writeSettings({
        settingsSchemaVersion: 2,
        cli: 'codex-app',
        runtimeDefaultMigration: { ...pending(), id: 'client-forged-id', state: 'accepted' },
    });
    pickerCalls = 0;
    const loaded = config.loadSettings();
    assert.equal(pickerCalls, 0);
    assert.equal(loaded.cli, 'claude');
    const original = JSON.parse(readFileSync(config.SETTINGS_PATH, 'utf8'));
    assert.equal(original.runtimeDefaultMigration.id, 'client-forged-id');
});

// A v1 document predates codex-app, so a missing cli is normalised to the old
// fallback. A v2 document claims this schema wrote it, and this schema always
// writes a known cli, so a missing or unknown one means the file cannot be
// trusted to supply the runtime. Without this the defaults merge would quietly
// hand an existing install codex-app for that run.
test('DRM-006c: a v2 document with no cli fails closed instead of inheriting the new default', () => {
    writeSettings({ settingsSchemaVersion: 2, runtimeDefaultMigration: null, model: 'gpt-5.5' });
    pickerCalls = 0;
    const loaded = config.loadSettings();
    assert.equal(pickerCalls, 0, 'the picker must not run for an existing install');
    assert.equal(loaded.cli, 'claude', 'a v2 document without a cli must not become codex-app');
    const original = JSON.parse(readFileSync(config.SETTINGS_PATH, 'utf8'));
    assert.equal('cli' in original, false, 'the original document must not be rewritten');
});

test('DRM-006d: a v2 document naming an unknown runtime fails closed', () => {
    writeSettings({ settingsSchemaVersion: 2, cli: 'not-a-real-runtime', runtimeDefaultMigration: null });
    pickerCalls = 0;
    const loaded = config.loadSettings();
    assert.equal(pickerCalls, 0);
    assert.equal(loaded.cli, 'claude', 'an unknown runtime must not survive into the running config');
    assert.equal(
        JSON.parse(readFileSync(config.SETTINGS_PATH, 'utf8')).cli,
        'not-a-real-runtime',
        'the original document must be preserved for the user to repair',
    );
});

test('DRM-007: unreadable settings follows the same no-picker fail-safe', { skip: process.platform === 'win32' }, () => {
    writeSettings({ cli: 'codex-app' });
    chmodSync(config.SETTINGS_PATH, 0o000);
    pickerCalls = 0;
    try {
        const loaded = config.loadSettings();
        assert.equal(pickerCalls, 0);
        assert.equal(loaded.cli, 'claude');
    } finally {
        chmodSync(config.SETTINGS_PATH, 0o600);
    }
});

test('DRM-008: pure accept/keep builders produce one logical patch and reject terminal replay', () => {
    const current = { runtimeDefaultMigration: pending(), cli: 'claude' };
    assert.deepEqual(runtime.resolveRuntimeDefaultMigration(current, 'accept'), {
        cli: 'codex-app',
        runtimeDefaultMigration: { ...pending(), state: 'accepted' },
    });
    assert.deepEqual(runtime.resolveRuntimeDefaultMigration(current, 'keep'), {
        runtimeDefaultMigration: { ...pending(), state: 'kept' },
    });
    assert.throws(
        () => runtime.resolveRuntimeDefaultMigration({ runtimeDefaultMigration: { ...pending(), state: 'kept' } }, 'accept'),
        runtime.RuntimeDefaultMigrationTerminalError,
    );
});

test('DRM-009: accept refresh failure rolls cli and migration state back together', async () => {
    writeSettings({ settingsSchemaVersion: 2, runtimeDefaultMigration: pending(), cli: 'claude' });
    config.loadSettings();
    const patch = runtime.resolveRuntimeDefaultMigration(config.settings, 'accept');
    await assert.rejects(runtime.applyRuntimeSettingsPatch(patch, {
        cliSwitchRefresh: async () => { throw new Error('fixture cli refresh failure'); },
    }), /fixture cli refresh failure/);
    assert.equal(config.settings["cli"], 'claude');
    assert.equal(config.settings["runtimeDefaultMigration"].state, 'pending');
    assert.equal(config.getSettingsPersistenceShape(), 'absent');
    const persisted = JSON.parse(readFileSync(config.SETTINGS_PATH, 'utf8'));
    assert.equal(persisted.cli, 'claude');
    assert.equal(persisted.runtimeDefaultMigration.state, 'pending');
});

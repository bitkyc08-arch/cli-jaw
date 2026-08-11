import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
    getSettingsPersistenceShape,
    settings,
    replaceSettings,
} from '../../src/core/config.ts';
import { addBroadcastListener, removeBroadcastListener } from '../../src/core/bus.ts';
import { reloadSettingsFromDisk, startSettingsWatch } from '../../src/core/settings-watch.ts';

type Captured = { type: string; data: Record<string, unknown> };

function withCapturedBroadcasts(run: (events: Captured[]) => void | Promise<void>): Promise<void> {
    const events: Captured[] = [];
    const listener = (type: string, data: Record<string, unknown>) => { events.push({ type, data }); };
    addBroadcastListener(listener);
    const prevSettings = { ...settings };
    const prevShape = getSettingsPersistenceShape();
    return Promise.resolve(run(events)).finally(() => {
        removeBroadcastListener(listener);
        replaceSettings(prevSettings, prevShape);
    });
}

test('SWA-001: external write reloads settings and broadcasts settings_change', () => withCapturedBroadcasts((events) => {
    // normalizeProjectDirs only keeps real directories — use this repo's root.
    const realDir = realpathSync(join(import.meta.dirname, '..', '..'));
    const reloaded = reloadSettingsFromDisk({
        readImpl: () => JSON.stringify({ cli: 'codex', projectDirs: [realDir] }),
        lastSavedRaw: null,
    });
    assert.equal(reloaded, true);
    assert.equal(settings["cli"], 'codex');
    assert.deepEqual(settings["projectDirs"], [realDir]);
    const change = events.find(e => e.type === 'settings_change');
    assert.ok(change, 'settings_change must be broadcast');
    assert.equal(change.data["source"], 'external');
    assert.deepEqual(change.data["projectDirs"], [realDir]);
}));

test('SWA-002: self-write echo is skipped (fingerprint match)', () => withCapturedBroadcasts((events) => {
    const raw = JSON.stringify({ cli: 'claude' });
    const reloaded = reloadSettingsFromDisk({ readImpl: () => raw, lastSavedRaw: raw });
    assert.equal(reloaded, false);
    assert.equal(events.filter(e => e.type === 'settings_change').length, 0);
}));

test('SWA-003: malformed JSON keeps in-memory settings and stays silent', () => withCapturedBroadcasts((events) => {
    const prevCli = settings["cli"];
    const reloaded = reloadSettingsFromDisk({ readImpl: () => '{not json', lastSavedRaw: null });
    assert.equal(reloaded, false);
    assert.equal(settings["cli"], prevCli);
    assert.equal(events.filter(e => e.type === 'settings_change').length, 0);
}));

test('SWA-004: watcher debounces rapid events into one reload and filters filenames', async () => {
    let listener: ((event: string, filename: string | Buffer | null) => void) | null = null;
    let closed = false;
    let reads = 0;
    const stop = startSettingsWatch({
        debounceMs: 10,
        watchImpl: (_dir, l) => { listener = l; return { close: () => { closed = true; } }; },
        readImpl: () => { reads += 1; throw new Error('stop here — read counted'); },
    });
    assert.ok(listener, 'watch listener must be registered');

    listener('change', 'unrelated.json');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(reads, 0, 'other filenames must not trigger a read');

    listener('change', 'settings.json');
    listener('change', 'settings.json');
    listener('change', 'settings.json');
    await new Promise(r => setTimeout(r, 40));
    assert.equal(reads, 1, 'rapid events must collapse into one reload');

    stop();
    assert.equal(closed, true, 'stop() must close the watcher');
});

test('SWA-005: server wires the watcher and producers broadcast settings_change', () => {
    const root = join(import.meta.dirname, '..', '..');
    const serverSrc = readFileSync(join(root, 'server.ts'), 'utf8');
    assert.ok(serverSrc.includes('startSettingsWatch()'), 'server.ts must start the settings watcher');
    const runtimeSrc = readFileSync(join(root, 'src/core/runtime-settings.ts'), 'utf8');
    assert.ok(runtimeSrc.includes("broadcast('settings_change'"), 'applyRuntimeSettingsPatch must broadcast settings_change');
    const projectSrc = readFileSync(join(root, 'src/cli/handlers-project.ts'), 'utf8');
    assert.ok(projectSrc.includes("broadcast('settings_change'"), 'project handler must broadcast settings_change');
});

test('SWA-006: external JSON cannot overwrite schema-owned fields but can update user settings', () => withCapturedBroadcasts((events) => {
    const migration = {
        id: 'codex-app-default-v2',
        state: 'accepted',
        fromCli: 'claude',
        toCli: 'codex-app',
    };
    replaceSettings({
        ...settings,
        settingsSchemaVersion: 3,
        runtimeDefaultMigration: migration,
        cli: 'codex-app',
    }, 'absent');
    const reloaded = reloadSettingsFromDisk({
        readImpl: () => JSON.stringify({
            settingsSchemaVersion: 99,
            runtimeDefaultMigration: { ...migration, state: 'kept' },
            cli: 'pi',
        }),
        lastSavedRaw: null,
    });
    assert.equal(reloaded, true);
    // The external document said 99. What matters is that the number in memory is the one
    // this process owns, not the one an outside writer asked for.
    assert.equal(settings["settingsSchemaVersion"], 3);
    assert.deepEqual(settings["runtimeDefaultMigration"], migration);
    assert.equal(settings["cli"], 'pi');
    const change = events.find(e => e.type === 'settings_change');
    assert.deepEqual(change?.data["changedKeys"], ['cli', 'runtime']);
}));

test('SWA-007: full reload can transition a present gate back to absent false', () => withCapturedBroadcasts((events) => {
    replaceSettings({
        ...settings,
        runtime: { codexApp: { multiplex: true } },
    }, 'present');
    const reloaded = reloadSettingsFromDisk({
        readImpl: () => JSON.stringify({ cli: 'codex-app' }),
        lastSavedRaw: null,
    });
    assert.equal(reloaded, true);
    assert.equal(settings["runtime"].codexApp.multiplex, false);
    assert.equal(getSettingsPersistenceShape(), 'absent');
    assert.ok((events.find(e => e.type === 'settings_change')?.data["changedKeys"] as string[]).includes('runtime'));
}));

test('SWA-008: invalid multiplex is dropped and follows the absent transition', () => withCapturedBroadcasts(() => {
    replaceSettings({
        ...settings,
        runtime: { codexApp: { multiplex: true } },
    }, 'present');
    const reloaded = reloadSettingsFromDisk({
        readImpl: () => JSON.stringify({
            cli: 'codex-app',
            runtime: { codexApp: { multiplex: 'true' } },
        }),
        lastSavedRaw: null,
    });
    assert.equal(reloaded, true);
    assert.equal(settings["runtime"].codexApp.multiplex, false);
    assert.equal(getSettingsPersistenceShape(), 'absent');
}));

test('SWA-009: laneMode is stripped while a valid multiplex sibling is applied', () => withCapturedBroadcasts(() => {
    for (const laneMode of ['native', 'fallback', 'anything']) {
        const reloaded = reloadSettingsFromDisk({
            readImpl: () => JSON.stringify({
                cli: 'codex-app',
                runtime: { codexApp: { laneMode, multiplex: true } },
            }),
            lastSavedRaw: null,
        });
        assert.equal(reloaded, true);
        assert.equal(settings["runtime"].codexApp.multiplex, true);
        assert.equal('laneMode' in settings["runtime"].codexApp, false);
        assert.equal(getSettingsPersistenceShape(), 'present');
    }
}));

test('SWA-010: external reload cannot replace an environment-managed Slack connection', () => withCapturedBroadcasts(() => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-environment-token';
    try {
        replaceSettings({
            ...settings,
            slack: {
                ...settings["slack"],
                enabled: true,
                botToken: 'xoxb-environment-token',
                appToken: '',
                forwardAll: true,
            },
        }, getSettingsPersistenceShape());
        const reloaded = reloadSettingsFromDisk({
            readImpl: () => JSON.stringify({
                slack: {
                    enabled: false,
                    botToken: 'xoxb-file-token',
                    appToken: 'xapp-file-token',
                    forwardAll: false,
                },
            }),
            lastSavedRaw: null,
        });

        assert.equal(reloaded, true);
        assert.equal(settings["slack"].enabled, true);
        assert.equal(settings["slack"].botToken, 'xoxb-environment-token');
        assert.equal(settings["slack"].appToken || '', '');
        assert.equal(settings["slack"].forwardAll, false);
    } finally {
        delete process.env['SLACK_BOT_TOKEN'];
    }
}));

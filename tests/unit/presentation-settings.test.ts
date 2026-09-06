import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import express from 'express';
import type { MainSessionRecord } from '../../src/core/main-session.ts';

// Set every filesystem boundary before importing the actual settings owners.
const home = mkdtempSync(join(tmpdir(), 'cli-jaw-presentation-'));
process.env['CLI_JAW_HOME'] = home;
process.env['CLI_JAW_JWC_AGENT_DIR'] = join(home, 'jwc-agent');
process.env['TMPDIR'] = join(home, 'tmp');
mkdirSync(process.env['TMPDIR'], { recursive: true });
mkdirSync(process.env['CLI_JAW_JWC_AGENT_DIR'], { recursive: true });
const jwcPath = join(process.env['CLI_JAW_JWC_AGENT_DIR'], 'config.yml');
const jwcSentinel = 'modelRoles:\n  default: sentinel/do-not-rewrite\ncustom: keep\n';

const config = await import('../../src/core/config.ts');
const database = await import('../../src/core/db.ts');
const runtime = await import('../../src/core/runtime-settings.ts');
const messaging = await import('../../src/messaging/runtime.ts');
const bus = await import('../../src/core/bus.ts');
const watcher = await import('../../src/core/settings-watch.ts');
const { sanitizeSettingsInput } = await import('../../src/core/settings-merge.ts');
const { registerSettingsRoutes } = await import('../../src/routes/settings.ts');

const nativeBucket = 'native-v1:claude:presentation-fixture';
let resets = 0;
let dispatches = 0;
let starts = 0;
let stops = 0;
const events: Array<{ type: string; data: Record<string, unknown> }> = [];
const listener = (type: string, data: Record<string, unknown>) => events.push({ type, data });
bus.addBroadcastListener(listener);

function writeDocument(value: unknown): void {
    writeFileSync(config.SETTINGS_PATH, JSON.stringify(value, null, 2));
}

function disk(): string { return readFileSync(config.SETTINGS_PATH, 'utf8'); }
function session(): MainSessionRecord { return database.getSession() as MainSessionRecord; }

async function apply(patch: Record<string, unknown>) {
    return runtime.applyRuntimeSettingsPatch(patch, {
        resetFallbackState: () => { resets += 1; },
        restartMessaging: async (prev, next, actualPatch) => {
            dispatches += 1;
            return messaging.restartMessagingRuntime(prev, next, actualPatch);
        },
    });
}

beforeEach(async () => {
    const initial = structuredClone(config.DEFAULT_SETTINGS);
    writeDocument({
        ...initial,
        cli: 'jwc',
        workingDir: home,
        presentation: { mode: 'legacy', sibling: 'preserve' },
        perCli: { ...initial.perCli, jwc: { provider: 'anthropic', model: 'settings-model' } },
        messaging: { ...initial.messaging, enabledChannels: ['telegram'], homeChannel: 'telegram' },
    });
    config.loadSettings();
    database.updateSession.run('jwc', 'native-session-sentinel', 'singleton-model', 'auto', home, 'high');
    database.upsertSessionBucket.run(nativeBucket, 'native-resume-sentinel', 'native-model', 'resume-key', 17);
    writeFileSync(jwcPath, jwcSentinel);
    messaging.__resetTransportRegistryForTests();
    // Only the external transport init/shutdown boundaries are fake. The restart
    // dispatcher, registry, running state, persistence, session and bus are real.
    for (const channel of ['telegram', 'discord', 'slack'] as const) {
        messaging.registerTransport(channel, {
            init: async () => { starts += 1; return messaging.transportStarted; },
            shutdown: async () => { stops += 1; },
        });
    }
    await messaging.startMessagingTransport('telegram');
    resets = dispatches = starts = stops = 0;
    events.length = 0;
});

after(() => {
    bus.removeBroadcastListener(listener);
    messaging.__resetTransportRegistryForTests();
    database.db.close();
    rmSync(home, { recursive: true, force: true });
});

test('presentation-only does not reset fallback state', async () => {
    await apply({ presentation: { mode: 'activity' } });
    assert.equal(resets, 0);
});

test('presentation-only preserves the actual singleton session row', async () => {
    const before = database.getSession();
    await apply({ presentation: { mode: 'activity' } });
    assert.deepEqual(database.getSession(), before);
});

test('presentation-only does not write the isolated JWC config', async () => {
    await apply({ presentation: { mode: 'activity' } });
    assert.equal(readFileSync(jwcPath, 'utf8'), jwcSentinel);
});

test('presentation-only persists, broadcasts and dispatches without changing transport or native identity', async () => {
    const perCli = structuredClone(config.settings['perCli']);
    const bucket = database.getSessionBucket.get(nativeBucket);
    await apply({ presentation: { mode: 'activity' } });
    assert.deepEqual(config.settings['presentation'], { mode: 'activity', sibling: 'preserve' });
    assert.deepEqual(JSON.parse(disk()).presentation, { mode: 'activity', sibling: 'preserve' });
    assert.equal(config.settings['cli'], 'jwc');
    assert.deepEqual(config.settings['perCli'], perCli);
    assert.deepEqual(database.getSessionBucket.get(nativeBucket), bucket);
    assert.equal(dispatches, 1);
    assert.equal(starts, 0);
    assert.equal(stops, 0);
    assert.deepEqual(messaging.getRunningMessagingTransports(), ['telegram']);
    assert.deepEqual(events.filter(e => e.type === 'settings_change').map(e => e.data['changedKeys']), [['presentation']]);
    config.loadSettings();
    assert.deepEqual(config.settings['presentation'], { mode: 'activity', sibling: 'preserve' });
    assert.deepEqual(config.settings['perCli'], perCli);
});

test('empty and partial presentation blocks retain explicit legacy and siblings', async () => {
    await apply({ presentation: {} });
    await apply({ presentation: { sibling: 'updated' } });
    assert.deepEqual(config.settings['presentation'], { mode: 'legacy', sibling: 'updated' });
    assert.equal(resets, 0);
    assert.equal(session().model, 'singleton-model');
    assert.equal(readFileSync(jwcPath, 'utf8'), jwcSentinel);
    config.loadSettings();
    assert.deepEqual(config.settings['presentation'], { mode: 'legacy', sibling: 'updated' });
});

for (const [name, patch] of [
    ['mixed', { presentation: { mode: 'activity' }, locale: 'en' }],
    ['empty', {}],
] as const) {
    test(`${name} patch preserves existing fallback, session and JWC side effects`, async () => {
        await apply(patch);
        assert.equal(resets, 1);
        assert.equal(session().model, 'settings-model');
        assert.equal(session().session_id, 'native-session-sentinel');
        assert.equal(readFileSync(jwcPath, 'utf8'), 'modelRoles:\n  default: anthropic/settings-model\ncustom: keep\n');
        assert.equal(dispatches, 1);
        assert.equal(starts, name === 'mixed' ? 1 : 0);
        assert.equal(stops, name === 'mixed' ? 1 : 0);
    });
}

test('inherited presentation is an empty patch, while inherited unrelated keys do not defeat an own presentation-only patch', async () => {
    await apply(Object.create({ presentation: { mode: 'activity' } }));
    assert.equal(resets, 1);
    assert.equal(session().model, 'settings-model');
    assert.equal(config.settings['presentation'].mode, 'legacy');
    await apply(Object.assign(Object.create({ locale: 'en' }), { presentation: { mode: 'activity' } }));
    assert.equal(resets, 1);
    assert.equal(starts, 0);
    assert.equal(stops, 0);
});

test('presentation-only write failure leaves disk, memory, session and broadcasts untouched', async () => {
    const before = config.snapshotSettingsState();
    const raw = disk();
    await assert.rejects(runtime.applyRuntimeSettingsPatch({ presentation: { mode: 'activity' } }, {
        writeSettings: () => { throw new Error('presentation write failed'); },
        resetFallbackState: () => { resets += 1; },
    }), /presentation write failed/);
    assert.deepEqual(config.snapshotSettingsState(), before);
    assert.equal(disk(), raw);
    assert.equal(session().model, 'singleton-model');
    assert.equal(readFileSync(jwcPath, 'utf8'), jwcSentinel);
    assert.equal(resets, 0);
    assert.equal(events.length, 0);
});

test('presentation-only dispatcher failure retains the existing persistence rollback', async () => {
    config.saveSettings(config.settings);
    const before = config.snapshotSettingsState();
    const raw = disk();
    await assert.rejects(runtime.applyRuntimeSettingsPatch({ presentation: { mode: 'activity' } }, {
        restartMessaging: async () => { throw new Error('presentation dispatcher failed'); },
        resetFallbackState: () => { resets += 1; },
    }), /presentation dispatcher failed/);
    assert.deepEqual(config.snapshotSettingsState(), before);
    assert.equal(disk(), raw);
    assert.equal(session().model, 'singleton-model');
    assert.equal(readFileSync(jwcPath, 'utf8'), jwcSentinel);
    assert.equal(resets, 0);
    assert.equal(events.length, 0);
});

test('fresh defaults and old absent documents resolve activity; explicit legacy survives save/reload', () => {
    assert.deepEqual(config.DEFAULT_SETTINGS.presentation, { mode: 'activity' });
    assert.deepEqual(config.settingsForHomeWithoutSettingsFile().presentation, { mode: 'activity' });
    for (const presentation of [undefined, { mode: 'legacy', sibling: 'kept' }]) {
        writeDocument({ cli: 'jwc', workingDir: home, ...(presentation ? { presentation } : {}) });
        config.loadSettings();
        const expected = presentation ?? { mode: 'activity' };
        assert.deepEqual(config.settings['presentation'], expected);
        config.saveSettings(config.settings);
        assert.deepEqual(JSON.parse(disk()).presentation, expected);
        config.loadSettings();
        assert.deepEqual(config.settings['presentation'], expected);
    }
});

test('boot repairs invalid presentation values and direct migration never spreads malformed blocks', () => {
    for (const presentation of [null, [], 'legacy', 42, { mode: 'native', sibling: 'kept' }]) {
        writeDocument({ cli: 'jwc', workingDir: home, presentation });
        config.loadSettings();
        const expected = presentation && typeof presentation === 'object' && !Array.isArray(presentation)
            ? { mode: 'activity', sibling: 'kept' } : { mode: 'activity' };
        assert.deepEqual(config.settings['presentation'], expected);
        assert.deepEqual(config.migrateSettings({ ...config.settings, presentation })['presentation'], expected);
        config.saveSettings(config.settings);
        config.loadSettings();
        assert.deepEqual(config.settings['presentation'], expected);
    }
});

test('invalid API presentation is rejected with no memory, disk or runtime side effects', async () => {
    const app = express();
    app.use(express.json());
    registerSettingsRoutes(app, (_req, _res, next) => next(), apply, process.cwd());
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
        for (const presentation of [null, [], 'legacy', 1, { mode: 'native' }, { mode: null }, { mode: 1 }]) {
            const patch = { presentation };
            const before = config.snapshotSettingsState();
            const raw = disk();
            const expectedPath = presentation && typeof presentation === 'object' && !Array.isArray(presentation)
                ? 'presentation.mode' : 'presentation';
            assert.deepEqual(sanitizeSettingsInput(patch, 'api').invalidPaths, [expectedPath]);
            await assert.rejects(apply(patch), /invalid_settings_field/);
            const response = await fetch(`http://127.0.0.1:${address.port}/api/settings`, {
                method: 'PUT', headers: { 'content-type': 'application/json' },
                body: JSON.stringify(patch), signal: AbortSignal.timeout(5000),
            });
            assert.equal(response.status, 400);
            assert.equal((await response.json()).error, 'invalid_settings_field');
            assert.equal(disk(), raw);
            assert.deepEqual(config.snapshotSettingsState(), before);
        }
        assert.equal(resets, 0);
        assert.equal(dispatches, 0);
        assert.equal(readFileSync(jwcPath, 'utf8'), jwcSentinel);
        assert.equal(events.length, 0);
        const response = await fetch(`http://127.0.0.1:${address.port}/api/settings`, {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ presentation: { mode: 'activity' } }), signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).data.presentation, { mode: 'activity', sibling: 'preserve' });
        assert.deepEqual(JSON.parse(disk()).presentation, { mode: 'activity', sibling: 'preserve' });
        assert.equal(resets, 0);
        assert.equal(session().model, 'singleton-model');
        assert.equal(readFileSync(jwcPath, 'utf8'), jwcSentinel);
        assert.equal(dispatches, 1);
        assert.equal(starts, 0);
        assert.equal(stops, 0);
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

test('real disk watcher ingress sanitizes invalid fields, retains legacy and merges siblings', () => {
    const warnings: string[] = [];
    const previousWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
        for (const presentation of [null, [], 'bad', { mode: 'invalid', sibling: 'updated' }]) {
            writeDocument({ presentation });
            const raw = disk();
            assert.equal(watcher.reloadSettingsFromDisk({ lastSavedRaw: null }), true);
            assert.equal(config.settings['presentation'].mode, 'legacy');
            assert.equal(disk(), raw, 'watch reload does not rewrite the external file');
        }
        assert.deepEqual(config.settings['presentation'], { mode: 'legacy', sibling: 'updated' });
        assert.ok(warnings.some(line => line.includes('presentation.mode')));
        assert.ok(warnings.some(line => line.endsWith('presentation')));
        writeDocument({ presentation: { mode: 'activity' } });
        assert.equal(watcher.reloadSettingsFromDisk({ lastSavedRaw: null }), true);
        assert.deepEqual(config.settings['presentation'], { mode: 'activity', sibling: 'updated' });
        assert.equal(session().model, 'singleton-model');
        assert.equal(readFileSync(jwcPath, 'utf8'), jwcSentinel);
    } finally {
        console.warn = previousWarn;
    }
});

test('presentation-only save keeps a registered native owner and live-run identity current', async () => {
    const { reserveClaudeRun, hasClaudeRuns } = await import('../../src/agent/runtime/claude-run-controls.ts');
    const { getSessionOwnershipGeneration } = await import('../../src/agent/session-persistence.ts');
    const { beginLiveRun, getLiveRun, setLiveRunTraceId, clearLiveRun } = await import('../../src/agent/live-run-state.ts');
    const scope = 'presentation-busy-native'; let cancellations = 0, settled = false;
    const owner = reserveClaudeRun({ runId: 'presentation-native-owner', scope, cancel: () => { cancellations++; } });
    void owner.done.then(() => { settled = true; });
    beginLiveRun(scope, 'claude'); setLiveRunTraceId(scope, 'tr_presentation1234567890');
    const live = structuredClone(getLiveRun(scope)), generation = getSessionOwnershipGeneration(scope);
    const native = database.getSessionBucket.get(nativeBucket);
    try {
        await apply({ presentation: { mode: 'activity' } });
        assert.equal(owner.current(), true); assert.equal(hasClaudeRuns(scope), true);
        assert.equal(cancellations, 0); assert.equal(settled, false);
        assert.deepEqual(getLiveRun(scope), live);
        assert.deepEqual(getSessionOwnershipGeneration(scope), generation);
        assert.deepEqual(database.getSessionBucket.get(nativeBucket), native);
        assert.equal(resets, 0); assert.equal(starts, 0); assert.equal(stops, 0);
    } finally { owner.finish(); clearLiveRun(scope); }
});

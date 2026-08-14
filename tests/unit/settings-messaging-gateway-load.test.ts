// A v4 settings document lost its gateway every time it was read.
//
// loadSettings() rebuilds the messaging block field by field, and the rebuild
// named only latestSeen and lastActive. enabledChannels and homeChannel were
// dropped, migrateSettings then refilled them from the legacy `channel` key —
// which the v4 migration had already deleted — so the fallback landed on
// telegram.
//
// It was silent and it was permanent: the load path rewrites the file when it
// migrates, so a Slack install came up as telegram, started no transport, and
// stayed that way. Seen on a real Windows host where /api/health reported
// ok:true while Slack answered nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function v4Document(enabled: string[], home: string): Record<string, any> {
    return {
        settingsSchemaVersion: 4,
        runtimeDefaultMigration: null,
        multiSessionDefaultMigration: null,
        cli: 'codex-app',
        multiSession: {
            enabled: true, maxConcurrent: 2, midRunPolicy: 'steer',
            channels: { telegram: false, discord: false, slack: true },
        },
        slack: { enabled: true, botToken: 'xoxb-test', appToken: 'xapp-test', teamId: 'T1' },
        messaging: {
            enabledChannels: enabled,
            homeChannel: home,
            latestSeen: { telegram: null, discord: null, slack: null },
            lastActive: { telegram: null, discord: null, slack: null },
        },
    };
}

async function loadInHome(doc: unknown): Promise<{ settings: any; onDisk: any }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-jaw-settings-'));
    const file = path.join(home, 'settings.json');
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    process.env['CLI_JAW_HOME'] = home;
    // Fresh module per home: config.ts resolves its paths at import time.
    const mod = await import('../../src/core/config.ts?home=' + encodeURIComponent(home));
    mod.loadSettings();
    return { settings: mod.settings, onDisk: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('a v4 slack gateway survives being loaded', async () => {
    const { settings, onDisk } = await loadInHome(v4Document(['slack'], 'slack'));

    assert.deepEqual(settings.messaging.enabledChannels, ['slack'],
        'the stored gateway must not be replaced by the legacy-channel fallback');
    assert.equal(settings.messaging.homeChannel, 'slack');

    // A load that corrupts the block in memory makes the corruption permanent,
    // because the same load path writes the file back. Pin the disk too.
    assert.deepEqual(onDisk.messaging.enabledChannels, ['slack'],
        'loading must not rewrite the file with a different gateway');
    assert.equal(onDisk.messaging.homeChannel, 'slack');
});

test('the reply-target bookkeeping still merges against defaults', async () => {
    // The named-field rebuild existed to fill in missing per-channel slots. That
    // has to keep working, or a document written before a channel existed would
    // read back without its slot.
    const doc = v4Document(['slack'], 'slack');
    doc['messaging'].latestSeen = { telegram: null };
    doc['messaging'].lastActive = { telegram: null };

    const { settings } = await loadInHome(doc);
    for (const key of ['telegram', 'discord', 'slack']) {
        assert.ok(key in settings.messaging.latestSeen, 'latestSeen.' + key + ' must exist');
        assert.ok(key in settings.messaging.lastActive, 'lastActive.' + key + ' must exist');
    }
    assert.deepEqual(settings.messaging.enabledChannels, ['slack']);
});


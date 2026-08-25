// #444 / #445: v3 leftovers that quietly changed which gateways run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateSettings } from '../../src/core/config.ts';

// ─── #445: a malformed v4 enabled set must not become Telegram ───

test('GW-445a: a v4 document with a non-array enabled set keeps its channel', () => {
    // legacyChannel is always 'telegram' at v4 because the key it reads was
    // deleted during the v3 migration. Treating a malformed set as "no set yet"
    // therefore handed a Slack install a Telegram gateway.
    const migrated = migrateSettings({
        settingsSchemaVersion: 4,
        messaging: { enabledChannels: 'slack', homeChannel: 'slack' },
    } as never) as { messaging: { enabledChannels: string[]; homeChannel: string } };

    assert.deepEqual(migrated.messaging.enabledChannels, ['slack']);
    assert.equal(migrated.messaging.homeChannel, 'slack');
});

test('GW-445b: an unsalvageable v4 set still yields a usable gateway', () => {
    const migrated = migrateSettings({
        settingsSchemaVersion: 4,
        messaging: { enabledChannels: 'not-a-channel', homeChannel: 'telegram' },
    } as never) as { messaging: { enabledChannels: string[] } };

    assert.deepEqual(migrated.messaging.enabledChannels, ['telegram'],
        'a broken set must not leave the install with no inbound at all');
});

test('GW-445c: a genuine v3 document still migrates from the legacy scalar', () => {
    const migrated = migrateSettings({
        settingsSchemaVersion: 3,
        channel: 'discord',
    } as never) as { messaging: { enabledChannels: string[]; homeChannel: string } };

    assert.deepEqual(migrated.messaging.enabledChannels, ['discord']);
    assert.equal(migrated.messaging.homeChannel, 'discord');
});


// ─── #444: DISCORD_TOKEN auto-switch wrote to a deleted field ───

test('GW-444a: DISCORD_TOKEN alone makes Discord the home channel', async () => {
    // applyEnvOverrides runs AFTER migrateSettings deleted `channel`, so the old
    // assignment landed on a key nothing reads and the documented auto-switch
    // silently stopped happening.
    const { applyEnvOverrides } = await import('../../src/core/config.ts');
    const previous = process.env['DISCORD_TOKEN'];
    process.env['DISCORD_TOKEN'] = 'test-token';
    try {
        const s = {
            messaging: { enabledChannels: [], homeChannel: 'telegram' },
            telegram: { token: '', enabled: false },
            discord: {},
        } as Record<string, any>;
        applyEnvOverrides(s);

        assert.equal(s['messaging'].homeChannel, 'discord');
        assert.ok(s['messaging'].enabledChannels.includes('discord'),
            'the home channel must also be enabled or nothing listens');
    } finally {
        if (previous === undefined) delete process.env['DISCORD_TOKEN'];
        else process.env['DISCORD_TOKEN'] = previous;
    }
});

test('GW-444b: a configured Telegram keeps the home channel', async () => {
    const { applyEnvOverrides } = await import('../../src/core/config.ts');
    const previous = process.env['DISCORD_TOKEN'];
    process.env['DISCORD_TOKEN'] = 'test-token';
    try {
        const s = {
            messaging: { enabledChannels: ['telegram'], homeChannel: 'telegram' },
            telegram: { token: 'tg-token', enabled: true },
            discord: {},
        } as Record<string, any>;
        applyEnvOverrides(s);

        assert.equal(s['messaging'].homeChannel, 'telegram',
            'adding a Discord token must not steal an established home');
    } finally {
        if (previous === undefined) delete process.env['DISCORD_TOKEN'];
        else process.env['DISCORD_TOKEN'] = previous;
    }
});


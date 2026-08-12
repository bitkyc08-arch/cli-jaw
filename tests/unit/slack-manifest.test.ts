import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';

import {
    SLACK_APP_MANIFEST,
    createSlackAppManifest,
    slackManifestJson,
    slackManifestYaml,
} from '../../src/slack/manifest.js';

// The manifest is the single source of truth the runbook displays; these
// pins exist so a scope/event edit here can never silently desync from what
// the transport actually calls.

// Every Slack Web API method the transport calls (src/slack/*.ts), mapped to
// the bot scope that authorizes it. auth.test needs no scope;
// apps.connections.open is authorized by the APP-LEVEL token (connections:write),
// not a bot scope.
const METHOD_SCOPE_MAP: Record<string, string | null> = {
    'chat.postMessage': 'chat:write',
    'conversations.open': 'im:write',
    'files.info': 'files:read',
    'files.getUploadURLExternal': 'files:write',
    'files.completeUploadExternal': 'files:write',
    'auth.test': null,
    'apps.connections.open': null,
};

// Every envelope type the socket layer routes (HANDLED_ENVELOPE_TYPES in
// src/slack/socket.ts) and the manifest feature that feeds it.
const REQUIRED_BOT_EVENTS = ['app_mention', 'message.channels', 'message.groups', 'message.im'];

test('manifest grants the scope behind every Web API method the transport calls', () => {
    const scopes: readonly string[] = SLACK_APP_MANIFEST.oauth_config.scopes.bot;
    for (const [method, scope] of Object.entries(METHOD_SCOPE_MAP)) {
        if (scope === null) continue;
        assert.ok(scopes.includes(scope), `${method} needs ${scope} but the manifest lacks it`);
    }
});

test('manifest subscribes to every bot event the inbound path consumes', () => {
    const events: readonly string[] = SLACK_APP_MANIFEST.settings.event_subscriptions.bot_events;
    for (const ev of REQUIRED_BOT_EVENTS) {
        assert.ok(events.includes(ev), `missing bot event ${ev}`);
    }
    // message.im is the one that silently kills DMs when forgotten — pin it
    // explicitly with its reason so a "cleanup" cannot remove it unnoticed.
    assert.ok(events.includes('message.im'), 'DMs die silently without message.im (app_mention does NOT cover DMs)');
});

test('socket mode and the DM composer surface stay enabled', () => {
    assert.equal(SLACK_APP_MANIFEST.settings.socket_mode_enabled, true);
    assert.equal(SLACK_APP_MANIFEST.features.app_home.messages_tab_enabled, true);
});

test('slash command starter set exists in the shared catalog shape', () => {
    const commands = SLACK_APP_MANIFEST.features.slash_commands.map(c => c.command);
    for (const cmd of ['/model', '/cli', '/clear', '/help']) {
        assert.ok(commands.includes(cmd), `starter slash command ${cmd} missing`);
    }
    assert.ok(!commands.includes('/status'), 'Slack reserves /status, so the generated manifest must omit it');
    // Socket Mode delivers the payload directly; escaping would double it.
    for (const c of SLACK_APP_MANIFEST.features.slash_commands) {
        assert.equal(c.should_escape, false);
        if ('usage_hint' in c) assert.notEqual(c.usage_hint, '', `${c.command} must omit an empty usage_hint`);
    }
});

test('custom app name is preserved while the bot display name is derived', () => {
    const cases = [
        ['Demo', 'Demo', 'demo'],
        ['demo app', 'demo app', 'demo-app'],
        ['데모', '데모', 'cli-jaw'],
        [' .__Demo   App--. ', '.__Demo   App--.', 'demo-app'],
        ['!!!', '!!!', 'cli-jaw'],
    ] as const;
    for (const [input, appName, botName] of cases) {
        const manifest = createSlackAppManifest(input);
        assert.equal(manifest.display_information.name, appName);
        assert.equal(manifest.features.bot_user.display_name, botName);
    }
});

test('legacy lowercase slug names keep identical app and bot output', () => {
    for (const value of ['cli-jaw', 'demo', 'demo-app', 'demo_app', 'demo.app', '...']) {
        const manifest = createSlackAppManifest(value);
        assert.equal(manifest.display_information.name, value);
        assert.equal(manifest.features.bot_user.display_name, value);
    }
});

test('app name validation enforces only the Slack app name length contract', () => {
    for (const value of ['', '   ', 'x'.repeat(36), '데'.repeat(36)]) {
        assert.throws(() => createSlackAppManifest(value), /Slack app name/);
    }
    for (const value of ['bad\nname', 'demo app', 'Demo', '데모']) {
        assert.doesNotThrow(() => createSlackAppManifest(value));
    }
});

test('unicode lowercase expansion stays within the Slack bot display-name limit', () => {
    const input = 'İ'.repeat(35);
    const manifest = createSlackAppManifest(input);
    const botName = manifest.features.bot_user.display_name;
    assert.equal(Array.from(manifest.display_information.name).length, 35);
    assert.equal(Array.from(botName).length, 69);
    assert.ok(Array.from(botName).length <= 80);
});

test('JSON output preserves the app name and serialized derived bot name', () => {
    const manifest = createSlackAppManifest('demo app');
    const parsed = JSON.parse(slackManifestJson('demo app'));
    assert.deepEqual(parsed, manifest);
    assert.equal(parsed.features.bot_user.display_name, 'demo-app');
});

test('YAML output round-trips to the same manifest', () => {
    const parsed = parse(slackManifestYaml());
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(SLACK_APP_MANIFEST)));
});

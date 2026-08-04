import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';

import { SLACK_APP_MANIFEST, slackManifestYaml } from '../../src/slack/manifest.js';

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
    for (const cmd of ['/status', '/model', '/cli', '/clear', '/help']) {
        assert.ok(commands.includes(cmd), `starter slash command ${cmd} missing`);
    }
    // Socket Mode delivers the payload directly; escaping would double it.
    for (const c of SLACK_APP_MANIFEST.features.slash_commands) {
        assert.equal(c.should_escape, false);
    }
});

test('YAML output round-trips to the same manifest', () => {
    const parsed = parse(slackManifestYaml());
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(SLACK_APP_MANIFEST)));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { settings } from '../../src/core/config.js';
import { dispatchApprovalStore } from '../../src/core/dispatch-approval.js';
import { createTestTransport } from '../../src/core/dispatch-approval-ingress.js';
import { handleDiscordMessage } from '../../src/discord/bot.js';

function pending() { return dispatchApprovalStore.create({ target: { kind: 'agent', name: 'A' }, projectRoot: '/r', task: 't', mutable: false, scope: null, fanOutCap: 1 }); }
function message(id: string, text: string, bot = false): any { return { id: `m-${Math.random()}`, author: { id, bot }, content: text, channelId: 'dm', attachments: { size: 0 }, guild: null }; }
test('Discord gateway handler accepts only allowlisted non-self human on trusted transport', async () => {
    settings['dispatchApproval'] = { operators: { slack: [], telegram: [], discord: ['D1'] }, ttlSeconds: 120 };
    settings['discord'] = { ...settings['discord'], channelIds: [], mentionOnly: false };
    const transport = createTestTransport('discord'); const client = { user: { id: 'BOT' } } as any;
    let row = pending(); await handleDiscordMessage(client, message('D1', `approve ${row.jti} ${row.digest}`), transport); assert.equal(dispatchApprovalStore.get(row.jti)?.status, 'approved');
    for (const msg of [message('D1', '', true), message('D2', ''), message('BOT', '')]) { row = pending(); msg.content = `approve ${row.jti} ${row.digest}`; await handleDiscordMessage(client, msg, transport); assert.equal(dispatchApprovalStore.get(row.jti)?.status, 'pending'); }
    row = pending(); await handleDiscordMessage(client, message('D1', `approve ${row.jti} ${row.digest}`), null); assert.equal(dispatchApprovalStore.get(row.jti)?.status, 'pending');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { settings } from '../../src/core/config.js';
import { dispatchApprovalStore } from '../../src/core/dispatch-approval.js';
import { createTestTransport } from '../../src/core/dispatch-approval-ingress.js';
import { handleTelegramUpdate, setTelegramBotUserIdForTest } from '../../src/telegram/bot.js';

function pending() { return dispatchApprovalStore.create({ target: { kind: 'agent', name: 'A' }, projectRoot: '/r', task: 't', mutable: false, scope: null, fanOutCap: 1 }); }
test('Telegram polling handler accepts only allowlisted human on trusted transport', () => {
    settings['dispatchApproval'] = { operators: { slack: [], telegram: [42], discord: [] }, ttlSeconds: 120 };
    const transport = createTestTransport('telegram');
    let row = pending(); assert.equal(handleTelegramUpdate({ message: { from: { id: 42, is_bot: false }, text: `approve ${row.jti} ${row.digest}` } }, transport), true); assert.equal(dispatchApprovalStore.get(row.jti)?.status, 'approved');
    for (const from of [{ id: 42, is_bot: true }, { id: 7, is_bot: false }]) { row = pending(); handleTelegramUpdate({ message: { from, text: `approve ${row.jti} ${row.digest}` } }, transport); assert.equal(dispatchApprovalStore.get(row.jti)?.status, 'pending'); }
    setTelegramBotUserIdForTest(99); row = pending(); handleTelegramUpdate({ message: { from: { id: 99, is_bot: false }, text: `approve ${row.jti} ${row.digest}` } }, transport); assert.equal(dispatchApprovalStore.get(row.jti)?.status, 'pending'); setTelegramBotUserIdForTest(null);
    row = pending(); handleTelegramUpdate({ message: { from: { id: 42 }, text: `approve ${row.jti} ${row.digest}` } }, null); assert.equal(dispatchApprovalStore.get(row.jti)?.status, 'pending');
});

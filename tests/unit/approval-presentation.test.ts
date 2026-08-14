import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchApprovalStore } from '../../src/core/dispatch-approval.ts';
import { parseApprovalCallbackData, presentTelegramApproval, presentDiscordApproval, presentSlackApproval } from '../../src/messaging/approval-presentation.ts';

test('telegram keyboard callback_data is opaque and under 64 bytes', () => {
    const row = dispatchApprovalStore.create({
        target: { kind: 'agent', name: 'A' }, projectRoot: '/r', task: 't',
        mutable: false, scope: null, fanOutCap: 1,
    });
    const presented = presentTelegramApproval(row, { actorId: '42', conversationKey: '42' }, 'please approve');
    assert.equal(presented.text, 'please approve');
    const rowButtons = presented.telegramKeyboard?.inline_keyboard[0];
    assert.equal(rowButtons?.length, 2);
    const approve = parseApprovalCallbackData(rowButtons![0]!.callback_data);
    const deny = parseApprovalCallbackData(rowButtons![1]!.callback_data);
    assert.equal(approve?.action, 'approve');
    assert.equal(deny?.action, 'deny');
    assert.ok(rowButtons![0]!.callback_data.length <= 64);
    assert.ok(rowButtons![1]!.callback_data.length <= 64);
    assert.doesNotMatch(rowButtons![0]!.callback_data, new RegExp(row.jti));
    assert.doesNotMatch(rowButtons![0]!.callback_data, new RegExp(row.digest));
    assert.equal(parseApprovalCallbackData('elic:0:1'), null);
});

test('discord components use the same opaque custom_id prefix', () => {
    const row = dispatchApprovalStore.create({
        target: { kind: 'agent', name: 'A' }, projectRoot: '/r', task: 't2',
        mutable: false, scope: null, fanOutCap: 1,
    });
    const presented = presentDiscordApproval(row, { actorId: 'USER9', conversationKey: 'USER9' }, 'please approve');
    const buttons = presented.discordComponents?.[0]?.components;
    assert.equal(buttons?.length, 2);
    assert.equal(parseApprovalCallbackData(buttons![0]!.custom_id)?.action, 'approve');
    assert.equal(parseApprovalCallbackData(buttons![1]!.custom_id)?.action, 'deny');
    assert.ok(buttons![0]!.custom_id.length <= 100);
    assert.doesNotMatch(buttons![0]!.custom_id, new RegExp(row.jti));
});

test('slack blocks use the same opaque action_id prefix', () => {
    const row = dispatchApprovalStore.create({
        target: { kind: 'agent', name: 'A' }, projectRoot: '/r', task: 't3',
        mutable: false, scope: null, fanOutCap: 1,
    });
    const presented = presentSlackApproval(row, { actorId: 'U1', conversationKey: 'U1' }, 'please approve');
    const buttons = presented.slackBlocks?.[0]?.elements;
    assert.equal(buttons?.length, 2);
    assert.equal(parseApprovalCallbackData(buttons![0]!.action_id)?.action, 'approve');
    assert.equal(parseApprovalCallbackData(buttons![1]!.action_id)?.action, 'deny');
    assert.doesNotMatch(buttons![0]!.action_id, new RegExp(row.jti));
});

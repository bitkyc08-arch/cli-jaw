import test from 'node:test';
import assert from 'node:assert/strict';
import { settings } from '../../src/core/config.js';
import { dispatchApprovalStore } from '../../src/core/dispatch-approval.js';
import { createTestTransport } from '../../src/core/dispatch-approval-ingress.js';
import { handleSlackEnvelope, setSlackSelfUserIdForTest } from '../../src/slack/bot.js';

function pending() { return dispatchApprovalStore.create({ target: { kind: 'agent', name: 'A' }, projectRoot: '/r', task: 't', mutable: false, scope: null, fanOutCap: 1 }); }
test('Slack socket envelope accepts only allowlisted human on trusted transport', async () => {
    settings['dispatchApproval'] = { operators: { slack: ['U1'], telegram: [], discord: [] }, ttlSeconds: 120 };
    const transport = createTestTransport('slack');
    let row = pending();
    const envelope = (user: string, text: string, extra = {}) => ({ type: 'events_api', payload: { event: { type: 'message', channel: 'D1', user, text, ...extra } } }) as any;
    await handleSlackEnvelope(envelope('U1', `approve ${row.jti} ${row.digest}`), transport); assert.equal(dispatchApprovalStore.get(row.jti)?.status, 'approved');
    row = pending(); await handleSlackEnvelope(envelope('U1', `approve ${row.jti} ${row.digest}`, { bot_id: 'B1' }), transport); assert.equal(dispatchApprovalStore.get(row.jti)?.status, 'pending');
    setSlackSelfUserIdForTest('SELF'); row = pending(); await handleSlackEnvelope(envelope('SELF', `approve ${row.jti} ${row.digest}`), transport); assert.equal(dispatchApprovalStore.get(row.jti)?.status, 'pending'); setSlackSelfUserIdForTest(null);
    row = pending(); await handleSlackEnvelope(envelope('U2', `approve ${row.jti} ${row.digest}`), transport); assert.equal(dispatchApprovalStore.get(row.jti)?.status, 'pending');
    row = pending(); await handleSlackEnvelope(envelope('U1', `approve ${row.jti} ${row.digest}`), null); assert.equal(dispatchApprovalStore.get(row.jti)?.status, 'pending');
});

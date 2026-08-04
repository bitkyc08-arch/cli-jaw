import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildRemoteBindingKey,
    buildRemoteSessionKey,
    groupQueueKey,
} from '../../src/messaging/session-key.ts';
import { slackTargetFromId } from '../../src/messaging/slack-target.ts';

test('Slack binding keys follow the canonical grammar', () => {
    assert.equal(buildRemoteBindingKey(slackTargetFromId('C1')), 'jaw:slack:channel:C1');
    assert.equal(buildRemoteBindingKey(slackTargetFromId('D1')), 'jaw:slack:direct:D1');
    assert.equal(
        buildRemoteBindingKey(slackTargetFromId('C1', { threadTs: '171.2' })),
        'jaw:slack:channel:C1:thread:171.2',
    );
});

test('binding key components are URI encoded without changing legacy queue keys', () => {
    const target = slackTargetFromId('C1', { threadTs: 'thread/value with space' });
    assert.equal(
        buildRemoteBindingKey(target),
        'jaw:slack:channel:C1:thread:thread%2Fvalue%20with%20space',
    );
    assert.equal(buildRemoteSessionKey(target), 'slack:channel:channel:C1:thread:thread/value with space');
    assert.equal(groupQueueKey('slack', target), 'slack:slack:channel:channel:C1:thread:thread/value with space');
});

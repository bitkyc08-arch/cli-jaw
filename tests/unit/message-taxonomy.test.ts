import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyMessageDisplayRole } from '../../public/js/features/message-taxonomy.ts';

test('message taxonomy keeps human channel ingress as user messages', () => {
    for (const source of ['web', 'telegram', 'discord', 'cli']) {
        assert.equal(classifyMessageDisplayRole({ role: 'user', source }), 'user', source);
    }
});

test('message taxonomy renders automated sources as system rows', () => {
    for (const source of ['bgtask', 'goal', 'system']) {
        assert.equal(classifyMessageDisplayRole({ role: 'user', source }), 'system', source);
    }
});

test('message taxonomy uses durable cli metadata during history hydration', () => {
    assert.equal(classifyMessageDisplayRole({ role: 'user', cli: 'bgtask' }), 'system');
    assert.equal(classifyMessageDisplayRole({ role: 'user', cli: 'goal_continuation' }), 'system');
    assert.equal(classifyMessageDisplayRole({ role: 'user', cli: 'telegram' }), 'user');
    assert.equal(classifyMessageDisplayRole({ role: 'user', cli: 'discord' }), 'user');
});

test('message taxonomy honors structured kind and role fields', () => {
    assert.equal(classifyMessageDisplayRole({ role: 'system' }), 'system');
    assert.equal(classifyMessageDisplayRole({ role: 'user', kind: 'system_notice' }), 'system');
    assert.equal(classifyMessageDisplayRole({ role: 'user', kind: 'notification' }), 'system');
    assert.equal(classifyMessageDisplayRole({ role: 'assistant', source: 'bgtask' }), 'agent');
});

test('queue and external transport flags do not change user identity', () => {
    assert.equal(classifyMessageDisplayRole({ role: 'user', source: 'telegram', fromQueue: true }), 'user');
    assert.equal(classifyMessageDisplayRole({ role: 'user', source: 'discord', external: true }), 'user');
});

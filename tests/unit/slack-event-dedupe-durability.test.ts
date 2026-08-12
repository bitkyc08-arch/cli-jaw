// #321: "already handled" lived in process memory while "still to handle" lived
// in SQLite, so a reconnect before Slack observed our ACK could admit the same
// delivery twice under the next lifecycle.
//
// The ordering is the delicate part. Committing at reservation time would have
// turned a recoverable redelivery into a ten-minute silent loss, because the
// socket ACKs before any work and several early returns sit between the
// reservation and admission. So: reserve in memory, commit durably only after a
// run is accepted.
import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    claimSlackEvent,
    clearSlackEventDedupForTest,
    commitSlackEvent,
    currentIngressGeneration,
    isIngressGenerationCurrent,
    resetSlackEventDedup,
    slackEventKey,
} from '../../src/slack/ingress.ts';

function freshKey(suffix: string): string {
    return slackEventKey('T_TEST', 'C_TEST', `${Date.now()}.${suffix}`);
}

test('SED-001: a second delivery of the same event is dropped', () => {
    clearSlackEventDedupForTest();
    const key = freshKey('001');
    assert.equal(claimSlackEvent(key), false, 'first delivery is admitted');
    assert.equal(claimSlackEvent(key), true, 'second delivery is dropped');
});

test('SED-002: a committed event stays dropped after the runtime resets', () => {
    // This is the bug. resetSlackEventDedup() clears the in-memory
    // reservations, which is what a runtime restart effectively does.
    clearSlackEventDedupForTest();
    const key = freshKey('002');
    assert.equal(claimSlackEvent(key), false);
    commitSlackEvent(key);

    resetSlackEventDedup();

    assert.equal(claimSlackEvent(key), true,
        'a run that was already admitted must not be admitted again after a restart');
});

test('SED-003: an event that never reached admission is redeliverable', () => {
    // The counterpart guarantee, and the reason commit is not at reserve time:
    // if we died before admitting, Slack redelivery has to still work or the
    // message is silently lost.
    clearSlackEventDedupForTest();
    const key = freshKey('003');
    assert.equal(claimSlackEvent(key), false);
    // No commitSlackEvent — the handler died between reservation and admission.
    resetSlackEventDedup();

    assert.equal(claimSlackEvent(key), false,
        'an uncommitted event must be admitted again rather than lost');
});

test('SED-004: distinct team/channel/ts never collide', () => {
    clearSlackEventDedupForTest();
    const base = Date.now();
    const a = slackEventKey('T1', 'C1', `${base}.1`);
    const b = slackEventKey('T2', 'C1', `${base}.1`);
    const c = slackEventKey('T1', 'C2', `${base}.1`);
    const d = slackEventKey('T1', 'C1', `${base}.2`);
    for (const key of [a, b, c, d]) {
        assert.equal(claimSlackEvent(key), false, `${key} must be independent`);
        commitSlackEvent(key);
    }
    for (const key of [a, b, c, d]) {
        assert.equal(claimSlackEvent(key), true);
    }
});

test('SED-005: the generation guard invalidates a delivery that outlived a reset', () => {
    // Reserve, reset (a redelivery re-reserves under the new generation), then
    // the original handler wakes up. Its captured generation is stale, so it
    // must not admit — otherwise both copies run.
    const captured = currentIngressGeneration();
    assert.equal(isIngressGenerationCurrent(captured), true, 'same generation is still valid');
    assert.equal(isIngressGenerationCurrent(captured - 1), false, 'a dead generation is not');
});

test('SED-006: commit is idempotent', () => {
    clearSlackEventDedupForTest();
    const key = freshKey('006');
    claimSlackEvent(key);
    commitSlackEvent(key);
    assert.doesNotThrow(() => commitSlackEvent(key), 'a repeated commit must not throw');
    resetSlackEventDedup();
    assert.equal(claimSlackEvent(key), true);
});

test('SED-007: reserving never throws, so a broken store cannot stop inbound messages', () => {
    clearSlackEventDedupForTest();
    assert.doesNotThrow(() => claimSlackEvent(freshKey('007')));
});

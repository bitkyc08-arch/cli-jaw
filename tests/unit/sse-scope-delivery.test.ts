import test from 'node:test';
import assert from 'node:assert/strict';
import { isInstanceWideEvent, shouldDeliverToScope } from '../../src/core/event-scope.ts';
import type { BusEvent } from '../../src/core/event-bus.ts';

// 072 §1.3a — a tab bound to one session must receive everything that session owns and
// nothing another session owns, while instance-wide events keep reaching every tab.

function entry(event: string, scope?: string, extra: Record<string, unknown> = {}): BusEvent {
    return {
        id: 1,
        topic: 'agent',
        event,
        data: scope === undefined ? { ...extra } : { scope, ...extra },
        ts: 0,
    };
}

test('an unscoped connection still receives everything', () => {
    // manager and worker connections depend on this.
    assert.equal(shouldDeliverToScope(entry('agent_output', 'local:a'), undefined), true);
    assert.equal(shouldDeliverToScope(entry('agent_output'), undefined), true);
    assert.equal(shouldDeliverToScope(entry('session_list'), undefined), true);
});

test('a scoped connection receives its own session events and not another session', () => {
    for (const event of ['agent_output', 'agent_tool', 'agent_done', 'agent_status', 'new_message', 'queue_update', 'orc_state', 'session_reset', 'clear', 'widget_updated']) {
        assert.equal(shouldDeliverToScope(entry(event, 'local:a'), 'local:a'), true, `${event} must reach its own tab`);
        assert.equal(shouldDeliverToScope(entry(event, 'local:b'), 'local:a'), false, `${event} must not leak from another session`);
    }
});

test('a session event that carries no scope does not leak into a scoped tab', () => {
    assert.equal(shouldDeliverToScope(entry('agent_output'), 'local:a'), false);
});

test('the default session is a scope like any other', () => {
    assert.equal(shouldDeliverToScope(entry('agent_output', 'default'), 'default'), true);
    assert.equal(shouldDeliverToScope(entry('agent_output', 'local:a'), 'default'), false);
    assert.equal(shouldDeliverToScope(entry('agent_output', 'default'), 'local:a'), false);
});

// broadcast() stamps the ambient session scope onto every event published inside a
// session's async context (core/bus.ts). Instance-wide events published during a turn
// therefore arrive carrying that session's scope, and a strict-equality filter alone
// would delete them from every other tab.
test('instance-wide events reach every tab even when a session stamped its scope on them', () => {
    for (const event of ['session_created', 'session_list', 'settings_change', 'memory_status', 'heartbeat_pending', 'bgtask_update', 'alert_escalation', 'agent_added', 'agent_updated', 'agent_deleted', 'schedule_wakeup']) {
        assert.equal(shouldDeliverToScope(entry(event, 'local:b'), 'local:a'), true, `${event} is instance-wide`);
    }
});

// A global switch is published outside any session context and so carries no scope at
// all. Without an explicit rule the strict filter deletes it from every scoped tab and
// each one keeps showing a stale idea of which session is active.
test('a session switch reaches every tab even though it carries no scope', () => {
    assert.equal(shouldDeliverToScope(entry('session_switched'), 'local:a'), true);
    assert.equal(shouldDeliverToScope(entry('session_switched', 'local:b'), 'local:a'), true);
});

// system_notice is a mixed type: some notices are about one session's turn and some
// about the instance. Classifying the whole type either way is wrong in one direction.
test('a system notice is routed by its code, not by its type', () => {
    for (const code of ['compact_suggest', 'auto_compact_refresh']) {
        assert.equal(shouldDeliverToScope(entry('system_notice', 'local:a', { code }), 'local:a'), true, `${code} reaches its own tab`);
        assert.equal(shouldDeliverToScope(entry('system_notice', 'local:b', { code }), 'local:a'), false, `${code} must not leak`);
    }
    // Instance-wide notices, and anything unrecognised, reach every tab: an extra
    // notice is noise while a missing one is invisible.
    for (const code of ['cli_switch_refresh', 'something_new', undefined]) {
        assert.equal(
            shouldDeliverToScope(entry('system_notice', 'local:b', code === undefined ? {} : { code }), 'local:a'),
            true,
            `${String(code)} is treated as instance-wide`,
        );
    }
});

// Goal state is one instance-wide file with no session field (goal/store.ts). A goal
// finished in one tab has to clear the cockpit in every tab, or the others keep showing
// a goal that is already over.
test('every goal event is instance-wide', () => {
    for (const event of ['goal_done', 'goal_cancel', 'goal_pause_detected', 'goal_continuation', 'goal_continuation_failed', 'goal_continuation_limit', 'goal_done_rejected', 'goal_pause_gate_pending']) {
        assert.equal(isInstanceWideEvent(event), true, `${event} must be instance-wide`);
        assert.equal(shouldDeliverToScope(entry(event, 'local:b'), 'local:a'), true);
    }
});

test('agent events are not swept into the instance-wide set by a prefix accident', () => {
    for (const event of ['agent_output', 'agent_done', 'agent_status', 'agent_tool', 'agent_retry', 'agent_fallback', 'agent_smoke']) {
        assert.equal(isInstanceWideEvent(event), false, `${event} belongs to one session`);
    }
});

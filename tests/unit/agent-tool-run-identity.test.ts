import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { emitAgentTool } from '../../src/agent/events/helpers.ts';
import { mapAgentEventToBus } from '../../src/agent/jwc-event-mapper.ts';
import { addBroadcastListener, removeBroadcastListener } from '../../src/core/bus.ts';
import type { SpawnContext } from '../../src/types/agent.ts';

// #398: the Slack progress listener filtered on `origin !== 'slack'`, which every
// concurrent Slack run passes. Two channels running at once each received the
// other's agent_tool events, so one channel's command lines appeared in the other
// channel's progress message. The fix stamps the run's identity at emit time and
// filters on it; these tests pin both halves.

function collect(fn: () => void): Array<Record<string, unknown>> {
    const seen: Array<Record<string, unknown>> = [];
    const listener = (type: string, data: Record<string, unknown>) => {
        if (type === 'agent_tool') seen.push(data);
    };
    addBroadcastListener(listener);
    try { fn(); } finally { removeBroadcastListener(listener); }
    return seen;
}

function ctxWith(over: Partial<SpawnContext>): SpawnContext {
    return {
        fullText: '', traceLog: [], toolLog: [], seenToolKeys: new Set<string>(),
        hasClaudeStreamEvents: false, sessionId: null, cost: null, turns: null,
        duration: null, tokens: null, stderrBuf: '', runStartedAt: 1,
        ...over,
    } as SpawnContext;
}

test('AT-001: emitAgentTool stamps the run identity onto agent_tool', () => {
    const seen = collect(() => {
        emitAgentTool(
            ctxWith({ requestId: 'req-a', origin: 'slack' }),
            'agent-1',
            { icon: '🔧', label: 'bash', toolType: 'bash', detail: 'ls /secret/path' },
            {},
        );
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!['requestId'], 'req-a');
    assert.equal(seen[0]!['origin'], 'slack');
});

test('AT-002: the jwc mapper stamps the same fields', () => {
    const seen = collect(() => {
        mapAgentEventToBus(
            { type: 'tool_execution_start', id: 't1', name: 'bash', args: { command: 'ls' } } as never,
            { cwd: '/tmp', sessionId: 'engine-session', requestId: 'req-b', origin: 'slack' },
        );
    });

    assert.ok(seen.length >= 1);
    assert.equal(seen[0]!['requestId'], 'req-b');
    assert.equal(seen[0]!['origin'], 'slack');
    // The engine session is NOT the request: keeping them distinct is the point.
    assert.equal(seen[0]!['sessionId'], 'engine-session');
});

// The listener shape used by src/slack/bot.ts, asserted directly: the module itself
// needs a live socket to construct, so the rule it applies is what gets pinned here.
const progressFilter = (data: Record<string, unknown>, requestId: string) =>
    data['requestId'] === requestId;

test('AT-003: a run only accepts its own events', () => {
    const fromA = { requestId: 'req-a', origin: 'slack', label: 'bash', detail: 'cat /a/secret' };
    const fromB = { requestId: 'req-b', origin: 'slack', label: 'bash', detail: 'cat /b/secret' };

    assert.equal(progressFilter(fromA, 'req-a'), true);
    assert.equal(progressFilter(fromB, 'req-a'), false, 'the other channel must not see this');
    assert.equal(progressFilter(fromA, 'req-b'), false);
});

test('AT-004: an unattributed event is dropped rather than shown to everyone', () => {
    // Passing it through would restore the pre-fix behaviour exactly.
    assert.equal(progressFilter({ origin: 'slack', label: 'bash' }, 'req-a'), false);
});


import test from 'node:test';
import assert from 'node:assert/strict';
import { createTraceContext, getSessionTrace, summarizeTrace } from '../../src/browser/web-ai/action-trace.ts';
import { appendTraceToSession, redactSensitive } from '../../src/browser/web-ai/trace-persistence.ts';
import { __resetSessionState, createSession, getSession } from '../../src/browser/web-ai/session.ts';

test('trace context records bounded steps and summarizes resolution sources', () => {
    const trace = createTraceContext('session-a');
    trace.record({ action: 'click', status: 'ok', target: { resolution: 'cache' } });
    trace.record({ action: 'fill', status: 'error', target: { source: 'css-fallback' } });

    assert.equal(getSessionTrace(trace).length, 2);
    assert.deepEqual(summarizeTrace(trace), {
        sessionId: 'session-a',
        totalSteps: 2,
        resolutionSources: ['cache', 'css-fallback'],
        errorCount: 1,
        firstTs: trace.steps[0]?.ts,
        lastTs: trace.steps[1]?.ts,
    });
});

test('trace persistence redacts sensitive values before attaching to a session', () => {
    __resetSessionState();
    const session = createSession({
        vendor: 'chatgpt',
        targetId: 'target-a',
        url: 'https://chatgpt.com/',
        envelope: { vendor: 'chatgpt', prompt: 'hello', attachmentPolicy: 'inline-only' },
        assistantCount: 0,
        timeoutMs: 1000,
    });

    appendTraceToSession(session.sessionId, [{ token: 'Bearer abc.def.ghi', email: 'a@example.com' }]);
    const reloaded = getSession(session.sessionId) as typeof session & { trace?: Array<Record<string, string>> };

    assert.equal(redactSensitive('sk-proj-abcdefghijklmnopqrstuvwxyz'), '[REDACTED]');
    assert.equal(reloaded.trace?.[0]?.token, '[REDACTED]');
    assert.equal(reloaded.trace?.[0]?.email, '[REDACTED]');
});

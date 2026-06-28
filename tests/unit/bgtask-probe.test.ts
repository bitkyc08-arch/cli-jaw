// bgtask session-probe mode + web-ai preset — against the real (isolated-home)
// native web-ai session store.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSession, updateSessionStatus } from '../../src/browser/web-ai/session.ts';
import type { QuestionEnvelope } from '../../src/browser/web-ai/types.ts';
import { createTask, getTask } from '../../src/bgtask/registry.ts';
import { startTask, type BgTaskCapture } from '../../src/bgtask/runner.ts';
import { webAiPreset, standaloneSessionGuidance } from '../../src/bgtask/presets.ts';
import type { BgTaskSpec } from '../../src/bgtask/types.ts';

function makeWebAiSession(): string {
    const record = createSession({
        vendor: 'chatgpt',
        targetId: `target-${Date.now()}-${Math.random()}`,
        url: 'https://chatgpt.com/',
        envelope: { system: 's', user: { question: 'q' } } as unknown as QuestionEnvelope,
        assistantCount: 0,
        timeoutMs: 60_000,
    });
    return record.sessionId;
}

function probeSpec(sessionId: string): BgTaskSpec {
    return {
        completion: { type: 'session-status', sessionId },
        promptTemplate: 'web-ai {{taskId}} {{status}}: {{result}}',
        stallAfterMs: 100, // shrinks probe interval to its 250ms floor for tests
    };
}

function waitForTerminal(taskId: string, timeoutMs = 6000): Promise<string> {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const t = setInterval(() => {
            const row = getTask(taskId);
            if (row && row.status !== 'running') {
                clearInterval(t);
                resolve(row.status);
                return;
            }
            if (Date.now() - start > timeoutMs) {
                clearInterval(t);
                reject(new Error(`task ${taskId} still running`));
            }
        }, 50);
    });
}

test('probe completes when the native session reaches a terminal status', async () => {
    const sid = makeWebAiSession();
    const row = createTask({ kind: 'web-ai', spec: probeSpec(sid) });
    const fired: string[] = [];
    startTask(row, (id) => fired.push(id));

    // session still 'sent' — probe keeps running
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(getTask(row.id)?.status, 'running');

    updateSessionStatus(sid, 'complete');
    assert.equal(await waitForTerminal(row.id), 'complete');
    assert.deepEqual(fired, [row.id]);
    const cap = JSON.parse(getTask(row.id)?.result ?? '{}') as BgTaskCapture;
    assert.equal(cap.sessionStatus, 'complete');
});

test('probe fails when the session reaches error status', async () => {
    const sid = makeWebAiSession();
    const row = createTask({ kind: 'web-ai', spec: probeSpec(sid) });
    startTask(row, () => {});
    updateSessionStatus(sid, 'error');
    assert.equal(await waitForTerminal(row.id), 'failed');
    const cap = JSON.parse(getTask(row.id)?.result ?? '{}') as BgTaskCapture;
    assert.equal(cap.sessionStatus, 'error');
});

test('probe fails fast for a missing session', async () => {
    const row = createTask({ kind: 'web-ai', spec: probeSpec('does-not-exist') });
    startTask(row, () => {});
    assert.equal(await waitForTerminal(row.id), 'failed');
    const cap = JSON.parse(getTask(row.id)?.result ?? '{}') as BgTaskCapture;
    assert.match(cap.reason ?? '', /session not found/);
});

test('webAiPreset builds a probe spec with defaults and warns when no watcher is active', async () => {
    const sid = makeWebAiSession();
    const preset = await webAiPreset({ sessionId: sid });
    assert.equal(preset.kind, 'web-ai');
    assert.deepEqual(preset.spec.completion, { type: 'session-status', sessionId: sid });
    assert.deepEqual(preset.spec.resultExtractor, { type: 'session-answer' });
    assert.ok(preset.spec.promptTemplate.includes(sid));
    assert.ok(preset.spec.deadlineAt && Date.parse(preset.spec.deadlineAt) > Date.now());
    assert.equal(preset.warnings.length, 1);
    assert.match(preset.warnings[0]!, /no active native watcher/);
});

test('webAiPreset accepts prompt override, throws for unknown session, no warning when terminal', async () => {
    await assert.rejects(webAiPreset({ sessionId: 'nope' }), /session not found/);

    const sid = makeWebAiSession();
    updateSessionStatus(sid, 'complete');
    const preset = await webAiPreset({ sessionId: sid, prompt: 'custom {{result}}' });
    assert.equal(preset.spec.promptTemplate, 'custom {{result}}');
    assert.equal(preset.warnings.length, 0, 'terminal session needs no watcher warning');
});

test('standaloneSessionGuidance gives actionable agbrowse guidance', () => {
    const msg = standaloneSessionGuidance('sess-xyz');
    // keeps the legacy substring so /session not found/ matchers stay valid
    assert.match(msg, /session not found/);
    assert.match(msg, /sess-xyz/);
    assert.match(msg, /agbrowse/);
    assert.match(msg, /--cmd/);
    assert.match(msg, /\["agbrowse","web-ai","watch","sess-xyz"\]/);
});

test('webAiPreset rejects an unknown session WITH actionable agbrowse guidance', async () => {
    await assert.rejects(
        webAiPreset({ sessionId: 'standalone-123' }),
        (err: Error) => /session not found/.test(err.message)
            && /agbrowse/.test(err.message)
            && /--cmd/.test(err.message),
    );
});

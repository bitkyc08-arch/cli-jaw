import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AGY_BOOTSTRAP_PREFIX,
    buildAgyBootstrapEnvelope,
    applyAgyBootstrapAcceptanceFromTranscriptLine,
    transcriptContainsBootstrapSentinel,
} from '../../src/agent/agy-bootstrap.ts';
import type { SpawnContext } from '../../src/types/agent.ts';

type BootstrapCtx = Pick<SpawnContext,
    'agyBootstrapSentinel' |
    'agyBootstrapAccepted' |
    'agyBootstrapAcceptanceMode'
>;

function userInputLine(content: string, createdAt: string): string {
    return JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: createdAt,
        content,
    });
}

test('AGY-BS-001: same normalized AGY envelope input produces same hash', () => {
    const first = buildAgyBootstrapEnvelope({
        taskPrompt: '  do the task\r\n',
        operationalContext: ' follow rules ',
        historyBlock: ' old context ',
        workingDir: '/repo',
        sessionId: 'session-a',
    });
    const second = buildAgyBootstrapEnvelope({
        taskPrompt: 'do the task\n',
        operationalContext: 'follow rules',
        historyBlock: 'old context',
        workingDir: '/repo',
        sessionId: 'session-a',
    });

    assert.equal(first.hash, second.hash);
    assert.equal(first.sentinel, `${AGY_BOOTSTRAP_PREFIX}${first.hash}`);
    assert.ok(first.sentinel.startsWith(AGY_BOOTSTRAP_PREFIX));
});

test('AGY-BS-002: AGY envelope orders bootstrap, current task, operational context, then history', () => {
    const envelope = buildAgyBootstrapEnvelope({
        taskPrompt: 'current task',
        operationalContext: 'operational rules',
        historyBlock: '[Recent Context]\nold task',
        workingDir: '/repo',
        sessionId: null,
    });
    const bootstrapIdx = envelope.prompt.indexOf('[CLI-JAW AGY BOOTSTRAP]');
    const taskIdx = envelope.prompt.indexOf('[Current cli-jaw task]');
    const operationalIdx = envelope.prompt.indexOf('[Operational Context — cli-jaw Integration]');
    const historyIdx = envelope.prompt.indexOf('[Recent context / history]');

    assert.ok(bootstrapIdx >= 0);
    assert.ok(taskIdx > bootstrapIdx);
    assert.ok(operationalIdx > taskIdx);
    assert.ok(historyIdx > operationalIdx);
    assert.match(envelope.prompt, /session=fresh/);
});

test('AGY-BS-003: AGY bootstrap hash changes when session id changes', () => {
    const base = {
        taskPrompt: 'task',
        operationalContext: 'rules',
        historyBlock: 'history',
        workingDir: '/repo',
    };
    const first = buildAgyBootstrapEnvelope({ ...base, sessionId: 'session-a' });
    const second = buildAgyBootstrapEnvelope({ ...base, sessionId: 'session-b' });
    assert.notEqual(first.hash, second.hash);
});

test('AGY-BS-004: transcript sentinel matcher detects JSON USER_INPUT content', () => {
    const envelope = buildAgyBootstrapEnvelope({
        taskPrompt: 'task',
        workingDir: '/repo',
        sessionId: 'session-a',
    });
    const line = userInputLine(
        `<USER_REQUEST>\n${envelope.sentinel}\n</USER_REQUEST>`,
        '2026-06-27T00:00:01.000Z',
    );

    assert.equal(transcriptContainsBootstrapSentinel(line, envelope.sentinel), true);
    assert.equal(transcriptContainsBootstrapSentinel(line, `${AGY_BOOTSTRAP_PREFIX}missing`), false);
});

test('AGY-BS-005: stale transcript rows do not mark AGY bootstrap accepted', () => {
    const envelope = buildAgyBootstrapEnvelope({
        taskPrompt: 'task',
        workingDir: '/repo',
        sessionId: 'session-a',
    });
    const ctx: BootstrapCtx = {
        agyBootstrapSentinel: envelope.sentinel,
        agyBootstrapAccepted: false,
        agyBootstrapAcceptanceMode: 'pending',
    };
    applyAgyBootstrapAcceptanceFromTranscriptLine(
        ctx,
        userInputLine(envelope.sentinel, '2026-06-26T23:59:00.000Z'),
        Date.parse('2026-06-27T00:00:00.000Z'),
    );

    assert.equal(ctx.agyBootstrapAccepted, false);
    assert.equal(ctx.agyBootstrapAcceptanceMode, 'pending');
});

test('AGY-BS-006: fresh USER_INPUT distinguishes accepted vs missing AGY bootstrap', () => {
    const envelope = buildAgyBootstrapEnvelope({
        taskPrompt: 'task',
        workingDir: '/repo',
        sessionId: 'session-a',
    });
    const minCreatedAtMs = Date.parse('2026-06-27T00:00:00.000Z');
    const acceptedCtx: BootstrapCtx = {
        agyBootstrapSentinel: envelope.sentinel,
        agyBootstrapAccepted: false,
        agyBootstrapAcceptanceMode: 'pending',
    };
    applyAgyBootstrapAcceptanceFromTranscriptLine(
        acceptedCtx,
        userInputLine(`<USER_REQUEST>${envelope.sentinel}</USER_REQUEST>`, '2026-06-27T00:00:01.000Z'),
        minCreatedAtMs,
    );
    assert.equal(acceptedCtx.agyBootstrapAccepted, true);
    assert.equal(acceptedCtx.agyBootstrapAcceptanceMode, 'accepted');

    const missingCtx: BootstrapCtx = {
        agyBootstrapSentinel: envelope.sentinel,
        agyBootstrapAccepted: false,
        agyBootstrapAcceptanceMode: 'pending',
    };
    applyAgyBootstrapAcceptanceFromTranscriptLine(
        missingCtx,
        userInputLine('<USER_REQUEST>no sentinel here</USER_REQUEST>', '2026-06-27T00:00:01.000Z'),
        minCreatedAtMs,
    );
    assert.equal(missingCtx.agyBootstrapAccepted, false);
    assert.equal(missingCtx.agyBootstrapAcceptanceMode, 'missing');
});

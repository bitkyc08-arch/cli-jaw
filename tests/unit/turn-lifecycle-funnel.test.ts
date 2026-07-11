import test from 'node:test';
import assert from 'node:assert/strict';
import { readTurnSegments } from '../../src/core/turn-segments.ts';
import { db } from '../../src/core/db.ts';
import { subscribe } from '../../src/core/event-bus.ts';
import {
    appendAssistantRawText,
    emitAgentTool,
    finishTurnLifecycle,
} from '../../src/agent/events/helpers.ts';
import type { SpawnContext } from '../../src/types/agent.ts';

function fakeClaudeContext(): SpawnContext {
    return {
        fullText: '',
        traceLog: [],
        toolLog: [],
        seenToolKeys: new Set(),
        hasClaudeStreamEvents: true,
        sessionId: null,
        cost: null,
        turns: null,
        duration: null,
        tokens: null,
        stderrBuf: '',
        runtimeCli: 'claude',
        traceAudience: 'public',
    };
}

test('claude funnel durably appends lifecycle and segments in published turnSeq order', () => {
    const ctx = fakeClaudeContext();
    const published: Array<{ event: string; data: Record<string, unknown> }> = [];
    const unsubscribe = subscribe(entry => {
        if (entry.topic === 'agent' && entry.event.startsWith('turn_')) {
            published.push({ event: entry.event, data: entry.data });
        }
    });

    try {
        appendAssistantRawText(ctx, 'hello');
        emitAgentTool(ctx, 'main', {
            icon: 'thinking',
            label: 'considering',
            toolType: 'thinking',
            status: 'running',
        }, {});
        emitAgentTool(ctx, 'main', {
            icon: 'tool',
            label: 'Read',
            toolType: 'Read',
            status: 'running',
            traceRunId: 'tr_1234567890abcdef',
            traceSeq: 7,
        }, {});
        emitAgentTool(ctx, 'main', {
            icon: 'tool',
            label: 'Read',
            toolType: 'Read',
            status: 'done',
            traceRunId: 'tr_1234567890abcdef',
            traceSeq: 7,
        }, {});
        finishTurnLifecycle(ctx, 'done');
    } finally {
        unsubscribe();
    }

    const turnRecords = published.map(entry => entry.data);
    const turnId = String(turnRecords[0]?.['turnId'] || '');
    assert.ok(turnId.startsWith('turn_'));
    assert.equal(turnRecords.every(record => record['sessionId'] === 'default'), true);
    assert.equal(turnRecords.every(record => Number.isSafeInteger(record['createdAt'])), true);
    assert.equal(turnRecords.every(record => Number.isSafeInteger(record['observedAt'])), true);
    assert.equal(turnRecords[0]?.['fidelity'], 'full');
    assert.deepEqual(published.map(entry => entry.event), [
        'turn_start',
        'turn_segment',
        'turn_segment',
        'turn_segment',
        'turn_segment',
        'turn_end',
    ]);
    assert.deepEqual(turnRecords.map(record => record['turnSeq']), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(turnRecords.map(record => record['type']), [
        'turn_start',
        'assistant_text',
        'thinking',
        'tool',
        'tool',
        'turn_end',
    ]);
    assert.deepEqual(turnRecords.map(record => record['status']), [
        'running',
        'running',
        'running',
        'running',
        'done',
        'done',
    ]);
    assert.deepEqual(readTurnSegments(turnId), turnRecords);
    db.prepare('DELETE FROM turn_segments WHERE turn_id = ?').run(turnId);
});

test('lifecycle handler closes the turn from finally without changing agent status events', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../src/agent/lifecycle-handler.ts', import.meta.url), 'utf8');
    assert.match(source, /finally\s*{\s*finishTurnLifecycle\(/);
    assert.match(source, /getTurnId\(ctx, 'public'\)/);
    assert.match(source, /broadcast\('agent_status', \{\s*status:/);
    assert.equal(source.match(/turnStatus = 'continued';/g)?.length, 8);
});

test('spawn error callbacks close their initialized turn', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../src/agent/spawn.ts', import.meta.url), 'utf8');
    assert.equal(
        source.match(/finishTurnLifecycle\(ctx, 'error', traceAudience\);/g)?.length,
        3,
    );
});

test('durable append failure publishes a structured system warning', () => {
    const ctx = fakeClaudeContext();
    const warnings: Record<string, unknown>[] = [];
    const unsubscribe = subscribe(entry => {
        if (entry.topic === 'system' && entry.event === 'turn_segment_error') warnings.push(entry.data);
    });
    db.exec(`
        CREATE TEMP TRIGGER fail_turn_segment_insert
        BEFORE INSERT ON turn_segments
        BEGIN
            SELECT RAISE(FAIL, 'forced turn append failure');
        END
    `);

    try {
        appendAssistantRawText(ctx, 'failure probe');
    } finally {
        db.exec('DROP TRIGGER fail_turn_segment_insert');
        unsubscribe();
    }

    assert.equal(warnings.length, 2);
    assert.equal(warnings[0]?.['turnSeq'], 1);
    assert.equal(warnings[0]?.['type'], 'turn_start');
    assert.match(String(warnings[0]?.['error']), /forced turn append failure/);
});

test('server prunes orphan turn segments on boot and the trace retention interval', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../server.ts', import.meta.url), 'utf8');
    assert.match(source, /import \{ pruneTurnSegments \} from '\.\/src\/core\/turn-segments\.js';/);
    assert.equal(source.match(/pruneTurnSegments\(traceRetentionDays\);/g)?.length, 2);
    const bootTurnPrune = source.indexOf('pruneTurnSegments(traceRetentionDays);');
    const bootTracePrune = source.indexOf('pruneTraceEvents(traceRetentionDays, traceMaxRows);');
    assert.ok(bootTurnPrune < bootTracePrune, 'orphan turn refs must be removed before trace retention runs');
});

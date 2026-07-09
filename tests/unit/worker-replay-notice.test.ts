import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { buildWorkerReplayNotice } from '../../src/orchestrator/worker-replay-notice.js';
import { readSource } from './source-normalize.js';

const projectRoot = join(import.meta.dirname, '../..');

// WP7 (260703): the notice now carries the FULL result up to 8000 chars
// (Claude Code task-notification model); longer results clip head+tail with
// the tail preserved (verdict lines live there).

test('replay notice injects the full result inline for bounded outputs', () => {
    const longText = `BEGIN-${'x'.repeat(1800)}-END`;
    const notice = buildWorkerReplayNotice({
        agentId: 'backend',
        runId: 'wr_notice_1',
        employeeName: 'Backend',
        taskPreview: 'verify a long-running implementation',
        text: longText,
        tools: [{ label: 'Read', status: 'done' }],
    });

    assert.ok(notice.includes('agent=backend'), 'notice must include agent id');
    assert.ok(notice.includes('run=wr_notice_1'), 'notice must include run id');
    assert.ok(notice.includes('cli-jaw worker read wr_notice_1 --tail 120'), 'notice must point to the full log');
    // Inverted from the pre-WP7 preview design: 1810 chars ≤ FULL_RESULT_MAX,
    // so the ENTIRE text — including the tail — must now be present.
    assert.ok(notice.includes('BEGIN-'), 'full injection must include the head');
    assert.ok(notice.includes('-END'), 'full injection must include the tail');
    assert.ok(notice.length <= 9800, 'notice must stay hard-bounded');
});

test('replay notice preserves multi-line formatting of the result', () => {
    const report = 'PASS\n\n1) imports resolve — src/a.ts:12\n2) signatures match\n\nVerdict: PASS';
    const notice = buildWorkerReplayNotice({
        agentId: 'backend', runId: 'wr_notice_2', text: report,
    });
    assert.ok(notice.includes('Result:\nPASS\n\n1) imports resolve'), 'newlines must survive (no previewText flattening)');
});

test('replay notice clips oversized results head+tail and keeps the verdict tail', () => {
    const longText = `HEAD-${'a'.repeat(12000)}-VERDICT: NEEDS_FIX`;
    const notice = buildWorkerReplayNotice({
        agentId: 'backend', runId: 'wr_notice_3', text: longText,
    });
    assert.ok(notice.includes('Result (clipped'), 'oversized result must be marked clipped');
    assert.ok(notice.includes('HEAD-'), 'clip must keep the head');
    assert.ok(notice.includes('VERDICT: NEEDS_FIX'), 'clip must keep the tail verdict');
    assert.ok(notice.match(/…\[\d+ chars omitted\]…/), 'clip must state the omitted length');
    assert.ok(notice.includes('cli-jaw worker status wr_notice_3'), 'clipped notice keeps status recovery');
    assert.ok(notice.length <= 9800, 'clipped notice must stay hard-bounded');
});

test('replay notice caps pathological name lengths without eating the tail', () => {
    const longText = `HEAD-${'b'.repeat(12000)}-TAIL-MARKER`;
    const notice = buildWorkerReplayNotice({
        agentId: 'x'.repeat(200),
        runId: 'wr_notice_4',
        employeeName: 'N'.repeat(200),
        taskPreview: 't'.repeat(500),
        text: longText,
    });
    assert.ok(notice.length <= 9800, 'hard bound holds under pathological names');
    assert.ok(notice.includes('TAIL-MARKER'), 'tail must survive even with long names (guard slice must not fire)');
});

test('replay notice handles empty results explicitly', () => {
    const notice = buildWorkerReplayNotice({ agentId: 'backend', runId: 'wr_notice_5', text: '   ' });
    assert.ok(notice.includes('Result: (empty result)'));
});

test('pipeline delayed replay uses the bounded notice builder', () => {
    const pipeline = readSource(join(projectRoot, 'src/orchestrator/pipeline.ts'));
    const drainStart = pipeline.indexOf('export async function drainPendingReplays');
    assert.ok(drainStart >= 0, 'drainPendingReplays must exist');
    const drainBlock = pipeline.slice(drainStart, drainStart + 1800);

    assert.ok(drainBlock.includes('buildWorkerReplayNotice(pr)'), 'delayed replay must use the notice builder');
    assert.equal(drainBlock.includes('\\n${pr.text}'), false, 'delayed replay must not bypass the builder with raw concatenation');
});

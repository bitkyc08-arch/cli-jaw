import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { buildWorkerReplayNotice } from '../../src/orchestrator/worker-replay-notice.js';
import { readSource } from './source-normalize.js';

const projectRoot = join(import.meta.dirname, '../..');

test('worker replay notice is bounded and points to runId recovery commands', () => {
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
    assert.ok(notice.includes('cli-jaw worker status wr_notice_1'), 'notice must include status recovery');
    assert.ok(notice.includes('cli-jaw worker read wr_notice_1 --tail 120'), 'notice must include output recovery');
    assert.ok(notice.length <= 1200, 'notice must be hard-bounded');
    assert.equal(notice.includes('END'), false, 'notice must not include the full long result tail');
});

test('pipeline delayed replay uses bounded notice instead of concatenating full worker text', () => {
    const pipeline = readSource(join(projectRoot, 'src/orchestrator/pipeline.ts'));
    const drainStart = pipeline.indexOf('export async function drainPendingReplays');
    assert.ok(drainStart >= 0, 'drainPendingReplays must exist');
    const drainBlock = pipeline.slice(drainStart, drainStart + 1800);

    assert.ok(drainBlock.includes('buildWorkerReplayNotice(pr)'), 'delayed replay must use bounded notice builder');
    assert.equal(drainBlock.includes('\\n${pr.text}'), false, 'delayed replay must not concatenate full worker text');
});

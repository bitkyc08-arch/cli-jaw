import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartbeatReport } from '../../src/memory/heartbeat-report.ts';

test('parses a trailing heartbeat report contract', () => {
    const report = parseHeartbeatReport('work log\nstatus: warning\nchanged: yes\nrecord_required: true\nuser_visible: 1\nsummary: needs attention\nevidence: e1\nnext_action: retry');
    assert.deepEqual({ ...report, raw: undefined }, {
        status: 'warning', changed: true, recordRequired: true, userVisible: true,
        summary: 'needs attention', evidence: 'e1', nextAction: 'retry', raw: undefined,
    });
});

test('missing report infers script failure and bounds scanned summary to 8KiB', () => {
    const report = parseHeartbeatReport('x'.repeat(9000), 3);
    assert.equal(report.status, 'failed');
    assert.equal(report.summary.length, 8192);
    assert.equal(report.raw.length, 9000);
});

test('missing report defaults quiet and ordinary output to ok', () => {
    assert.equal(parseHeartbeatReport('[SILENT]').status, 'ok');
    assert.equal(parseHeartbeatReport('ordinary').status, 'ok');
});

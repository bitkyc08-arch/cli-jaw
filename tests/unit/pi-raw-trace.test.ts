import test from 'node:test';
import assert from 'node:assert/strict';
import { PiRawTrace, PI_RAW_TRACE_BYTES, PI_RAW_RECORD_BYTES, PI_RAW_RECORDS } from '../../src/agent/runtime/pi-raw-trace.ts';
import type { TraceEventInput } from '../../src/trace/types.ts';

function harness() {
    const rows: TraceEventInput[] = [];
    let failures = 0;
    const trace = new PiRawTrace('owned-run', input => {
        rows.push(input);
        return { traceRunId: 'owned-run', traceSeq: rows.length, detailAvailable: true,
            detailBytes: Buffer.byteLength(String(input.raw)), rawRetentionStatus: 'available' };
    }, () => { failures++; });
    return { trace, rows, failures: () => failures };
}

test('repeated growing Pi snapshots retain linear deltas without mutating semantic input', () => {
    const h = harness();
    let wireBytes = 0;
    for (let i = 1; i <= 200; i++) {
        const snapshot = { content: [{ type: 'text', text: 'x'.repeat(i * 200) }] };
        const record = { type: 'message_update', message: snapshot,
            assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x'.repeat(200), partial: snapshot } };
        wireBytes += Buffer.byteLength(JSON.stringify(record));
        h.trace.record(record);
        assert.equal(record.message, snapshot);
        assert.equal(record.assistantMessageEvent.partial, snapshot);
    }
    assert.ok(wireBytes > PI_RAW_TRACE_BYTES);
    assert.equal(h.rows.length, 200);
    assert.ok(h.trace.diagnostics().bytes < 150_000);
    assert.equal(h.trace.diagnostics().limited, false);
    for (const row of h.rows) {
        const raw = JSON.parse(String(row.raw));
        assert.equal(raw.message, undefined);
        assert.equal(raw.assistantMessageEvent.partial, undefined);
        assert.equal(raw.assistantMessageEvent.delta.length, 200);
        assert.match(raw._jawRawRetention, /omitted/);
    }
});

test('oversized raw payload reserves bounded terminal metadata instead of degrading semantic projection', () => {
    const h = harness();
    h.trace.record({ type: 'tool_execution_update', partialResult: 'x'.repeat(PI_RAW_RECORD_BYTES) });
    for (let i = 0; i < 100; i++) {
        h.trace.record({ type: 'agent_end', messages: ['omitted-private'] });
        h.trace.record({ type: 'response', command: 'abort', id: i, success: true });
        h.trace.record({ type: 'error', message: 'omitted-private' });
    }
    assert.equal(h.rows.length, 4);
    assert.equal(h.failures(), 0, 'intentional raw omission is not a failed journal write');
    assert.equal(h.trace.diagnostics().limited, true);
    assert.ok(!JSON.stringify(h.rows).includes('omitted-private'));
    assert.ok(h.rows.every(row => row.source === 'system' && Buffer.byteLength(String(row.raw)) < 1024));
});

test('raw bytes and record counts are bounded independently, with fresh per-run budgets', () => {
    const byteBound = harness();
    for (let i = 0; i < 100; i++) byteBound.trace.record({ type: 'tool_execution_update', text: 'x'.repeat(60_000) });
    assert.ok(byteBound.trace.diagnostics().bytes <= PI_RAW_TRACE_BYTES);
    assert.equal(byteBound.trace.diagnostics().limited, true);
    const rowBound = harness();
    for (let i = 0; i < PI_RAW_RECORDS + 20; i++) rowBound.trace.record({ type: 'heartbeat' });
    assert.equal(rowBound.trace.diagnostics().records, PI_RAW_RECORDS);
    assert.equal(rowBound.rows.length, PI_RAW_RECORDS + 1);
    assert.equal(harness().trace.diagnostics().limited, false);
});

test('trace redaction precedes persisted payload and byte accounting', () => {
    const h = harness();
    h.trace.record({ type: 'tool_execution_start', args: { password: 'CANARY', token: 'CANARY' } });
    const serialized = String(h.rows[0]?.raw);
    assert.ok(!serialized.includes('CANARY'));
    assert.match(serialized, /REDACTED/);
    assert.equal(h.trace.diagnostics().bytes, Buffer.byteLength(serialized));
});

for (const mode of ['null', 'throw'] as const) {
    test('actual append ' + mode + ' notifies failure once and stops all raw writes', () => {
        let attempts = 0, failures = 0;
        const trace = new PiRawTrace('run', () => {
            attempts++;
            if (mode === 'throw') throw new Error('disk failed');
            return null;
        }, () => { failures++; throw new Error('observer failed'); });
        assert.doesNotThrow(() => {
            trace.record({ type: 'agent_start' });
            trace.record({ type: 'agent_end' });
            trace.record({ type: 'error' });
        });
        assert.equal(attempts, 1);
        assert.equal(failures, 1);
        assert.equal(trace.diagnostics().failed, true);
    });
}

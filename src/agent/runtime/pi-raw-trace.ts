import { stringifyTraceValue } from '../../trace/redact.js';
import type { TraceEventInput, TracePointer } from '../../trace/types.js';

export const PI_RAW_TRACE_BYTES = 4 * 1024 * 1024;
export const PI_RAW_RECORD_BYTES = 64 * 1024;
export const PI_RAW_RECORDS = 2048;
type Append = (input: TraceEventInput) => TracePointer | null;
const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

function thin(raw: unknown): unknown {
    const row = object(raw);
    if (row?.['type'] !== 'message_update') return raw;
    const { message: _message, ...rest } = row;
    const event = object(row['assistantMessageEvent']);
    if (event) {
        const { partial: _partial, ...delta } = event;
        rest['assistantMessageEvent'] = delta;
    }
    return { ...rest, _jawRawRetention: 'delta-only; repeated message snapshots omitted' };
}

export class PiRawTrace {
    private bytes = 0;
    private records = 0;
    private limited = false;
    private failed = false;
    private dropped = 0;
    private readonly controls = new Set<string>();

    constructor(private readonly runId: string, private readonly append: Append,
        private readonly onFailure: () => void) {}

    private write(eventType: string, serialized: string, source: 'cli_raw' | 'system'): boolean {
        if (this.failed) return false;
        try {
            if (this.append({ runId: this.runId, source, eventType, raw: serialized })) return true;
        } catch { /* Existing projection degradation owns failure notification. */ }
        this.failed = true;
        try { this.onFailure(); } catch { /* Observation cannot fail the turn. */ }
        return false;
    }

    private control(kind: string, fields: Record<string, unknown>): void {
        if (this.controls.has(kind) || this.controls.size >= 4 || this.failed) return;
        this.controls.add(kind);
        this.write('pi_rpc:' + kind, stringifyTraceValue(fields), 'system');
    }

    record(raw: unknown): void {
        if (this.failed) return;
        const row = object(raw);
        const type = typeof row?.['type'] === 'string' ? row['type'] : 'unknown';
        const serialized = this.limited ? '' : stringifyTraceValue(thin(raw));
        const bytes = Buffer.byteLength(serialized, 'utf8');
        if (this.limited || bytes > PI_RAW_RECORD_BYTES || this.bytes + bytes > PI_RAW_TRACE_BYTES
            || this.records >= PI_RAW_RECORDS) {
            this.dropped++;
            if (!this.limited) {
                this.limited = true;
                this.control('raw_retention_limited', { type: 'raw_retention_limited', retainedBytes: this.bytes,
                    retainedRecords: this.records, byteLimit: PI_RAW_TRACE_BYTES, recordLimit: PI_RAW_RECORDS,
                    detail: 'Raw payloads omitted; semantic events and legacy output continue' });
            }
            if (type === 'agent_end' || type === 'error') {
                this.control(type, { type, rawPayloadOmitted: true });
            } else if (type === 'response' && row?.['command'] === 'abort') {
                this.control('abort_response', { type, command: 'abort', success: row['success'] === true, rawPayloadOmitted: true });
            }
            return;
        }
        if (this.write('pi_rpc:' + type, serialized, 'cli_raw')) {
            this.bytes += bytes;
            this.records++;
        }
    }

    diagnostics() {
        return { bytes: this.bytes, records: this.records, limited: this.limited, failed: this.failed, dropped: this.dropped };
    }
}

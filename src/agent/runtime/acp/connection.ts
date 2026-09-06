import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { decodeFrame, type RpcFrame, type RpcId } from './wire.js';

const FRAME_LIMIT = 4 * 1024 * 1024; // payload bytes, excluding LF or CRLF
const CARRY_LIMIT = FRAME_LIMIT + 1; // a split CR delimiter may precede the next LF
const WRITE_LIMIT = 8 * 1024 * 1024; // active + queued bytes, including LF
const WRITE_COUNT_LIMIT = 1024;
const WRITE_TIMEOUT_MS = 30_000;
const PENDING_LIMIT = 64;
type Pending = {
    resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>;
    onResponse?: (frame: RpcFrame) => void; settling?: boolean;
};
type Write = {
    bytes: Buffer; resolve(): void; reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>; settled: boolean;
};

/** Transport only: the caller owns process reaping and bounded asynchronous frame admission. */
export class AcpConnection {
    private nextId = 0;
    private buffer: Buffer = Buffer.alloc(0);
    private buffered = 0;
    private readonly decoder = new TextDecoder('utf-8', { fatal: true });
    private readonly pending = new Map<RpcId, Pending>();
    private readonly writes: Write[] = [];
    private activeWrite: Write | null = null;
    private queuedBytes = 0;
    private closed = false;

    constructor(private child: ChildProcessWithoutNullStreams, private hooks: {
        frame(frame: RpcFrame): void;
        failed(error: Error): void;
    }) {
        child.stdout.on('data', this.receive);
        child.stdout.once('end', this.ended);
        child.once('exit', this.exited);
        // Keep error consumers for this child's lifetime, including late EPIPE after close.
        child.on('error', this.failed);
        child.stdin.on('error', this.failed);
        child.stdout.on('error', this.failed);
    }

    get alive(): boolean { return !this.closed; }
    private failed = () => this.close(new Error('acp_io_error'));
    private exited = () => this.close(new Error('acp_child_exit'));
    private ended = () => this.close(new Error(this.buffered ? 'acp_truncated_frame' : 'acp_stdout_end'));

    private append(bytes: Buffer): void {
        const needed = this.buffered + bytes.length;
        const trailingCr = (bytes.at(-1) ?? this.buffer[this.buffered - 1]) === 13;
        if (needed > FRAME_LIMIT && !(needed === CARRY_LIMIT && trailingCr)) throw new Error('acp_frame_limit');
        if (needed > this.buffer.length) {
            const next = Buffer.allocUnsafe(Math.min(CARRY_LIMIT, Math.max(needed, this.buffer.length * 2, 4096)));
            this.buffer.copy(next, 0, 0, this.buffered);
            this.buffer = next;
        }
        bytes.copy(this.buffer, this.buffered);
        this.buffered = needed;
    }

    private receive = (chunk: Buffer) => {
        if (this.closed) return;
        if (!Buffer.isBuffer(chunk)) { this.close(new Error('acp_invalid_bytes')); return; }
        try {
            let offset = 0;
            while (!this.closed && offset < chunk.length) {
                const newline = chunk.indexOf(10, offset);
                if (newline < 0) { this.append(chunk.subarray(offset)); break; }
                const bytes = chunk.subarray(offset, newline);
                let payload = bytes;
                if (this.buffered) {
                    this.append(bytes);
                    payload = this.buffer.subarray(0, this.buffered);
                }
                this.buffered = 0;
                if (payload.at(-1) === 13) payload = payload.subarray(0, -1);
                if (payload.length > FRAME_LIMIT) throw new Error('acp_frame_limit');
                let line: string;
                try { line = this.decoder.decode(payload).trim(); }
                catch { throw new Error('acp_invalid_utf8'); }
                if (line) this.deliver(decodeFrame(line));
                offset = newline + 1;
            }
        } catch (error) {
            this.close(error instanceof Error ? error : new Error('acp_frame_failure'));
        }
    };

    private deliver(frame: RpcFrame): void {
        // Each peer owns its ID namespace: a callback is never an outgoing response.
        if ('method' in frame) {
            try { this.hooks.frame(frame); }
            catch { this.close(new Error('acp_frame_hook_failed')); }
            return;
        }
        const entry = this.pending.get(frame.id);
        if (!entry || entry.settling) return; // unknown, late or duplicate replies cannot become events
        entry.settling = true;
        try { entry.onResponse?.(frame); }
        catch { this.close(new Error('acp_response_observer_failed')); return; }
        if (this.closed) return; // observer retirement must also reject this still-registered request
        this.pending.delete(frame.id);
        clearTimeout(entry.timer);
        if ('error' in frame) entry.reject(new Error(`acp_rpc_error:${frame.error.code}`));
        else entry.resolve(frame.result);
    }

    write(frame: RpcFrame): Promise<void> {
        if (this.closed) return Promise.reject(new Error('acp_closed'));
        let encoded: string;
        try {
            encoded = JSON.stringify(frame);
            if (typeof encoded !== 'string') throw new Error('acp_serialize_failed');
        }
        catch {
            const error = new Error('acp_serialize_failed');
            this.close(error);
            return Promise.reject(error);
        }
        if (this.closed) return Promise.reject(new Error('acp_closed'));
        const size = Buffer.byteLength(encoded) + 1;
        if (size - 1 > FRAME_LIMIT || this.queuedBytes + size > WRITE_LIMIT
            || this.writes.length + Number(this.activeWrite !== null) >= WRITE_COUNT_LIMIT) {
            const error = new Error('acp_write_limit');
            this.close(error);
            return Promise.reject(error);
        }
        // unknown result/params can serialize differently (for example, undefined results).
        try { decodeFrame(encoded); }
        catch {
            const error = new Error('acp_invalid_outgoing_frame');
            this.close(error);
            return Promise.reject(error);
        }
        const bytes = Buffer.from(encoded + '\n');
        const written = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => this.close(new Error('acp_write_timeout')), WRITE_TIMEOUT_MS);
            this.queuedBytes += bytes.length;
            this.writes.push({ bytes, resolve, reject, timer, settled: false });
        });
        // Observe immediately without replacing the caller-visible rejecting promise.
        void written.catch(() => undefined);
        this.pump();
        return written;
    }

    private pump(): void {
        if (this.closed || this.activeWrite) return;
        const entry = this.writes.shift();
        if (!entry) return;
        this.activeWrite = entry;
        if (!this.child.stdin.writable) { this.close(new Error('acp_stdin_closed')); return; }
        try {
            this.child.stdin.write(entry.bytes, error => {
                if (entry.settled) return;
                if (error) { this.close(new Error('acp_write_failed')); return; }
                this.settleWrite(entry);
                this.pump();
            });
        } catch { this.close(new Error('acp_write_failed')); }
    }

    private settleWrite(entry: Write, error?: Error): void {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(entry.timer);
        this.queuedBytes -= entry.bytes.length;
        entry.bytes = Buffer.alloc(0);
        if (this.activeWrite === entry) this.activeWrite = null;
        if (error) entry.reject(error); else entry.resolve();
    }

    request(method: string, params: unknown, timeoutMs = 30_000, onResponse?: (frame: RpcFrame) => void) {
        if (this.closed || this.pending.size >= PENDING_LIMIT) throw new Error('acp_unavailable');
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
            throw new Error('acp_invalid_timeout');
        }
        const id = `jaw:${++this.nextId}`;
        let resolve!: (value: unknown) => void;
        let reject!: (error: Error) => void;
        const result = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
        void result.catch(() => undefined);
        const timer = setTimeout(() => this.close(new Error('acp_timeout')), timeoutMs);
        this.pending.set(id, { resolve, reject, timer, ...(onResponse === undefined ? {} : { onResponse }) });
        const dispatched = this.write({ jsonrpc: '2.0', id, method, params });
        void dispatched.catch(error => this.close(error));
        return { id, dispatched, result };
    }

    notify(method: string, params: unknown): Promise<void> {
        return this.write({ jsonrpc: '2.0', method, params });
    }
    reply(id: RpcId, result: unknown): Promise<void> { return this.write({ jsonrpc: '2.0', id, result }); }
    refuse(id: RpcId, code: number, message: string): Promise<void> {
        return this.write({ jsonrpc: '2.0', id, error: { code, message } });
    }

    close(error = new Error('acp_closed')): void {
        if (this.closed) return;
        this.closed = true;
        this.buffer = Buffer.alloc(0);
        this.buffered = 0;
        this.child.stdout.off('data', this.receive);
        this.child.stdout.off('end', this.ended);
        this.child.off('exit', this.exited);
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
        this.pending.clear();
        if (this.activeWrite) this.settleWrite(this.activeWrite, error);
        for (const entry of this.writes.splice(0)) this.settleWrite(entry, error);
        try { this.hooks.failed(error); }
        catch { /* All local work is settled even if the process owner's failure hook throws. */ }
    }
}

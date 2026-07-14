// 026 — trace detail range API (02x amendment).
// Bounded range reader for trace event payloads: 4MiB whole-fetch cap,
// 256KiB byte-range chunks, UTF-8/ANSI-safe boundaries, sparse 64KiB line
// index with revision binding, and abort-aware fd reads. The range path
// never uses readFileSync / whole-file buffers (026 §0.4).
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

export const DETAIL_WHOLE_MAX_BYTES = 4 * 1024 * 1024;
export const DETAIL_CHUNK_MAX_BYTES = 262_144;
export const LINE_INDEX_STRIDE_BYTES = 65_536;
const BOUNDARY_LOOKAROUND_BYTES = 4_096;
const INDEX_CACHE_MAX_ENTRIES = 16;

export type AnsiParserState = {
    kind: 'none' | 'esc' | 'csi' | 'osc' | 'osc-esc';
    pending: string;
    sgr: string;
};

type IndexCheckpoint = { byteOffset: number; lineNumber: number; ansi: AnsiParserState };
type SpillIndex = { revision: string; totalBytes: number; checkpoints: IndexCheckpoint[]; totalLines: number };

export interface TraceDetailSource {
    runId: string;
    seq: number;
    /** absolute validated spill path, or null when payload is inline */
    spillPath: string | null;
    /** inline payload when spillPath is null */
    inline: string | null;
}

export interface TraceDetailRangeData {
    totalBytes: number;
    requestedOffset: number;
    requestedLimit: number;
    actualStart: number;
    actualEndExclusive: number;
    nextOffset: number | null;
    eof: boolean;
    text: string;
    contentEncoding: 'utf-8';
    line: { first: number; last: number; indexStrideBytes: number };
    boundary: {
        utf8Adjusted: boolean;
        startsAtLineBoundary: boolean;
        ansiStateBefore: string | null;
        ansiStateAfter: string | null;
    };
    revision: string;
}

export type TraceDetailRangeResult =
    | { kind: 'range'; data: TraceDetailRangeData }
    | { kind: 'gone' }
    | { kind: 'revision_changed' }
    | { kind: 'invalid_utf8' }
    | { kind: 'canceled' };

// ─── ANSI state machine ──────────────────────────────

function freshAnsi(): AnsiParserState { return { kind: 'none', pending: '', sgr: '' }; }
function cloneAnsi(s: AnsiParserState): AnsiParserState { return { kind: s.kind, pending: s.pending, sgr: s.sgr }; }
function insideSequence(s: AnsiParserState): boolean { return s.kind !== 'none'; }

function applySgr(state: AnsiParserState, seq: string): void {
    const params = seq.slice(2, -1);
    const parts = params.split(';').filter(p => p.length > 0);
    if (parts.length === 0 || parts.includes('0')) state.sgr = '';
    else state.sgr += seq;
}

/** Advance the ANSI parser over one byte. Mutates state. */
function ansiStep(state: AnsiParserState, byte: number): void {
    const ch = String.fromCharCode(byte);
    switch (state.kind) {
        case 'none':
            if (byte === 0x1b) { state.kind = 'esc'; state.pending = ch; }
            return;
        case 'esc':
            if (ch === '[') { state.kind = 'csi'; state.pending += ch; }
            else if (ch === ']') { state.kind = 'osc'; state.pending += ch; }
            else { state.kind = 'none'; state.pending = ''; }
            return;
        case 'csi':
            state.pending += ch;
            if (byte >= 0x40 && byte <= 0x7e) {
                if (ch === 'm') applySgr(state, state.pending);
                state.kind = 'none'; state.pending = '';
            }
            return;
        case 'osc':
            if (byte === 0x07) { state.kind = 'none'; state.pending = ''; }
            else if (byte === 0x1b) { state.kind = 'osc-esc'; state.pending += ch; }
            else state.pending += ch;
            return;
        case 'osc-esc':
            // ESC \ (ST) terminates OSC; any other byte returns to OSC body.
            if (ch === '\\') { state.kind = 'none'; state.pending = ''; }
            else { state.kind = 'osc'; state.pending += ch; }
            return;
    }
}

// ─── sparse line index (bounded LRU, revision-bound) ─

const indexCache = new Map<string, SpillIndex>();

function cacheKey(runId: string, seq: number): string { return `${runId}:${seq}`; }

export function evictDetailRangeIndex(runId: string, seq?: number): void {
    if (seq != null) { indexCache.delete(cacheKey(runId, seq)); return; }
    const prefix = `${runId}:`;
    for (const key of indexCache.keys()) if (key.startsWith(prefix)) indexCache.delete(key);
}

function cachePut(key: string, index: SpillIndex): void {
    indexCache.delete(key);
    indexCache.set(key, index);
    while (indexCache.size > INDEX_CACHE_MAX_ENTRIES) {
        const oldest = indexCache.keys().next().value;
        if (oldest === undefined) break;
        indexCache.delete(oldest);
    }
}

async function fileRevision(handle: FileHandle): Promise<{ revision: string; size: number }> {
    const st = await handle.stat();
    return { revision: `${st.size}:${Math.floor(st.mtimeMs)}`, size: st.size };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new RangeAbortError();
}
class RangeAbortError extends Error { constructor() { super('trace_range_canceled'); } }

/** Chunked scan building 64KiB-stride checkpoints. Never reads the whole file at once. */
async function buildIndex(
    handle: FileHandle, totalBytes: number, revision: string, signal?: AbortSignal,
): Promise<SpillIndex> {
    const checkpoints: IndexCheckpoint[] = [{ byteOffset: 0, lineNumber: 1, ansi: freshAnsi() }];
    const buf = Buffer.alloc(Math.min(DETAIL_CHUNK_MAX_BYTES, Math.max(totalBytes, 1)));
    const ansi = freshAnsi();
    let line = 1;
    let pos = 0;
    let nextCheckpoint = LINE_INDEX_STRIDE_BYTES;
    while (pos < totalBytes) {
        throwIfAborted(signal);
        const want = Math.min(buf.length, totalBytes - pos);
        const { bytesRead } = await handle.read(buf, 0, want, pos);
        if (bytesRead <= 0) break;
        for (let i = 0; i < bytesRead; i++) {
            const b = buf[i] as number;
            if (b === 0x0a) line++;
            if (b === 0x1b || ansi.kind !== 'none') ansiStep(ansi, b);
            const abs = pos + i + 1;
            if (abs >= nextCheckpoint && abs < totalBytes) {
                checkpoints.push({ byteOffset: abs, lineNumber: line, ansi: cloneAnsi(ansi) });
                nextCheckpoint = abs + LINE_INDEX_STRIDE_BYTES;
            }
        }
        pos += bytesRead;
    }
    return { revision, totalBytes, checkpoints, totalLines: line };
}

/** In-memory equivalent for inline payloads: same checkpoint semantics without fd reads. */
function buildInlineIndex(payload: Buffer, revision: string): SpillIndex {
    const checkpoints: IndexCheckpoint[] = [{ byteOffset: 0, lineNumber: 1, ansi: freshAnsi() }];
    const ansi = freshAnsi();
    let line = 1;
    let nextCheckpoint = LINE_INDEX_STRIDE_BYTES;
    for (let i = 0; i < payload.length; i++) {
        const b = payload[i] as number;
        if (b === 0x0a) line++;
        if (b === 0x1b || ansi.kind !== 'none') ansiStep(ansi, b);
        const abs = i + 1;
        if (abs >= nextCheckpoint && abs < payload.length) {
            checkpoints.push({ byteOffset: abs, lineNumber: line, ansi: cloneAnsi(ansi) });
            nextCheckpoint = abs + LINE_INDEX_STRIDE_BYTES;
        }
    }
    return { revision, totalBytes: payload.length, checkpoints, totalLines: line };
}

// ─── boundary helpers ────────────────────────────────

function isUtf8Continuation(byte: number): boolean { return (byte & 0xc0) === 0x80; }

function nearestCheckpoint(index: SpillIndex, offset: number): IndexCheckpoint {
    let best = index.checkpoints[0] as IndexCheckpoint;
    for (const cp of index.checkpoints) {
        if (cp.byteOffset <= offset) best = cp;
        else break;
    }
    return best;
}

type BoundaryProbe = {
    state: AnsiParserState; lineNumber: number; utf8Adjusted: boolean;
    adjustedOffset: number; startsAtLineBoundary: boolean;
};

/**
 * Replay from the nearest checkpoint to `offset`, returning the parser state and
 * line number at the (possibly forward-adjusted) start boundary. Reads at most
 * one stride plus bounded lookaround.
 */
async function probeStart(
    read: (buf: Buffer, position: number, length: number) => Promise<number>,
    index: SpillIndex, offset: number, signal?: AbortSignal,
): Promise<BoundaryProbe> {
    const cp = nearestCheckpoint(index, offset);
    const ansi = cloneAnsi(cp.ansi);
    let line = cp.lineNumber;
    let utf8Adjusted = false;
    let target = offset;
    const spanEnd = Math.min(index.totalBytes, offset + BOUNDARY_LOOKAROUND_BYTES);
    const span = Buffer.alloc(Math.max(spanEnd - cp.byteOffset, 1));
    const got = await read(span, cp.byteOffset, spanEnd - cp.byteOffset);
    throwIfAborted(signal);
    const rel = (abs: number): number => abs - cp.byteOffset;
    // walk from checkpoint to requested offset, tracking state
    for (let abs = cp.byteOffset; abs < Math.min(offset, cp.byteOffset + got); abs++) {
        const b = span[rel(abs)] as number;
        if (b === 0x0a) line++;
        if (b === 0x1b || ansi.kind !== 'none') ansiStep(ansi, b);
    }
    // UTF-8: move forward off continuation bytes
    while (target < spanEnd && rel(target) < got && isUtf8Continuation(span[rel(target)] as number)) {
        utf8Adjusted = true; target++;
    }
    // ANSI: if we are inside an escape sequence at target, advance to its end
    if (insideSequence(ansi)) {
        while (target < spanEnd && rel(target) < got && insideSequence(ansi)) {
            const b = span[rel(target)] as number;
            if (b === 0x0a) line++;
            ansiStep(ansi, b);
            target++;
        }
    }
    const prevIdx = rel(target - 1);
    const startsAtLineBoundary = target === 0
        || (prevIdx >= 0 && prevIdx < got && (span[prevIdx] as number) === 0x0a);
    return { state: ansi, lineNumber: line, utf8Adjusted, adjustedOffset: target, startsAtLineBoundary };
}

// ─── main range reader ───────────────────────────────

export interface RangeReadOptions { offset: number; limit: number; signal?: AbortSignal }

export async function readTraceDetailRange(
    source: TraceDetailSource, opts: RangeReadOptions,
): Promise<TraceDetailRangeResult> {
    try {
        if (source.spillPath === null) {
            const payload = Buffer.from(source.inline ?? '', 'utf8');
            const revision = `inline:${payload.length}`;
            const index = buildInlineIndex(payload, revision);
            const read = (buf: Buffer, position: number, length: number): Promise<number> => {
                const n = Math.min(length, Math.max(payload.length - position, 0));
                payload.copy(buf, 0, position, position + n);
                return Promise.resolve(n);
            };
            return await sliceRange(read, index, revision, opts);
        }
        let handle: FileHandle;
        try {
            handle = await fsp.open(source.spillPath, 'r');
        } catch {
            return { kind: 'gone' };
        }
        try {
            const { revision, size } = await fileRevision(handle);
            const key = cacheKey(source.runId, source.seq);
            let index = indexCache.get(key);
            if (index && index.revision !== revision) {
                // The payload was rewritten since a previous chunk was served from
                // this index. Serving from a rebuilt index would let the client
                // concatenate mixed revisions — force a metadata restart instead
                // (026 §3.4). The next request rebuilds against the new revision.
                evictDetailRangeIndex(source.runId, source.seq);
                return { kind: 'revision_changed' };
            }
            if (!index) {
                index = await buildIndex(handle, size, revision, opts.signal);
                cachePut(key, index);
            }
            const read = async (buf: Buffer, position: number, length: number): Promise<number> => {
                const { bytesRead } = await handle.read(buf, 0, length, position);
                return bytesRead;
            };
            const result = await sliceRange(read, index, revision, opts);
            // post-read revision re-check: an in-place truncate/rewrite during the
            // read must not leak mixed bytes (026 §3.4, audit r2).
            const after = await fileRevision(handle);
            if (after.revision !== revision) {
                evictDetailRangeIndex(source.runId, source.seq);
                return { kind: 'revision_changed' };
            }
            return result;
        } finally {
            await handle.close();
        }
    } catch (error) {
        if (error instanceof RangeAbortError) return { kind: 'canceled' };
        if (error instanceof Utf8Error) return { kind: 'invalid_utf8' };
        throw error;
    }
}

class Utf8Error extends Error { constructor() { super('trace_payload_invalid_utf8'); } }

async function sliceRange(
    read: (buf: Buffer, position: number, length: number) => Promise<number>,
    index: SpillIndex, revision: string, opts: RangeReadOptions,
): Promise<TraceDetailRangeResult> {
    const { totalBytes } = index;
    const offset = Math.min(opts.offset, totalBytes);
    const start = await probeStart(read, index, offset, opts.signal);
    let end = Math.min(start.adjustedOffset + opts.limit, totalBytes);
    const chunkLen = Math.max(end - start.adjustedOffset, 0);
    const chunk = Buffer.alloc(Math.max(chunkLen, 1));
    let got = 0;
    if (chunkLen > 0) got = await read(chunk, start.adjustedOffset, chunkLen);
    throwIfAborted(opts.signal);
    let body = chunk.subarray(0, got);
    end = start.adjustedOffset + body.length;
    // end boundary: never split a UTF-8 code point — shrink back to a boundary.
    if (end < totalBytes) {
        let cut = body.length;
        while (cut > 0 && isUtf8Continuation(body[cut - 1] as number)) cut--;
        if (cut > 0 && ((body[cut - 1] as number) & 0x80) !== 0 && !isUtf8Continuation(body[cut - 1] as number)) cut--;
        // ANSI: don't end inside an escape sequence — walk state through the body.
        const ansi = cloneAnsi(start.state);
        let lastSafe = 0;
        for (let i = 0; i < cut; i++) {
            const b = body[i] as number;
            if (b === 0x1b || ansi.kind !== 'none') ansiStep(ansi, b);
            if (ansi.kind === 'none') lastSafe = i + 1;
        }
        if (lastSafe < cut) cut = lastSafe;
        body = body.subarray(0, cut);
        end = start.adjustedOffset + cut;
    }
    // strict UTF-8 validation (026 §3.2): surface broken payload bytes as 422.
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
        throw new Utf8Error();
    }
    // line numbers + end-state across the returned body
    const endState = cloneAnsi(start.state);
    let lineCount = 0;
    for (let i = 0; i < body.length; i++) {
        const b = body[i] as number;
        if (b === 0x0a) lineCount++;
        if (b === 0x1b || endState.kind !== 'none') ansiStep(endState, b);
    }
    const eof = end >= totalBytes;
    return {
        kind: 'range',
        data: {
            totalBytes,
            requestedOffset: opts.offset,
            requestedLimit: opts.limit,
            actualStart: start.adjustedOffset,
            actualEndExclusive: end,
            nextOffset: eof ? null : end,
            eof,
            text,
            contentEncoding: 'utf-8',
            line: {
                first: start.lineNumber,
                last: start.lineNumber + lineCount,
                indexStrideBytes: LINE_INDEX_STRIDE_BYTES,
            },
            boundary: {
                utf8Adjusted: start.utf8Adjusted,
                startsAtLineBoundary: start.startsAtLineBoundary,
                ansiStateBefore: start.state.sgr || null,
                ansiStateAfter: endState.sgr || null,
            },
            revision,
        },
    };
}

/**
 * Assemble a whole payload (≤4MiB) through the same bounded reader — the
 * compat no-range path must not use readFileSync either (audit r1 b2).
 */
export async function readTraceDetailWhole(
    source: TraceDetailSource, signal?: AbortSignal,
): Promise<{ kind: 'whole'; raw: string } | { kind: 'gone' } | { kind: 'too_large'; totalBytes: number } | { kind: 'canceled' }> {
    if (source.spillPath === null) {
        const raw = source.inline ?? '';
        if (Buffer.byteLength(raw, 'utf8') > DETAIL_WHOLE_MAX_BYTES) {
            return { kind: 'too_large', totalBytes: Buffer.byteLength(raw, 'utf8') };
        }
        return { kind: 'whole', raw };
    }
    let handle: FileHandle;
    try {
        handle = await fsp.open(source.spillPath, 'r');
    } catch {
        return { kind: 'gone' };
    }
    try {
        const st = await handle.stat();
        if (st.size > DETAIL_WHOLE_MAX_BYTES) return { kind: 'too_large', totalBytes: st.size };
        const parts: Buffer[] = [];
        const buf = Buffer.alloc(DETAIL_CHUNK_MAX_BYTES);
        let pos = 0;
        while (pos < st.size) {
            if (signal?.aborted) return { kind: 'canceled' };
            const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, st.size - pos), pos);
            if (bytesRead <= 0) break;
            parts.push(Buffer.from(buf.subarray(0, bytesRead)));
            pos += bytesRead;
        }
        return { kind: 'whole', raw: Buffer.concat(parts).toString('utf8') };
    } finally {
        await handle.close();
    }
}

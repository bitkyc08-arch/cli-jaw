import test from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import express, { type NextFunction, type Request, type Response as ExpressResponse } from 'express';
import { JAW_HOME } from '../../src/core/config.ts';
import { db } from '../../src/core/db.ts';
import { registerTraceRoutes } from '../../src/routes/traces.ts';
import { evictDetailRangeIndex } from '../../src/trace/detail-range.ts';
import {
    appendTraceEvent,
    getTraceEventMeta,
    startTraceRun,
} from '../../src/trace/store.ts';

const CHUNK_BYTES = 262_144;
const INDEX_STRIDE_BYTES = 65_536;
const LARGE_CHUNKS = 512;
const LARGE_BYTES = INDEX_STRIDE_BYTES * LARGE_CHUNKS;
type SpillFixture = {
    runId: string;
    seq: number;
    spillPath: string;
    totalBytes: number;
};

type RangeData = {
    runId: string;
    seq: number;
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
};

type RangeBody = { ok: true; data: RangeData };

function noAuth(_req: Request, _res: ExpressResponse, next: NextFunction): void {
    next();
}

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
    const app = express();
    registerTraceRoutes(app, noAuth);
    const server: Server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
        await fn(`http://127.0.0.1:${address.port}`);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

function seedEvent(eventType: string, raw = 'seed'): { runId: string; seq: number } {
    const runId = startTraceRun({ cli: 'codex', audience: 'public' });
    const pointer = appendTraceEvent({ runId, source: 'cli_raw', eventType, raw });
    assert.ok(pointer);
    return { runId, seq: pointer.traceSeq };
}

function setSpillRow(fixture: SpillFixture): void {
    const rawPath = nodePath.relative(JAW_HOME, fixture.spillPath);
    db.prepare(`
        UPDATE trace_events
        SET raw_json = NULL, raw_path = ?, bytes = ?, retention_status = 'spilled'
        WHERE run_id = ? AND seq = ?
    `).run(rawPath, fixture.totalBytes, fixture.runId, fixture.seq);
    db.prepare(`
        UPDATE trace_runs SET byte_count = ?, raw_retention_status = 'spilled' WHERE id = ?
    `).run(fixture.totalBytes, fixture.runId);
}

function createSmallSpill(eventType: string, bytes: Buffer): SpillFixture {
    const event = seedEvent(eventType);
    const dir = nodePath.join(JAW_HOME, 'traces', event.runId);
    const spillPath = nodePath.join(dir, `${String(event.seq).padStart(6, '0')}.json`);
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(spillPath, bytes);
    const fixture = { ...event, spillPath, totalBytes: bytes.byteLength };
    setSpillRow(fixture);
    return fixture;
}

function createLargeSpill(): SpillFixture & { emojiStart: number; newlineOffsets: number[] } {
    const event = seedEvent('large-range');
    const dir = nodePath.join(JAW_HOME, 'traces', event.runId);
    const spillPath = nodePath.join(dir, `${String(event.seq).padStart(6, '0')}.json`);
    const newlineOffsets: number[] = [];
    let emojiStart = -1;
    nodeFs.mkdirSync(dir, { recursive: true });
    const fd = nodeFs.openSync(spillPath, 'w');
    try {
        for (let index = 0; index < LARGE_CHUNKS; index += 1) {
            const beforeEmoji = Buffer.from(`chunk-${index}|한글|`, 'utf8');
            const emoji = Buffer.from('🙂', 'utf8');
            const prefix = Buffer.concat([
                beforeEmoji,
                emoji,
                Buffer.from('|\r\n\x1b[31mred\x1b[0m|', 'utf8'),
            ]);
            const suffix = Buffer.from('\r\n', 'utf8');
            const filler = Buffer.alloc(INDEX_STRIDE_BYTES - prefix.byteLength - suffix.byteLength, 0x78);
            const chunk = Buffer.concat([prefix, filler, suffix]);
            assert.equal(chunk.byteLength, INDEX_STRIDE_BYTES);
            if (index === LARGE_CHUNKS / 2) emojiStart = index * INDEX_STRIDE_BYTES + beforeEmoji.byteLength;
            for (let at = chunk.indexOf(0x0a); at >= 0; at = chunk.indexOf(0x0a, at + 1)) {
                newlineOffsets.push(index * INDEX_STRIDE_BYTES + at);
            }
            assert.equal(nodeFs.writeSync(fd, chunk), INDEX_STRIDE_BYTES);
        }
    } finally {
        nodeFs.closeSync(fd);
    }
    const fixture = { ...event, spillPath, totalBytes: LARGE_BYTES, emojiStart, newlineOffsets };
    setSpillRow(fixture);
    assert.equal(nodeFs.statSync(spillPath).size, LARGE_BYTES);
    assert.ok(spillPath.startsWith(tmpdir()), 'test-home spill must live below os.tmpdir()');
    return fixture;
}

async function fetchRange(baseUrl: string, fixture: SpillFixture, offset: number, limit = CHUNK_BYTES): Promise<Response> {
    return fetch(`${baseUrl}/api/traces/${fixture.runId}/events/${fixture.seq}?offset=${offset}&limit=${limit}`);
}

function lineAtOffset(newlineOffsets: number[], offset: number): number {
    let low = 0;
    let high = newlineOffsets.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if ((newlineOffsets[middle] ?? Number.MAX_SAFE_INTEGER) < offset) low = middle + 1;
        else high = middle;
    }
    return low + 1;
}

test.describe('trace detail byte range API', { concurrency: false }, () => {
    let large: ReturnType<typeof createLargeSpill>;
    let small: { runId: string; seq: number; raw: string };
    let gone: SpillFixture;
    let invalidUtf8: SpillFixture;

    test.before(() => {
        const raw = 'small 한글🙂\r\n\x1b[31mred\x1b[0m';
        small = { ...seedEvent('small-detail', raw), raw };
        large = createLargeSpill();
        gone = createSmallSpill('gone-range', Buffer.from('gone payload\r\n', 'utf8'));
        invalidUtf8 = createSmallSpill('invalid-utf8', Buffer.alloc(4096, 0xff));

        const meta = getTraceEventMeta(large.runId, large.seq);
        assert.ok(meta);
        assert.equal(meta.totalBytes, LARGE_BYTES);
        assert.equal(meta.payloadState, 'spilled');
        assert.ok(meta.spillPath);
    });

    test.after(() => {
        for (const fixture of [large, gone, invalidUtf8]) {
            if (fixture?.runId) evictDetailRangeIndex(fixture.runId);
        }
        if (small?.runId) evictDetailRangeIndex(small.runId);
        db.close();
        nodeFs.rmSync(JAW_HOME, { recursive: true, force: true });
    });

    test('keeps the legacy detail shape and full raw text below 4 MiB', async () => {
        await withServer(async baseUrl => {
            const response = await fetch(`${baseUrl}/api/traces/${small.runId}/events/${small.seq}`);
            assert.equal(response.status, 200);
            const body = await response.json() as { ok: true; data: Record<string, unknown> };
            assert.equal(body.ok, true);
            assert.deepEqual(Object.keys(body.data).sort(), [
                'bytes', 'createdAt', 'eventType', 'preview', 'raw', 'retentionStatus', 'runId', 'seq', 'source',
            ]);
            assert.equal(body.data['runId'], small.runId);
            assert.equal(body.data['seq'], small.seq);
            assert.equal(body.data['source'], 'cli_raw');
            assert.equal(body.data['eventType'], 'small-detail');
            assert.equal(body.data['bytes'], Buffer.byteLength(small.raw));
            assert.equal(body.data['retentionStatus'], 'available');
            assert.equal(body.data['raw'], small.raw);
            assert.equal(typeof body.data['createdAt'], 'number');
        });
    });

    test('requires byte ranges for an unbounded 32 MiB detail request', async () => {
        await withServer(async baseUrl => {
            const response = await fetch(`${baseUrl}/api/traces/${large.runId}/events/${large.seq}`);
            assert.equal(response.status, 413);
            assert.deepEqual(await response.json(), {
                ok: false,
                error: 'trace_detail_range_required',
                totalBytes: LARGE_BYTES,
                rangeAvailable: true,
                chunkSize: CHUNK_BYTES,
            });
        });
    });

    test('returns the first bounded chunk with line and continuation metadata', async () => {
        await withServer(async baseUrl => {
            const response = await fetchRange(baseUrl, large, 0);
            assert.equal(response.status, 200);
            const body = await response.json() as RangeBody;
            assert.equal(body.data.actualStart, 0);
            assert.ok(body.data.text.length > 0);
            assert.ok((body.data.nextOffset ?? 0) > 0);
            assert.equal(body.data.line.first, 1);
            assert.equal(body.data.line.indexStrideBytes, INDEX_STRIDE_BYTES);
            assert.equal(body.data.contentEncoding, 'utf-8');
            assert.ok(body.data.revision.length > 0);
        });
    });

    test('reassembles all sequential chunks byte-for-byte using nextOffset', async () => {
        await withServer(async baseUrl => {
            const chunks: Buffer[] = [];
            let offset = 0;
            let eof = false;
            for (let requests = 0; !eof && requests < 1024; requests += 1) {
                const response = await fetchRange(baseUrl, large, offset);
                assert.equal(response.status, 200);
                const { data } = await response.json() as RangeBody;
                assert.equal(data.actualStart, offset);
                const bytes = Buffer.from(data.text, 'utf8');
                assert.equal(bytes.byteLength, Buffer.byteLength(data.text));
                assert.equal(bytes.byteLength, data.actualEndExclusive - data.actualStart);
                chunks.push(bytes);
                eof = data.eof;
                if (!eof) {
                    assert.ok(data.nextOffset != null && data.nextOffset > offset);
                    offset = data.nextOffset;
                } else {
                    assert.equal(data.nextOffset, null);
                }
            }
            assert.equal(eof, true);
            const combined = Buffer.concat(chunks);
            const original = nodeFs.readFileSync(large.spillPath);
            assert.equal(combined.byteLength, LARGE_BYTES);
            assert.ok(combined.equals(original), 'sequential text chunks must equal the original spill bytes');
        });
    });

    test('adjusts a mid-emoji byte seek to a UTF-8 code point boundary', async () => {
        await withServer(async baseUrl => {
            const requestedOffset = large.emojiStart + 2;
            const response = await fetchRange(baseUrl, large, requestedOffset, 4096);
            assert.equal(response.status, 200);
            const { data } = await response.json() as RangeBody;
            assert.equal(data.requestedOffset, requestedOffset);
            assert.notEqual(data.actualStart, requestedOffset);
            assert.ok(data.actualStart === large.emojiStart || data.actualStart === large.emojiStart + 4);
            assert.equal(data.boundary.utf8Adjusted, true);
        });
    });

    test('tail seek reports the same first line as the fixture sequential scan', async () => {
        await withServer(async baseUrl => {
            const response = await fetchRange(baseUrl, large, LARGE_BYTES - 131_071, 65_536);
            assert.equal(response.status, 200);
            const { data } = await response.json() as RangeBody;
            assert.equal(data.line.first, lineAtOffset(large.newlineOffsets, data.actualStart));
        });
    });

    test('range handling never calls fs.readFileSync', async () => {
        evictDetailRangeIndex(large.runId);
        const original = nodeFs.readFileSync;
        let calls = 0;
        Object.defineProperty(nodeFs, 'readFileSync', {
            configurable: true,
            writable: true,
            value: (...args: unknown[]) => {
                calls += 1;
                return Reflect.apply(original, nodeFs, args);
            },
        });
        try {
            await withServer(async baseUrl => {
                const response = await fetchRange(baseUrl, large, INDEX_STRIDE_BYTES + 17, 8192);
                assert.equal(response.status, 200);
                await response.json();
            });
        } finally {
            Object.defineProperty(nodeFs, 'readFileSync', { configurable: true, writable: true, value: original });
        }
        assert.equal(calls, 0);
    });

    test('rejects negative, fractional, zero, and oversized ranges', async () => {
        const queries = ['offset=-1&limit=1', 'offset=1.5&limit=1', 'offset=0&limit=0', 'offset=0&limit=262145'];
        await withServer(async baseUrl => {
            for (const query of queries) {
                const response = await fetch(`${baseUrl}/api/traces/${large.runId}/events/${large.seq}?${query}`);
                assert.equal(response.status, 400, query);
                assert.deepEqual(await response.json(), { ok: false, error: 'invalid_trace_range' }, query);
            }
        });
    });

    test('distinguishes missing runs from missing events', async () => {
        await withServer(async baseUrl => {
            const missingRun = `tr_${'a'.repeat(32)}`;
            const runResponse = await fetch(`${baseUrl}/api/traces/${missingRun}/events/1?offset=0&limit=1`);
            assert.equal(runResponse.status, 404);
            assert.deepEqual(await runResponse.json(), { ok: false, error: 'trace_not_found' });
            const eventResponse = await fetch(`${baseUrl}/api/traces/${large.runId}/events/999?offset=0&limit=1`);
            assert.equal(eventResponse.status, 404);
            assert.deepEqual(await eventResponse.json(), { ok: false, error: 'trace_event_not_found' });
        });
    });

    test('returns 410 when a spilled payload has been removed', async () => {
        nodeFs.unlinkSync(gone.spillPath);
        await withServer(async baseUrl => {
            const response = await fetchRange(baseUrl, gone, 0, 1024);
            assert.equal(response.status, 410);
            assert.deepEqual(await response.json(), { ok: false, error: 'trace_payload_gone' });
        });
    });

    test('returns 422 for an invalid UTF-8 spill', async () => {
        await withServer(async baseUrl => {
            const response = await fetchRange(baseUrl, invalidUtf8, 0, 4096);
            assert.equal(response.status, 422);
            assert.deepEqual(await response.json(), { ok: false, error: 'trace_payload_invalid_utf8' });
        });
    });

    test('cleans up an aborted range request and continues serving', async () => {
        evictDetailRangeIndex(large.runId);
        const originalConsoleError = console.error;
        const errors: unknown[][] = [];
        console.error = (...args: unknown[]) => { errors.push(args); };
        try {
            await withServer(async baseUrl => {
                const controller = new AbortController();
                const pending = fetch(`${baseUrl}/api/traces/${large.runId}/events/${large.seq}?offset=${LARGE_BYTES - CHUNK_BYTES}&limit=${CHUNK_BYTES}`, {
                    signal: controller.signal,
                });
                setImmediate(() => controller.abort());
                await pending.then(async response => response.body?.cancel(), error => {
                    assert.equal((error as Error).name, 'AbortError');
                });
                await new Promise<void>(resolve => setImmediate(resolve));
                const followUp = await fetch(`${baseUrl}/api/traces/${large.runId}`);
                assert.equal(followUp.status, 200);
            });
        } finally {
            console.error = originalConsoleError;
        }
        assert.deepEqual(errors, []);
    });

    test('keeps coarse heap growth below 48 MiB for a tail seek', async () => {
        await withServer(async baseUrl => {
            const before = process.memoryUsage().heapUsed;
            const response = await fetchRange(baseUrl, large, LARGE_BYTES - 65_537, 65_536);
            assert.equal(response.status, 200);
            const body = await response.json() as RangeBody;
            assert.ok(body.data.text.length > 0);
            const growth = Math.max(0, process.memoryUsage().heapUsed - before);
            assert.ok(growth < 48 * 1024 * 1024, `tail seek heap growth was ${growth} bytes`);
        });
    });

    test('returns 409 when the spill revision changes between range reads', async () => {
        await withServer(async baseUrl => {
            const first = await fetchRange(baseUrl, large, 0);
            assert.equal(first.status, 200);
            const firstBody = await first.json() as RangeBody;
            assert.ok(firstBody.data.nextOffset != null);

            nodeFs.truncateSync(large.spillPath, 0);
            nodeFs.writeFileSync(large.spillPath, Buffer.from('rewritten\r\n'.repeat(8192), 'utf8'));

            const next = await fetchRange(baseUrl, large, firstBody.data.nextOffset);
            assert.equal(next.status, 409);
            assert.deepEqual(await next.json(), { ok: false, error: 'trace_payload_revision_changed' });
        });
    });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAnsiChunk } from '../../public/dashboard2/src/turn-stream/detail/ansi-parser.ts';
import { fetchTraceDetail } from '../../public/dashboard2/src/turn-stream/detail/detail-client.ts';
import { getDetailController } from '../../public/dashboard2/src/turn-stream/detail/detail-loader.ts';
import { indexInlineLines, lineAtByteOffset, projectSparseLine } from '../../public/dashboard2/src/turn-stream/detail/line-index.ts';
import { createTurnStore } from '../../public/dashboard2/src/turn-stream/store/turn-store.ts';
import {
    TOOL_DETAIL_SCENARIOS,
    fixtureLineAtByteOffset,
    generateToolDetail10Mb,
    sliceToolDetailUtf8,
} from '../fixtures/dashboard2/render-parity/tool-detail-10mb.ts';

// 089.08: detail-client no longer permits an implicit manager-origin base.
const TEST_API_BASE = '/i/3457';

function response(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fetcher(sequence: Array<Response | ((signal?: AbortSignal) => Promise<Response>)>): typeof fetch {
    return (async (_input: string | URL | Request, init?: RequestInit) => {
        const next = sequence.shift();
        assert.ok(next, 'unexpected fetch');
        return typeof next === 'function' ? next(init?.signal ?? undefined) : next;
    }) as typeof fetch;
}

const full = (raw: string) => response(200, { ok: true, data: {
    runId: 'run', seq: 1, source: 'cli_raw', eventType: 'tool', preview: raw.slice(0, 10),
    bytes: Buffer.byteLength(raw), retentionStatus: 'available', createdAt: 1, raw,
} });

test('detail client preserves typed 400/404/409/410/413 variants and metadata', async () => {
    const cases = [
        [400, { ok: false, error: 'invalid_trace_range' }, 'bad-range'],
        [404, { ok: false, error: 'trace_event_not_found' }, 'not-found'],
        [409, { ok: false, error: 'trace_payload_revision_changed' }, 'revision-changed'],
        [410, { ok: false, error: 'trace_payload_gone' }, 'gone'],
        [413, { ok: false, error: 'trace_detail_range_required', totalBytes: 10_000_000, rangeAvailable: true, chunkSize: 262_144 }, 'range-required'],
    ] as const;
    for (const [status, body, kind] of cases) {
        const result = await fetchTraceDetail('run', 1, { apiBase: TEST_API_BASE, fetcher: fetcher([response(status, body)]) });
        assert.equal(result.kind, kind);
        if (result.kind === 'range-required') assert.deepEqual({ totalBytes: result.totalBytes, chunkSize: result.chunkSize }, { totalBytes: 10_000_000, chunkSize: 262_144 });
    }
});

test('range client preserves exact server cursor and boundary fields', async () => {
    const result = await fetchTraceDetail('run', 1, { apiBase: TEST_API_BASE, offset: 7, fetcher: fetcher([response(200, { ok: true, data: {
        runId: 'run', seq: 1, totalBytes: 20, requestedOffset: 7, requestedLimit: 8,
        actualStart: 5, actualEndExclusive: 13, nextOffset: 17, eof: false, text: '한글', contentEncoding: 'utf-8',
        line: { first: 3, last: 4, indexStrideBytes: 65536 },
        boundary: { utf8Adjusted: true, startsAtLineBoundary: false, ansiStateBefore: '\x1b[31m', ansiStateAfter: '\x1b[0m' }, revision: 'rev-1',
    } })]) });
    assert.equal(result.kind, 'range');
    if (result.kind === 'range') assert.deepEqual(
        [result.data.actualStart, result.data.actualEndExclusive, result.data.nextOffset, result.data.line.first, result.data.line.last, result.data.boundary.ansiStateBefore, result.data.boundary.ansiStateAfter, result.data.revision],
        [5, 13, 17, 3, 4, '\x1b[31m', '\x1b[0m', 'rev-1'],
    );
});

test('ANSI parser continues split SGR, strips OSC/cursor/erase/hyperlink, and preserves emoji', () => {
    const first = parseAnsiChunk('before\x1b[3');
    assert.equal(first.pending, '\x1b[3');
    const second = parseAnsiChunk('1mred🙂\x1b]8;;https://bad.invalid\x07link\x1b]8;;\x07\x1b[2J\x1b[10H', first.state, first.pending);
    assert.deepEqual(second.tokens, [
        { text: 'red🙂', fg: 'red' },
        { text: 'link', fg: 'red' },
    ]);
    assert.equal(second.state, '\x1b[31m');
    assert.equal(second.pending, '');
});

test('fixture byte slicing never splits emoji and line index matches byte ground truth', () => {
    const text = '첫줄🙂\n둘째 한글\nthird';
    const emoji = Buffer.from(text).indexOf(Buffer.from('🙂'));
    const slice = sliceToolDetailUtf8(text, emoji + 2, 9);
    assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(slice.text)));
    const lines = indexInlineLines(text);
    for (const offset of [0, emoji, emoji + 4, Buffer.byteLength(text)]) {
        assert.equal(lineAtByteOffset(lines, offset)?.line, fixtureLineAtByteOffset(text, offset));
    }
    assert.equal(projectSparseLine([
        { offset: 0, endExclusive: 10, text: 'a', firstLine: 1, lastLine: 3 },
        { offset: 100, endExclusive: 120, text: 'b', firstLine: 10, lastLine: 12 },
    ], 11)?.offset, 100);
});

test('10MB fixture is deterministic and mixes required payload families', () => {
    const a = generateToolDetail10Mb();
    const b = generateToolDetail10Mb();
    assert.equal(a, b);
    assert.ok(Buffer.byteLength(a) >= 10 * 1024 * 1024);
    assert.match(a, /\x1b\[3[0-7]m/);
    assert.match(a, /한글🙂/);
    assert.match(a, /@@ -/);
    assert.equal(TOOL_DETAIL_SCENARIOS.gone.status, 410);
});

test('T3 grace reuses entries, pressure evicts grace, pins survive, and dispose clears', () => {
    let clock = 1_000;
    const store = createTurnStore('detail-t3', { t3MaxBytes: 260, now: () => clock });
    store.putDetail('reuse', 'x'.repeat(40), true);
    store.collapseDetail('reuse', clock + 60_000);
    assert.equal(store.getDetail('reuse'), 'x'.repeat(40));
    clock += 30_000;
    store.touchDetail('reuse');
    assert.equal(store.getDetail('reuse'), 'x'.repeat(40));
    store.putDetail('pressure', 'y'.repeat(100));
    assert.equal(store.hasDetail('reuse'), false, 'oldest unpinned grace entry yields to pressure');
    store.putDetail('pinned', 'z'.repeat(60));
    store.pinDetail('pinned', 'copy');
    store.putDetail('victim', 'v'.repeat(100));
    assert.equal(store.hasDetail('pinned'), true);
    store.dispose();
    assert.equal(store.detailBytes(), 0);
    assert.equal(store.hasDetail('pinned'), false);
});

test('loader migrates pending identity to deterministic full-content hash', async () => {
    const store = createTurnStore('loader-hash');
    const controller = getDetailController(store, { traceRunId: 'run', traceSeq: 1 }, { apiBase: TEST_API_BASE, fetcher: fetcher([full('한글🙂\nbody')]) });
    const snapshot = await controller.open();
    assert.equal(snapshot.phase, 'ready-inline');
    assert.match(snapshot.resolvedRevision ?? '', /^fnv1a-[0-9a-f]{8}-\d+$/);
    assert.equal(store.hasDetail('run#1@pending'), false);
    assert.equal(store.hasDetail(`run#1@${snapshot.resolvedRevision}`), true);
});

test('loader keeps 404, 410, and repeated 409 distinct', async () => {
    for (const [status, error, phase] of [
        [404, 'trace_event_not_found', 'unavailable'],
        [410, 'trace_payload_gone', 'gone'],
    ] as const) {
        const store = createTurnStore(`loader-${status}`);
        const controller = getDetailController(store, { traceRunId: `run-${status}`, traceSeq: 1 }, { apiBase: TEST_API_BASE, fetcher: fetcher([response(status, { ok: false, error })]) });
        assert.equal((await controller.open()).phase, phase);
    }
    const store = createTurnStore('loader-409');
    const controller = getDetailController(store, { traceRunId: 'run-409', traceSeq: 1 }, { apiBase: TEST_API_BASE, fetcher: fetcher([
        response(413, { ok: false, error: 'trace_detail_range_required', totalBytes: 99, rangeAvailable: true, chunkSize: 10 }),
        response(409, { ok: false, error: 'trace_payload_revision_changed' }),
        response(413, { ok: false, error: 'trace_detail_range_required', totalBytes: 100, rangeAvailable: true, chunkSize: 10 }),
    ]) });
    assert.equal((await controller.open()).phase, 'stale-revision');
});

test('abort and generation guard prevent stale commits', async () => {
    let resolve!: (value: Response) => void;
    const delayed = new Promise<Response>(yes => { resolve = yes; });
    const store = createTurnStore('loader-abort');
    const controller = getDetailController(store, { traceRunId: 'abort', traceSeq: 1 }, {
        apiBase: TEST_API_BASE,
        fetcher: fetcher([async () => delayed]),
    });
    const pending = controller.open();
    controller.abort();
    resolve(full('late'));
    await pending;
    assert.equal(store.hasDetail('abort#1@pending'), false);
    assert.equal(controller.snapshot().phase === 'ready-inline', false);
});

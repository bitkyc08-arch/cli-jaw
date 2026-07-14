import assert from 'node:assert/strict';
import test from 'node:test';
import { findDetailMatches } from '../../public/dashboard2/src/turn-stream/detail/detail-find.worker.ts';
import { navigateToToolHit, resetToolSearchCapability, searchToolOutput } from '../../public/dashboard2/src/turn-stream/detail/detail-search.ts';
import { copyFullDetail, DetailCopyError } from '../../public/dashboard2/src/turn-stream/detail/detail-copy.ts';

test('find worker returns generation, line and offsets', () => {
    assert.deepEqual(findDetailMatches({ text: 'one\ntwo one', query: 'one', generation: 7 }), { generation: 7, matches: [{ line: 1, start: 0, end: 3 }, { line: 2, start: 8, end: 11 }] });
});

test('search probes once then remains resident-only without spill fetch', async () => {
    resetToolSearchCapability(); let calls = 0;
    const fetcher = async (): Promise<Response> => { calls += 1; return new Response('', { status: 404 }); };
    assert.equal((await searchToolOutput('resident', 'resident only', fetcher)).mode, 'resident');
    assert.equal((await searchToolOutput('only', 'resident only', fetcher)).mode, 'resident');
    assert.equal(calls, 1);
});

test('hit navigation preserves hydrate-scroll-focus-expand-seek order', async () => {
    const order: string[] = []; const hit = { turnId: 't', turnSeq: 1, detailRef: {}, snippet: 'x' };
    await navigateToToolHit(hit, { hydrate: async () => { order.push('hydrate'); }, scroll: async () => { order.push('scroll'); }, focus: () => { order.push('focus'); }, expand: async () => { order.push('expand'); }, seek: async () => { order.push('seek'); } });
    assert.deepEqual(order, ['hydrate', 'scroll', 'focus', 'expand', 'seek']);
});

function controller(chunks: Array<{ ok: boolean; text?: string; next?: number; error?: string }>) {
    const pins: string[] = []; let index = 0;
    return { pins, controller: { open: async () => {}, snapshot: () => ({ phase: 'ready-ranged', resolvedRevision: 'r', totalBytes: 4, lineCount: 1, chunks: [], error: undefined }), pin: (reason: string) => pins.push(`pin:${reason}`), unpin: (reason: string) => pins.push(`unpin:${reason}`), loadRange: async (offset: number) => { const item = chunks[index++]!; return item.ok ? { ok: true, chunk: { offset, endExclusive: item.next!, text: item.text!, firstLine: 1, lastLine: 1 }, nextOffset: item.next } : { ok: false, error: item.error }; } } };
}

test('copy is all-or-nothing and balances copy pin', async () => {
    const fixture = controller([{ ok: true, text: 'ab', next: 2 }, { ok: false, error: 'gone' }]); let writes = 0;
    await assert.rejects(copyFullDetail(fixture.controller as never, { clipboard: { writeText: async () => { writes += 1; } } }), (error: unknown) => error instanceof DetailCopyError && error.offset === 2);
    assert.equal(writes, 0); assert.deepEqual(fixture.pins, ['pin:copy', 'unpin:copy']);
});

test('copy cancellation never writes and balances copy pin', async () => {
    const fixture = controller([{ ok: true, text: 'abcd', next: 4 }]); const abort = new AbortController(); abort.abort(); let writes = 0;
    await assert.rejects(copyFullDetail(fixture.controller as never, { signal: abort.signal, clipboard: { writeText: async () => { writes += 1; } } }), { name: 'AbortError' });
    assert.equal(writes, 0); assert.deepEqual(fixture.pins, ['pin:copy', 'unpin:copy']);
});

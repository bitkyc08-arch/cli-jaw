import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTraceDetail, workerApiBase, workerApiUrl } from '../../public/dashboard2/src/turn-stream/detail/detail-client.ts';
import { readSource } from './source-normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const read = (path: string): string => readSource(join(projectRoot, path), 'utf8');

test('worker URL helper validates port and worker-owned API paths', () => {
    assert.equal(workerApiBase(3457), '/i/3457');
    assert.equal(workerApiUrl(3457, '/api/link-preview?url=x'), '/i/3457/api/link-preview?url=x');
    assert.throws(() => workerApiBase(0), /Invalid worker port/);
    assert.throws(() => workerApiBase(1.5), /Invalid worker port/);
    assert.throws(() => workerApiUrl(3457, '/manager/local'), /must start with \/api\//);
});

test('trace full and range requests use the explicit worker base', async () => {
    const calls: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ ok: true, data: {
            runId: 'run', seq: 2, totalBytes: 1, requestedOffset: 0, requestedLimit: 1,
            actualStart: 0, actualEndExclusive: 1, nextOffset: null, eof: true, text: 'x',
            contentEncoding: 'utf-8', line: { first: 1, last: 1, indexStrideBytes: 65536 },
            boundary: { utf8Adjusted: false, startsAtLineBoundary: true, ansiStateBefore: null, ansiStateAfter: null }, revision: 'r1',
        } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    await fetchTraceDetail('run', 2, { apiBase: workerApiBase(3457), fetcher });
    await fetchTraceDetail('run', 2, { apiBase: workerApiBase(3457), offset: 0, limit: 1, fetcher });
    assert.deepEqual(calls, [
        '/i/3457/api/traces/run/events/2',
        '/i/3457/api/traces/run/events/2?offset=0&limit=1',
    ]);
    await assert.rejects(() => fetchTraceDetail('run', 2, { fetcher }), /Worker API base is required/);
});

test('ChatView injects workerPort through RenderActionPorts only', () => {
    const provider = read('public/dashboard2/src/providers/render-action-ports.tsx');
    const chat = read('public/dashboard2/src/chat/ChatView.tsx');
    assert.match(provider, /workerPort:\s*number \| null/);
    assert.match(provider, /workerPort:\s*null/);
    assert.match(chat, /workerPort:\s*scope\.port/);
    assert.doesNotMatch(chat, /workerPort=\{/);
});

test('all three detail-controller creation sites use the context worker base', () => {
    const turnRow = read('public/dashboard2/src/turn-stream/components/TurnRow.tsx');
    const liveTail = read('public/dashboard2/src/turn-stream/live/LiveTurnTail.tsx');
    assert.equal((turnRow.match(/getDetailController\(/g) ?? []).length, 1);
    assert.equal((liveTail.match(/getDetailController\(/g) ?? []).length, 2);
    for (const source of [turnRow, liveTail]) {
        assert.match(source, /useRenderActionPorts\(\)/);
        assert.match(source, /workerPort !== null/);
    }
    assert.equal((`${turnRow}\n${liveTail}`.match(/apiBase:\s*workerApiBase\(workerPort\)/g) ?? []).length, 3);
});

test('link preview metadata, image, and cache are port-scoped without manager fallback', () => {
    const source = read('public/dashboard2/src/turn-stream/render/links/LinkPreviewCard.tsx');
    assert.match(source, /useRenderActionPorts\(\)/);
    assert.match(source, /workerApiUrl\(workerPort, `\/api\/link-preview\?/);
    assert.match(source, /workerApiUrl\(workerPort, `\/api\/link-preview\/image\?/);
    assert.match(source, /const cacheKey = `\$\{workerPort\}:\$\{url\}`/);
    assert.match(source, /workerPort === null/);
    assert.doesNotMatch(source, /fetch\(`\/api\/link-preview/);
});

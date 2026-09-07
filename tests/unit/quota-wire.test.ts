import test from 'node:test';
import assert from 'node:assert/strict';
import { asQuotaRecord, quotaNumber, quotaPercent, quotaResetIso, readQuotaBytes, readQuotaJson } from '../../src/routes/quota-wire.ts';

test('quota values preserve observed fractions and reject absent/nonfinite readings', () => {
    for (const value of [undefined, null, '', ' ', true, {}, NaN, Infinity, 'wat']) {
        assert.equal(quotaNumber(value), undefined);
        assert.equal(quotaPercent(value), undefined);
    }
    assert.equal(quotaNumber('0'), 0);
    assert.equal(quotaPercent('12.345'), 12.345);
    assert.equal(quotaPercent(-1), 0);
    assert.equal(quotaPercent(101), 100);
    assert.equal(asQuotaRecord([]), null);
    assert.equal(asQuotaRecord(null), null);
    assert.deepEqual(asQuotaRecord({ n: 0 }), { n: 0 });
});

test('reset dates normalize epoch strings and follow reference threshold', () => {
    const expected = '2030-01-01T00:00:00.000Z';
    for (const value of [1893456000, '1893456000', 1893456000000, '1893456000000', expected]) {
        assert.equal(quotaResetIso(value), expected);
    }
    assert.equal(quotaResetIso(10000000001), '1970-04-26T17:46:40.001Z');
    for (const value of [0, -1, NaN, Infinity, 1e30, '', 'garbage', null, {}, '1970-01-01']) {
        assert.equal(quotaResetIso(value), null);
    }
});

test('JSON reader accepts the exact byte boundary and rejects streamed overflow', async () => {
    const exact = '"' + 'a'.repeat(512 * 1024 - 2) + '"';
    assert.equal((await readQuotaJson(new Response(exact)) as string).length, 512 * 1024 - 2);
    await assert.rejects(readQuotaJson(new Response(exact + ' ')), /size limit/);
    await assert.rejects(readQuotaJson(new Response('not-json')), SyntaxError);
    await assert.rejects(readQuotaJson(new Response(new Uint8Array([0xff]))), TypeError);
    await assert.rejects(readQuotaJson(new Response(null)), /no body/);
});

test('declared oversize and dishonest streaming sizes cancel the producer', async () => {
    let declaredCancelled = false;
    const declared = new Response(new ReadableStream({
        cancel() { declaredCancelled = true; },
    }), { headers: { 'content-length': String(512 * 1024 + 1) } });
    await assert.rejects(readQuotaBytes(declared), /size limit/);
    assert.equal(declaredCancelled, true);

    let streamedCancelled = false;
    const streamed = new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array(512 * 1024));
            controller.enqueue(new Uint8Array(1));
        },
        cancel() { streamedCancelled = true; },
    }), { headers: { 'content-length': '1' } });
    await assert.rejects(readQuotaBytes(streamed), /size limit/);
    assert.equal(streamedCancelled, true);
});

test('stalled stream rejects by deadline even when producer cancellation never resolves', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
        cancel() {
            cancelled = true;
            return new Promise<void>(() => undefined);
        },
    }));
    await assert.rejects(readQuotaJson(response, 5), /timed out/);
    assert.equal(cancelled, true);
});

test('byte reader preserves protobuf bytes and joins chunks without text conversion', async () => {
    const response = new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array([0, 255]));
            controller.enqueue(new Uint8Array([128, 1]));
            controller.close();
        },
    }));
    assert.deepEqual(await readQuotaBytes(response), new Uint8Array([0, 255, 128, 1]));
});


test('continuously ready chunks cannot starve the total deadline timer', async () => {
    const response = new Response(new ReadableStream({
        start(controller) {
            for (let i = 0; i < 50000; i++) controller.enqueue(new Uint8Array([32]));
            controller.close();
        },
    }));
    await assert.rejects(readQuotaBytes(response, 1), /timed out/);
});

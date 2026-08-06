import test from 'node:test';
import assert from 'node:assert/strict';

import { recoverSlackAttachments } from '../../src/slack/attachment-recovery.ts';

type Call = { url: string; body: string };

function harness(messages: unknown[], calls: Call[] = [], ok = true) {
    const fetchImpl = (async (input: unknown, init?: { body?: unknown }) => {
        calls.push({ url: String(input), body: String(init?.body ?? '') });
        return new Response(
            JSON.stringify(ok ? { ok: true, messages } : { ok: false, error: 'channel_not_found' }),
            { headers: { 'content-type': 'application/json' } },
        );
    }) as unknown as Parameters<typeof recoverSlackAttachments>[3] extends { fetchImpl?: infer F } ? F : never;
    return { fetchImpl, calls };
}

const FILES = [{ id: 'F1', name: 'a.png' }, { id: 'F2', name: 'b.png' }];

test('SAR-001: history lookup sends inclusive=true and limit=1', async () => {
    // 회귀 근거: oldest/latest 는 배타적이라 inclusive 없이는 대상 메시지가
    // 결과에서 빠지고 복구가 영구히 빈 배열을 돌려준다. 스텁은 이 실수를
    // 잡지 못하므로 실제 전송된 요청 바디를 단언한다.
    const calls: Call[] = [];
    const { fetchImpl } = harness([{ ts: '111.1', text: '', files: FILES }], calls);
    const files = await recoverSlackAttachments('xoxb-x', 'C1', '111.1', { fetchImpl });

    assert.equal(files.length, 2);
    assert.deepEqual(files.map(f => f.id), ['F1', 'F2']);

    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /conversations\.history$/);
    const params = new URLSearchParams(calls[0]!.body);
    assert.equal(params.get('inclusive'), 'true');
    assert.equal(params.get('oldest'), '111.1');
    assert.equal(params.get('limit'), '1');
    assert.equal(params.get('latest'), null, 'latest must not be sent — it would re-introduce the exclusive-bound bug');
});

test('SAR-002: a thread message uses conversations.replies', async () => {
    const calls: Call[] = [];
    const { fetchImpl } = harness([
        { ts: '100.0', text: 'root' },
        { ts: '111.1', text: '', files: [FILES[0]] },
    ], calls);
    const files = await recoverSlackAttachments('xoxb-x', 'C1', '111.1', { threadTs: '100.0', fetchImpl });

    assert.deepEqual(files.map(f => f.id), ['F1']);
    assert.match(calls[0]!.url, /conversations\.replies$/);
    assert.equal(new URLSearchParams(calls[0]!.body).get('ts'), '100.0');
});

test('SAR-003: a ts that does not match returns empty', async () => {
    const { fetchImpl } = harness([{ ts: '999.9', text: 'other', files: FILES }]);
    assert.deepEqual(await recoverSlackAttachments('xoxb-x', 'C1', '111.1', { fetchImpl }), []);
});

test('SAR-004: a message without files returns empty', async () => {
    const { fetchImpl } = harness([{ ts: '111.1', text: 'text only' }]);
    assert.deepEqual(await recoverSlackAttachments('xoxb-x', 'C1', '111.1', { fetchImpl }), []);
});

test('SAR-005: an API failure never throws', async () => {
    const { fetchImpl } = harness([], [], false);
    assert.deepEqual(await recoverSlackAttachments('xoxb-x', 'C1', '111.1', { fetchImpl }), []);
});

test('SAR-006: a rejected fetch never throws', async () => {
    const boom = (async () => { throw new Error('socket hang up'); }) as never;
    assert.deepEqual(await recoverSlackAttachments('xoxb-x', 'C1', '111.1', { fetchImpl: boom }), []);
});

test('SAR-007: missing identifiers short-circuit without any API call', async () => {
    const calls: Call[] = [];
    const { fetchImpl } = harness([], calls);
    assert.deepEqual(await recoverSlackAttachments('', 'C1', '111.1', { fetchImpl }), []);
    assert.deepEqual(await recoverSlackAttachments('xoxb-x', '', '111.1', { fetchImpl }), []);
    assert.deepEqual(await recoverSlackAttachments('xoxb-x', 'C1', '', { fetchImpl }), []);
    assert.equal(calls.length, 0);
});

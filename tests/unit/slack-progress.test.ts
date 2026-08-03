// The "정보 수집 중…" status message: posted once, edited in place, deleted
// when the answer lands. Slack gives bots no typing indicator, so this is the
// only progress surface — and it must never double-post or throw.
import test from 'node:test';
import assert from 'node:assert/strict';

import { startSlackProgress, statusFromToolEvent, truncateStatus } from '../../src/slack/progress.ts';

type Call = { method: string; body: Record<string, unknown> };

function fakeSlack(overrides: Record<string, unknown> = {}) {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        const method = String(url).split('/').pop() || '';
        calls.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
        const payload = method === 'chat.postMessage'
            ? { ok: true, ts: '111.222', ...overrides }
            : { ok: true };
        return { ok: true, text: async () => JSON.stringify(payload) } as Response;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
}

const target = { channel: 'slack' as const, targetId: 'C1', chatId: 'C1' } as never;

test('the status line is trimmed to one short line', () => {
    assert.equal(truncateStatus('  a\n\n  b  '), 'a b');
    assert.equal(truncateStatus('x'.repeat(200)).length, 140);
});

test('tool events become readable status text, empty ones are ignored', () => {
    assert.equal(statusFromToolEvent({ label: 'Read', detail: 'src/app.ts' }, 'Working'), 'Read — src/app.ts');
    assert.equal(statusFromToolEvent({ detail: 'only detail' }, 'Working'), 'Working — only detail');
    assert.equal(statusFromToolEvent({}, 'Working'), null);
});

test('a placeholder is posted once and removed on finish', async () => {
    const { calls, fetchImpl } = fakeSlack();
    const progress = await startSlackProgress('xoxb-1', target, '정보 수집 중...', { fetchImpl });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'chat.postMessage');
    assert.equal(calls[0]?.body['text'], '정보 수집 중...');

    await progress.finish();
    const methods = calls.map(c => c.method);
    assert.deepEqual(methods, ['chat.postMessage', 'chat.delete']);
    assert.equal(calls[1]?.body['ts'], '111.222');
});

test('updates edit the same message instead of posting new ones', async () => {
    const { calls, fetchImpl } = fakeSlack();
    const progress = await startSlackProgress('xoxb-1', target, 'start', { fetchImpl });
    progress.update('Read — src/app.ts');
    await new Promise(r => setTimeout(r, 60));
    const updates = calls.filter(c => c.method === 'chat.update');
    assert.equal(updates.length, 1, 'exactly one edit for one update');
    assert.equal(updates[0]?.body['ts'], '111.222');
    assert.equal(calls.filter(c => c.method === 'chat.postMessage').length, 1, 'never a second message');
    await progress.finish();
});

test('bursty updates collapse to the latest text (rate limit safety)', async () => {
    const { calls, fetchImpl } = fakeSlack();
    const progress = await startSlackProgress('xoxb-1', target, 'start', { fetchImpl });
    progress.update('one');
    progress.update('two');
    progress.update('three');
    await new Promise(r => setTimeout(r, 60));
    const updates = calls.filter(c => c.method === 'chat.update');
    assert.equal(updates.length, 1, 'three rapid updates collapse into one edit');
    assert.equal(updates[0]?.body['text'], 'three', 'the newest status wins');
    await progress.finish();
});

test('updates after finish are dropped', async () => {
    const { calls, fetchImpl } = fakeSlack();
    const progress = await startSlackProgress('xoxb-1', target, 'start', { fetchImpl });
    await progress.finish();
    progress.update('late');
    await new Promise(r => setTimeout(r, 60));
    assert.equal(calls.filter(c => c.method === 'chat.update').length, 0);
});

test('a failed placeholder post degrades to no-op instead of throwing', async () => {
    const fetchImpl = (async () => ({ ok: true, text: async () => JSON.stringify({ ok: false, error: 'not_in_channel' }) } as Response)) as unknown as typeof fetch;
    const progress = await startSlackProgress('xoxb-1', target, 'start', { fetchImpl });
    assert.equal(progress.ts(), null);
    progress.update('anything');
    await progress.finish();
});

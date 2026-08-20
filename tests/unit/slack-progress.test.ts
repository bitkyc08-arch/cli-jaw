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

// ─── credentials never reach the channel (#408) ─────
//
// The final answer is masked inside chunkSlackMessage(). This transport calls
// slackApi directly and was not, so progress — which mirrors what the agent
// actually RAN — carried a bearer token to the channel verbatim.

// Structurally a token, not a real one: xoxb + the digit-group shape the
// redactor matches on.
const FAKE_BOT_TOKEN = `xoxb-${'1'.repeat(13)}-${'2'.repeat(13)}-${'a'.repeat(24)}`;

test('SPR-001: the placeholder post is masked', async () => {
    const { calls, fetchImpl } = fakeSlack();
    const progress = await startSlackProgress('xoxb-1', target, `curl -H "Authorization: Bearer ${FAKE_BOT_TOKEN}"`, { fetchImpl });
    const posted = String(calls[0]?.body['text'] ?? '');
    assert.ok(!posted.includes(FAKE_BOT_TOKEN), `the token must not reach Slack; saw: ${posted}`);
    assert.match(posted, /curl/, 'the rest of the status survives');
    await progress.finish();
});

test('SPR-002: every edit is masked, not just the first post', async () => {
    const { calls, fetchImpl } = fakeSlack();
    const progress = await startSlackProgress('xoxb-1', target, 'start', { fetchImpl });
    progress.update(`Bash — curl -H "Authorization: Bearer ${FAKE_BOT_TOKEN}" https://api`);
    await new Promise(r => setTimeout(r, 60));
    const edited = String(calls.find(c => c.method === 'chat.update')?.body['text'] ?? '');
    assert.ok(edited, 'an edit must have happened');
    assert.ok(!edited.includes(FAKE_BOT_TOKEN), `the token must not reach Slack; saw: ${edited}`);
    await progress.finish();
});

test('SPR-003: ordinary Korean progress text is not mangled', async () => {
    // Over-masking is the failure mode on the other side: a status line the
    // reader cannot read is its own bug.
    const { calls, fetchImpl } = fakeSlack();
    const status = '파일 3개 읽는 중 — src/app.ts, src/index.ts';
    const progress = await startSlackProgress('xoxb-1', target, status, { fetchImpl });
    assert.equal(calls[0]?.body['text'], status);
    await progress.finish();
});

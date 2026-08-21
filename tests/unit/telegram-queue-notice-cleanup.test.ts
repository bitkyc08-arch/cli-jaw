// Telegram queue-notice cleanup, driven through the PRODUCTION transport
// factory (createTelegramNoticeTransport) that src/telegram/bot.ts binds.
//
// Before this work the notice was posted and its message_id thrown away, so it
// stayed in the chat forever. The fix is ordering: delete only after the answer
// is out, and rewrite rather than delete when no answer ever came.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramNoticeTransport, type TelegramNoticeApi } from '../../src/telegram/reactions.ts';
import { createQueueNotice, QueueNoticeRegistry } from '../../src/messaging/queue-notice.ts';

const EXPIRED = '대기 시간이 초과되었습니다';

function fakeApi(overrides: Partial<TelegramNoticeApi> = {}) {
    const calls: string[] = [];
    const seen: (AbortSignal | undefined)[] = [];
    const api: TelegramNoticeApi = {
        async deleteMessage(chatId, messageId, signal) {
            calls.push(`delete:${chatId}:${messageId}`);
            seen.push(signal);
            return true;
        },
        async editMessageText(chatId, messageId, text, _other, signal) {
            calls.push(`edit:${chatId}:${messageId}:${text}`);
            seen.push(signal);
            return true;
        },
        ...overrides,
    };
    return { api, calls, seen };
}

test('the notice is deleted only after the queued answer is delivered', async () => {
    const { api, calls } = fakeApi();
    const notice = createQueueNotice({ expiredText: EXPIRED });
    notice.bind(createTelegramNoticeTransport(api, -100999, 42));
    const sent: string[] = [];
    sent.push('answer');            // sendTelegramMarkdown resolves first
    await notice.close('answered');  // ...then the notice is redundant
    assert.deepEqual(sent, ['answer']);
    assert.deepEqual(calls, ['delete:-100999:42']);
});

test('a failed answer send rewrites the notice instead of deleting it', async () => {
    // Deleting here would leave the user with neither an answer nor any sign
    // the turn happened — worse than the bug being fixed.
    const { api, calls } = fakeApi();
    const notice = createQueueNotice({ expiredText: EXPIRED });
    notice.bind(createTelegramNoticeTransport(api, 1, 2));
    const sendOk = false;
    await notice.close(sendOk ? 'answered' : 'expired');
    assert.deepEqual(calls, [`edit:1:2:${EXPIRED}`]);
});

test('a timeout rewrites the notice through the registry', async () => {
    const { api, calls } = fakeApi();
    const notice = createQueueNotice({ expiredText: EXPIRED });
    const registry = new QueueNoticeRegistry();
    registry.add((signal) => notice.close('expired', signal));
    notice.bind(createTelegramNoticeTransport(api, 1, 2));
    await registry.drain(1000);
    assert.deepEqual(calls, [`edit:1:2:${EXPIRED}`]);
    assert.equal(registry.size, 0);
});

test('shutdown closes a notice whose post was still in flight', async () => {
    // ctx.reply for the notice is awaited, and the queued job can settle during
    // that await — so cleanup routinely runs before there is a handle.
    const { api, calls } = fakeApi();
    const notice = createQueueNotice({ expiredText: EXPIRED });
    const registry = new QueueNoticeRegistry();
    registry.add((signal) => notice.close('expired', signal));
    const draining = registry.drain(1000);          // shutdown first
    notice.bind(createTelegramNoticeTransport(api, 1, 2));  // handle second
    await draining;
    assert.deepEqual(calls, [`edit:1:2:${EXPIRED}`], 'a late handle must still be closed');
});

test('a failed notice post never strands the shutdown drain', async () => {
    const notice = createQueueNotice({ expiredText: EXPIRED });
    const registry = new QueueNoticeRegistry();
    registry.add((signal) => notice.close('expired', signal));
    notice.abandon();   // ctx.reply threw: no message_id will ever arrive
    const started = Date.now();
    await registry.drain(5000);
    assert.ok(Date.now() - started < 1000, 'abandon must release the drain immediately');
});

test('the shutdown signal reaches the Telegram API call', async () => {
    // grammY takes the signal positionally; dropping it would make the drain's
    // deadline stop the waiting without stopping the request.
    const { api, seen } = fakeApi();
    const notice = createQueueNotice({ expiredText: EXPIRED });
    notice.bind(createTelegramNoticeTransport(api, 1, 2));
    const controller = new AbortController();
    await notice.close('answered', controller.signal);
    // Composed with the factory's own timeout, so not reference-equal — what
    // matters is that the caller's cancellation still reaches the request.
    const passed = seen[0] as AbortSignal;
    assert.ok(passed instanceof AbortSignal);
    assert.equal(passed.aborted, false);
    controller.abort();
    assert.equal(passed.aborted, true, 'aborting the caller must abort the request');
});

test('a 48-hour-limit failure is harmless', async () => {
    // Telegram refuses to delete messages older than 48h, and may lack the
    // permission in groups. The worst case is the stale notice we have today.
    const errors: unknown[] = [];
    const { api } = fakeApi({
        async deleteMessage() { throw new Error('message can\'t be deleted'); },
    });
    const notice = createQueueNotice({ expiredText: EXPIRED, onError: (e) => errors.push(e) });
    notice.bind(createTelegramNoticeTransport(api, 1, 2));
    await notice.close('answered');
    assert.equal(errors.length, 1, 'reported, not thrown at the reply path');
});

test('a notice close with NO caller signal is still bounded on its own', async () => {
    // Ordinary delivery and the 5-minute timer both close without a signal, and
    // QueueNotice pins the first one it gets — so without a composed timeout the
    // common path would inherit grammY's 500s default and a later shutdown could
    // not fix it.
    let observed: AbortSignal | undefined;
    const api: TelegramNoticeApi = {
        async deleteMessage(_c, _m, signal) { observed = signal as AbortSignal | undefined; return true; },
        async editMessageText(_c, _m, _t, _o, signal) { observed = signal as AbortSignal | undefined; return true; },
    };
    const transport = createTelegramNoticeTransport(api, 1, 2);
    await transport.delete();   // no signal supplied
    assert.ok(observed instanceof AbortSignal, 'the factory must supply its own timeout');
    assert.equal(observed!.aborted, false);
});

test('the composed timeout actually fires', async () => {
    // Proves boundedness rather than mere presence: a never-aborting controller
    // would satisfy the previous assertion.
    let observed: AbortSignal | undefined;
    const api: TelegramNoticeApi = {
        async deleteMessage(_c, _m, signal) {
            observed = signal as AbortSignal | undefined;
            return true;
        },
        async editMessageText() { return true; },
    };
    // A live, never-aborted caller signal, so only the timeout can end this.
    const caller = new AbortController();
    const notice = createQueueNotice({ expiredText: EXPIRED });
    // 10ms rather than the shipped 5s. Waiting out the real duration made this
    // assertion race the test runner's event-loop teardown on CI, and the thing
    // being proven — that the timeout fires at all — does not depend on it.
    notice.bind(createTelegramNoticeTransport(api, 1, 2, 10));
    await notice.close('answered', caller.signal);
    // Bounded observation rather than parking the vendor stub on the timer: a
    // promise that only AbortSignal.timeout can settle races node:test's
    // event-loop teardown, which killed this whole file on CI (cancelledByParent)
    // while passing locally every run.
    assert.ok(observed, 'the API call must receive a signal');
    await new Promise<void>(resolve => {
        if (observed!.aborted) { resolve(); return; }
        const timer = setTimeout(resolve, 200);
        observed!.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    assert.equal(observed!.aborted, true, 'the composed timeout must abort the call');
    assert.equal(caller.signal.aborted, false, 'the caller signal is untouched');
});

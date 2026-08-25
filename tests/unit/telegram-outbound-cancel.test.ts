// Telegram outbound cancellation (#417, L2).
//
// createIpv4Fetch already honours init.signal and DESTROYS the request on abort.
// What was missing is a caller that supplies one: sendTelegramMarkdown took no
// signal, so every send below it was unbounded no matter how good the adapter was.
//
// grammY takes the signal as its LAST positional argument, which is why these
// assertions read it off the call record rather than an options object.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sendTelegramMarkdown } from '../../src/telegram/rich-message.ts';

type Call = { chunk: string; signal: unknown };

function richApi(onSend?: (chunk: string, signal: AbortSignal | undefined) => void) {
    const calls: Call[] = [];
    const api = {
        sendRichMessage: async (_chatId: unknown, payload: { markdown: string }, _opts: unknown, signal?: AbortSignal) => {
            calls.push({ chunk: payload.markdown, signal });
            onSend?.(payload.markdown, signal);
            return {};
        },
        sendMessage: async (_chatId: unknown, text: string, _opts: unknown, signal?: AbortSignal) => {
            calls.push({ chunk: text, signal });
            onSend?.(text, signal);
            return {};
        },
    } as unknown as Parameters<typeof sendTelegramMarkdown>[0];
    return { api, calls };
}

test('the caller signal reaches the rich send', async () => {
    const controller = new AbortController();
    const { api, calls } = richApi();

    await sendTelegramMarkdown(api, 1, 'hello', { signal: controller.signal });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.signal, controller.signal,
        'grammy takes the signal positionally; dropping it makes every bound below a lie');
});

test('an already-aborted signal sends nothing at all', async () => {
    const { api, calls } = richApi();

    await sendTelegramMarkdown(api, 1, 'hello', { signal: AbortSignal.abort() });

    assert.equal(calls.length, 0, 'a turn that is already cancelled must not reach the vendor');
});

test('a multi-chunk answer stops at the chunk boundary once aborted', async () => {
    const controller = new AbortController();
    // Two chunks: abort during the first, so the second must never be sent.
    const { api, calls } = richApi((_chunk, _signal) => { controller.abort(); });
    const long = 'x'.repeat(40_000);

    await sendTelegramMarkdown(api, 1, long, { signal: controller.signal });

    assert.equal(calls.length, 1,
        'the chunk loop must re-check the signal; otherwise shutdown still posts the rest');
});

test('no signal keeps the previous behaviour', async () => {
    const { api, calls } = richApi();
    await sendTelegramMarkdown(api, 1, 'hello');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.signal, undefined);
});

test('the signal also reaches the HTML fallback leg', async () => {
    const controller = new AbortController();
    const calls: Call[] = [];
    // No sendRichMessage: an older grammy build falls straight to sendMessage.
    const api = {
        sendMessage: async (_chatId: unknown, text: string, _opts: unknown, signal?: AbortSignal) => {
            calls.push({ chunk: text, signal });
            return {};
        },
    } as unknown as Parameters<typeof sendTelegramMarkdown>[0];

    await sendTelegramMarkdown(api, 1, 'hello', { signal: controller.signal });

    assert.ok(calls.length >= 1);
    assert.equal(calls[0]?.signal, controller.signal,
        'the fallback path is the one older deployments actually use');
});


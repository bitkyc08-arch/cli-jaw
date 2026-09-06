import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let formatted: string[] = [];
mock.module('../../src/slack/format.ts', { namedExports: {
    toMrkdwn: (text: string) => text,
    chunkSlackMessage: () => formatted,
} });
mock.module('../../src/discord/forwarder.ts', { namedExports: {
    chunkDiscordMessage: () => formatted,
} });
mock.module('../../src/telegram/forwarder.ts', { namedExports: {
    markdownToTelegramHtml: (text: string) => text,
    chunkTelegramMessage: () => formatted,
} });
const { sendSlackText } = await import('../../src/slack/send-only-client.ts');
const { sendDiscordTextRest } = await import('../../src/discord/send-only-client.ts');
const { sendTelegramMarkdown } = await import('../../src/telegram/rich-message.ts');
const target = { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C1' } as const;

for (const chunks of [[], [' ', '\n']]) {
    test(`native Slack/Discord formatter ${JSON.stringify(chunks)} cannot report delivery`, async () => {
        formatted = chunks;
        const calls: string[] = [];
        const fetchImpl = async () => { calls.push('slack'); return new Response(JSON.stringify({ ok: true })); };
        const scheduler = { schedule: async () => { calls.push('discord'); return { ok: true }; } };
        assert.equal((await sendSlackText('fake', target, 'nonempty input', { fetchImpl, requireBodyDelivery: true })).ok, false);
        assert.deepEqual(await sendDiscordTextRest('fake', 'C1', 'nonempty input', {
            scheduler: scheduler as never, requireBodyDelivery: true,
        }), { ok: false, status: 400, error: 'discord_empty_message',
            failure: { kind: 'format', retryAfterMs: 0, code: 'empty_message', message: 'discord_empty_message' } });
        assert.deepEqual(calls, []);
        // Default-false callers retain exact prior loop behavior, including zero iterations.
        assert.equal((await sendSlackText('fake', target, 'input', { fetchImpl })).ok, true);
        assert.equal((await sendDiscordTextRest('fake', 'C1', 'input', { scheduler: scheduler as never })).ok, true);
        assert.deepEqual(calls, [...chunks.map(() => 'slack'), ...chunks.map(() => 'discord')]);
    });
}

test('nonempty native formatter sends the same chunks and wire options as legacy', async () => {
    formatted = ['one', 'two'];
    const capture = async (requireBodyDelivery?: boolean) => {
        const calls: unknown[] = [];
        await sendSlackText('fake', target, 'input', { requireBodyDelivery, fetchImpl: async (_url, init) => {
            calls.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ ok: true }));
        } });
        await sendDiscordTextRest('fake', 'C1', 'input', { requireBodyDelivery, scheduler: {
            schedule: async (request: { makeInit(): RequestInit }) => {
                calls.push(JSON.parse(String(request.makeInit().body))); return { ok: true };
            },
        } as never });
        return calls;
    };
    assert.deepEqual(await capture(true), await capture());
});

test('Telegram native guard covers rich, HTML-only and rich-to-HTML empty bodies', async () => {
    const calls: string[] = [];
    const sendMessage = async () => { calls.push('html'); return {}; };
    const error = { code: 'empty_message', status: 400 };
    await assert.rejects(sendTelegramMarkdown({ sendRichMessage: async () => { calls.push('rich'); }, sendMessage } as never,
        1, ' \n', { requireBodyDelivery: true }), error);
    assert.deepEqual(calls, []);
    for (formatted of [[], [' \n']]) {
        await assert.rejects(sendTelegramMarkdown({ sendMessage } as never, 1, 'answer', { requireBodyDelivery: true }), error);
        assert.deepEqual(calls, []);
        await assert.rejects(sendTelegramMarkdown({ sendMessage, sendRichMessage: async () => {
            calls.push('rich'); throw Object.assign(new Error('parse entities'), { error_code: 400 });
        } } as never, 1, 'answer', { requireBodyDelivery: true }), error);
        assert.deepEqual(calls.splice(0), ['rich']);
    }
});

test('Telegram tag-stripped plaintext guard stops the last fallback leg, not an abort', async () => {
    formatted = ['<b></b>'];
    const calls: string[] = [];
    const api = { sendMessage: async (_chat: unknown, body: string, options: { parse_mode?: string } | undefined) => {
        calls.push(`${options?.parse_mode ?? 'plain'}:${body}`);
        if (options?.parse_mode) throw Object.assign(new Error('parse entities'), { error_code: 400 });
        return {};
    } };
    await assert.rejects(sendTelegramMarkdown(api as never, 1, 'answer', { requireBodyDelivery: true }),
        { message: 'telegram_empty_message', code: 'empty_message', status: 400 });
    assert.deepEqual(calls.splice(0), ['HTML:<b></b>']);
    assert.equal((await sendTelegramMarkdown(api as never, 1, 'answer')).ok, true);
    assert.deepEqual(calls, ['HTML:<b></b>', 'plain:']);
});

test('Telegram native option never enters vendor options and preserves nonempty leg order', async () => {
    formatted = ['answer'];
    const capture = async (requireBodyDelivery?: boolean) => {
        const calls: unknown[] = [];
        const api = {
            sendRichMessage: async (_chat: unknown, body: unknown, opts: unknown) => {
                calls.push(['rich', body, opts]); throw Object.assign(new Error('parse entities'), { error_code: 400 });
            },
            sendMessage: async (_chat: unknown, body: unknown, opts: unknown) => { calls.push(['html', body, opts]); },
        };
        assert.equal((await sendTelegramMarkdown(api as never, 1, 'answer', { message_thread_id: 42, requireBodyDelivery })).ok, true);
        return calls;
    };
    assert.deepEqual(await capture(true), await capture());
});

for (const leg of ['rich', 'HTML', 'plain']) {
    test(`Telegram receipt fires only after successful ${leg} body, never in vendor options`, async () => {
        formatted = ['answer'];
        const order: string[] = [];
        const formatError = Object.assign(new Error('cannot parse entities'), { error_code: 400 });
        const options: unknown[] = [];
        const api = {
            sendRichMessage: async (_chat: unknown, _body: unknown, opts: unknown) => {
                order.push('rich'); options.push(opts);
                if (leg !== 'rich') throw formatError;
                order.push('accepted:rich');
            },
            sendMessage: async (_chat: unknown, _body: unknown, opts?: { parse_mode?: string }) => {
                const method = opts?.parse_mode ?? 'plain';
                order.push(method); options.push(opts);
                if (method === 'HTML' && leg === 'plain') throw formatError;
                order.push(`accepted:${method}`);
            },
        };
        assert.deepEqual(await sendTelegramMarkdown(api as never, 1, 'answer', {
            message_thread_id: 42, requireBodyDelivery: true,
            onBodyDelivered: () => { order.push('receipt'); },
            onBodyDeliveryFailed: () => { assert.fail('successful body must not invalidate receipt'); },
        }), { ok: true });
        assert.equal(order.filter(x => x === 'receipt').length, 1);
        assert.deepEqual(order.slice(-2), [`accepted:${leg}`, 'receipt']);
        for (const value of options) {
            assert.deepEqual(value, value && 'parse_mode' in (value as object)
                ? { message_thread_id: 42, parse_mode: 'HTML' } : { message_thread_id: 42 });
        }
    });
}

test('Telegram observer does not count zero chunks, whitespace, failed formats or aborted sends', async () => {
    let receipts = 0;
    const observe = () => { receipts++; };
    const formatError = Object.assign(new Error('cannot parse entities'), { error_code: 400 });
    formatted = [];
    assert.deepEqual(await sendTelegramMarkdown({ sendMessage: async () => assert.fail('zero chunks') } as never,
        1, 'answer', { onBodyDelivered: observe }), { ok: true });
    formatted = ['answer'];
    const reject = async () => { throw formatError; };
    // Preserve the legacy all-format-rejected outcome, but it cannot mint a receipt.
    assert.deepEqual(await sendTelegramMarkdown({ sendRichMessage: reject, sendMessage: reject } as never,
        1, 'answer', { onBodyDelivered: observe }), { ok: true });
    const controller = new AbortController();
    const aborting = { sendRichMessage: async () => { controller.abort(); throw new Error('aborted'); }, sendMessage: reject };
    assert.deepEqual(await sendTelegramMarkdown(aborting as never, 1, 'answer', {
        signal: controller.signal, onBodyDelivered: observe,
    }), { ok: false, aborted: true });
    assert.equal(receipts, 0);
    await sendTelegramMarkdown({ sendRichMessage: async () => {}, sendMessage: reject } as never,
        1, ' \n', { onBodyDelivered: observe });
    assert.equal(receipts, 0);
});

test('Telegram native all-format rejection throws original final error without another attempt', async () => {
    formatted = ['answer'];
    const formatError = Object.assign(new Error('cannot parse entities: final plaintext rejected'), { error_code: 400 });
    const attempts: string[] = [];
    let receipts = 0;
    const api = {
        sendRichMessage: async () => { attempts.push('rich'); throw formatError; },
        sendMessage: async (_chat: unknown, _body: unknown, opts?: { parse_mode?: string }) => {
            attempts.push(opts?.parse_mode ?? 'plain'); throw formatError;
        },
    };
    await assert.rejects(sendTelegramMarkdown(api as never, 1, 'answer', {
        requireBodyDelivery: true, onBodyDelivered: () => { receipts++; },
    }), error => error === formatError);
    assert.deepEqual(attempts, ['rich', 'HTML', 'plain']);
    assert.equal(receipts, 0);
});

test('Telegram native rejects a later failed plaintext chunk even after an earlier body landed', async () => {
    formatted = ['first', 'second'];
    const formatError = Object.assign(new Error('cannot parse entities: second chunk rejected'), { error_code: 400 });
    const order: string[] = [];
    const api = { sendMessage: async (_chat: unknown, text: string, opts?: { parse_mode?: string }) => {
        order.push(`${opts?.parse_mode ?? 'plain'}:${text}`);
        if (text === 'second') throw formatError;
    } };
    await assert.rejects(sendTelegramMarkdown(api as never, 1, 'answer', {
        requireBodyDelivery: true, onBodyDelivered: () => { order.push('receipt'); },
    }), error => error === formatError);
    assert.deepEqual(order, ['HTML:first', 'receipt', 'HTML:second', 'plain:second']);
});

test('Telegram receipt observer failures do not change success or cause retries', async () => {
    for (const observer of [() => { throw new Error('observer'); }, async () => { throw new Error('observer'); }]) {
        let sends = 0;
        assert.deepEqual(await sendTelegramMarkdown({ sendRichMessage: async () => { sends++; } } as never,
            1, 'answer', { onBodyDelivered: observer }), { ok: true });
        await Promise.resolve();
        assert.equal(sends, 1);
    }
});

test('Telegram abort racing a resolved vendor call cannot mint a receipt', async () => {
    const controller = new AbortController();
    let receipts = 0;
    const api = { sendRichMessage: async () => { controller.abort(); return {}; } };
    // Keep legacy result behavior; only the private observation is withheld.
    assert.deepEqual(await sendTelegramMarkdown(api as never, 1, 'answer', {
        signal: controller.signal, onBodyDelivered: () => { receipts++; },
    }), { ok: true });
    assert.equal(receipts, 0);
});

test('legacy later plaintext format failure invalidates prior receipt without changing send order or ok', async () => {
    formatted = ['first', 'last'];
    const formatError = Object.assign(new Error('cannot parse entities'), { error_code: 400 });
    const capture = async (observe: boolean) => {
        const calls: unknown[] = [];
        const observations: string[] = [];
        const api = { sendMessage: async (_chat: unknown, text: string, opts?: { parse_mode?: string }) => {
            calls.push([text, opts]);
            if (text === 'last') throw formatError;
        } };
        const result = await sendTelegramMarkdown(api as never, 1, 'answer', observe ? {
            onBodyDelivered: () => { observations.push('delivered'); },
            onBodyDeliveryFailed: () => { observations.push('invalidated'); throw new Error('observer failure'); },
        } : undefined);
        return { result, calls, observations };
    };
    const legacy = await capture(false);
    const observed = await capture(true);
    assert.deepEqual(observed.result, { ok: true });
    assert.deepEqual(observed.result, legacy.result);
    assert.deepEqual(observed.calls, legacy.calls);
    assert.deepEqual(observed.calls, [
        ['first', { parse_mode: 'HTML' }], ['last', { parse_mode: 'HTML' }], ['last', undefined],
    ]);
    assert.deepEqual(observed.observations, ['delivered', 'invalidated']);
});

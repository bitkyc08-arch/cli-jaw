import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// Real Express router -> sendToTopic -> sendTelegramMarkdown. Only the bot API,
// format output and persisted hub configuration are faked; no HTTP listener.
let chunks: string[] = ['answer'];
let rejectFormats = false;
let rejectText: string | undefined;
const calls: Array<{ text: string; options: unknown }> = [];
let hubApi: FakeHubBot['api'];
const formatError = Object.assign(new Error('cannot parse entities'), { error_code: 400 });
mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request'); });
const store = await import('../../src/manager/telegram-hub/routing-store.ts');
mock.module('../../src/manager/telegram-hub/routing-store.ts', { namedExports: { ...store,
    getHubConfig: () => ({ enabled: true, token: 'fake', chatId: '123', defaultPort: 3457, routes: [] }),
    resolveRoute: (chatId: string, threadId: string) => chatId === '123' && threadId === '42' ? { port: 3457 } : null,
} });
mock.module('../../src/telegram/forwarder.ts', { namedExports: {
    markdownToTelegramHtml: (text: string) => text,
    chunkTelegramMessage: () => chunks,
    escapeHtmlTg: (text: string) => text,
    createForwarderLifecycle: () => ({ attach() {}, detach() {} }),
    createTelegramForwarder: () => () => {},
    relayTelegramImages: async () => {},
} });
class FakeHubBot {
    api = {
        getWebhookInfo: async () => ({ url: '' }), setMyCommands: async () => {},
        sendMessage: async (_chatId: unknown, text: string, options: unknown) => {
            calls.push({ text, options });
            if (rejectFormats || text === rejectText) throw formatError;
            return {};
        },
    };
    constructor() { hubApi = this.api; }
    catch() { return this; } on() { return this; } callbackQuery() { return this; }
    async start(options: { onStart(info: { username: string }): void }) { options.onStart({ username: 'fake' }); }
    async stop() {}
}
const grammy = await import('grammy');
mock.module('grammy', { namedExports: { ...grammy, Bot: FakeHubBot } });
const { startHubBot, stopHubBot } = await import('../../src/manager/telegram-hub/hub-bot.ts');
const { createDashboardTelegramHubRouter } = await import('../../src/manager/routes/telegram-hub.ts');
const router = createDashboardTelegramHubRouter();

function outbound(body: Record<string, unknown>, ip = '127.0.0.1'): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
        const request = { method: 'POST', url: '/outbound', headers: {}, socket: { remoteAddress: ip }, body };
        const response = { statusCode: 200,
            status(code: number) { this.statusCode = code; return this; },
            json(result: Record<string, unknown>) { resolve({ status: this.statusCode, body: result }); return this; },
        };
        router.handle(request as never, response as never, (error?: unknown) => reject(error ?? new Error('Route not handled')));
    });
}

test.before(async () => { await startHubBot(); }); // inert fake Bot only
test.after(async () => { await stopHubBot(); });
test.beforeEach(() => {
    calls.length = 0; chunks = ['answer']; rejectFormats = false; rejectText = undefined;
    Reflect.deleteProperty(hubApi, 'sendRichMessage');
});

test('actual hub route returns positive receipt only after helper calls fake vendor successfully', async () => {
    assert.deepEqual(await outbound({ chatId: '123', threadId: '42', type: 'text', text: 'answer' }),
        { status: 200, body: { ok: true, bodyDelivered: true } });
    assert.deepEqual(calls, [{ text: 'answer', options: { message_thread_id: 42, parse_mode: 'HTML' } }]);
});

test('actual hub route returns false receipt for zero formatter chunks, preserving legacy ok', async () => {
    chunks = [];
    assert.deepEqual(await outbound({ chatId: '123', threadId: '42', type: 'text', text: 'answer' }),
        { status: 200, body: { ok: true, bodyDelivered: false } });
    assert.deepEqual(calls, []);
});

test('flagless hub all-format rejection keeps legacy ok but never confirms body delivery', async () => {
    rejectFormats = true;
    assert.deepEqual(await outbound({ chatId: '123', threadId: '42', type: 'text', text: 'answer' }),
        { status: 200, body: { ok: true, bodyDelivered: false } });
    assert.deepEqual(calls, [
        { text: 'answer', options: { message_thread_id: 42, parse_mode: 'HTML' } },
        { text: 'answer', options: { message_thread_id: 42 } },
    ]);
});

test('actual hub route invalidates partial multichunk success while preserving legacy ok and calls', async () => {
    chunks = ['first', 'last']; rejectText = 'last';
    assert.deepEqual(await outbound({ chatId: '123', threadId: '42', type: 'text', text: 'answer' }),
        { status: 200, body: { ok: true, bodyDelivered: false } });
    assert.deepEqual(calls, [
        { text: 'first', options: { message_thread_id: 42, parse_mode: 'HTML' } },
        { text: 'last', options: { message_thread_id: 42, parse_mode: 'HTML' } },
        { text: 'last', options: { message_thread_id: 42 } },
    ]);
});

test('a later rich chunk lost to an empty HTML fallback invalidates earlier success', async () => {
    let richCalls = 0;
    Reflect.set(hubApi, 'sendRichMessage', async () => {
        richCalls++;
        if (richCalls > 1) throw formatError;
        return {};
    });
    chunks = [];
    const result = await outbound({ chatId: '123', threadId: '42', type: 'text', text: 'a'.repeat(32_100) });
    assert.equal(richCalls, 2);
    assert.deepEqual(calls, []);
    assert.deepEqual(result, { status: 200, body: { ok: true, bodyDelivered: false } });
});

test('request cannot forge receipt or opt into a guard; authorization checks are unchanged', async () => {
    chunks = [];
    const body = { chatId: '123', threadId: '42', type: 'text', text: 'answer',
        bodyDelivered: true, requireBodyDelivery: true, onBodyDelivered: 'not-a-callback' };
    assert.deepEqual(await outbound(body), { status: 200, body: { ok: true, bodyDelivered: false } });
    assert.equal((await outbound(body, '192.0.2.1')).status, 403);
    assert.equal((await outbound({ ...body, chatId: '456' })).status, 403);
    assert.equal((await outbound({ ...body, threadId: '43' })).status, 403);
    assert.deepEqual(calls, []);
});

test('non-text hub response does not acquire a text-body receipt', async () => {
    const reply_markup = { inline_keyboard: [] };
    assert.deepEqual(await outbound({ chatId: '123', threadId: '42', type: 'keyboard', text: 'question', reply_markup }),
        { status: 200, body: { ok: true } });
    assert.deepEqual(calls, [{ text: 'question', options: { message_thread_id: 42, reply_markup } }]);
});

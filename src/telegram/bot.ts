// ─── Telegram Bot ────────────────────────────────────

import https from 'node:https';
import nodeFetch, { type RequestInit } from 'node-fetch';
import { Bot, type Context } from 'grammy';
import { sequentialize } from '@grammyjs/runner';
import { addBroadcastListener, removeBroadcastListener } from '../core/bus.js';
import { settings } from '../core/config.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { resolveHubCallback } from './hub-callback.js';
import { requiresStreamingFetchBody } from './fetch-body.js';
import { StatusUpdateBuffer } from './status-update-buffer.js';
import { t, normalizeLocale } from '../core/i18n.js';
import { isResetIntent } from '../orchestrator/pipeline.js';
import { submitMessage } from '../orchestrator/gateway.js';
import { makeCommandCtx } from '../cli/command-context.js';
import {
    saveUpload, buildMediaPrompt,
    resetFallbackState,
} from '../agent/spawn.js';
import { bumpGenerationForSessionLocalReset, bumpSessionOwnershipGeneration } from '../agent/session-persistence.js';
import { parseCommand, executeCommand } from '../cli/commands.js';
import { getTelegramMenuCommands } from '../command-contract/policy.js';
import { downloadTelegramFile, TELEGRAM_DOWNLOAD_LIMITS } from '../../lib/upload.js';
import { clearMainSessionState, resetSessionPreservingHistory } from '../core/main-session.js';
import { applyRuntimeSettingsPatch } from '../core/runtime-settings.js';
import { resetEmployeeSessions, seedDefaultEmployees } from '../core/employees.js';
import { handleVoice } from './voice.js';
import { getLastActiveTarget, registerTransport, setLastActiveTarget, setLatestSeenTarget } from '../messaging/runtime.js';
import { registerSendTransport, sendChannelOutput } from '../messaging/send.js';
import type { RemoteTarget } from '../messaging/types.js';
import type { ChannelSendRequest } from '../messaging/send.js';
import {
    escapeHtmlTg,
    createForwarderLifecycle,
    createTelegramForwarder,
    relayTelegramImages,
} from './forwarder.js';
import { sendTelegramMarkdown, type RichSendOpts } from './rich-message.js';
import { db } from '../core/db.js';
import { TelegramDurablePoller, TelegramUpdateOffsetStore } from './update-offset.js';

export {
    escapeHtmlTg,
    markdownToTelegramHtml,
    chunkTelegramMessage,
    createForwarderLifecycle,
    createTelegramForwarder,
} from './forwarder.js';

// Re-exported from collect.ts (extracted in Phase B)
import { orchestrateAndCollect, orchestrateAndCollectData } from '../orchestrator/collect.js';
import { log } from '../core/logger.js';
export { orchestrateAndCollect };
import {
    startPendingElicitation,
    handleElicitationCallback,
    discardPendingElicitation,
} from './elicitation-buttons.js';
import { redactOutboundPayload, redactOutboundText, logErrorText, userErrorText } from '../messaging/redact.js';
import { sendWithRetryPolicy } from '../messaging/retry.js';
import { handleApprovalCommand, registerProductionTransport, type DispatchApprovalTransport } from '../core/dispatch-approval-ingress.js';

// ─── State ───────────────────────────────────────────

export let telegramBot: Bot | null = null;
export const telegramActiveChatIds = new Set<number>();
let tgRetryTimer: ReturnType<typeof setTimeout> | null = null;
let tgInitLock = false;
let tg409RetryCount = 0;
const TG_MAX_RETRIES = 3;
let botUsername: string | null = null;
let telegramPoller: TelegramDurablePoller | null = null;
const telegramFinalDeliveryFailures = new Set<number>();
/**
 * The bot's own user id, learned from getMe at startup.
 *
 * Needed for the self-echo guard. Until it is known the guard falls back to
 * the is_bot flag, which is why those are two separate checks.
 */
let botUserId: number | null = null;
export function setTelegramBotUserIdForTest(value: number | null): void { botUserId = value; }
let telegramApprovalIngress: DispatchApprovalTransport | null = null;
function createTelegramPollingIngress(): DispatchApprovalTransport {
    const transport = Object.freeze({ platform: 'telegram' as const });
    registerProductionTransport(transport);
    return transport;
}
export function handleTelegramUpdate(update: Record<string, unknown>, transport = telegramApprovalIngress): boolean {
    const message = update['message'] as { text?: unknown; from?: { id?: unknown; is_bot?: boolean } } | undefined;
    const text = typeof message?.text === 'string' ? message.text : '';
    const fromIdRaw = message?.from?.id;
    const fromId = typeof fromIdRaw === 'number' ? fromIdRaw : undefined;
    const approval = handleApprovalCommand(transport, {
        ...update,
        __jawSelf: isSelfEcho({ fromId, isBot: message?.from?.is_bot, botUserId, allowBots: settings["telegram"]?.allowBots }),
    }, text);
    return approval.handled;
}

/**
 * Whether an update should be dropped as our own output or another bot's.
 *
 * Extracted from the middleware so it can be exercised directly: the guard is
 * two checks, and the reason for two is the window before getMe returns, which
 * is exactly the case a test needs to reach.
 */
export function isSelfEcho(input: {
    fromId?: number | undefined;
    isBot?: boolean | undefined;
    botUserId: number | null;
    allowBots?: boolean | undefined;
}): boolean {
    // Our own id, once we know it.
    if (input.fromId !== undefined && input.botUserId !== null && input.fromId === input.botUserId) return true;
    // Until then — and for every other bot — fall back on the is_bot flag.
    if (input.isBot && !input.allowBots) return true;
    return false;
}
const telegramUpdateOffsets = new TelegramUpdateOffsetStore(db);
let targetReplyForwarderInstalled = false;
const telegramForwarderLifecycle = createForwarderLifecycle({
    addListener: addBroadcastListener,
    removeListener: removeBroadcastListener,
    buildForwarder: ({ bot }: Record<string, unknown>) => createTelegramForwarder({
        bot: bot as Bot,
        getLastChatId: () => {
            const chatIds = Array.from(telegramActiveChatIds);
            return chatIds.length ? (chatIds[chatIds.length - 1] ?? null) : null;
        },
        getLastTarget: () => getLastActiveTarget('telegram'),
        shouldSkip: (data: Record<string, unknown>) => data["origin"] === 'telegram', // handled by tgOrchestrate already
        log: ({ chatId, preview }: { chatId: string | number; preview: string }) => {
            log.info(`[tg:forward] → chat ${chatId}: ${String(preview).slice(0, 60)}...`);
        },
    }),
});


function currentLocale() {
    return normalizeLocale(settings["locale"], 'ko');
}

function markChatActive(chatId: number, ctx?: Context) {
    // Refresh insertion order so Array.from(set).at(-1) points to latest active chat.
    telegramActiveChatIds.delete(chatId);
    telegramActiveChatIds.add(chatId);
    // Auto-persist to settings.json so forwarding survives server restart
    const allowed = settings["telegram"]?.allowedChatIds || [];
    if (!allowed.includes(chatId)) {
        settings["telegram"].allowedChatIds = [...allowed, chatId];
        import('../core/config.js').then(m => m.saveSettings(settings)).catch(() => { });
    }
    // Update messaging runtime targets
    if (ctx) {
        const target = buildTelegramTarget(ctx);
        setLastActiveTarget('telegram', target);
        setLatestSeenTarget('telegram', target);
    }
}

function detachTelegramForwarder() {
    telegramForwarderLifecycle.detach();
}

function attachTelegramForwarder(bot: Bot) {
    telegramForwarderLifecycle.attach({ bot });
}

function installTelegramTargetReplyForwarder(): void {
    if (targetReplyForwarderInstalled) return;
    targetReplyForwarderInstalled = true;
    addBroadcastListener((type, data) => {
        if (type !== 'orchestrate_done' || data["origin"] !== 'telegram' || data["replyViaTarget"] !== true) return;
        if (!data["text"]) return;
        const target = data["target"] as RemoteTarget | undefined;
        if (!target || target.channel !== 'telegram') return;
        void sendChannelOutput({
            channel: 'telegram',
            type: 'text',
            text: String(data["text"]),
            target,
        }).then((result) => {
            if (!result.ok) log.error('[tg:target-reply]', logErrorText(result.error || 'send failed'));
            // Forward elicitation keyboards through hub if present.
            const specs = data["elicitationSpecs"];
            const raw = Array.isArray(specs) ? specs[0] : undefined;
            if (typeof raw === 'string' && raw) {
                const keyboards = startPendingElicitation(String(target.targetId || ''), raw);
                for (const kb of keyboards ?? []) {
                    void sendChannelOutput({
                        channel: 'telegram', type: 'keyboard',
                        text: kb.text, reply_markup: kb.reply_markup, target,
                    }).catch(() => {});
                }
            }
        }).catch((err: unknown) => {
            log.error('[tg:target-reply]', logErrorText(err));
        });
    });
}

// ─── Transport Contract Exports ─────────────────────

export async function shutdownTelegram() {
    if (tgRetryTimer) { clearTimeout(tgRetryTimer); tgRetryTimer = null; }
    detachTelegramForwarder();
    if (telegramPoller) {
        const oldPoller = telegramPoller;
        telegramPoller = null;
        try { await oldPoller.stop(); } catch (e: unknown) {
            log.warn('[telegram:poller-stop]', logErrorText(e));
        }
    }
    if (!telegramBot) return;
    const old = telegramBot;
    telegramBot = null;
    try { await old.stop(); } catch (e: unknown) {
        log.warn('[telegram:stop]', logErrorText(e));
    }
}

export function getLatestTelegramChatId(): string | number | null {
    return Array.from(telegramActiveChatIds).at(-1) as string | number | null ?? null;
}

export function getTelegramTargetIds(): Array<string | number> {
    return settings["telegram"].allowedChatIds?.length
        ? [...settings["telegram"].allowedChatIds]
        : ([...telegramActiveChatIds] as Array<string | number>);
}

export async function sendTelegramText(chatId: string, text: string) {
    const bot = resolveTelegramSendBot();
    if (!bot) throw new Error('Telegram not configured');
    return bot.api.sendMessage(chatId, redactOutboundText(text));
}

export type TelegramSendClientResult =
    | { client: Bot; reason?: never; status?: never }
    | { client: null; reason: string; status: 400 | 503 };

let telegramSendOnlyBot: Bot | null = null;
let telegramSendOnlyToken: string | null = null;

export function invalidateTelegramSendClient(): void {
    telegramSendOnlyBot = null;
    telegramSendOnlyToken = null;
}

export function getTelegramSendClient(): TelegramSendClientResult {
    const tg = settings["telegram"];
    if (!tg?.enabled) {
        return { client: null, reason: 'telegram_disabled', status: 503 };
    }
    const token = typeof tg.token === 'string' ? tg.token.trim() : '';
    if (!token) {
        return { client: null, reason: 'telegram_token_missing', status: 503 };
    }
    if (telegramSendOnlyBot && telegramSendOnlyToken === token) {
        return { client: telegramSendOnlyBot };
    }
    telegramSendOnlyBot = new Bot(token);
    telegramSendOnlyToken = token;
    return { client: telegramSendOnlyBot };
}

function resolveTelegramSendBot(): Bot | null {
    if (telegramBot) return telegramBot;
    return getTelegramSendClient().client;
}

function buildTelegramTarget(ctx: Context): RemoteTarget {
    const chatType = ctx.chat?.type;
    const isGroup = chatType === 'group' || chatType === 'supergroup';
    const messageThreadId = ctx.msg?.is_topic_message ? ctx.msg.message_thread_id : undefined;
    return stripUndefined({
        channel: 'telegram',
        targetKind: 'channel',
        peerKind: isGroup ? 'group' : 'direct',
        targetId: String(ctx.chat?.id ?? ''),
        threadId: messageThreadId !== undefined && messageThreadId > 1
            ? String(messageThreadId)
            : undefined,
    });
}

async function telegramSendHandler(req: ChannelSendRequest): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
    // P2b: hub-member mode — this instance's own bot is disabled; relay outbound through the
    // dashboard hub (it owns the single forum-group bot token). hubCallbackUrl is SSRF-guarded.
    const hub = settings["telegramHub"];
    if (hub?.mode === 'hub-member' && req.target?.channel === 'telegram' && req.target?.targetId) {
        const base = resolveHubCallback(hub.hubCallbackUrl);
        try {
            const r = await fetch(`${base}/api/dashboard/telegram-hub/outbound`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(stripUndefined({
                    chatId: req.target.targetId, threadId: req.target.threadId,
                    type: req.type, text: req.text, filePath: req.filePath, caption: req.caption, reply_markup: req.reply_markup,
                })),
                signal: AbortSignal.timeout(15_000),
            });
            const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
            return j['ok'] ? { ok: true, via: 'hub', type: req.type } : { ok: false, error: String(j['error'] || 'hub outbound failed'), status: 502 };
        } catch (e) {
            return { ok: false, error: (e as Error).message, status: 502 };
        }
    }

    const bot = resolveTelegramSendBot();
    if (!bot) {
        const send = getTelegramSendClient();
        return { ok: false, error: send.reason ?? 'Telegram not configured', status: send.status ?? 503 };
    }

    const chatId = req.chatId || req.target?.targetId || getLatestTelegramChatId();
    if (!chatId) return { ok: false, error: 'No telegram chatId available', status: 400 };

    // P0: thread-aware send. Programmatic sends must carry message_thread_id so
    // replies/files land in the originating forum topic (ctx.reply already auto-threads).
    // stripUndefined drops the key for non-forum chats → identical wire payload.
    const { threadIdNumber } = await import('../messaging/thread-target.js');
    const messageThreadId = threadIdNumber(req.target);

    if (req.type === 'text') {
        const text = req.text?.trim();
        if (!text) return { ok: false, error: 'text required' };
        // Rich-first default (Bot API 10.1): raw markdown via sendRichMessage, with the
        // legacy HTML→plaintext chain as per-chunk fallback inside the helper.
        await sendTelegramMarkdown(bot.api, chatId, text, stripUndefined({ message_thread_id: messageThreadId }));
        return { ok: true, chat_id: chatId, type: 'text' };
    }

    if (req.type === 'keyboard') {
        const text = req.text?.trim();
        if (!text || !req.reply_markup) return { ok: false, error: 'text and reply_markup required for keyboard type' };
        const sent = await sendWithRetryPolicy(
            () => bot.api.sendMessage(chatId, redactOutboundText(text), stripUndefined({
                message_thread_id: messageThreadId,
                reply_markup: redactOutboundPayload(req.reply_markup) as import("@grammyjs/types").InlineKeyboardMarkup,
            })),
            (err) => log.warn('[tg:keyboard] send failed:', logErrorText(err)),
        );
        if (!sent) return { ok: false, error: 'keyboard send failed' };
        return { ok: true, chat_id: chatId, type: 'keyboard' };
    }

    // File types
    const filePath = req.filePath;
    if (!filePath) return { ok: false, error: 'file_path required for non-text types' };
    const { validateFileSize, sendTelegramFile } = await import('./telegram-file.js');
    validateFileSize(filePath, req.type);
    const result = await sendTelegramFile(bot, chatId, filePath, req.type, stripUndefined({ caption: req.caption, threadId: messageThreadId }));
    return result;
}

// Register transport at module load time
registerTransport('telegram', { init: initTelegram, shutdown: shutdownTelegram });
registerSendTransport('telegram', telegramSendHandler);
installTelegramTargetReplyForwarder();

function toTelegramCommandDescription(desc: string) {
    const text = String(desc || '').trim();
    return text.length >= 3 ? text.slice(0, 256) : 'Run command';
}

function escapeRegExp(text: string) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function syncTelegramCommands(bot: Bot) {
    const locale = currentLocale();
    const cmds = getTelegramMenuCommands()
        .map((c: { name: string; desc?: string; descKey?: string; tgDescKey?: string }) => ({
            command: c.name,
            description: toTelegramCommandDescription(
                (c.tgDescKey ? t(c.tgDescKey, {}, locale) : (c.descKey ? t(c.descKey, {}, locale) : c.desc)) ?? ''
            ),
        }));
    // Set commands with language_code per Telegram Bot API
    // Also set default (no language_code) for users without language preference
    return Promise.all([
        bot.api.setMyCommands(cmds),
        bot.api.setMyCommands(cmds, { language_code: locale as 'en' | 'ko' }),
    ]);
}

function makeTelegramCommandCtx() {
    return makeCommandCtx('telegram', currentLocale(), {
        applySettings: async (patch) => {
            bumpSessionOwnershipGeneration();
            return applyRuntimeSettingsPatch(patch, {
                resetFallbackState: () => resetFallbackState(null),
            });
        },
        clearSession: () => {
            bumpGenerationForSessionLocalReset();
            clearMainSessionState();
        },
        resetSession: () => {
            bumpGenerationForSessionLocalReset();
            resetSessionPreservingHistory();
        },
        resetEmployees: () => seedDefaultEmployees({ reset: true, notify: true }),
        resetEmployeeSessions: () => resetEmployeeSessions(),
    });
}

// ─── Init ────────────────────────────────────────────

export async function initTelegram() {
    if (tgInitLock) {
        log.warn('[tg] initTelegram already in progress, skipping');
        return;
    }
    tgInitLock = true;
    try { await _initTelegramInner(); } finally { tgInitLock = false; }
}

async function _initTelegramInner() {
    // Dedupe retry timer — cancel pending retry if initTelegram called again
    if (tgRetryTimer) { clearTimeout(tgRetryTimer); tgRetryTimer = null; }

    detachTelegramForwarder();
    if (telegramBot) {
        const old = telegramBot;
        telegramBot = null;
        try {
            await old.stop();
        } catch (e: unknown) {
            log.warn('[telegram:stop]', logErrorText(e));
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    const stoppingPoller = telegramPoller?.stop().catch((e: unknown) => {
        log.warn('[telegram:poller-stop]', logErrorText(e));
    });
    telegramPoller = null;
    await stoppingPoller;
    const envToken = process.env["TELEGRAM_TOKEN"];
    if (envToken) settings["telegram"].token = envToken;

    const envChatIds = process.env["TELEGRAM_ALLOWED_CHAT_IDS"];
    if (envChatIds) {
        settings["telegram"].allowedChatIds = envChatIds
            .split(',')
            .map(id => parseInt(id.trim(), 10))
            .filter(id => !isNaN(id));
    }

    if (!settings["telegram"]?.enabled || !settings["telegram"]?.token) {
        log.info('[tg] ⏭️  Telegram pending (disabled or no token)');
        return;
    }

    // Pre-seed telegramActiveChatIds from persisted allowedChatIds
    if (settings["telegram"].allowedChatIds?.length) {
        for (const id of settings["telegram"].allowedChatIds) telegramActiveChatIds.add(id);
        log.info(`[tg] Pre-seeded ${settings["telegram"].allowedChatIds.length} chat(s) from allowedChatIds`);
    }

    const ipv4Agent = new https.Agent({ family: 4 });
    const ipv4Fetch = (url: string, init: Record<string, unknown> = {}): Promise<unknown> => {
        const body = init["body"];
        if (requiresStreamingFetchBody(body)) {
            return nodeFetch(url, {
                ...(init as RequestInit),
                agent: ipv4Agent,
            });
        }
        return new Promise((resolve, reject) => {
            const u = new URL(url);
            const headersInit = init["headers"];
            const opts = {
                hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
                method: (init["method"] as string) || 'GET', agent: ipv4Agent,
                headers: headersInit instanceof Headers
                    ? Object.fromEntries(headersInit)
                    : ((headersInit as Record<string, string>) || {}),
            };
            const req = https.request(opts, (res) => {
                let data = '';
                res.on('data', (c: string) => data += c);
                res.on('end', () => resolve({
                    ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
                    status: res.statusCode,
                    json: () => Promise.resolve(JSON.parse(data)),
                    text: () => Promise.resolve(data),
                }));
            });
            req.on('error', reject);
            if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
            req.end();
        });
    };

    const bot = new Bot(settings["telegram"].token, {
        client: { fetch: ipv4Fetch as never },
    });
    bot.catch((err) => log.error('[tg:error]', logErrorText(err)));
    bot.use(sequentialize((ctx) => `tg:${ctx.chat?.id || 'unknown'}`));

    // Never process our own output, and skip other bots unless allowed.
    //
    // Discord has had this since inception (see Events.MessageCreate below);
    // Telegram did not, so a bridge that re-injects bot output — or simply
    // another bot in the same group — could drive a loop. It sits ahead of the
    // logging middleware so an echo does not pollute the log either.
    //
    // Two checks rather than one: botUserId is only known once getMe returns,
    // and is_bot still covers the window before that.
    bot.use(async (ctx, next) => {
        const from = ctx.from;
        if (isSelfEcho({ fromId: from?.id, isBot: from?.is_bot, botUserId, allowBots: settings["telegram"]?.allowBots })) return;
        await next();
    });

    bot.use(async (ctx, next) => {
        // Inbound text is logged too, and a user can paste a token into chat.
        log.info(`[tg:update] chat=${ctx.chat?.id} text=${redactOutboundText(ctx.message?.text || '').slice(0, 40)}`);
        await next();
    });

    bot.use(async (ctx, next) => {
        const allowed = settings["telegram"].allowedChatIds;
        if (allowed?.length > 0 && !allowed.includes(ctx.chat?.id)) {
            log.info(`[tg:blocked] chatId=${ctx.chat?.id}`);
            return;
        }
        await next();
    });

    // Group chat @mention gating (configurable)
    bot.use(async (ctx, next) => {
        if (settings["telegram"].mentionOnly === false) {
            await next();
            return;
        }
        const chatType = ctx.chat?.type;
        if (chatType === 'group' || chatType === 'supergroup') {
            const text = ctx.message?.text || ctx.message?.caption || '';
            if (!botUsername || !text.includes(`@${botUsername}`)) {
                return;
            }
        }
        await next();
    });

    bot.command('start', (ctx) => ctx.reply(t('tg.connected', {}, currentLocale())));
    bot.command('id', (ctx) => ctx.reply(`Chat ID: <code>${ctx.chat?.id ?? ''}</code>`, { parse_mode: 'HTML' }));

    // Inline-keyboard elicitation answers (single_select fences → buttons).
    bot.callbackQuery(/^elic:/, async (ctx) => {
        const cbChatId = ctx.chat?.id;
        if (!cbChatId) { await ctx.answerCallbackQuery(); return; }
        const result = handleElicitationCallback(String(cbChatId), ctx.callbackQuery.data ?? '');
        if (result.kind === 'stale') {
            await ctx.answerCallbackQuery({ text: t('tg.elicitationExpired', {}, currentLocale()) });
            return;
        }
        await ctx.answerCallbackQuery({ text: redactOutboundText(result.ack) });
        // Best-effort: freeze the tapped question's keyboard so the choice reads as taken.
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { });
        if (result.kind === 'complete') {
            await tgOrchestrate(ctx, result.combinedAnswer, result.combinedAnswer);
        }
    });

    async function tgOrchestrate(ctx: Context, prompt: string, displayMsg: string) {
        const chatId = ctx.chat?.id;
        if (!ctx.chat) return;
        const chat = ctx.chat;
        const responseTarget = buildTelegramTarget(ctx);
        const result = submitMessage(prompt, stripUndefined({ origin: 'telegram' as const, displayText: displayMsg, skipOrchestrate: true, target: responseTarget, chatId }));
        // Reproduce grammy ctx.reply's auto-injected routing (context.js: thread/business/DM-topic)
        // so the rich-first send helper lands replies exactly where ctx.reply would.
        const replyOptsOf = (c: Context): RichSendOpts => stripUndefined({
            business_connection_id: c.businessConnectionId,
            message_thread_id: c.msg?.is_topic_message ? c.msg.message_thread_id : undefined,
            direct_messages_topic_id: c.msg?.direct_messages_topic?.topic_id,
        });
        // Single_select elicitation fences arrive as raw specs on orchestrate_done;
        // render the first one as inline-keyboard messages after the text body.
        const sendElicitationKeyboards = async (targetChatId: number | string, specs: unknown) => {
            const raw = Array.isArray(specs) ? specs[0] : undefined;
            if (typeof raw !== 'string' || !raw) return;
            const keyboards = startPendingElicitation(String(targetChatId), raw);
            for (const kb of keyboards ?? []) {
                await ctx.api.sendMessage(targetChatId, redactOutboundText(kb.text), { ...replyOptsOf(ctx), reply_markup: redactOutboundPayload(kb.reply_markup) })
                    .catch(() => { });
            }
        };

        if (result.action === 'queued') {
            log.info(`[tg:queue] agent busy, queued (${result.pending} pending)`);
            // 큐 처리 후 응답을 이 채팅으로 전달 — requestId로 request-level 격리
            const requestId = result.requestId;
            const finalDeliveryControl: { cancel?: (reason: unknown) => void } = {};
            const finalDelivery = new Promise<void>((resolve, reject) => {
                let timer: ReturnType<typeof setTimeout>;
                let settled = false;
                const cleanup = () => {
                    clearTimeout(timer);
                    removeBroadcastListener(queueHandler);
                };
                finalDeliveryControl.cancel = (reason) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(reason);
                };
                const queueHandler = (type: string, data: Record<string, unknown>) => {
                    if (type !== 'orchestrate_done' || !data["text"] || data["origin"] !== 'telegram' || data["requestId"] !== requestId) return;
                    if (settled) return;
                    settled = true;
                    cleanup();
                    void sendTelegramMarkdown(ctx.api, chat.id, String(data["text"]), replyOptsOf(ctx))
                        .then(() => {
                            resolve();
                            void relayTelegramImages(bot, chat.id, String(data["text"]), responseTarget).catch(() => { });
                            void sendElicitationKeyboards(chat.id, data["elicitationSpecs"]).catch(() => { });
                        })
                        .catch(reject);
                };
                timer = setTimeout(() => {
                    finalDeliveryControl.cancel?.(new Error('telegram_queue_delivery_timeout'));
                }, 300000);
                addBroadcastListener(queueHandler);
            });
            void finalDelivery.catch(() => { });
            try {
                await ctx.reply(t('tg.queued', { count: result.pending }, currentLocale()));
                await finalDelivery;
            } catch (error) {
                finalDeliveryControl.cancel?.(error);
                await finalDelivery.catch(() => { });
                telegramFinalDeliveryFailures.add(ctx.update.update_id);
                throw error;
            }
            return;
        }

        if (result.action === 'rejected') {
            await ctx.reply(`❌ ${result.reason}`);
            return;
        }

        // result.action === 'started' — TG 출력 로직 진입
        const submitRequestId = result.requestId;
        markChatActive(chat.id, ctx);

        await ctx.replyWithChatAction('typing')
            .then(() => log.info('[tg:typing] ✅ sent'))
            .catch((e: unknown) => log.info('[tg:typing] ❌', logErrorText(e)));
        const typingInterval = setInterval(() => {
            ctx.replyWithChatAction('typing')
                .then(() => log.info('[tg:typing] ✅ refresh'))
                .catch((e: unknown) => log.info('[tg:typing] ❌ refresh', logErrorText(e)));
        }, 4000);

        const showTools = settings["telegram"]?.showToolUse !== false;
        let statusMsgId: number | null = null;
        let statusMsgCreatePromise: Promise<number | null> | null = null;
        let statusUpdateTimer: ReturnType<typeof setTimeout> | null = null;
        let statusUpdateRunning = false;
        const statusUpdateBuffer = new StatusUpdateBuffer();
        let toolLines: string[] = [];

        const flushStatusUpdate = async () => {
            const display = statusUpdateBuffer.take();
            if (!display) return;

            if (!statusMsgId) {
                if (!statusMsgCreatePromise) {
                    statusMsgCreatePromise = ctx.reply(`🔄 ${redactOutboundText(display)}`)
                        .then((m: { message_id: number }) => {
                            statusMsgId = m.message_id;
                            return statusMsgId;
                        })
                        .catch(() => null)
                        .finally(() => {
                            statusMsgCreatePromise = null;
                        });
                }
                await statusMsgCreatePromise;
                return;
            }

            await ctx.api.editMessageText(chat.id, statusMsgId, `🔄 ${redactOutboundText(display)}`)
                .catch(() => { });
        };

        const scheduleStatusUpdate = () => {
            if (statusUpdateTimer) return;
            statusUpdateTimer = setTimeout(async () => {
                statusUpdateTimer = null;
                if (statusUpdateRunning) return;
                statusUpdateRunning = true;
                try {
                    await flushStatusUpdate();
                } finally {
                    statusUpdateRunning = false;
                    // If pending text changed while updating, flush once more.
                    if (statusUpdateBuffer.hasPending() && !statusUpdateTimer) scheduleStatusUpdate();
                }
            }, 180);
        };

        const pushToolLine = (line: string) => {
            if (!line) return;
            if (toolLines[toolLines.length - 1] === line) return;
            toolLines.push(line);
            if (toolLines.length > 24) toolLines = toolLines.slice(-24);
            statusUpdateBuffer.set(toolLines.slice(-5).join('\n'));
            scheduleStatusUpdate();
        };

        const toolHandler = showTools ? (type: string, data: Record<string, any>) => {
            if (type === 'agent_retry') {
                const retryReason = escapeHtmlTg(data["reason"] || '429');
                const retryDelay = data["delay"] > 0 ? ` — ${data["delay"]}s 후 재시도` : ' — 재시도';
                pushToolLine(`⏳ ${escapeHtmlTg(data["cli"])} ${retryReason}${retryDelay}`);
            } else if (type === 'agent_fallback') {
                pushToolLine(`⚡ ${data["from"]} → ${data["to"]}`);
            } else if (type === 'agent_smoke') {
                log.info(`[tg:smoke] ${data["cli"]} smoke detected — auto-continuing`);
            } else if (type === 'agent_tool' && data["icon"] && data["label"]) {
                // Copilot ACP emits many thought chunks; hide them on Telegram to avoid message storms.
                if (data["icon"] === '💭') return;
                pushToolLine(`${data["icon"]} ${data["label"]}`);
            } else {
                return;
            }
        } : null;

        if (toolHandler) addBroadcastListener(toolHandler);

        let finalDeliveryStarted = false;
        try {
            const { text: collectedText, data: doneData } = await orchestrateAndCollectData(prompt, stripUndefined({
                origin: 'telegram', chatId: chat.id, requestId: submitRequestId, _skipInsert: true,
                target: responseTarget,
                scope: result.sessionContext?.scope,
                chatSessionId: result.sessionContext?.chatSessionId,
                remoteKey: result.sessionContext?.remoteKey,
            }));
            clearInterval(typingInterval);
            if (statusUpdateTimer) {
                clearTimeout(statusUpdateTimer);
                statusUpdateTimer = null;
            }
            if (toolHandler) removeBroadcastListener(toolHandler);
            if (statusMsgId) {
                ctx.api.deleteMessage(chat.id, statusMsgId).catch(() => { });
            }
            finalDeliveryStarted = true;
            await sendTelegramMarkdown(ctx.api, chat.id, collectedText, replyOptsOf(ctx));
            log.info(`[tg:out] ${chat.id}: ${redactOutboundText(collectedText).slice(0, 80)}`);
            void relayTelegramImages(bot, chat.id, collectedText, responseTarget).catch(() => { });
            void sendElicitationKeyboards(chat.id, doneData["elicitationSpecs"]).catch(() => { });
        } catch (err: unknown) {
            clearInterval(typingInterval);
            if (statusUpdateTimer) {
                clearTimeout(statusUpdateTimer);
                statusUpdateTimer = null;
            }
            if (toolHandler) removeBroadcastListener(toolHandler);
            if (statusMsgId) {
                ctx.api.deleteMessage(chat.id, statusMsgId).catch(() => { });
            }
            log.error('[tg:error]', logErrorText(err));
            await ctx.reply(`❌ Error: ${userErrorText(err)}`);
            if (finalDeliveryStarted) telegramFinalDeliveryFailures.add(ctx.update.update_id);
        }
    }

    bot.on('message:text', async (ctx) => {
        if (!ctx.chat) return;
        markChatActive(ctx.chat.id, ctx);
        let text = ctx.message.text;
        if (botUsername) {
            text = text.replace(new RegExp(`@${escapeRegExp(botUsername)}\\b`, 'g'), '').trim();
        }
        if (text.startsWith('/')) {
            const parsed = parseCommand(text);
            if (!parsed) return;
            const result = await executeCommand(parsed, makeTelegramCommandCtx());

            // ── /steer special path: kill + re-orchestrate with full TG UX ──
            // steerHandler already killed the agent and waited for exit.
            // Just start tgOrchestrate for typing indicator + result delivery.
            if (result?.steerPrompt) {
                const steerPrompt = result.steerPrompt;
                await ctx.reply(redactOutboundText(result.text || '🔄'));
                try {
                    await tgOrchestrate(ctx, steerPrompt, steerPrompt);
                } catch (err: unknown) {
                    log.error('[tg:steer]', logErrorText(err));
                    await ctx.reply(`❌ Steer failed: ${userErrorText(err)}`.slice(0, 500)).catch(() => {});
                }
                return;
            }

            if (result?.text) {
                const out = redactOutboundText(String(result.text));
                try {
                    await ctx.reply(out);
                } catch {
                    await ctx.reply(out.slice(0, 4000));
                }
            }
            return;
        }
        log.info(`[tg:in] ${ctx.chat?.id}: ${redactOutboundText(text).slice(0, 80)}`);

        // Typed reply supersedes any pending elicitation buttons (placed after the
        // /command branch so slash commands do not discard the pending session).
        discardPendingElicitation(String(ctx.chat.id));

        // Reset intent: use submitMessage gateway for consistency
        if (isResetIntent(text)) {
            const target = buildTelegramTarget(ctx);
            const result = submitMessage(text, { origin: 'telegram', target, chatId: ctx.chat?.id });
            if (result.action === 'rejected') {
                await ctx.reply(t('ws.agentBusy', {}, currentLocale()));
            } else {
                await ctx.reply(t('tg.resetDone', {}, currentLocale()));
            }
            return;
        }
        await tgOrchestrate(ctx, text, text);
    });

    bot.on('message:photo', async (ctx) => {
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1]!;
        const caption = ctx.message.caption || '';
        log.info(`[tg:photo] ${ctx.chat?.id}: fileId=${largest.file_id.slice(0, 20)}... caption=${redactOutboundText(caption).slice(0, 40)}`);
        try {
            const dlResult = await downloadTelegramFile(largest.file_id, settings["telegram"].token, stripUndefined({
                kind: 'photo',
                maxBytes: TELEGRAM_DOWNLOAD_LIMITS.photo,
                fileSize: largest.file_size,
            })) as Record<string, unknown>;
            const filePath = saveUpload(dlResult["buffer"] as Buffer, `photo${dlResult["ext"]}`);
            const prompt = buildMediaPrompt(filePath, caption);
            await tgOrchestrate(ctx, prompt, `${t('tg.imageCaption', { caption }, currentLocale())}`);
        } catch (err: unknown) {
            log.error('[tg:photo:error]', logErrorText(err));
            await ctx.reply(t('tg.imageFail', { msg: userErrorText(err) }, currentLocale()));
        }
    });

    bot.on('message:document', async (ctx) => {
        const doc = ctx.message.document;
        const caption = ctx.message.caption || '';
        log.info(`[tg:doc] ${ctx.chat?.id}: ${doc.file_name} (${doc.file_size} bytes)`);
        try {
            const dlResult = await downloadTelegramFile(doc.file_id, settings["telegram"].token, stripUndefined({
                kind: 'document',
                maxBytes: TELEGRAM_DOWNLOAD_LIMITS.document,
                fileSize: doc.file_size,
            })) as Record<string, any>;
            const filePath = saveUpload(dlResult["buffer"], doc.file_name || 'document');
            const prompt = buildMediaPrompt(filePath, caption);
            await tgOrchestrate(ctx, prompt, `[📎 ${doc.file_name || 'file'}] ${caption}`);
        } catch (err: unknown) {
            log.error('[tg:doc:error]', logErrorText(err));
            await ctx.reply(t('tg.fileFail', { msg: userErrorText(err) }, currentLocale()));
        }
    });

    bot.on('message:voice', async (ctx) => { await handleVoice(ctx, currentLocale, tgOrchestrate); });

    // Identity first: the self-echo guard needs it, and the refusal below has
    // to happen BEFORE anything is attached. Returning after attaching left the
    // forwarder wired to a bot that never starts, still trying to send.
    //
    // Reset before asking, so a restart cannot inherit the previous bot's
    // identity and check incoming messages against the wrong id.
    botUsername = null;
    botUserId = null;
    try {
        const me = await bot.api.getMe();
        bot.botInfo = me;
        botUsername = me.username || null;
        botUserId = me.id ?? null;
    } catch (err: unknown) {
        log.warn('[tg] getMe failed; bot identity unknown', logErrorText(err));
    }

    // The durable offset is scoped by bot identity, so polling must not start
    // when getMe cannot provide that identity.
    if (botUserId === null) {
        log.error(logErrorText('[tg] refusing to start durable polling: bot identity could not be read'));
        return;
    }

    // ─── Global Forwarding: non-Telegram responses → Telegram ───
    if (settings["telegram"]?.forwardAll !== false) {
        attachTelegramForwarder(bot);
    }

    void syncTelegramCommands(bot).catch((e) => {
        log.warn('[tg:commands] setMyCommands failed:', logErrorText(e));
    });

    const poller = new TelegramDurablePoller({
        api: bot.api,
        key: String(botUserId),
        store: telegramUpdateOffsets,
        handleUpdateThroughFinalDelivery: async (update) => {
            try {
                if (handleTelegramUpdate(update as unknown as Record<string, unknown>, telegramApprovalIngress)) return;
                await bot.handleUpdate(update);
                if (telegramFinalDeliveryFailures.has(update.update_id)) {
                    throw new Error('telegram_final_delivery_failed');
                }
            } finally {
                telegramFinalDeliveryFailures.delete(update.update_id);
            }
        },
        onStart: (info) => {
            tg409RetryCount = 0;
            const skipped = info.skippedThroughUpdateId === null ? '' : `; skipped through update ${info.skippedThroughUpdateId}`;
            log.info(`[tg] ✅ @${botUsername ?? botUserId} durable polling active at offset ${info.nextOffset}${skipped}`);
        },
    });
    telegramPoller = poller;
    telegramApprovalIngress = createTelegramPollingIngress();
    poller.start().catch((err: unknown) => {
        const telegramError = err as { error_code?: number; message?: string };
        const is409 = telegramError.error_code === 409 || telegramError.message?.includes('409');
        if (is409) {
            tg409RetryCount++;
            if (tg409RetryCount > TG_MAX_RETRIES) {
                log.error(`[tg:409] Max retries (${TG_MAX_RETRIES}) exceeded. Restart server to retry.`);
                return;
            }
            const delay = Math.min(5000 * Math.pow(2, tg409RetryCount - 1), 30000);
            log.warn(`[tg:409] Polling conflict — retry ${tg409RetryCount}/${TG_MAX_RETRIES} in ${delay / 1000}s...`);
            if (!tgRetryTimer) {
                tgRetryTimer = setTimeout(() => { tgRetryTimer = null; void initTelegram(); }, delay);
            }
        } else {
            log.error('[tg:fatal] Telegram durability bootstrap/polling failed; no uncommitted backlog consumed', logErrorText(err));
        }
    });
    telegramBot = bot;
    log.info('[tg] Bot starting...');
}

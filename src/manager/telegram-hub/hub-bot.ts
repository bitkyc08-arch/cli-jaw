// Dashboard-owned Telegram hub bot (P2). One bot token bound to one Telegram
// hub chat; each topic/thread (message_thread_id) routes to its mapped instance
// and replies relay back into the topic. The hub chat may be a forum supergroup
// or a bot private chat with topics enabled. Includes the GPT Pro review fixes (doc 05):
// chatId-required start guard, 409 retry-state fix, getWebhookInfo+await
// deleteWebhook, secure-by-default routing (unmapped topics refused), and a
// timeout on the hub->instance forward.
import { Bot } from 'grammy';
import { getHubConfig, resolveRoute, upsertRoute, removeRoute } from './routing-store.js';
import type { TelegramHubConfig } from './types.js';
import { DASHBOARD_DEFAULT_PORT, MANAGED_INSTANCE_PORT_FROM, MANAGED_INSTANCE_PORT_TO } from '../constants.js';
import { stripUndefined } from '../../core/strip-undefined.js';

let hubBot: Bot | null = null;
let hubToken: string | null = null;
let hubState: 'stopped' | 'starting' | 'polling' | 'error' = 'stopped';
let hubError: string | null = null;
let hubChatId: string | null = null;
type HubTrace = {
    at: string;
    chatId?: string;
    chatType?: string;
    threadId?: string;
    textPrefix?: string;
    reason?: string;
    name?: string;
    resultPrefix?: string;
};
let hubLastUpdate: HubTrace | null = null;
let hubLastIgnored: HubTrace | null = null;
let hubLastCommand: HubTrace | null = null;
let retries = 0;
const MAX_RETRIES = 5;
const FORWARD_TIMEOUT_MS = 15_000;
const HUB_COMMANDS = new Set(['setthread', 'threads', 'hubhelp']); // P3 fills the handler bodies
const TRACE_TEXT_LIMIT = 80;
const TOPIC_TYPING_REFRESH_MS = 4_000;
const TOPIC_TYPING_TIMEOUT_MS = 5 * 60_000;

type TopicTypingTimer = {
    interval: ReturnType<typeof setInterval>;
    timeout: ReturnType<typeof setTimeout>;
};
type EnsureHubMemberResult = { ok: true } | { ok: false; error: string };
type EnsureHubMemberFn = (port: number, chatId: string) => Promise<EnsureHubMemberResult>;

const topicTypingTimers = new Map<string, TopicTypingTimer>();

/** Map a raw message_thread_id to a route key. General topic (id<=1) → '1'. Exported for tests. */
export function threadKey(thread?: number): string {
    return thread && thread > 1 ? String(thread) : '1';
}

/** Whether startHubBot would actually start: enabled + token + bound chatId all present (GPT Pro B1). Exported for tests. */
export function canStartHub(cfg: TelegramHubConfig): boolean {
    return cfg.enabled === true && Boolean(cfg.token) && Boolean(cfg.chatId);
}

export function canMutateHubRoute(chatType: string | undefined, isGroupAdmin: boolean): boolean {
    return chatType === 'private' || isGroupAdmin;
}

export function tracePrefix(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, TRACE_TEXT_LIMIT);
}

function topicTypingKey(chatId: string, threadId: string): string {
    return `${chatId}:${threadId}`;
}

function threadOptions(threadId: string): { message_thread_id?: number } {
    const message_thread_id = Number(threadId) > 1 ? Number(threadId) : undefined;
    return stripUndefined({ message_thread_id });
}

function stopTopicTyping(chatId: string, threadId: string): void {
    const key = topicTypingKey(chatId, threadId);
    const timers = topicTypingTimers.get(key);
    if (!timers) return;
    clearInterval(timers.interval);
    clearTimeout(timers.timeout);
    topicTypingTimers.delete(key);
}

function stopAllTopicTyping(): void {
    for (const timers of topicTypingTimers.values()) {
        clearInterval(timers.interval);
        clearTimeout(timers.timeout);
    }
    topicTypingTimers.clear();
}

function startTopicTyping(chatId: string, threadId: string): void {
    stopTopicTyping(chatId, threadId);
    const sendTyping = () => {
        hubBot?.api.sendChatAction(chatId, 'typing', threadOptions(threadId)).catch(() => {});
    };
    sendTyping();
    const key = topicTypingKey(chatId, threadId);
    const interval = setInterval(sendTyping, TOPIC_TYPING_REFRESH_MS);
    const timeout = setTimeout(() => stopTopicTyping(chatId, threadId), TOPIC_TYPING_TIMEOUT_MS);
    topicTypingTimers.set(key, { interval, timeout });
}

export const __topicTypingTest = {
    start: startTopicTyping,
    stop: stopTopicTyping,
    clearAll: stopAllTopicTyping,
    count: () => topicTypingTimers.size,
};

function chatIdSettingValue(chatId: string): string | number {
    const numeric = Number(chatId);
    return Number.isSafeInteger(numeric) ? numeric : chatId;
}

function readAllowedChatIds(settingsValue: unknown): Array<string | number> {
    const telegram = settingsValue && typeof settingsValue === 'object'
        ? (settingsValue as Record<string, unknown>)['telegram']
        : undefined;
    const allowed = telegram && typeof telegram === 'object'
        ? (telegram as Record<string, unknown>)['allowedChatIds']
        : undefined;
    return Array.isArray(allowed) ? allowed.filter(v => typeof v === 'string' || typeof v === 'number') : [];
}

function currentHubCallbackUrl(): string {
    const port = process.env["DASHBOARD_PORT"] || DASHBOARD_DEFAULT_PORT;
    return `http://127.0.0.1:${port}`;
}

export function buildLocalFirstSettingsPatch(chatId: string, currentSettings: unknown = {}, hubCallbackUrl = currentHubCallbackUrl()): Record<string, unknown> {
    const allowed = readAllowedChatIds(currentSettings);
    const chatValue = chatIdSettingValue(chatId);
    const hasChat = allowed.some(v => String(v) === String(chatValue));
    return {
        telegram: {
            enabled: true,
            allowedChatIds: hasChat ? allowed : [...allowed, chatValue],
            forwardAll: true,
            mentionOnly: true,
        },
        telegramHub: {
            mode: 'standalone',
            hubCallbackUrl,
        },
    };
}

export const buildHubMemberSettingsPatch = buildLocalFirstSettingsPatch;

export async function ensureTargetHubMember(port: number, chatId: string, fetchImpl: typeof fetch = fetch): Promise<EnsureHubMemberResult> {
    const base = `http://127.0.0.1:${port}`;
    let currentSettings: unknown = {};
    try {
        const getRes = await fetchImpl(`${base}/api/settings`, { signal: AbortSignal.timeout(2_000) });
        currentSettings = await getRes.json().catch(() => ({}));
    } catch {
        currentSettings = {};
    }

    try {
        const putRes = await fetchImpl(`${base}/api/settings`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildLocalFirstSettingsPatch(chatId, currentSettings)),
            signal: AbortSignal.timeout(3_000),
        });
        if (!putRes.ok) return { ok: false, error: `settings PUT ${putRes.status}` };
        return { ok: true };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}

export function getHubBotStatus(): {
    state: 'stopped' | 'starting' | 'polling' | 'error';
    chatId?: string;
    error?: string;
    lastUpdate?: HubTrace;
    lastIgnored?: HubTrace;
    lastCommand?: HubTrace;
} {
    return stripUndefined({
        state: hubState,
        chatId: hubChatId || undefined,
        error: hubError || undefined,
        lastUpdate: hubLastUpdate || undefined,
        lastIgnored: hubLastIgnored || undefined,
        lastCommand: hubLastCommand || undefined,
    });
}

export async function reconcileHubBotWithConfig(): Promise<void> {
    const cfg = getHubConfig();
    if (!canStartHub(cfg)) {
        if (hubState !== 'stopped') await stopHubBot();
        return;
    }
    if (!hubBot || hubToken !== cfg.token || hubChatId !== cfg.chatId) await startHubBot();
}

async function forwardToInstance(port: number, prompt: string, chatId: string, threadId: string, peerKind: 'group' | 'direct', overrides?: { model?: string; systemPrompt?: string }): Promise<{ syncText?: string }> {
    const target = { channel: 'telegram', targetKind: 'channel', peerKind, targetId: chatId, threadId };
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/message`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(stripUndefined({ prompt, target, overrides })),
            signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
        });
        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok || j['ok'] === false) {
            const reason = String(j['error'] || j['reason'] || `HTTP ${res.status}`);
            return { syncText: `⚠️ 인스턴스 ${port} 요청 실패: ${reason}` };
        }
        // Slash commands return text synchronously; prompts reply later via /outbound.
        if (j['command'] && typeof j['text'] === 'string' && (j['text'] as string).trim()) {
            return { syncText: j['text'] as string };
        }
        return {};
    } catch (e) {
        console.error(`[tg:hub] forward to ${port} failed:`, (e as Error).message);
        return { syncText: `⚠️ 인스턴스 ${port} 응답 실패: ${(e as Error).message}` };
    }
}

// P3: real hub-command handlers over the P1 routing-store. Mutating /setthread
// requires the sender to be a Telegram group admin/creator (GPT Pro auth fix, doc 05);
// read-only forms (bare /setthread, /threads, /hubhelp) need no authorization.
export async function handleHubCommand(
    name: string,
    args: string[],
    chatId: string,
    threadId: string,
    isAdmin: () => Promise<boolean>,
    ensureHubMember: EnsureHubMemberFn = async () => ({ ok: true }),
): Promise<string> {
    if (name === 'setthread') {
        const arg = (args[0] || '').toLowerCase();
        if (!arg) {                                   // bare: show current binding (read-only)
            const r = resolveRoute(chatId, threadId);
            return r ? `이 토픽 → 인스턴스 ${r.port}${r.label ? ` (${r.label})` : ''}`
                     : '이 토픽은 미연결입니다. /setthread <port> 로 연결하세요.';
        }
        if (!(await isAdmin())) return '권한이 없습니다 — 그룹 관리자 또는 허용된 개인 채팅만 /setthread 로 변경할 수 있습니다.';
        if (arg === 'off') { removeRoute(chatId, threadId); return '이 토픽 라우팅을 해제했습니다.'; }
        const port = Number(arg);
        if (!Number.isInteger(port) || port < MANAGED_INSTANCE_PORT_FROM || port > MANAGED_INSTANCE_PORT_TO)
            return `포트는 ${MANAGED_INSTANCE_PORT_FROM}–${MANAGED_INSTANCE_PORT_TO} 범위여야 합니다.`;
        const ensured = await ensureHubMember(port, chatId);
        if (!ensured.ok) return `⚠️ 인스턴스 ${port} hub-member 자동 설정 실패: ${ensured.error}\n라우팅은 활성화하지 않았습니다.`;
        upsertRoute({ chatId, threadId, port, enabled: true });
        return `✅ 이 토픽 → 인스턴스 ${port} 연결됨.`;
    }
    if (name === 'threads') {
        const mine = getHubConfig().routes.filter(r => r.chatId === chatId);
        return mine.length
            ? `이 그룹의 라우트:\n${mine.map(r => `• thread ${r.threadId} → ${r.port}${r.enabled ? '' : ' (off)'}`).join('\n')}`
            : '연결된 토픽이 없습니다.';
    }
    if (name === 'hubhelp') return '/setthread <port> · /setthread off · /threads';
    return '알 수 없는 허브 명령입니다.';
}

export function createHubBot(token: string): Bot {
    const bot = new Bot(token);
    bot.catch((err) => console.error('[tg:hub]', (err as Error).message || err));

    bot.on('message:text', async (ctx) => {   // grammY narrows ctx.message.text to string here
        if (!ctx.chat || !ctx.message) return;
        const cfg = getHubConfig();
        const chatId = String(ctx.chat.id);
        const threadId = threadKey(ctx.message.message_thread_id);
        const text = ctx.message.text.trim();
        hubLastUpdate = stripUndefined({
            at: new Date().toISOString(),
            chatId,
            chatType: ctx.chat.type,
            threadId,
            textPrefix: tracePrefix(text),
        });
        if (!cfg.chatId || chatId !== cfg.chatId) {
            hubLastIgnored = stripUndefined({
                at: new Date().toISOString(),
                chatId,
                reason: cfg.chatId ? `chat mismatch; expected ${cfg.chatId}` : 'hub chatId is not configured',
            });
            return;          // only the bound hub chat
        }

        // (a) hub-level slash interception — NO mention-gate on the hub bot (topic binding = auth).
        if (text.startsWith('/')) {
            const name = text.slice(1).split(/\s+/)[0]!.split('@')[0]!.toLowerCase();
            if (HUB_COMMANDS.has(name)) {
                const args = text.slice(1).split(/\s+/).slice(1);
                const isAdmin = async (): Promise<boolean> => {
                    try {
                        const uid = ctx.from?.id;
                        if (!uid) return canMutateHubRoute(ctx.chat.type, false);
                        const m = await ctx.getChatMember(uid);
                        return canMutateHubRoute(ctx.chat.type, m.status === 'creator' || m.status === 'administrator');
                    } catch { return canMutateHubRoute(ctx.chat.type, false); }
                };
                const result = await handleHubCommand(name, args, chatId, threadId, isAdmin, ensureTargetHubMember);
                hubLastCommand = stripUndefined({
                    at: new Date().toISOString(),
                    name,
                    chatId,
                    threadId,
                    resultPrefix: tracePrefix(result),
                });
                await ctx.reply(result).catch((e) => {
                    hubLastIgnored = stripUndefined({
                        at: new Date().toISOString(),
                        chatId,
                        threadId,
                        reason: `command reply failed: ${(e as Error).message}`,
                    });
                    console.error('[tg:hub] command reply failed:', (e as Error).message);
                }); // grammY auto-threads
                return;
            }
        }

        // (b) route to the mapped instance — secure-by-default: refuse unmapped topics
        // (GPT Pro B2: no silent defaultPort auto-routing).
        const route = resolveRoute(chatId, threadId);
        if (!route) {
            await ctx.reply('이 토픽은 인스턴스에 연결되지 않았습니다. /setthread <port> 로 연결하세요.');
            return;
        }
        startTopicTyping(chatId, threadId);
        const overrides = (route.model || route.systemPrompt)
            ? stripUndefined({ model: route.model, systemPrompt: route.systemPrompt })
            : undefined;
        const peerKind = ctx.chat.type === 'private' ? 'direct' : 'group';
        const { syncText } = await forwardToInstance(route.port, text, chatId, threadId, peerKind, overrides);
        if (syncText) {
            stopTopicTyping(chatId, threadId);
            await ctx.reply(syncText);
        } // slash sync result; prompt result arrives via /outbound
    });

    return bot;
}

/** Send a relayed reply into a topic (used by POST /api/dashboard/telegram-hub/outbound). */
export async function sendToTopic(
    chatId: string,
    threadId: string,
    payload: { type: string; text?: string; filePath?: string; caption?: string },
): Promise<{ ok: boolean; error?: string }> {
    stopTopicTyping(chatId, threadId);
    if (!hubBot) return { ok: false, error: 'hub bot not running' };
    const message_thread_id = Number(threadId) > 1 ? Number(threadId) : undefined;
    if (payload.type === 'text') {
        const { markdownToTelegramHtml, chunkTelegramMessage } = await import('../../telegram/forwarder.js');
        const { sendRichOrHtml } = await import('../../telegram/rich-message.js');   // P4: rich when available, else HTML
        for (const chunk of chunkTelegramMessage(markdownToTelegramHtml(payload.text || ''))) {
            await sendRichOrHtml(hubBot, chatId, chunk, stripUndefined({ message_thread_id }))
                .catch(() => hubBot!.api.sendMessage(chatId, chunk.replace(/<[^>]+>/g, ''), stripUndefined({ message_thread_id })));
        }
        return { ok: true };
    }
    const { sendTelegramFile } = await import('../../telegram/telegram-file.js');
    const r = await sendTelegramFile(hubBot, chatId, payload.filePath!, payload.type, stripUndefined({ caption: payload.caption, threadId: message_thread_id }));
    return stripUndefined({ ok: r.ok, error: r.error });
}

/**
 * Start (or restart) the hub bot from the current registry config. Idempotent.
 * GPT Pro fixes: requires bound chatId; checks getWebhookInfo before deleteWebhook;
 * marks running state only AFTER onStart so a 409 actually retries.
 */
export async function startHubBot(): Promise<void> {
    const cfg = getHubConfig();
    if (!canStartHub(cfg)) { await stopHubBot(); return; }
    if (hubBot && hubToken === cfg.token) {
        hubState = 'polling';
        hubChatId = cfg.chatId;
        hubError = null;
        return;
    }
    await stopHubBot();

    const bot = createHubBot(cfg.token);
    hubState = 'starting';
    hubChatId = cfg.chatId;
    hubError = null;
    // deleteWebhook safety: only delete if a webhook is actually set (avoid blind drop).
    try {
        const info = await bot.api.getWebhookInfo();
        if (info.url) await bot.api.deleteWebhook({ drop_pending_updates: true });
    } catch (e) {
        console.error('[tg:hub] getWebhookInfo failed:', (e as Error).message);
    }

    void bot.start({
        drop_pending_updates: true,
        onStart: (info) => {
            hubBot = bot; hubToken = cfg.token; retries = 0;   // mark running ONLY after polling starts
            hubState = 'polling';
            hubError = null;
            console.log(`[tg:hub] @${info.username} polling chat=${cfg.chatId}`);
            // best-effort forum check (non-blocking); private bot-topic chats are valid
            // hub targets but are not forum supergroups.
            if (!cfg.chatId.startsWith('-100')) return;
            bot.api.getChat(cfg.chatId).then((c) => {
                if (c.is_forum !== true) console.warn(`[tg:hub] WARNING: bound chat ${cfg.chatId} is not a forum (is_forum != true)`);
            }).catch(() => {});
        },
    }).catch((err: unknown) => {
        if (hubBot === bot) { hubBot = null; hubToken = null; }   // clear so retry re-runs
        const e = err as { error_code?: number; message?: string };
        const is409 = e?.error_code === 409 || String(e?.message).includes('409');
        if (is409 && ++retries <= MAX_RETRIES) {
            hubState = 'starting';
            hubError = `polling conflict; retry ${retries}/${MAX_RETRIES}`;
            setTimeout(() => { void startHubBot(); }, Math.min(5000 * 2 ** (retries - 1), 30_000));
        } else {
            hubState = 'error';
            hubError = e?.message || String(err);
            console.error('[tg:hub:fatal]', err);
        }
    });
}

export async function stopHubBot(): Promise<void> {
    stopAllTopicTyping();
    if (hubBot) {
        const b = hubBot;
        hubBot = null;
        hubToken = null;
        hubState = 'stopped';
        hubChatId = null;
        hubError = null;
        await b.stop().catch(() => {});
    } else {
        hubState = 'stopped';
        hubChatId = null;
        hubError = null;
    }
}

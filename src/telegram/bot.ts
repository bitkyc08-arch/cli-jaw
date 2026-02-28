// ─── Telegram Bot ────────────────────────────────────

import https from 'node:https';
import { Bot } from 'grammy';
import { sequentialize } from '@grammyjs/runner';
import { broadcast, addBroadcastListener, removeBroadcastListener } from '../core/bus.js';
import { settings, detectAllCli, APP_VERSION } from '../core/config.js';
import { t, normalizeLocale } from '../core/i18n.js';
import { insertMessage, getSession, updateSession, clearMessages } from '../core/db.js';
import { orchestrate, orchestrateContinue, orchestrateReset, isContinueIntent, isResetIntent } from '../orchestrator/pipeline.js';
import { submitMessage } from '../orchestrator/gateway.js';
import { makeCommandCtx } from '../cli/command-context.js';
import {
    activeProcess, killActiveAgent, waitForProcessEnd,
    saveUpload, buildMediaPrompt, messageQueue,
} from '../agent/spawn.js';
import { parseCommand, executeCommand } from '../cli/commands.js';
import { getTelegramMenuCommands } from '../command-contract/policy.js';
import { getMergedSkills } from '../prompt/builder.js';
import * as memory from '../memory/memory.js';
import { downloadTelegramFile } from '../../lib/upload.js';
import {
    escapeHtmlTg,
    markdownToTelegramHtml,
    chunkTelegramMessage,
    createForwarderLifecycle,
    createTelegramForwarder,
} from './forwarder.js';

export {
    escapeHtmlTg,
    markdownToTelegramHtml,
    chunkTelegramMessage,
    createForwarderLifecycle,
    createTelegramForwarder,
} from './forwarder.js';

// Re-exported from collect.ts (extracted in Phase B)
import { orchestrateAndCollect } from '../orchestrator/collect.js';
export { orchestrateAndCollect };

// ─── State ───────────────────────────────────────────

export let telegramBot: any = null;
export const telegramActiveChatIds = new Set();
let tgRetryTimer: ReturnType<typeof setTimeout> | null = null;
let botUsername: string | null = null;
const telegramForwarderLifecycle = createForwarderLifecycle({
    addListener: addBroadcastListener,
    removeListener: removeBroadcastListener,
    buildForwarder: ({ bot }: Record<string, any>) => createTelegramForwarder({
        bot,
        getLastChatId: () => {
            const chatIds = Array.from(telegramActiveChatIds);
            return chatIds.length ? chatIds[chatIds.length - 1] : null;
        },
        shouldSkip: (data: any) => data.origin === 'telegram', // handled by tgOrchestrate already
        log: ({ chatId, preview }: { chatId: any; preview: any }) => {
            console.log(`[tg:forward] → chat ${chatId}: ${String(preview).slice(0, 60)}...`);
        },
    }),
});


function currentLocale() {
    return normalizeLocale(settings.locale, 'ko');
}

function markChatActive(chatId: number) {
    // Refresh insertion order so Array.from(set).at(-1) points to latest active chat.
    telegramActiveChatIds.delete(chatId);
    telegramActiveChatIds.add(chatId);
    // Auto-persist to settings.json so forwarding survives server restart
    const allowed = settings.telegram?.allowedChatIds || [];
    if (!allowed.includes(chatId)) {
        settings.telegram.allowedChatIds = [...allowed, chatId];
        import('../core/config.js').then(m => m.saveSettings(settings)).catch(() => { });
    }
}

function detachTelegramForwarder() {
    telegramForwarderLifecycle.detach();
}

function attachTelegramForwarder(bot: any) {
    telegramForwarderLifecycle.attach({ bot });
}

function toTelegramCommandDescription(desc: string) {
    const text = String(desc || '').trim();
    return text.length >= 3 ? text.slice(0, 256) : 'Run command';
}

function escapeRegExp(text: string) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function syncTelegramCommands(bot: any) {
    const locale = currentLocale();
    const cmds = getTelegramMenuCommands()
        .map((c: any) => ({
            command: c.name,
            description: toTelegramCommandDescription(
                c.tgDescKey ? t(c.tgDescKey, {}, locale) : (c.descKey ? t(c.descKey, {}, locale) : c.desc)
            ),
        }));
    // Set commands with language_code per Telegram Bot API
    // Also set default (no language_code) for users without language preference
    return Promise.all([
        bot.api.setMyCommands(cmds),
        bot.api.setMyCommands(cmds, { language_code: locale }),
    ]);
}

function makeTelegramCommandCtx() {
    return makeCommandCtx('telegram', currentLocale(), {
        applySettings: async (patch) => {
            const { replaceSettings: _replace, saveSettings: _save } = await import('../core/config.js');
            const { mergeSettingsPatch } = await import('../core/settings-merge.js');
            const merged = mergeSettingsPatch(settings, patch);
            _replace(merged);
            _save(merged);
            if (patch.telegram) {
                const { initTelegram: _init } = await import('./bot.js');
                void _init();
            }
            return { ok: true };
        },
        clearSession: () => {
            clearMessages.run();
            const s = getSession() as Record<string, any>;
            updateSession.run(s.active_cli, null, s.model, s.permissions, s.working_dir, s.effort);
            broadcast('clear', {});
        },
    });
}

// ─── Init ────────────────────────────────────────────

export async function initTelegram() {
    // Dedupe retry timer — cancel pending retry if initTelegram called again
    if (tgRetryTimer) { clearTimeout(tgRetryTimer); tgRetryTimer = null; }

    detachTelegramForwarder();
    if (telegramBot) {
        const old = telegramBot;
        telegramBot = null;
        try { await old.stop(); } catch (e: unknown) { console.warn('[telegram:stop]', (e as Error).message); }
    }
    const envToken = process.env.TELEGRAM_TOKEN;
    if (envToken) settings.telegram.token = envToken;

    const envChatIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS;
    if (envChatIds) {
        settings.telegram.allowedChatIds = envChatIds
            .split(',')
            .map(id => parseInt(id.trim(), 10))
            .filter(id => !isNaN(id));
    }

    if (!settings.telegram?.enabled || !settings.telegram?.token) {
        console.log('[tg] ⏭️  Telegram pending (disabled or no token)');
        return;
    }

    // Pre-seed telegramActiveChatIds from persisted allowedChatIds
    if (settings.telegram.allowedChatIds?.length) {
        for (const id of settings.telegram.allowedChatIds) telegramActiveChatIds.add(id);
        console.log(`[tg] Pre-seeded ${settings.telegram.allowedChatIds.length} chat(s) from allowedChatIds`);
    }

    const ipv4Agent = new https.Agent({ family: 4 });
    const ipv4Fetch = (url: string, init: Record<string, any> = {}): Promise<any> => {
        return new Promise((resolve, reject) => {
            const u = new URL(url);
            const opts = {
                hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
                method: init.method || 'GET', agent: ipv4Agent,
                headers: init.headers instanceof Headers ? Object.fromEntries(init.headers) : (init.headers || {}),
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
            if (init.body) req.write(typeof init.body === 'string' ? init.body : JSON.stringify(init.body));
            req.end();
        });
    };

    const bot = new Bot(settings.telegram.token, {
        client: { fetch: ipv4Fetch as any },
    });
    bot.catch((err) => console.error('[tg:error]', err.message || err));
    bot.use(sequentialize((ctx) => `tg:${ctx.chat?.id || 'unknown'}`));

    bot.use(async (ctx, next) => {
        console.log(`[tg:update] chat=${ctx.chat?.id} text=${(ctx.message?.text || '').slice(0, 40)}`);
        await next();
    });

    bot.use(async (ctx, next) => {
        const allowed = settings.telegram.allowedChatIds;
        if (allowed?.length > 0 && !allowed.includes(ctx.chat?.id)) {
            console.log(`[tg:blocked] chatId=${ctx.chat?.id}`);
            return;
        }
        await next();
    });

    // Group chat @mention gating
    bot.use(async (ctx, next) => {
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
    bot.command('id', (ctx) => ctx.reply(`Chat ID: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' }));

    async function tgOrchestrate(ctx: any, prompt: string, displayMsg: string) {
        const chatId = ctx.chat?.id;
        const result = submitMessage(prompt, { origin: 'telegram', displayText: displayMsg, skipOrchestrate: true, chatId });

        if (result.action === 'queued') {
            console.log(`[tg:queue] agent busy, queued (${result.pending} pending)`);
            await ctx.reply(t('tg.queued', { count: result.pending }, currentLocale()));

            // 큐 처리 후 응답을 이 채팅으로 전달
            const queueHandler = (type: string, data: Record<string, any>) => {
                if (type === 'orchestrate_done' && data.text && data.origin === 'telegram' && data.chatId === chatId) {
                    removeBroadcastListener(queueHandler);
                    const html = markdownToTelegramHtml(data.text);
                    const chunks = chunkTelegramMessage(html);
                    for (const chunk of chunks) {
                        ctx.reply(chunk, { parse_mode: 'HTML' })
                            .catch(() => ctx.reply(chunk.replace(/<[^>]+>/g, '')).catch(() => { }));
                    }
                }
            };
            addBroadcastListener(queueHandler);
            setTimeout(() => removeBroadcastListener(queueHandler), 300000);
            return;
        }

        if (result.action === 'rejected') {
            await ctx.reply(`❌ ${result.reason}`);
            return;
        }

        // result.action === 'started' — TG 출력 로직 진입
        markChatActive(ctx.chat.id);

        await ctx.replyWithChatAction('typing')
            .then(() => console.log('[tg:typing] ✅ sent'))
            .catch((e: any) => console.log('[tg:typing] ❌', e.message));
        const typingInterval = setInterval(() => {
            ctx.replyWithChatAction('typing')
                .then(() => console.log('[tg:typing] ✅ refresh'))
                .catch((e: any) => console.log('[tg:typing] ❌ refresh', e.message));
        }, 4000);

        const showTools = settings.telegram?.showToolUse !== false;
        let statusMsgId: number | null = null;
        let statusMsgCreatePromise: Promise<any> | null = null;
        let statusUpdateTimer: ReturnType<typeof setTimeout> | null = null;
        let statusUpdateRunning = false;
        let pendingStatusText = '';
        let toolLines: string[] = [];

        const flushStatusUpdate = async () => {
            const display = pendingStatusText;
            if (!display) return;

            if (!statusMsgId) {
                if (!statusMsgCreatePromise) {
                    statusMsgCreatePromise = ctx.reply(`🔄 ${display}`)
                        .then((m: any) => {
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

            await ctx.api.editMessageText(ctx.chat.id, statusMsgId, `🔄 ${display}`)
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
                    if (pendingStatusText && !statusUpdateTimer) scheduleStatusUpdate();
                }
            }, 180);
        };

        const pushToolLine = (line: string) => {
            if (!line) return;
            if (toolLines[toolLines.length - 1] === line) return;
            toolLines.push(line);
            if (toolLines.length > 24) toolLines = toolLines.slice(-24);
            pendingStatusText = toolLines.slice(-5).join('\n');
            scheduleStatusUpdate();
        };

        const toolHandler = showTools ? (type: string, data: Record<string, any>) => {
            if (type === 'agent_retry') {
                pushToolLine(`⏳ ${data.cli} 429 — ${data.delay}s 후 재시도`);
            } else if (type === 'agent_fallback') {
                pushToolLine(`⚡ ${data.from} → ${data.to}`);
            } else if (type === 'agent_tool' && data.icon && data.label) {
                // Copilot ACP emits many thought chunks; hide them on Telegram to avoid message storms.
                if (data.icon === '💭') return;
                pushToolLine(`${data.icon} ${data.label}`);
            } else {
                return;
            }
        } : null;

        if (toolHandler) addBroadcastListener(toolHandler);

        try {
            const result = await orchestrateAndCollect(prompt, { origin: 'telegram', chatId: ctx.chat.id, _skipInsert: true }) as string;
            clearInterval(typingInterval);
            if (statusUpdateTimer) {
                clearTimeout(statusUpdateTimer);
                statusUpdateTimer = null;
            }
            if (toolHandler) removeBroadcastListener(toolHandler);
            if (statusMsgId) {
                ctx.api.deleteMessage(ctx.chat.id, statusMsgId).catch(() => { });
            }
            const html = markdownToTelegramHtml(result);
            const chunks = chunkTelegramMessage(html);
            for (const chunk of chunks) {
                try {
                    await ctx.reply(chunk, { parse_mode: 'HTML' });
                } catch {
                    await ctx.reply(chunk.replace(/<[^>]+>/g, ''));
                }
            }
            console.log(`[tg:out] ${ctx.chat.id}: ${result.slice(0, 80)}`);
        } catch (err: unknown) {
            clearInterval(typingInterval);
            if (statusUpdateTimer) {
                clearTimeout(statusUpdateTimer);
                statusUpdateTimer = null;
            }
            if (toolHandler) removeBroadcastListener(toolHandler);
            if (statusMsgId) {
                ctx.api.deleteMessage(ctx.chat.id, statusMsgId).catch(() => { });
            }
            console.error('[tg:error]', err);
            await ctx.reply(`❌ Error: ${(err as Error).message}`);
        }
    }

    bot.on('message:text', async (ctx) => {
        markChatActive(ctx.chat.id);
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
            if (result?.type === 'steer' && result?.steerPrompt) {
                const steerPrompt = result.steerPrompt;
                await ctx.reply(result.text || '🔄');
                tgOrchestrate(ctx, steerPrompt, steerPrompt);
                return;
            }

            if (result?.text) {
                const out = String(result.text);
                try {
                    await ctx.reply(out);
                } catch {
                    await ctx.reply(out.slice(0, 4000));
                }
            }
            return;
        }
        console.log(`[tg:in] ${ctx.chat.id}: ${text.slice(0, 80)}`);

        // Reset intent: use submitMessage gateway for consistency
        if (isResetIntent(text)) {
            const result = submitMessage(text, { origin: 'telegram' });
            if (result.action === 'rejected') {
                await ctx.reply(t('ws.agentBusy', {}, currentLocale()));
            } else {
                await ctx.reply(t('tg.resetDone', {}, currentLocale()));
            }
            return;
        }
        tgOrchestrate(ctx, text, text);
    });

    bot.on('message:photo', async (ctx) => {
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1]!;
        const caption = ctx.message.caption || '';
        console.log(`[tg:photo] ${ctx.chat.id}: fileId=${largest.file_id.slice(0, 20)}... caption=${caption.slice(0, 40)}`);
        try {
            const dlResult = await downloadTelegramFile(largest.file_id, settings.telegram.token) as Record<string, any>;
            const filePath = saveUpload(dlResult.buffer, `photo${dlResult.ext}`);
            const prompt = buildMediaPrompt(filePath, caption);
            tgOrchestrate(ctx, prompt, `${t('tg.imageCaption', { caption }, currentLocale())}`);
        } catch (err: unknown) {
            console.error('[tg:photo:error]', err);
            await ctx.reply(t('tg.imageFail', { msg: (err as Error).message }, currentLocale()));
        }
    });

    bot.on('message:document', async (ctx) => {
        const doc = ctx.message.document;
        const caption = ctx.message.caption || '';
        console.log(`[tg:doc] ${ctx.chat.id}: ${doc.file_name} (${doc.file_size} bytes)`);
        try {
            const dlResult = await downloadTelegramFile(doc.file_id, settings.telegram.token) as Record<string, any>;
            const filePath = saveUpload(dlResult.buffer, doc.file_name || 'document');
            const prompt = buildMediaPrompt(filePath, caption);
            tgOrchestrate(ctx, prompt, `[📎 ${doc.file_name || 'file'}] ${caption}`);
        } catch (err: unknown) {
            console.error('[tg:doc:error]', err);
            await ctx.reply(t('tg.fileFail', { msg: (err as Error).message }, currentLocale()));
        }
    });
    // ─── Global Forwarding: non-Telegram responses → Telegram ───
    if (settings.telegram?.forwardAll !== false) {
        attachTelegramForwarder(bot);
    }

    void syncTelegramCommands(bot).catch((e) => {
        console.warn('[tg:commands] setMyCommands failed:', e.message);
    });

    botUsername = null;
    try {
        const me = await bot.api.getMe();
        botUsername = me.username || null;
    } catch { /* noop */ }

    bot.start({
        drop_pending_updates: true,
        onStart: (info) => console.log(`[tg] ✅ @${info.username} polling active`),
    }).catch((err) => {
        const is409 = err?.error_code === 409 || err?.message?.includes('409');
        if (is409) {
            console.warn('[tg:409] Polling conflict — retrying in 5s...');
            if (!tgRetryTimer) {
                tgRetryTimer = setTimeout(() => { tgRetryTimer = null; void initTelegram(); }, 5000);
            }
        } else {
            console.error('[tg:fatal]', err);
        }
    });
    telegramBot = bot as any;
    console.log('[tg] Bot starting...');
}

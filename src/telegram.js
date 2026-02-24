// ─── Telegram Bot ────────────────────────────────────

import https from 'node:https';
import { Bot } from 'grammy';
import { sequentialize } from '@grammyjs/runner';
import { broadcast, addBroadcastListener, removeBroadcastListener } from './bus.js';
import { settings, detectAllCli, APP_VERSION } from './config.js';
import { insertMessage, getSession, updateSession, clearMessages } from './db.js';
import { orchestrate, orchestrateContinue, isContinueIntent } from './orchestrator.js';
import {
    activeProcess, killActiveAgent, waitForProcessEnd,
    saveUpload, buildMediaPrompt, messageQueue,
} from './agent.js';
import { parseCommand, executeCommand, COMMANDS } from './commands.js';
import { getMergedSkills } from './prompt.js';
import * as memory from './memory.js';
import { downloadTelegramFile } from '../lib/upload.js';

// ─── Helpers ─────────────────────────────────────────

export function escapeHtmlTg(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function markdownToTelegramHtml(md) {
    if (!md) return '';
    let html = escapeHtmlTg(md);
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    html = html.replace(/(?<![*])\*(?![*])(.+?)(?<![*])\*(?![*])/g, '<i>$1</i>');
    html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');
    return html;
}

export function chunkTelegramMessage(text, limit = 4096) {
    if (text.length <= limit) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= limit) { chunks.push(remaining); break; }
        let splitAt = remaining.lastIndexOf('\n', limit);
        if (splitAt < limit * 0.3) splitAt = limit;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt);
    }
    return chunks;
}

export function orchestrateAndCollect(prompt) {
    return new Promise((resolve) => {
        let collected = '';
        let timeout;
        const IDLE_TIMEOUT = 120000;

        function resetTimeout() {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                removeBroadcastListener(handler);
                resolve(collected || '⏰ 시간 초과 (2분 무응답)');
            }, IDLE_TIMEOUT);
        }

        const handler = (type, data) => {
            if (type === 'agent_chunk' || type === 'agent_tool' ||
                type === 'agent_output' || type === 'agent_status' ||
                type === 'agent_done' || type === 'agent_fallback' ||
                type === 'round_start' || type === 'round_done') {
                resetTimeout();
            }
            if (type === 'agent_output') collected += data.text || '';
            if (type === 'agent_done' && data.error && data.text) {
                collected = collected || data.text;
            }
            if (type === 'orchestrate_done') {
                clearTimeout(timeout);
                removeBroadcastListener(handler);
                resolve(data.text || collected || '응답 없음');
            }
        };
        addBroadcastListener(handler);
        const run = isContinueIntent(prompt) ? orchestrateContinue() : orchestrate(prompt);
        Promise.resolve(run).catch(err => {
            clearTimeout(timeout);
            removeBroadcastListener(handler);
            resolve(`❌ ${err.message}`);
        });
        resetTimeout();
    });
}

// ─── State ───────────────────────────────────────────

export let telegramBot = null;
export const telegramActiveChatIds = new Set();
const RESERVED_CMDS = new Set(['start', 'id', 'help', 'settings']);
const TG_EXCLUDED_CMDS = new Set(['model', 'cli']);  // read-only on Telegram

function markChatActive(chatId) {
    // Refresh insertion order so Array.from(set).at(-1) points to latest active chat.
    telegramActiveChatIds.delete(chatId);
    telegramActiveChatIds.add(chatId);
}

function toTelegramCommandDescription(desc) {
    const text = String(desc || '').trim();
    return text.length >= 3 ? text.slice(0, 256) : 'Run command';
}

function syncTelegramCommands(bot) {
    return bot.api.setMyCommands(
        COMMANDS
            .filter(c => c.interfaces.includes('telegram') && !RESERVED_CMDS.has(c.name) && !TG_EXCLUDED_CMDS.has(c.name))
            .map(c => ({
                command: c.name,
                description: toTelegramCommandDescription(c.desc),
            }))
    );
}

function makeTelegramCommandCtx() {
    return {
        interface: 'telegram',
        version: APP_VERSION,
        getSession,
        getSettings: () => settings,
        // Telegram settings changes: only fallbackOrder allowed
        updateSettings: async (patch) => {
            if (patch.fallbackOrder !== undefined && Object.keys(patch).length === 1) {
                const { replaceSettings: _replace, saveSettings: _save } = await import('./config.js');
                _replace({ ...settings, ...patch });
                _save(settings);
                return { ok: true };
            }
            return { ok: false, text: '❌ Telegram에서 설정 변경은 지원하지 않습니다.' };
        },
        getRuntime: () => ({
            uptimeSec: Math.floor(process.uptime()),
            activeAgent: !!activeProcess,
            queuePending: messageQueue.length,
        }),
        getSkills: () => getMergedSkills(),
        clearSession: async () => {
            clearMessages.run();
            const s = getSession();
            updateSession.run(s.active_cli, null, s.model, s.permissions, s.working_dir, s.effort);
            broadcast('clear', {});
        },
        getCliStatus: () => detectAllCli(),
        getMcp: () => ({ servers: {} }),
        syncMcp: async () => ({ results: {} }),
        installMcp: async () => ({ results: {} }),
        listMemory: () => memory.list(),
        searchMemory: (q) => memory.search(q),
        getBrowserStatus: async () => {
            try {
                const m = await import('./browser/index.js');
                return m.getBrowserStatus(settings.browser?.cdpPort || 9240);
            } catch {
                return { running: false, tabs: [] };
            }
        },
        getBrowserTabs: async () => {
            try {
                const m = await import('./browser/index.js');
                return { tabs: await m.listTabs(settings.browser?.cdpPort || 9240) };
            } catch {
                return { tabs: [] };
            }
        },
        getPrompt: () => ({ content: '(Telegram에서 미지원)' }),
    };
}

// ─── Init ────────────────────────────────────────────

export function initTelegram() {
    if (telegramBot) {
        const old = telegramBot;
        telegramBot = null;
        try { old.stop(); } catch { }
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
        console.log('[tg] ⏸️  Telegram pending (disabled or no token)');
        return;
    }

    const ipv4Agent = new https.Agent({ family: 4 });
    const ipv4Fetch = (url, init = {}) => {
        return new Promise((resolve, reject) => {
            const u = new URL(url);
            const opts = {
                hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
                method: init.method || 'GET', agent: ipv4Agent,
                headers: init.headers instanceof Headers ? Object.fromEntries(init.headers) : (init.headers || {}),
            };
            const req = https.request(opts, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
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
        client: { fetch: ipv4Fetch },
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

    bot.command('start', (ctx) => ctx.reply('🦞 Claw Agent 연결됨! 메시지를 보내면 AI 에이전트가 응답합니다.'));
    bot.command('id', (ctx) => ctx.reply(`Chat ID: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' }));

    async function tgOrchestrate(ctx, prompt, displayMsg) {
        if (activeProcess) {
            console.log('[tg:steer] killing active agent for new message');
            killActiveAgent('telegram-steer');
            await waitForProcessEnd(3000);
        }

        markChatActive(ctx.chat.id);
        insertMessage.run('user', displayMsg, 'telegram', '');
        broadcast('new_message', { role: 'user', content: displayMsg, source: 'telegram' });

        await ctx.replyWithChatAction('typing')
            .then(() => console.log('[tg:typing] ✅ sent'))
            .catch(e => console.log('[tg:typing] ❌', e.message));
        const typingInterval = setInterval(() => {
            ctx.replyWithChatAction('typing')
                .then(() => console.log('[tg:typing] ✅ refresh'))
                .catch(e => console.log('[tg:typing] ❌ refresh', e.message));
        }, 4000);

        const showTools = settings.telegram?.showToolUse !== false;
        let statusMsgId = null;
        let toolLines = [];

        const toolHandler = showTools ? (type, data) => {
            if (type === 'agent_fallback') {
                toolLines.push(`⚡ ${data.from} → ${data.to}`);
            } else if (type === 'agent_tool' && data.icon && data.label) {
                toolLines.push(`${data.icon} ${data.label}`);
            } else {
                return;
            }
            const display = toolLines.slice(-5).join('\n');
            if (!statusMsgId) {
                ctx.reply(`🔄 ${display}`)
                    .then(m => { statusMsgId = m.message_id; })
                    .catch(() => { });
            } else {
                ctx.api.editMessageText(ctx.chat.id, statusMsgId, `🔄 ${display}`)
                    .catch(() => { });
            }
        } : null;

        if (toolHandler) addBroadcastListener(toolHandler);

        try {
            const result = await orchestrateAndCollect(prompt);
            clearInterval(typingInterval);
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
        } catch (err) {
            clearInterval(typingInterval);
            if (toolHandler) removeBroadcastListener(toolHandler);
            if (statusMsgId) {
                ctx.api.deleteMessage(ctx.chat.id, statusMsgId).catch(() => { });
            }
            console.error('[tg:error]', err);
            await ctx.reply(`❌ Error: ${err.message}`);
        }
    }

    bot.on('message:text', async (ctx) => {
        markChatActive(ctx.chat.id);
        const text = ctx.message.text;
        if (text.startsWith('/')) {
            const parsed = parseCommand(text);
            if (!parsed) return;
            const result = await executeCommand(parsed, makeTelegramCommandCtx());
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
        tgOrchestrate(ctx, text, text);
    });

    bot.on('message:photo', async (ctx) => {
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1];
        const caption = ctx.message.caption || '';
        console.log(`[tg:photo] ${ctx.chat.id}: fileId=${largest.file_id.slice(0, 20)}... caption=${caption.slice(0, 40)}`);
        try {
            const { buffer, ext } = await downloadTelegramFile(largest.file_id, settings.telegram.token);
            const filePath = saveUpload(buffer, `photo${ext}`);
            const prompt = buildMediaPrompt(filePath, caption);
            tgOrchestrate(ctx, prompt, `[📷 이미지] ${caption}`);
        } catch (err) {
            console.error('[tg:photo:error]', err);
            await ctx.reply(`❌ 이미지 처리 실패: ${err.message}`);
        }
    });

    bot.on('message:document', async (ctx) => {
        const doc = ctx.message.document;
        const caption = ctx.message.caption || '';
        console.log(`[tg:doc] ${ctx.chat.id}: ${doc.file_name} (${doc.file_size} bytes)`);
        try {
            const { buffer } = await downloadTelegramFile(doc.file_id, settings.telegram.token);
            const filePath = saveUpload(buffer, doc.file_name || 'document');
            const prompt = buildMediaPrompt(filePath, caption);
            tgOrchestrate(ctx, prompt, `[📎 ${doc.file_name || 'file'}] ${caption}`);
        } catch (err) {
            console.error('[tg:doc:error]', err);
            await ctx.reply(`❌ 파일 처리 실패: ${err.message}`);
        }
    });

    void syncTelegramCommands(bot).catch((e) => {
        console.warn('[tg:commands] setMyCommands failed:', e.message);
    });

    bot.start({
        drop_pending_updates: true,
        onStart: (info) => console.log(`[tg] ✅ @${info.username} polling active`),
    });
    telegramBot = bot;
    console.log('[tg] Bot starting...');
}

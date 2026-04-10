// ─── Discord Bot ─────────────────────────────────────
// Discord transport implementation for cli-jaw messaging runtime.

import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { settings } from '../core/config.js';
import { submitMessage } from '../orchestrator/gateway.js';
import { orchestrateAndCollect } from '../orchestrator/collect.js';
import { isResetIntent } from '../orchestrator/pipeline.js';
import { addBroadcastListener, removeBroadcastListener, type BroadcastListener } from '../core/bus.js';
import { saveUpload, buildMediaPrompt, isAgentBusy } from '../agent/spawn.js';
import { registerTransport, setLastActiveTarget, setLatestSeenTarget, getLastActiveTarget } from '../messaging/runtime.js';
import { registerSendTransport } from '../messaging/send.js';
import { t, normalizeLocale } from '../core/i18n.js';
import type { RemoteTarget } from '../messaging/types.js';
import type { ChannelSendRequest } from '../messaging/send.js';
import { handleDiscordSlashCommand, registerDiscordSlashCommands } from './commands.js';
import { createDiscordForwarder, chunkDiscordMessage } from './forwarder.js';
import { sendDiscordFile } from './discord-file.js';
import type { Attachment, Message } from 'discord.js';

// ─── State ───────────────────────────────────────────

export let discordClient: Client | null = null;
export const discordActiveChannelIds = new Set<string>();
let forwarderHandler: BroadcastListener | null = null;

// ─── Helpers ────────────────────────────────────────

function buildDiscordTarget(msg: any): RemoteTarget {
    const isGroup = msg.guild !== null;
    return {
        channel: 'discord',
        targetKind: isGroup ? 'channel' : 'user',
        peerKind: isGroup ? 'channel' : 'direct',
        targetId: msg.channelId,
        threadId: msg.channel?.isThread?.() ? msg.channelId : undefined,
        guildId: msg.guildId ?? undefined,
        parentTargetId: msg.channel?.isThread?.() ? (msg.channel.parentId ?? undefined) : undefined,
    };
}

function markChannelActive(channelId: string) {
    discordActiveChannelIds.delete(channelId);
    discordActiveChannelIds.add(channelId);
}

const MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024; // 50 MiB

async function downloadDiscordAttachment(attachment: Attachment): Promise<{ buffer: Buffer; name: string }> {
    if (attachment.size && attachment.size > MAX_ATTACHMENT_SIZE) {
        throw new Error(`Attachment too large: ${(attachment.size / 1024 / 1024).toFixed(1)} MiB (max 50 MiB)`);
    }
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`Failed to download attachment: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, name: attachment.name || 'attachment' };
}

function stripBotMention(text: string, botId: string): string {
    return text.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
}

function currentLocale() {
    return normalizeLocale(settings.locale, 'ko');
}

// ─── Discord Orchestrate (full reply path) ──────────

async function dcOrchestrate(msg: Message, prompt: string, displayMsg: string) {
    const target = buildDiscordTarget(msg);
    const chatId = msg.channelId;
    const result = submitMessage(prompt, {
        origin: 'discord', displayText: displayMsg, skipOrchestrate: true, target, chatId,
    });

    if (result.action === 'queued') {
        console.log(`[discord:queue] agent busy, queued (${result.pending} pending)`);
        await msg.reply(t('tg.queued', { count: result.pending }, currentLocale()));

        // Listen for queued result — correlate by requestId (request-level isolation)
        const requestId = result.requestId;
        let queueTimeout: ReturnType<typeof setTimeout>;
        const queueHandler = (type: string, data: Record<string, any>) => {
            if (type === 'orchestrate_done' && data.text && data.origin === 'discord'
                && data.requestId === requestId) {
                clearTimeout(queueTimeout);
                removeBroadcastListener(queueHandler);
                const chunks = chunkDiscordMessage(data.text);
                for (const chunk of chunks) {
                    (msg.channel as any).send(chunk).catch((e: Error) => {
                        console.error('[discord:queue-send]', e.message);
                    });
                }
            }
        };
        addBroadcastListener(queueHandler);
        queueTimeout = setTimeout(() => removeBroadcastListener(queueHandler), 300000);
        return;
    }

    if (result.action === 'rejected') {
        await msg.reply(`❌ ${result.reason}`);
        return;
    }

    // result.action === 'started' — orchestrate and collect result
    markChannelActive(msg.channelId);

    try {
        const text = String(await orchestrateAndCollect(prompt, {
            origin: 'discord', target, chatId, requestId: result.requestId, _skipInsert: true,
        }));
        const chunks = chunkDiscordMessage(text);
        for (const chunk of chunks) {
            await (msg.channel as any).send(chunk);
        }
        console.log(`[discord:out] ${msg.channelId}: ${text.slice(0, 80)}`);
    } catch (err: unknown) {
        console.error('[discord:error]', err);
        await msg.reply(`❌ Error: ${(err as Error).message}`).catch(() => { });
    }
}

// ─── Init / Shutdown ────────────────────────────────

export async function initDiscord() {
    await shutdownDiscord();
    if (!settings.discord?.enabled || !settings.discord?.token) {
        console.log('[discord] ⏭️  Discord pending (disabled or no token)');
        return;
    }

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages,
        ],
        partials: [Partials.Channel], // Required for DM events
    });

    // ── Error handler: disable Discord on network failure ──
    client.on(Events.Error, (err) => {
        console.error(`[discord] ❌ Client error: ${err.message}`);
        console.error('[discord] Disabling Discord for this session — restart to retry');
        shutdownDiscord().catch(() => { /* ignore */ });
    });

    // ── Message handler ──
    client.on(Events.MessageCreate, async (msg) => {
        if (msg.author.id === client.user?.id) return; // never process own messages
        if (msg.author.bot && !settings.discord.allowBots) return;
        if (settings.discord.channelIds?.length) {
            const parentId = (msg.channel as any)?.parentId;
            if (!settings.discord.channelIds.includes(msg.channelId)
                && !(parentId && settings.discord.channelIds.includes(parentId))) return;
        }

        // @mention gating: skip non-mentioned messages in guild channels
        if (settings.discord.mentionOnly && msg.guild) {
            if (!client.user || !msg.mentions.has(client.user, { ignoreRepliedUser: true })) return;
        }

        markChannelActive(msg.channelId);
        const target = buildDiscordTarget(msg);
        setLastActiveTarget('discord', target);
        setLatestSeenTarget('discord', target);

        // Attachment handling
        if (msg.attachments.size > 0) {
            const first = msg.attachments.first()!;
            try {
                const dl = await downloadDiscordAttachment(first);
                const filePath = saveUpload(dl.buffer, dl.name);
                let caption = msg.content || '';
                if (settings.discord.mentionOnly && client.user) {
                    caption = stripBotMention(caption, client.user.id);
                }
                const prompt = buildMediaPrompt(filePath, caption);
                dcOrchestrate(msg, prompt, `[📎 ${dl.name}] ${caption}`).catch(e => console.error('[discord:orchestrate]', (e as Error).message));
            } catch (e) {
                console.error('[discord:attachment]', (e as Error).message);
                await msg.reply(`❌ ${(e as Error).message}`).catch(() => { });
            }
            return;
        }

        // Text message
        let text = msg.content?.trim() || '';
        if (settings.discord.mentionOnly && client.user) {
            text = stripBotMention(text, client.user.id);
        }
        if (!text) return;

        console.log(`[discord:in] ${msg.channelId}: ${text.slice(0, 80)}`);

        // Reset intent: use submitMessage gateway for consistency
        if (isResetIntent(text)) {
            const result = submitMessage(text, { origin: 'discord', target });
            if (result.action === 'rejected') {
                await msg.reply(t('ws.agentBusy', {}, currentLocale()));
            } else {
                await msg.reply(t('tg.resetDone', {}, currentLocale()));
            }
            return;
        }

        dcOrchestrate(msg, text, text).catch(e => console.error('[discord:orchestrate]', (e as Error).message));
    });

    // ── Slash command handler ──
    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        await handleDiscordSlashCommand(interaction);
    });

    // ── Forwarder: non-Discord responses → Discord ──
    if (settings.discord?.forwardAll !== false) {
        const fwd = createDiscordForwarder({
            client,
            getLastTarget: () => getLastActiveTarget('discord'),
            shouldSkip: (data) => data.origin === 'discord',
            log: ({ channelId, preview }) => {
                console.log(`[discord:forward] → ${channelId}: ${preview}...`);
            },
        });
        forwarderHandler = fwd;
        addBroadcastListener(fwd);
    }

    // ── Login ──
    try {
        await client.login(settings.discord.token);
    } catch (err) {
        console.error(`[discord] ❌ Login failed (network?): ${(err as Error).message}`);
        console.error('[discord] Disabling Discord for this session — restart to retry');
        try { await client.destroy(); } catch { /* ignore */ }
        return;
    }
    discordClient = client;
    console.log(`[discord] ✅ Bot logged in as ${client.user?.tag || 'unknown'}`);

    // Register slash commands after login
    await registerDiscordSlashCommands(client);
}

export async function shutdownDiscord() {
    if (forwarderHandler) {
        removeBroadcastListener(forwarderHandler);
        forwarderHandler = null;
    }
    discordActiveChannelIds.clear();
    if (!discordClient) return;
    const old = discordClient;
    discordClient = null;
    try { await old.destroy(); } catch (e) {
        console.warn('[discord:stop]', (e as Error).message);
    }
    console.log('[discord] stopped');
}

// ─── Send Handler ───────────────────────────────────

async function discordSendHandler(req: ChannelSendRequest): Promise<{ ok: boolean; error?: string; [k: string]: any }> {
    if (!discordClient) return { ok: false, error: 'Discord not connected' };

    // Thread-aware: prefer threadId over targetId when present
    const channelId = req.chatId || req.target?.threadId || req.target?.targetId
        || (Array.from(discordActiveChannelIds).at(-1))
        || settings.discord?.channelIds?.[0];
    if (!channelId) return { ok: false, error: 'No discord channelId available — send a message first or set channelIds' };

    if (req.type === 'text') {
        const text = req.text?.trim();
        if (!text) return { ok: false, error: 'text required' };
        try {
            const channel = await discordClient.channels.fetch(String(channelId));
            if (!channel || !('send' in channel)) return { ok: false, error: 'Channel not text-based' };
            const chunks = chunkDiscordMessage(text);
            for (const chunk of chunks) {
                await (channel as any).send(chunk);
            }
            return { ok: true, channel_id: channelId, type: 'text' };
        } catch (e) {
            return { ok: false, error: (e as Error).message };
        }
    }

    // File types
    const filePath = req.filePath;
    if (!filePath) return { ok: false, error: 'file_path required for non-text types' };

    const target: RemoteTarget = req.target || {
        channel: 'discord',
        targetKind: 'channel',
        peerKind: 'channel',
        targetId: String(channelId),
    };

    const fileResult = await sendDiscordFile(discordClient, target, filePath, { caption: req.caption });
    if (!fileResult.ok) return fileResult;
    return { ok: true, channel_id: channelId, type: req.type };
}

// ─── Register Transport ─────────────────────────────

registerTransport('discord', { init: initDiscord, shutdown: shutdownDiscord });
registerSendTransport('discord', discordSendHandler);

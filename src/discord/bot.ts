// ─── Discord Bot ─────────────────────────────────────
// Discord transport implementation for cli-jaw messaging runtime.

import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { settings } from '../core/config.js';
import { submitMessage } from '../orchestrator/gateway.js';
import { orchestrateAndCollect } from '../orchestrator/collect.js';
import { isResetIntent } from '../orchestrator/pipeline.js';
import { addBroadcastListener, removeBroadcastListener } from '../core/bus.js';
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
let forwarderHandler: ((type: string, data: any) => void) | null = null;

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

async function downloadDiscordAttachment(attachment: Attachment): Promise<{ buffer: Buffer; name: string }> {
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`Failed to download attachment: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, name: attachment.name || 'attachment' };
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
        const queueHandler = (type: string, data: Record<string, any>) => {
            if (type === 'orchestrate_done' && data.text && data.origin === 'discord'
                && data.requestId === requestId) {
                removeBroadcastListener(queueHandler);
                const chunks = chunkDiscordMessage(data.text);
                for (const chunk of chunks) {
                    (msg.channel as any).send(chunk).catch(() => { });
                }
            }
        };
        addBroadcastListener(queueHandler);
        setTimeout(() => removeBroadcastListener(queueHandler), 300000);
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

    // ── Message handler ──
    client.on(Events.MessageCreate, async (msg) => {
        if (msg.author.bot && !settings.discord.allowBots) return;
        if (settings.discord.channelIds?.length && !settings.discord.channelIds.includes(msg.channelId)) return;

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
                const prompt = buildMediaPrompt(filePath, msg.content || '');
                dcOrchestrate(msg, prompt, `[📎 ${dl.name}] ${msg.content || ''}`);
            } catch (e) {
                console.error('[discord:attachment]', (e as Error).message);
                await msg.reply(`❌ ${(e as Error).message}`).catch(() => { });
            }
            return;
        }

        // Text message
        const text = msg.content?.trim();
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

        dcOrchestrate(msg, text, text);
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
    await client.login(settings.discord.token);
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

    const channelId = req.chatId || req.target?.targetId
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

    try {
        await sendDiscordFile(discordClient, target, filePath, { caption: req.caption });
        return { ok: true, channel_id: channelId, type: req.type };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}

// ─── Register Transport ─────────────────────────────

registerTransport('discord', { init: initDiscord, shutdown: shutdownDiscord });
registerSendTransport('discord', discordSendHandler);

// ─── Discord Bot ─────────────────────────────────────
// Discord transport implementation for cli-jaw messaging runtime.

import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { settings } from '../core/config.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { submitMessage } from '../orchestrator/gateway.js';
import { orchestrateAndCollect } from '../orchestrator/collect.js';
import { isResetIntent } from '../orchestrator/pipeline.js';
import { addBroadcastListener, removeBroadcastListener, type BroadcastListener } from '../core/bus.js';
import { saveUpload, buildMediaPromptMany } from '../agent/spawn.js';
import { setLastActiveTarget, setLatestSeenTarget, getLastActiveTarget } from '../messaging/runtime.js';
import { t, normalizeLocale } from '../core/i18n.js';
import type { RemoteTarget } from '../messaging/types.js';
import type { ChannelSendRequest } from '../messaging/send.js';
import { handleDiscordSlashCommand, registerDiscordSlashCommands } from './commands.js';
import { createDiscordForwarder, chunkDiscordMessage } from './forwarder.js';
import { sendDiscordFile } from './discord-file.js';
import { getDiscordSendClient, sendDiscordFileRest, sendDiscordTextRest } from './send-only-client.js';
import type { Attachment, Message } from 'discord.js';
import { asSendable, asThreadLike, asTypingChannel } from './channel-types.js';
import { log } from '../core/logger.js';

// ─── State ───────────────────────────────────────────

export let discordClient: Client | null = null;
export const discordActiveChannelIds = new Set<string>();
let forwarderHandler: BroadcastListener | null = null;
let dcInitLock = false;

type SavedDiscordAttachment = { name: string; filePath: string };
type FailedDiscordAttachment = { name: string; reason: string };

// ─── Helpers ────────────────────────────────────────

function buildDiscordTarget(msg: Message): RemoteTarget {
    const isGroup = msg.guild !== null;
    return stripUndefined({
        channel: 'discord',
        targetKind: isGroup ? 'channel' : 'user',
        peerKind: isGroup ? 'channel' : 'direct',
        targetId: msg.channelId,
        threadId: msg.channel?.isThread?.() ? msg.channelId : undefined,
        guildId: msg.guildId ?? undefined,
        parentTargetId: msg.channel?.isThread?.() ? (asThreadLike(msg.channel)?.parentId ?? undefined) : undefined,
    });
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

async function downloadAndSaveDiscordAttachments(
    attachments: Message['attachments'],
): Promise<{ saved: SavedDiscordAttachment[]; failed: FailedDiscordAttachment[] }> {
    const attachmentList = Array.from(attachments.values());
    const results = await Promise.allSettled(
        attachmentList.map(async (attachment) => {
            const dl = await downloadDiscordAttachment(attachment);
            const filePath = saveUpload(dl.buffer, dl.name);
            return { name: dl.name, filePath };
        }),
    );

    const saved: SavedDiscordAttachment[] = [];
    const failed: FailedDiscordAttachment[] = [];

    for (const [index, result] of results.entries()) {
        const fallbackName = attachmentList[index]?.name || `attachment-${index + 1}`;
        if (result.status === 'fulfilled') {
            saved.push(result.value);
        } else {
            failed.push({
                name: fallbackName,
                reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
            });
        }
    }

    return { saved, failed };
}

function stripBotMention(text: string, botId: string): string {
    return text.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
}

function buildAttachmentFailureWarning(failed: FailedDiscordAttachment[]): string | null {
    if (!failed.length) return null;
    return `⚠️ 제외된 첨부파일:\n${failed.map(item => `- ${item.name}: ${item.reason}`).join('\n')}`;
}

function currentLocale() {
    return normalizeLocale(settings["locale"], 'ko');
}

// ─── Discord Orchestrate (full reply path) ──────────

async function dcOrchestrate(msg: Message, prompt: string, displayMsg: string) {
    const target = buildDiscordTarget(msg);
    const chatId = msg.channelId;
    const result = submitMessage(prompt, {
        origin: 'discord', displayText: displayMsg, skipOrchestrate: true, target, chatId,
    });

    if (result.action === 'queued') {
        log.info(`[discord:queue] agent busy, queued (${result.pending} pending)`);
        await msg.reply(t('tg.queued', { count: result.pending }, currentLocale()));

        // Listen for queued result — correlate by requestId (request-level isolation)
        const requestId = result.requestId;
        let queueTimeout: ReturnType<typeof setTimeout>;
        const queueHandler = async (type: string, data: Record<string, any>) => {
            if (type === 'orchestrate_done' && data["text"] && data["origin"] === 'discord'
                && data["requestId"] === requestId) {
                clearTimeout(queueTimeout);
                removeBroadcastListener(queueHandler);
                const chunks = chunkDiscordMessage(data["text"]);
                const channel = asSendable(msg.channel);
                if (!channel) return;
                for (const chunk of chunks) {
                    await channel.send(chunk).catch((e: Error) => {
                        log.error('[discord:queue-send]', e.message);
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

    // Typing indicator: start + periodic refresh (8s, Discord expires at 10s)
    const typingChannel = asTypingChannel(msg.channel);
    typingChannel?.sendTyping?.()
        ?.then(() => log.info('[discord:typing] ✅ sent'))
        ?.catch((e: Error) => log.info('[discord:typing] ❌', e.message));
    const typingInterval = setInterval(() => {
        typingChannel?.sendTyping?.()
            ?.then(() => log.info('[discord:typing] ✅ refresh'))
            ?.catch((e: Error) => log.info('[discord:typing] ❌ refresh', e.message));
    }, 8000);

    try {
        const text = String(await orchestrateAndCollect(prompt, {
            origin: 'discord', target, chatId, requestId: result.requestId, _skipInsert: true,
        }));
        const chunks = chunkDiscordMessage(text);
        const channel = asSendable(msg.channel);
        if (!channel) throw new Error('Discord channel is not text-based');
        for (const chunk of chunks) {
            await channel.send(chunk);
        }
        log.info(`[discord:out] ${msg.channelId}: ${text.slice(0, 80)}`);
    } catch (err: unknown) {
        log.error('[discord:error]', err);
        await msg.reply(`❌ Error: ${(err as Error).message}`).catch(() => { });
    } finally {
        clearInterval(typingInterval);
    }
}

// ─── Init / Shutdown ────────────────────────────────

export async function initDiscord() {
    if (dcInitLock) {
        log.warn('[discord] initDiscord already in progress, skipping');
        return;
    }
    dcInitLock = true;
    try {
    await shutdownDiscord();
    if (!settings["discord"]?.enabled || !settings["discord"]?.token) {
        log.info('[discord] ⏭️  Discord pending (disabled or no token)');
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
        allowedMentions: { parse: [] },
    });

    // ── Error handler: disable Discord on network failure ──
    client.on(Events.Error, (err) => {
        log.error(`[discord] ❌ Client error: ${err.message}`);
        log.error('[discord] Disabling Discord for this session — restart to retry');
        shutdownDiscord().catch(() => { /* ignore */ });
    });

    // ── Message handler ──
    client.on(Events.MessageCreate, async (msg) => {
        if (msg.author.id === client.user?.id) return; // never process own messages
        if (msg.author.bot && !settings["discord"].allowBots) return;
        if (settings["discord"].channelIds?.length) {
            const parentId = asThreadLike(msg.channel)?.parentId;
            if (!settings["discord"].channelIds.includes(msg.channelId)
                && !(parentId && settings["discord"].channelIds.includes(parentId))) return;
        }

        // @mention gating: skip non-mentioned messages in guild channels
        if (settings["discord"].mentionOnly && msg.guild) {
            if (!client.user || !msg.mentions.has(client.user, { ignoreRepliedUser: true })) return;
        }

        markChannelActive(msg.channelId);
        const target = buildDiscordTarget(msg);
        setLastActiveTarget('discord', target);
        setLatestSeenTarget('discord', target);

        let normalizedText = msg.content?.trim() || '';
        if (settings["discord"].mentionOnly && client.user) {
            normalizedText = stripBotMention(normalizedText, client.user.id);
        }

        // Attachment handling
        if (msg.attachments.size > 0) {
            try {
                const { saved, failed } = await downloadAndSaveDiscordAttachments(msg.attachments);
                if (saved.length === 0) {
                    const warning = buildAttachmentFailureWarning(failed) || '❌ No attachment could be processed';
                    await msg.reply(warning).catch(() => { });
                    return;
                }

                const prompt = buildMediaPromptMany(saved.map(item => item.filePath), normalizedText);
                const fileLabel = saved.length === 1
                    ? `[📎 ${saved[0]!.name}] ${normalizedText}`.trim()
                    : `[📎 ${saved.length} files] ${normalizedText}`.trim();

                const warning = buildAttachmentFailureWarning(failed);
                if (warning) {
                    await msg.reply(warning).catch(() => { });
                }

                dcOrchestrate(msg, prompt, fileLabel).catch(e => log.error('[discord:orchestrate]', (e as Error).message));
            } catch (e) {
                log.error('[discord:attachment]', (e as Error).message);
                await msg.reply(`❌ ${(e as Error).message}`).catch(() => { });
            }
            return;
        }

        // Text message
        const text = normalizedText;
        if (!text) return;

        log.info(`[discord:in] ${msg.channelId}: ${text.slice(0, 80)}`);

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

        dcOrchestrate(msg, text, text).catch(e => log.error('[discord:orchestrate]', (e as Error).message));
    });

    // ── Slash command handler ──
    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        await handleDiscordSlashCommand(interaction);
    });

    // ── Forwarder: non-Discord responses → Discord ──
    if (settings["discord"]?.forwardAll !== false) {
        const fwd = createDiscordForwarder({
            client,
            getLastTarget: () => getLastActiveTarget('discord'),
            shouldSkip: (data) => data["origin"] === 'discord',
            log: ({ channelId, preview }) => {
                log.info(`[discord:forward] → ${channelId}: ${preview}...`);
            },
        });
        forwarderHandler = fwd;
        addBroadcastListener(fwd);
    }

    // ── Login ──
    try {
        await client.login(settings["discord"].token);
    } catch (err) {
        log.error(`[discord] ❌ Login failed (network?): ${(err as Error).message}`);
        log.error('[discord] Disabling Discord for this session — restart to retry');
        if (forwarderHandler) {
            removeBroadcastListener(forwarderHandler);
            forwarderHandler = null;
        }
        try { await client.destroy(); } catch { /* ignore */ }
        return;
    }
    discordClient = client;
    log.info(`[discord] ✅ Bot logged in as ${client.user?.tag || 'unknown'}`);

    // Register slash commands after login
    await registerDiscordSlashCommands(client);
    } finally { dcInitLock = false; }
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
    try {
        await old.destroy();
    } catch (e) {
        log.warn('[discord:stop]', (e as Error).message);
        await new Promise(r => setTimeout(r, 2000));
    }
    log.info('[discord] stopped');
}

// ─── Send Handler ───────────────────────────────────

export async function discordSendHandler(req: ChannelSendRequest): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
    const channelId = req.chatId || req.target?.threadId || req.target?.targetId
        || (Array.from(discordActiveChannelIds).at(-1))
        || settings["discord"]?.channelIds?.[0];
    if (!channelId) {
        return { ok: false, error: 'No discord channelId available — send a message first or set channelIds', status: 400 };
    }

    if (discordClient) {
        if (req.type === 'text') {
            const text = req.text?.trim();
            if (!text) return { ok: false, error: 'text required' };
            try {
                const channel = await discordClient.channels.fetch(String(channelId));
                const sendable = asSendable(channel);
                if (!sendable) return { ok: false, error: 'Channel not text-based' };
                const chunks = chunkDiscordMessage(text);
                for (const chunk of chunks) {
                    await sendable.send(chunk);
                }
                return { ok: true, channel_id: channelId, type: 'text' };
            } catch (e) {
                return { ok: false, error: (e as Error).message };
            }
        }

        const filePath = req.filePath;
        if (!filePath) return { ok: false, error: 'file_path required for non-text types' };
        const target: RemoteTarget = req.target || {
            channel: 'discord',
            targetKind: 'channel',
            peerKind: 'channel',
            targetId: String(channelId),
        };
        const fileResult = await sendDiscordFile(discordClient, target, filePath, stripUndefined({ caption: req.caption }));
        if (!fileResult.ok) return fileResult;
        return { ok: true, channel_id: channelId, type: req.type };
    }

    const sendClient = getDiscordSendClient();
    if (!sendClient.token) {
        return { ok: false, error: sendClient.reason ?? 'Discord not configured', status: sendClient.status ?? 503 };
    }

    if (req.type === 'text') {
        const text = req.text?.trim();
        if (!text) return { ok: false, error: 'text required' };
        const result = await sendDiscordTextRest(sendClient.token, String(channelId), text);
        if (!result.ok) return result;
        return { ok: true, channel_id: channelId, type: 'text' };
    }

    const filePath = req.filePath;
    if (!filePath) return { ok: false, error: 'file_path required for non-text types' };
    const fileResult = await sendDiscordFileRest(sendClient.token, String(channelId), filePath, req.caption);
    if (!fileResult.ok) return fileResult;
    return { ok: true, channel_id: channelId, type: req.type };
}

// Transport registration moved to ./register.js (lazy loader) so importing
// this module — and discord.js's ~48MB with it — happens on first use only.

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
import {
    setLastActiveTarget,
    setLatestSeenTarget,
    getLastActiveTarget,
    transportStarted,
    transportNotStarted,
    type TransportStartOutcome,
} from '../messaging/runtime.js';
import { createHash } from 'node:crypto';
import {
    admitIngress, getIngressJournal, settleIngress, type IngressAdmission,
} from '../messaging/durable-ingress.js';
import { currentGenerationForEnvelope } from '../messaging/ingress-generation.js';
import { discordInboundEnvelope } from '../messaging/inbound-envelope.js';
import { t, normalizeLocale } from '../core/i18n.js';
import type { RemoteTarget } from '../messaging/types.js';
import { sendChannelOutput, type ChannelSendRequest } from '../messaging/send.js';
import { handleApprovalCommand, handleApprovalCallback, registerProductionTransport, type DispatchApprovalTransport } from '../core/dispatch-approval-ingress.js';
import { parseApprovalCallbackData } from '../messaging/approval-presentation.js';
import { handleDiscordSlashCommand, registerDiscordSlashCommands } from './commands.js';
import { createDiscordForwarder, chunkDiscordMessage, relayDiscordImages } from './forwarder.js';
import { sendDiscordFile } from './discord-file.js';
import { getDiscordSendClient, sendDiscordFileRest, sendDiscordTextRest } from './send-only-client.js';
import type { Attachment, Interaction, Message } from 'discord.js';
import { asSendable, asThreadLike, asTypingChannel } from './channel-types.js';
import { log } from '../core/logger.js';
import { redactOutboundText, logErrorText, userErrorText } from '../messaging/redact.js';
import { createSeenSet, DELIVERY_DEDUPE_TTL_MS } from '../messaging/dedupe.js';
import {
    DiscordGatewaySupervisor,
    type DiscordGatewayClientPort,
    type DiscordGatewaySnapshot,
    type GatewayEventMap,
    type GatewayEventName,
} from './gateway-supervisor.js';

/** Redelivered message ids, so a gateway resume does not run the agent twice. */
const discordSeenMessages = createSeenSet(DELIVERY_DEDUPE_TTL_MS);

// ─── State ───────────────────────────────────────────

export let discordClient: Client | null = null;
export const discordActiveChannelIds = new Set<string>();
let forwarderHandler: BroadcastListener | null = null;
let dcInitLock = false;
let gatewaySupervisor: DiscordGatewaySupervisor | null = null;
let lastGatewayEventCode: string | null = null;
let discordApprovalIngress: DispatchApprovalTransport | null = null;
function createDiscordGatewayIngress(): DispatchApprovalTransport {
    const transport = Object.freeze({ platform: 'discord' as const });
    registerProductionTransport(transport);
    return transport;
}
interface DiscordGenerationResources {
    client: Client;
    messageHandler: (msg: Message) => void;
    interactionHandler: (interaction: Interaction) => void;
    forwarder: BroadcastListener | null;
}

const generationResources = new Map<DiscordGatewayClientPort, DiscordGenerationResources>();

export class DiscordJsGatewayClientPort implements DiscordGatewayClientPort {
    constructor(readonly client: Client) {}

    login(token: string): Promise<string> { return this.client.login(token); }
    destroy(): void { this.client.destroy(); }
    shardIds(): readonly number[] { return [...this.client.ws.shards.keys()]; }

    on<K extends GatewayEventName>(
        event: K,
        listener: (...args: GatewayEventMap[K]) => void,
    ): void {
        this.client.on(event, listener);
    }

    off<K extends GatewayEventName>(
        event: K,
        listener: (...args: GatewayEventMap[K]) => void,
    ): void {
        this.client.off(event, listener);
    }
}

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

/**
 * Answer a queued turn nobody is waiting on any more.
 *
 * The ordinary queued reply rides a temporary listener armed by the request that
 * was queued (see `dcOrchestrate`). A restart destroys it — and the boot drain
 * (#407) runs exactly those messages. Without this the drain consumes the item,
 * deletes its row, and the answer goes nowhere.
 *
 * Keyed on the target the item carried through the queue, not on whoever spoke
 * most recently, and skipped when a live waiter would post the same result.
 */
const pendingQueueRequestIds = new Set<string>();
let targetReplyForwarderInstalled = false;

function installDiscordTargetReplyForwarder(): void {
    if (targetReplyForwarderInstalled) return;
    targetReplyForwarderInstalled = true;
    addBroadcastListener((type, data) => {
        if (type !== 'orchestrate_done' || data["origin"] !== 'discord' || !data["text"]) return;
        if (data["error"]) return;
        const target = data["target"] as RemoteTarget | undefined;
        if (!target || target.channel !== 'discord' || !target.targetId) return;
        if (data["requestId"] && pendingQueueRequestIds.has(String(data["requestId"]))) return;
        void sendChannelOutput({ channel: 'discord', type: 'text', text: String(data["text"]), target })
            .then(result => {
                if (!result.ok) log.error('[discord:target-reply]', logErrorText(result.error || 'send failed'));
            })
            .catch((e: unknown) => log.error('[discord:target-reply]', logErrorText(e)));
    });
}

installDiscordTargetReplyForwarder();

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
                if (requestId) pendingQueueRequestIds.delete(requestId);
                const chunks = chunkDiscordMessage(data["text"]);
                const channel = asSendable(msg.channel);
                if (!channel) {
                    log.warn('[discord:queue-send] channel not sendable, dropping queued reply', { channelId: msg.channelId });
                    return;
                }
                for (const chunk of chunks) {
                    await channel.send(chunk).catch((e: Error) => {
                        log.error('[discord:queue-send]', logErrorText(e));
                    });
                }
                await relayDiscordImages(msg.client, target, String(data["text"]));
            }
        };
        addBroadcastListener(queueHandler);
        if (requestId) pendingQueueRequestIds.add(requestId);
        queueTimeout = setTimeout(() => {
            removeBroadcastListener(queueHandler);
            if (requestId) pendingQueueRequestIds.delete(requestId);
        }, 300000);
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
        ?.catch((e: Error) => log.info('[discord:typing] ❌', logErrorText(e)));
    const typingInterval = setInterval(() => {
        typingChannel?.sendTyping?.()
            ?.then(() => log.info('[discord:typing] ✅ refresh'))
            ?.catch((e: Error) => log.info('[discord:typing] ❌ refresh', logErrorText(e)));
    }, 8000);

    try {
        const text = String(await orchestrateAndCollect(prompt, stripUndefined({
            origin: 'discord', target, chatId, requestId: result.requestId, _skipInsert: true,
            scope: result.sessionContext?.scope,
            chatSessionId: result.sessionContext?.chatSessionId,
            remoteKey: result.sessionContext?.remoteKey,
        })));
        const chunks = chunkDiscordMessage(text);
        const channel = asSendable(msg.channel);
        if (!channel) throw new Error('Discord channel is not text-based');
        for (const chunk of chunks) {
            await channel.send(chunk);
        }
        await relayDiscordImages(msg.client, target, text);
        log.info(`[discord:out] ${msg.channelId}: ${redactOutboundText(text).slice(0, 80)}`);
    } catch (err: unknown) {
        log.error('[discord:error]', logErrorText(err));
        await msg.reply(`❌ Error: ${userErrorText(err)}`).catch(() => { });
    } finally {
        clearInterval(typingInterval);
    }
}

// ─── Init / Shutdown ────────────────────────────────

async function handleDiscordApprovalButton(interaction: import('discord.js').ButtonInteraction): Promise<void> {
    const parsed = parseApprovalCallbackData(interaction.customId);
    if (!parsed) {
        await interaction.deferUpdate().catch(() => undefined);
        return;
    }
    await interaction.deferUpdate();
    const result = handleApprovalCallback(
        discordApprovalIngress,
        { author: interaction.user },
        parsed.opaqueId,
        parsed.action,
        { conversationKey: interaction.user.id, sessionGeneration: 0 },
    );
    const reply = result.approved ? 'approved' : (result.reason || 'rejected');
    await interaction.editReply({ components: [] }).catch(() => undefined);
    await interaction.followUp({ content: redactOutboundText(reply), ephemeral: true }).catch(() => undefined);
}

async function installDiscordGeneration(
    port: DiscordGatewayClientPort,
    client: Client,
): Promise<void> {
    const messageHandler = (msg: Message): void => {
        void handleDiscordMessage(client, msg, discordApprovalIngress).catch((error) => {
            log.error('[discord:message]', logErrorText(error));
        });
    };
    const interactionHandler = (interaction: Interaction): void => {
        if (interaction.isButton()) {
            void handleDiscordApprovalButton(interaction).catch((error) => {
                log.error('[discord:approval]', logErrorText(error));
            });
            return;
        }
        if (!interaction.isChatInputCommand()) return;
        void handleDiscordSlashCommand(interaction).catch((error) => {
            log.error('[discord:command]', logErrorText(error));
        });
    };

    client.on(Events.MessageCreate, messageHandler);
    client.on(Events.InteractionCreate, interactionHandler);
    const resources: DiscordGenerationResources = {
        client,
        messageHandler,
        interactionHandler,
        forwarder: null,
    };
    generationResources.set(port, resources);
    await registerDiscordSlashCommands(client);

    if (settings["discord"]?.forwardAll !== false) {
        const forwarder = createDiscordForwarder({
            client,
            getLastTarget: () => getLastActiveTarget('discord'),
            shouldSkip: (data) => data["origin"] === 'discord',
            log: ({ channelId, preview }) => {
                log.info(`[discord:forward] → ${channelId}: ${preview}...`);
            },
        });
        addBroadcastListener(forwarder);
        resources.forwarder = forwarder;
        forwarderHandler = forwarder;
    }

    discordClient = client;
}

async function retireDiscordGeneration(port: DiscordGatewayClientPort): Promise<void> {
    const resources = generationResources.get(port);
    generationResources.delete(port);
    if (!resources) return;

    resources.client.off(Events.MessageCreate, resources.messageHandler);
    resources.client.off(Events.InteractionCreate, resources.interactionHandler);
    if (resources.forwarder) {
        removeBroadcastListener(resources.forwarder);
        if (forwarderHandler === resources.forwarder) forwarderHandler = null;
    }
    if (discordClient === resources.client) discordClient = null;
}


/**
 * Journal the message before it is handled. Discord differs from the other two
 * channels in where the account id comes from: `client.user.id` is null before READY
 * and can change across reconnects, so it is read here at handler time rather than
 * captured at startup.
 *
 * When it cannot be resolved the message is NOT admitted. Handling it would put work
 * through a path whose durability record could not be written, and dropping it
 * silently is what this milestone exists to stop; the gateway still has it and will
 * redeliver on the next generation.
 */
function admitDiscordMessage(client: Client, msg: Message, target: RemoteTarget): IngressAdmission {
    const journal = getIngressJournal();
    if (!journal) return { admit: true, journaled: false };

    const botUserId = client.user?.id;
    if (!botUserId) {
        log.warn(redactOutboundText(`[discord:ingress] bot identity unavailable — not admitting message ${msg.id}`));
        return { admit: false, reason: 'already_handled' };
    }

    const envelope = discordInboundEnvelope({
        botUserId,
        messageId: msg.id,
        channelId: msg.channelId,
        authorId: msg.author.id,
        guildId: msg.guildId,
        isThread: msg.channel?.isThread?.() ?? false,
        parentId: asThreadLike(msg.channel)?.parentId,
        target,
    });
    const admission = admitIngress(journal, envelope, discordPayloadDigest(msg), undefined, envelope ? currentGenerationForEnvelope(envelope) : 0);
    if (!admission.admit) {
        log.info(redactOutboundText(`[discord:ingress] message ${msg.id} already handled — not re-running`));
    }
    return admission;
}

/** Identity of the message body. Never the body itself: the journal is not an archive. */
function discordPayloadDigest(msg: Message): string {
    return createHash('sha256')
        .update(JSON.stringify({ id: msg.id, content: msg.content ?? '', attachments: msg.attachments.size }))
        .digest('hex');
}

export async function handleDiscordMessage(client: Client, msg: Message, transport = discordApprovalIngress): Promise<void> {
    const approval = handleApprovalCommand(transport, {
        ...msg,
        author: msg.author,
        __jawSelf: msg.author.id === client.user?.id,
    }, msg.content || '');
    if (approval.handled) return;
    if (msg.author.id === client.user?.id) return; // never process own messages
    if (msg.author.bot && !settings["discord"].allowBots) return;
    if (settings["discord"].channelIds?.length) {
        const parentId = asThreadLike(msg.channel)?.parentId;
        if (!settings["discord"].channelIds.includes(msg.channelId)
            && !(parentId && settings["discord"].channelIds.includes(parentId))) return;
    }

    if (settings["discord"].mentionOnly && msg.guild) {
        if (!client.user || !msg.mentions.has(client.user, { ignoreRepliedUser: true })) return;
    }

    if (discordSeenMessages.seen(msg.id)) {
        log.info(`[discord:duplicate] id=${msg.id}`);
        return;
    }

    markChannelActive(msg.channelId);
    const target = buildDiscordTarget(msg);

    // Durable record of this message. The seen-set above stays as the hot in-process
    // filter; this is what survives a restart, which is the whole difference between
    // Discord and the other two channels before M3.
    const admission = admitDiscordMessage(client, msg, target);
    if (!admission.admit) return;
    const settle = (error?: unknown) => settleIngress(getIngressJournal(), admission, error);
    setLastActiveTarget('discord', target);
    setLatestSeenTarget('discord', target);

    let normalizedText = msg.content?.trim() || '';
    if (settings["discord"].mentionOnly && client.user) {
        normalizedText = stripBotMention(normalizedText, client.user.id);
    }

    if (msg.attachments.size > 0) {
        try {
            const { saved, failed } = await downloadAndSaveDiscordAttachments(msg.attachments);
            if (saved.length === 0) {
                const warning = buildAttachmentFailureWarning(failed) || '❌ No attachment could be processed';
                await msg.reply(warning).catch(() => { });
                // The user was told; there is nothing left to retry on redelivery.
                settle();
                return;
            }

            const prompt = buildMediaPromptMany(saved.map(item => item.filePath), normalizedText);
            const fileLabel = saved.length === 1
                ? `[📎 ${saved[0]!.name}] ${normalizedText}`.trim()
                : `[📎 ${saved.length} files] ${normalizedText}`.trim();
            const warning = buildAttachmentFailureWarning(failed);
            if (warning) await msg.reply(warning).catch(() => { });
            dcOrchestrate(msg, prompt, fileLabel).catch(e => log.error('[discord:orchestrate]', logErrorText(e)));
            settle();
        } catch (error) {
            log.error('[discord:attachment]', logErrorText(error));
            await msg.reply(`❌ ${userErrorText(error)}`).catch(() => { });
            settle(error);
        }
        return;
    }

    const text = normalizedText;
    if (!text) {
        settle();
        return;
    }
    log.info(`[discord:in] ${msg.channelId}: ${redactOutboundText(text).slice(0, 80)}`);

    // Reset intent: use submitMessage gateway for consistency
    if (isResetIntent(text)) {
        const result = submitMessage(text, { origin: 'discord', target });
        if (result.action === 'rejected') {
            await msg.reply(t('ws.agentBusy', {}, currentLocale()));
        } else {
            await msg.reply(t('tg.resetDone', {}, currentLocale()));
        }
        settle();
        return;
    }

    dcOrchestrate(msg, text, text).catch(e => log.error('[discord:orchestrate]', logErrorText(e)));
    settle();
}

function observeGatewaySnapshot(snapshot: DiscordGatewaySnapshot): void {
    if (snapshot.lastEventCode === lastGatewayEventCode) return;
    lastGatewayEventCode = snapshot.lastEventCode;
    if (snapshot.lastEventCode?.startsWith('client_error:')
        || snapshot.lastEventCode?.startsWith('shard_error:')) {
        log.warn(`[discord:gateway] ${snapshot.lastEventCode}`);
    } else if (snapshot.state === 'blocked') {
        log.error(logErrorText(`[discord:gateway] blocked (${snapshot.lastEventCode ?? 'unknown'})`));
    } else if (snapshot.state === 'recovering') {
        log.warn(`[discord:gateway] recovering (${snapshot.lastEventCode ?? 'unknown'})`);
    }
}

export async function initDiscord(): Promise<TransportStartOutcome> {
    if (dcInitLock) {
        log.warn('[discord] initDiscord already in progress, skipping');
        return transportNotStarted('superseded');
    }
    dcInitLock = true;
    try {
    await shutdownDiscord();
    if (!settings["discord"]?.enabled || !settings["discord"]?.token) {
        log.info('[discord] ⏭️  Discord pending (disabled or no token)');
        return transportNotStarted('not_configured');
    }

    const supervisor = new DiscordGatewaySupervisor({
        token: settings["discord"].token,
        createClient: () => new DiscordJsGatewayClientPort(new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages,
            ],
            partials: [Partials.Channel],
            allowedMentions: { parse: [] },
        })),
        onGenerationReady: async (port) => {
            const adapter = port as DiscordJsGatewayClientPort;
            await installDiscordGeneration(port, adapter.client);
        },
        onConnectionReady: (port) => {
            const adapter = port as DiscordJsGatewayClientPort;
            log.info(`[discord] ✅ Bot logged in as ${adapter.client.user?.tag || 'unknown'}`);
        },
        onClientRetired: retireDiscordGeneration,
        onSnapshot: observeGatewaySnapshot,
    });
    gatewaySupervisor = supervisor;
    discordApprovalIngress = createDiscordGatewayIngress();
    await supervisor.start();
    // ACCEPTED, not ready. start() resolves once replaceClient has been issued, and
    // replaceClient swallows a login failure into scheduleReplacement('login_failed')
    // instead of rethrowing; the message handler is installed later by
    // onGenerationReady. Readiness belongs to channel health — do not "fix" this
    // into a guarantee the supervisor never makes.
    return transportStarted;
    } finally { dcInitLock = false; }
}

export async function shutdownDiscord() {
    discordActiveChannelIds.clear();
    const supervisor = gatewaySupervisor;
    gatewaySupervisor = null;
    if (supervisor) {
        try {
            await supervisor.stop();
        } catch (error) {
            log.warn('[discord:stop]', logErrorText(error));
            await new Promise(r => setTimeout(r, 2000));
        }
    } else if (discordClient) {
        const old = discordClient;
        discordClient = null;
        try {
            await old.destroy();
        } catch (error) {
            log.warn('[discord:stop]', logErrorText(error));
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    forwarderHandler = null;
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

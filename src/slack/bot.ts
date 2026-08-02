// ─── Slack Bot ───────────────────────────────────────
// Slack transport implementation for the cli-jaw messaging runtime.
// Mirrors src/discord/bot.ts structurally: init/shutdown lifecycle, an inbound
// handler that gates then dispatches into submitMessage/orchestrateAndCollect,
// and a forwarder for non-Slack-origin agent output.

import { settings } from '../core/config.js';
import { log } from '../core/logger.js';
import { t, normalizeLocale } from '../core/i18n.js';
import { addBroadcastListener, removeBroadcastListener, type BroadcastListener } from '../core/bus.js';
import { submitMessage } from '../orchestrator/gateway.js';
import { orchestrateAndCollect } from '../orchestrator/collect.js';
import { isResetIntent } from '../orchestrator/pipeline.js';
import { setLastActiveTarget, setLatestSeenTarget, getLastActiveTarget } from '../messaging/runtime.js';
import { slackTargetFromId, resolveSlackThreadTs } from '../messaging/slack-target.js';
import type { RemoteTarget } from '../messaging/types.js';
import { slackApi } from './api.js';
import { SlackSocketClient, type SlackEnvelope } from './socket.js';
import { resolveEventText, shouldProcessSlackEvent, type SlackMessageEvent } from './events.js';
import { sendSlackText, getSlackSendClient } from './send-only-client.js';
import { createSlackForwarder, relaySlackImages } from './forwarder.js';
import { handleSlackSlashCommand } from './commands.js';

let socketClient: SlackSocketClient | null = null;
let forwarderHandler: BroadcastListener | null = null;
let selfUserId: string | null = null;
let slackInitLock = false;

export function getSlackSelfUserId(): string | null { return selfUserId; }
export function getSlackConnectionState(): string {
    return socketClient?.getState() ?? 'disconnected';
}

function currentLocale() { return normalizeLocale(settings["locale"], 'ko'); }

function gateConfig() {
    const sc = settings["slack"] || {};
    return {
        selfUserId,
        allowBots: Boolean(sc.allowBots),
        mentionOnly: sc.mentionOnly !== false,
        channelIds: Array.isArray(sc.channelIds) ? sc.channelIds as string[] : [],
    };
}

function buildSlackTarget(event: SlackMessageEvent): RemoteTarget {
    const replyInThread = settings["slack"]?.replyInThread !== false;
    const threadTs = resolveSlackThreadTs(event, replyInThread);
    const teamId = settings["slack"]?.teamId;
    return slackTargetFromId(event.channel as string, {
        ...(threadTs ? { threadTs } : {}),
        ...(teamId ? { teamId: String(teamId) } : {}),
    });
}

// ─── Dispatch (full reply path) ─────────────────────

async function slackOrchestrate(target: RemoteTarget, prompt: string, displayMsg: string) {
    const client = getSlackSendClient();
    if (!client.token) return;
    const token = client.token;
    const chatId = target.targetId;
    const result = submitMessage(prompt, {
        origin: 'slack', displayText: displayMsg, skipOrchestrate: true, target, chatId,
    });

    if (result.action === 'queued') {
        log.info(`[slack:queue] agent busy, queued (${result.pending} pending)`);
        await sendSlackText(token, target, t('tg.queued', { count: result.pending }, currentLocale()));
        const requestId = result.requestId;
        let queueTimeout: ReturnType<typeof setTimeout>;
        const queueHandler = async (type: string, data: Record<string, unknown>) => {
            if (type === 'orchestrate_done' && data["text"] && data["origin"] === 'slack'
                && data["requestId"] === requestId) {
                clearTimeout(queueTimeout);
                removeBroadcastListener(queueHandler);
                const text = String(data["text"]);
                await sendSlackText(token, target, text);
                await relaySlackImages(token, target, text);
            }
        };
        addBroadcastListener(queueHandler);
        queueTimeout = setTimeout(() => removeBroadcastListener(queueHandler), 300000);
        return;
    }

    if (result.action === 'rejected') {
        await sendSlackText(token, target, `❌ ${result.reason}`);
        return;
    }

    try {
        const text = String(await orchestrateAndCollect(prompt, {
            origin: 'slack', target, chatId, requestId: result.requestId, _skipInsert: true,
        }));
        await sendSlackText(token, target, text);
        await relaySlackImages(token, target, text);
        log.info(`[slack:out] ${target.targetId}: ${text.slice(0, 80)}`);
    } catch (err: unknown) {
        log.error('[slack:error]', err);
        await sendSlackText(token, target, `❌ Error: ${(err as Error).message}`).catch(() => { });
    }
}

// ─── Envelope routing ───────────────────────────────

export async function handleSlackEnvelope(envelope: SlackEnvelope): Promise<void> {
    if (envelope.type === 'slash_commands') {
        await handleSlackSlashCommand(envelope.payload || {});
        return;
    }
    if (envelope.type === 'interactive') {
        // v1 scope: acked by the socket layer and logged. Block Kit callback
        // routing is a recorded follow-up (050 section 5.8).
        log.info('[slack:interactive] received (not routed in v1)');
        return;
    }
    const payload = envelope.payload as { event?: SlackMessageEvent } | undefined;
    const event = payload?.event;
    if (!event) return;

    const decision = shouldProcessSlackEvent(event, gateConfig(), envelope.type);
    if (!decision.process) {
        log.info(`[slack:in] skipped (${decision.reason})`);
        return;
    }

    const target = buildSlackTarget(event);
    setLastActiveTarget('slack', target);
    setLatestSeenTarget('slack', target);

    const text = resolveEventText(event, selfUserId);
    if (!text) return;
    log.info(`[slack:in] ${event.channel}: ${text.slice(0, 80)}`);

    if (isResetIntent(text)) {
        const client = getSlackSendClient();
        const result = submitMessage(text, { origin: 'slack', target });
        if (client.token) {
            await sendSlackText(client.token, target, result.action === 'rejected'
                ? t('ws.agentBusy', {}, currentLocale())
                : t('tg.resetDone', {}, currentLocale()));
        }
        return;
    }

    slackOrchestrate(target, text, text).catch(e => log.error('[slack:orchestrate]', (e as Error).message));
}

// ─── Init / Shutdown ────────────────────────────────

export async function initSlack(): Promise<void> {
    if (slackInitLock) {
        log.warn('[slack] initSlack already in progress, skipping');
        return;
    }
    slackInitLock = true;
    try {
        await shutdownSlack();
        const sc = settings["slack"];
        if (!sc?.enabled || !sc?.botToken) {
            log.info('[slack] ⏭️  Slack pending (disabled or no bot token)');
            return;
        }
        if (!sc.appToken) {
            // Outbound still works via the send transport; only inbound needs
            // the app-level token. Say so precisely instead of "failed".
            log.warn('[slack] app-level token missing — outbound only, no inbound events');
            return;
        }

        const auth = await slackApi<{ user_id?: string; team_id?: string }>(sc.botToken, 'auth.test');
        if (!auth.ok) {
            log.error('[slack] auth.test failed:', auth.error);
            return;
        }
        selfUserId = auth.data?.user_id || null;
        if (auth.data?.team_id && !sc.teamId) sc.teamId = auth.data.team_id;

        socketClient = new SlackSocketClient({
            appToken: sc.appToken,
            onEnvelope: handleSlackEnvelope,
        });
        await socketClient.start();

        forwarderHandler = createSlackForwarder({
            getToken: () => getSlackSendClient().token,
            getLastTarget: () => getLastActiveTarget('slack'),
            shouldSkip: (data) => data["origin"] === 'slack',
        });
        addBroadcastListener(forwarderHandler);
        log.info(`[slack] ✅ connected as ${selfUserId || 'unknown'}`);
    } finally {
        slackInitLock = false;
    }
}

export async function shutdownSlack(): Promise<void> {
    if (forwarderHandler) {
        removeBroadcastListener(forwarderHandler);
        forwarderHandler = null;
    }
    socketClient?.stop();
    socketClient = null;
    selfUserId = null;
}

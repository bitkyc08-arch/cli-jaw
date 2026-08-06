// ─── Slack Bot ───────────────────────────────────────
// Slack transport implementation for the cli-jaw messaging runtime.
// Mirrors src/discord/bot.ts structurally: init/shutdown lifecycle, an inbound
// handler that gates then dispatches into submitMessage/orchestrateAndCollect,
// and a forwarder for non-Slack-origin agent output.

import { settings } from '../core/config.js';
import { withSessionScope } from '../core/session-context.js';
import { log } from '../core/logger.js';
import { t, normalizeLocale } from '../core/i18n.js';
import { addBroadcastListener, removeBroadcastListener, type BroadcastListener } from '../core/bus.js';
import { submitMessage } from '../orchestrator/gateway.js';
import { orchestrateAndCollect } from '../orchestrator/collect.js';
import { isResetIntent } from '../orchestrator/pipeline.js';
import { setLastActiveTarget, setLatestSeenTarget, getLastActiveTarget } from '../messaging/runtime.js';
import { slackTargetFromId, resolveSlackThreadTs } from '../messaging/slack-target.js';
import type { RemoteTarget } from '../messaging/types.js';
import { buildMediaPromptMany } from '../agent/spawn.js';
import { slackApi } from './api.js';
import { SlackSocketClient, type SlackEnvelope } from './socket.js';
import { resolveEventText, shouldAttachSlack, shouldProcessSlackEvent, type SlackMessageEvent } from './events.js';
import { isThreadParticipated, markThreadParticipated } from './thread-tracker.js';
import { sendSlackText, getSlackSendClient } from './send-only-client.js';
import { startSlackProgress, statusFromToolEvent } from './progress.js';
import { createSlackForwarder, relaySlackImages } from './forwarder.js';
import { handleSlackSlashCommand } from './commands.js';
import { logErrorText, redactOutboundText } from '../messaging/redact.js';
import { downloadAndSaveSlackFiles, type FailedSlackFile } from './inbound-file.js';
import { admitSlackRun, enqueueSlackIngress, resetSlackIngress, slackIngressLaneKey, type SlackRunContext } from './ingress.js';
import { recoverSlackAttachments } from './attachment-recovery.js';

let socketClient: SlackSocketClient | null = null;
let forwarderHandler: BroadcastListener | null = null;
let selfUserId: string | null = null;
let slackInitLock = false;
/**
 * Listeners waiting on a queued agent result. Tracked so shutdown can drop
 * them immediately instead of leaving them armed for their 5-minute timeout,
 * which would let a post-shutdown result fire against a dead transport.
 */
const pendingQueueWaiters = new Set<() => void>();
/**
 * Bumped by every init and shutdown. An `initSlack` suspended on an await
 * checks it afterwards, so a shutdown that races the auth round-trip cannot be
 * undone by the stale initialization resuming and resurrecting the transport.
 */
let lifecycleGeneration = 0;
/**
 * Set when an init arrives while another is already running. The in-flight
 * init drains it on the way out, so a rapid disable/re-enable cannot leave
 * Slack permanently off just because its start request landed mid-teardown.
 */
let initRequestPending = false;

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
        // Thread continuation defaults ON (threadRequireMention=false):
        // once mentioned, a thread keeps flowing without re-mention.
        threadRequireMention: sc.threadRequireMention === true,
        isParticipatedThread: isThreadParticipated,
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

async function slackOrchestrate(
    target: RemoteTarget,
    prompt: string,
    displayMsg: string,
    signal: AbortSignal,
) {
    const client = getSlackSendClient();
    if (!client.token) return;
    const token = client.token;
    const chatId = target.targetId;
    if (signal.aborted) return;
    const result = admitSlackRun({
        target, prompt, displayText: displayMsg, chatId,
        runReply: async (ctx: SlackRunContext) => {
            try {
                const progress = await startSlackProgress(
                    token, target, t('slack.progress.start', {}, currentLocale()),
                ).catch(() => null);
                const progressHandler = (type: string, data: Record<string, unknown>) => {
                    if (!progress || type !== 'agent_tool') return;
                    if (data['origin'] && data['origin'] !== 'slack') return;
                    const line = statusFromToolEvent(data, t('slack.progress.working', {}, currentLocale()));
                    if (line) progress.update(line);
                };
                if (progress) addBroadcastListener(progressHandler);
                const text = String(await withSessionScope(
                    { scope: ctx.scope, chatSessionId: ctx.chatSessionId },
                    () => orchestrateAndCollect(prompt, {
                        origin: 'slack', target, chatId, requestId: ctx.requestId,
                        ...(ctx.remoteKey ? { remoteKey: ctx.remoteKey } : {}),
                        chatSessionId: ctx.chatSessionId, scope: ctx.scope, _skipInsert: true,
                    }).finally(async () => {
                        if (!progress) return;
                        removeBroadcastListener(progressHandler);
                        await progress.finish().catch(() => { });
                    }),
                ));
                const sendResult = await sendSlackText(token, target, text);
                // A successful reply into a thread makes that thread ours —
                // future replies there need no mention (marking point b).
                if (sendResult.ok && target.threadId) {
                    markThreadParticipated(target.targetId, target.threadId);
                }
                await relaySlackImages(token, target, text);
                log.info(`[slack:out] ${target.targetId}: ${redactOutboundText(text).slice(0, 80)}`);
            } catch (err: unknown) {
                log.error('[slack:error]', logErrorText(err));
                await sendSlackText(token, target, `❌ Error: ${(err as Error).message}`).catch(() => { });
            }
        },
    });
    result.laneTail?.catch(error => log.error('[slack:lane]', logErrorText(error)));

    if (result.action === 'queued') {
        log.info(`[slack:queue] agent busy, queued (${result.pending} pending)`);
        const requestId = result.requestId;
        let queueTimeout: ReturnType<typeof setTimeout>;
        let disposed = false;
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            clearTimeout(queueTimeout);
            removeBroadcastListener(queueHandler);
            pendingQueueWaiters.delete(dispose);
        };
        const queueHandler = async (type: string, data: Record<string, unknown>) => {
            if (type === 'orchestrate_done' && data["text"] && data["origin"] === 'slack'
                && data["requestId"] === requestId) {
                // Dispose FIRST so a duplicate broadcast cannot double-post.
                if (disposed) return;
                dispose();
                const text = String(data["text"]);
                const queuedSendResult = await sendSlackText(token, target, text);
                if (queuedSendResult.ok && target.threadId) {
                    markThreadParticipated(target.targetId, target.threadId);
                }
                await relaySlackImages(token, target, text);
            }
        };
        // Register BEFORE any await: a fast queued job can finish while the
        // "queued" notice is still in flight, and the completion broadcast
        // would be missed entirely.
        addBroadcastListener(queueHandler);
        pendingQueueWaiters.add(dispose);
        queueTimeout = setTimeout(dispose, 300000);
        await sendSlackText(token, target, t('tg.queued', { count: result.pending }, currentLocale()));
        return;
    }

    if (result.action === 'rejected') {
        // The gateway dedup contract is "absorb silently" — the rejection
        // exists so the SAME message delivered twice costs nothing. Posting
        // ❌ for it is how one user message becomes a visible error.
        if (result.reason === 'duplicate') {
            log.info('[slack:duplicate] absorbed silently');
            return;
        }
        await sendSlackText(token, target, `❌ ${result.reason}`);
        return;
    }

}

function buildSlackFileFailureWarning(failed: readonly FailedSlackFile[], allFailed = false): string | null {
    if (!failed.length) return null;
    const locale = currentLocale();
    const items = failed.map(file => `- ${file.name}: ${t(`slack.files.error.${file.code}`, {}, locale)}`);
    return `${t(allFailed ? 'slack.files.allFailure' : 'slack.files.partialFailure', {}, locale)}\n${items.join('\n')}`;
}

export async function processSlackMessageEvent(
    event: SlackMessageEvent,
    target: RemoteTarget,
    text: string,
    signal: AbortSignal,
): Promise<void> {
    const files = event.files || [];
    let prompt = text;
    let displayText = text;
    if (files.length) {
        const token = getSlackSendClient().token;
        if (!token) return;
        const { saved, failed } = await downloadAndSaveSlackFiles(token, files, { signal });
        if (signal.aborted) return;
        const visibleFailed = failed.filter(file => file.code !== 'ingress_cancelled');
        for (const file of failed) {
            const idSuffix = file.id.replace(/[^a-zA-Z0-9]/g, '').slice(-6);
            log.info(`[slack:file] id=...${idSuffix} name=${file.name} code=${file.code}`);
        }
        const warning = buildSlackFileFailureWarning(visibleFailed, saved.length === 0);
        if (warning) await sendSlackText(token, target, warning).catch(() => undefined);
        if (!saved.length) return;
        prompt = buildMediaPromptMany(saved.map(file => file.filePath), text);
        displayText = saved.length === 1
            ? `[📎 ${saved[0]!.name}] ${text}`.trim()
            : `[📎 ${saved.length} files] ${text}`.trim();
    }
    if (!prompt || signal.aborted) return;
    await slackOrchestrate(target, prompt, displayText, signal);
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
    if (event.type === 'app_mention' && event.channel) {
        // A mention inside a thread marks that thread; a top-level mention
        // marks the thread this message would parent (marking point a).
        markThreadParticipated(event.channel, event.thread_ts || event.ts || '');
    }

    const target = buildSlackTarget(event);
    setLastActiveTarget('slack', target);
    setLatestSeenTarget('slack', target);

    const text = resolveEventText(event, selfUserId);
    let hasFiles = Boolean(event.files?.length);
    // app_mention 봉투에는 files 가 없고, 첨부를 가진 message 사본은 위
    // shouldProcessSlackEvent 에서 mention_via_app_mention 으로 드롭된다.
    // 그래서 멘션과 함께 올린 파일은 여기서 되찾지 않으면 영영 사라진다.
    if (!hasFiles && event.type === 'app_mention' && event.channel && event.ts) {
        const recoverToken = getSlackSendClient().token;
        if (recoverToken) {
            const recovered = await recoverSlackAttachments(
                recoverToken, event.channel, event.ts,
                event.thread_ts ? { threadTs: event.thread_ts } : {},
            );
            if (recovered.length) {
                event.files = recovered;
                hasFiles = true;
                log.info(`[slack:recover] ${event.channel} ts=${event.ts}: ${recovered.length} attachment(s)`);
            }
        }
    }
    if (!text && !hasFiles) return;
    if (text) log.info(`[slack:in] ${event.channel}: ${redactOutboundText(text).slice(0, 80)}`);

    if (!hasFiles && isResetIntent(text)) {
        const client = getSlackSendClient();
        const result = submitMessage(text, { origin: 'slack', target });
        if (client.token) {
            await sendSlackText(client.token, target, result.action === 'rejected'
                ? t('ws.agentBusy', {}, currentLocale())
                : t('tg.resetDone', {}, currentLocale()));
        }
        return;
    }

    enqueueSlackIngress(slackIngressLaneKey(target), signal =>
        processSlackMessageEvent(event, target, text, signal));
}

// ─── Init / Shutdown ────────────────────────────────

export async function initSlack(): Promise<void> {
    if (slackInitLock) {
        // Do not discard the request: the running init may be about to abort
        // because THIS caller's shutdown superseded it.
        log.info('[slack] initSlack already in progress — queuing a follow-up');
        initRequestPending = true;
        return;
    }
    slackInitLock = true;
    try {
        // Claim the generation FIRST so an external shutdown that lands while
        // we are tearing down or authenticating is not lost, then tear down
        // WITHOUT bumping it — an internal teardown must not invalidate the
        // init it belongs to.
        const generation = ++lifecycleGeneration;
        await disposeSlackRuntime();
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
        // One bot, one instance: a second instance sharing these tokens would
        // silently swallow half the events (Socket Mode round-robin).
        if (!shouldAttachSlack(sc.attachPort, settings["port"])) {
            log.info(`[slack] not the attach instance (attach port ${sc.attachPort}, this :${settings["port"]}) — socket not opened`);
            return;
        }

        const auth = await slackApi<{ user_id?: string; team_id?: string }>(sc.botToken, 'auth.test');
        // A shutdown may have landed while auth.test was in flight; resuming
        // here would resurrect a transport the caller asked us to stop.
        if (generation !== lifecycleGeneration) {
            log.info('[slack] init superseded during auth — aborting');
            return;
        }
        if (!auth.ok) {
            log.error('[slack] auth.test failed:', auth.error);
            return;
        }
        selfUserId = auth.data?.user_id || null;
        if (auth.data?.team_id && !sc.teamId) sc.teamId = auth.data.team_id;

        const client = new SlackSocketClient({
            appToken: sc.appToken,
            onEnvelope: handleSlackEnvelope,
        });
        socketClient = client;
        await client.start();
        if (generation !== lifecycleGeneration) {
            log.info('[slack] init superseded during connect — disposing socket');
            client.stop();
            if (socketClient === client) socketClient = null;
            return;
        }

        forwarderHandler = createSlackForwarder({
            getToken: () => getSlackSendClient().token,
            getLastTarget: () => getLastActiveTarget('slack'),
            shouldSkip: (data) => data["origin"] === 'slack',
        });
        addBroadcastListener(forwarderHandler);
        log.info(`[slack] ✅ connected as ${selfUserId || 'unknown'}`);
    } finally {
        slackInitLock = false;
        if (initRequestPending) {
            initRequestPending = false;
            await initSlack();
        }
    }
}

export async function shutdownSlack(): Promise<void> {
    lifecycleGeneration++;
    await disposeSlackRuntime();
}

/**
 * Release every runtime resource WITHOUT touching the lifecycle generation.
 * `initSlack` reuses this for its own teardown; only an external
 * `shutdownSlack` invalidates in-flight initializations.
 */
async function disposeSlackRuntime(): Promise<void> {
    await resetSlackIngress();
    if (forwarderHandler) {
        removeBroadcastListener(forwarderHandler);
        forwarderHandler = null;
    }
    // Drop any queued-result waiters rather than leaving them armed for their
    // 5-minute timeout against a transport that no longer exists.
    for (const dispose of [...pendingQueueWaiters]) dispose();
    pendingQueueWaiters.clear();
    socketClient?.stop();
    socketClient = null;
    selfUserId = null;
}

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
import { isContinueIntent } from '../orchestrator/parser.js';
import {
    setLastActiveTarget, setLatestSeenTarget, getLastActiveTarget,
    transportStarted, transportNotStarted, type TransportStartOutcome,
} from '../messaging/runtime.js';
import { slackTargetFromId, resolveSlackThreadPlacement } from '../messaging/slack-target.js';
import type { RemoteTarget } from '../messaging/types.js';
import { buildMediaPromptMany } from '../agent/spawn.js';
import {
    addSlackReaction,
    describeSlackError,
    removeSlackReaction,
    slackApi,
    SLACK_CLEANUP_TIMEOUT_MS,
} from './api.js';
import {
    createAckHandle,
    resolveAckConfig,
    shouldAck,
    SLACK_ACK_DEFAULTS,
    type AckHandle,
} from '../messaging/ack-reaction.js';
import {
    createQueueNotice,
    QueueNoticeRegistry,
} from '../messaging/queue-notice.js';
import { OutboundSendRegistry } from '../messaging/outbound-lifecycle.js';
import {
    recordSlackScopeObservation,
    getSlackScopeStatus,
    describeSlackScopeGaps,
    resetSlackScopeStatus,
} from './scope-status.js';
import { SlackSocketClient, type SlackEnvelope, type SlackPreflightResult } from './socket.js';
import { runSlackAutoJoin, mergeSlackAutoJoin } from './auto-join.js';
import { createHash } from 'node:crypto';
import { admitIngress, getIngressJournal } from '../messaging/durable-ingress.js';
import { getQueueNoticeStore } from '../messaging/queue-notice-store.js';
import { restoreQueueNotices } from '../messaging/queue-notice-restore.js';
import { createSlackNoticeTransport } from './notice-transport.js';
import { currentGenerationForEnvelope } from '../messaging/ingress-generation.js';
import { slackInboundEnvelope } from '../messaging/inbound-envelope.js';
import { readSlackAllowlist, resolveEventText, shouldAttachSlack, shouldProcessSlackEvent, type SlackMessageEvent } from './events.js';
import {
    markThreadParticipated, threadParticipationKind,
    claimThreadPrefetch, commitThreadPrefetch,
    releaseThreadPrefetch, resetThreadPrefetchClaims,
} from './thread-tracker.js';
import { sendSlackText, getSlackSendClient } from './send-only-client.js';
import { startSlackProgress, statusFromToolEvent } from './progress.js';
import { createSlackForwarder, relaySlackImages } from './forwarder.js';
import { nextDeliverySeq, pendingDeliveryAnchor, wasSelfDelivered } from '../messaging/turn-delivery.js';
import { shouldSkipForwarding } from '../messaging/forwarder-origin.js';
import { handleSlackSlashCommand } from './commands.js';
import { logErrorText, redactOutboundText } from '../messaging/redact.js';
import { downloadAndSaveSlackFiles, type FailedSlackFile } from './inbound-file.js';
import { admitSlackRun, claimSlackEvent, commitSlackEvent, currentIngressGeneration, enqueueSlackIngress, isIngressGenerationCurrent, resetSlackIngress, resolveSlackScopeForTarget, slackEventKey, slackIngressLaneKey, type SlackRunContext } from './ingress.js';
import { buildSenderDisplay, buildSenderPrompt, resolveSenderIdentity } from './identity.js';
import {
    admitHistoryStart, cachedNameMap, resolveConversationInfo, resolveThreadInfo, THREAD_FETCH_LIMIT,
} from './conversation.js';
import { fetchSlackHistory, formatHistoryForAgent } from './history.js';
import { buildSlackContextBlock, applySlackContext, buildThreadPreamble, ROSTER_PREVIEW } from './context.js';
import { fetchSlackChannelMembers } from './roster.js';
import type { SlackIdentity } from './identity.js';
import { recoverSlackAttachments } from './attachment-recovery.js';
import { getSessionOwnershipGeneration, type SessionOwnerToken } from '../agent/session-persistence.js';
import { resetSlackIdentityCache } from './identity.js';
import { resetSlackConversationCache } from './conversation.js';
import { handleApprovalCommand, handleApprovalCallback, registerProductionTransport, type DispatchApprovalTransport } from '../core/dispatch-approval-ingress.js';
import { parseApprovalCallbackData } from '../messaging/approval-presentation.js';

let socketClient: SlackSocketClient | null = null;
let forwarderHandler: BroadcastListener | null = null;
let selfUserId: string | null = null;
let slackInitLock = false;
/**
 * Request ids a live queued-reply listener is already waiting on. The
 * target-reply forwarder checks this so a result does not get posted twice: once
 * by the requester that is still here, once by the fallback that exists for the
 * requester that is not (#407).
 */
const pendingQueueRequestIds = new Set<string>();
/**
 * Queue-notice teardowns, owned by the shared lifecycle module rather than by
 * hand-rolled closures. Shutdown drains this instead of dropping callbacks, so a
 * turn that never answered gets its notice rewritten rather than left claiming
 * the agent is still working on it.
 */
const slackNoticeRegistry = new QueueNoticeRegistry();

/**
 * In-flight ANSWER sends (#417). The notice registry above cancels cleanup;
 * this one cancels the answer body, chunk-retry sleeps, and image uploads —
 * the calls that used to outlive the process because no signal reached them.
 */
const slackOutboundRegistry = new OutboundSendRegistry();

/**
 * A reaction transition is best-effort, so it gets a tighter bound than an
 * ordinary cleanup call: settle() may run remove THEN apply sequentially, and
 * the running apply can still be in flight ahead of both.
 */
const SLACK_ACK_TIMEOUT_MS = 2500;
/**
 * Long enough for the worst honest chain — running apply, terminal remove,
 * terminal apply, plus one notice call — so a slow-but-working Slack finishes
 * inside the deadline instead of being cut off by it.
 */
const SLACK_NOTICE_DRAIN_MS = SLACK_CLEANUP_TIMEOUT_MS + SLACK_ACK_TIMEOUT_MS * 2;

/** Live ack config, re-read per turn so a settings change needs no restart. */
function slackAckConfig() {
    return resolveAckConfig(settings["slack"]?.ack, SLACK_ACK_DEFAULTS);
}

/**
 * Build the ACK handle for one inbound message.
 *
 * The transport throws on vendor failure because slackApi RESOLVES with
 * {ok:false}; without that check the handle would record a reaction that never
 * landed and then try to remove something that is not there. already_reacted and
 * no_reaction are successes: they mean the desired state is already true.
 */
function buildSlackAck(
    token: string,
    target: RemoteTarget,
    anchorTs: string,
    context: { isDirect: boolean; isMention: boolean },
): AckHandle | null {
    const config = slackAckConfig();
    if (!shouldAck(config, context)) return null;
    return createAckHandle(config, {
        // Slack has no atomic replace, so the previous reaction must come off first.
        mode: 'remove-then-add',
        apply: async (emoji) => {
            const r = await addSlackReaction(token, target.targetId, anchorTs, emoji,
                { timeoutMs: SLACK_ACK_TIMEOUT_MS });
            if (!r.ok && r.error !== 'already_reacted') {
                throw new Error(describeSlackError(r.error, r.data));
            }
        },
        remove: async (emoji) => {
            const r = await removeSlackReaction(token, target.targetId, anchorTs, emoji,
                { timeoutMs: SLACK_ACK_TIMEOUT_MS });
            if (!r.ok && r.error !== 'no_reaction') {
                throw new Error(describeSlackError(r.error, r.data));
            }
        },
        // Any workspace emoji name is valid; the wrapper strips colons.
        coerce: (emoji) => emoji,
    }, (e) => log.info('[slack:ack]', logErrorText(e)));
}

function hasPendingQueueWaiter(requestId: string): boolean {
    return pendingQueueRequestIds.has(requestId);
}

// ─── Durable notice records (#418) ──────────────────
// The handles above are process-local; these three wrap the store that outlives
// the process. Every one of them is best-effort by contract: a durable write is a
// convenience for the NEXT boot, and letting it throw here would fail the turn the
// user is actually waiting on.

function reserveSlackNoticeRecord(requestId: string, target: RemoteTarget): void {
    try {
        getQueueNoticeStore()?.reserve({ requestId, channel: 'slack', target });
    } catch (e) {
        log.info('[slack:queue-notice] reserve failed', logErrorText(e));
    }
}

function attachSlackNoticeRecord(requestId: string, ts: string): void {
    try {
        getQueueNoticeStore()?.attachMessageId(requestId, ts);
    } catch (e) {
        log.info('[slack:queue-notice] attach failed', logErrorText(e));
    }
}

function closeSlackNoticeRecord(requestId: string): void {
    try {
        getQueueNoticeStore()?.close(requestId);
    } catch (e) {
        log.info('[slack:queue-notice] close failed', logErrorText(e));
    }
}

/**
 * Close a queue notice as ANSWERED from a path that never held the live handle.
 *
 * The standing target-reply forwarder posts queued answers when no waiter is
 * listening any more (restart, missed requestId). It used to stop there, which
 * left the "대기열에 추가됨" message sitting in the thread next to the answer —
 * the user-reported leak (#411 family). The durable record (#418) still knows
 * the posted ts, so the answer's own delivery path can finish the promise:
 * delete the notice message and drop the record. Best-effort like every other
 * durable-notice touch; the answer is already out.
 */
async function closeSlackNoticeAsAnsweredByRequestId(requestId: string): Promise<void> {
    try {
        const record = getQueueNoticeStore()?.findByRequestId(requestId);
        if (!record) return;
        const token = getSlackSendClient().token;
        if (record.messageId && token) {
            await createSlackNoticeTransport(token, record.target.targetId, record.messageId)
                .delete();
        }
        closeSlackNoticeRecord(requestId);
    } catch (e) {
        log.info('[slack:queue-notice] answered-close failed', logErrorText(e));
    }
}

/**
 * Rewrite notices left behind by a previous run.
 *
 * Called once the token is known, because the transport needs it — a record whose
 * transport cannot be built yet is kept rather than closed (#418).
 */
export async function restoreSlackQueueNotices(): Promise<void> {
    const store = getQueueNoticeStore();
    if (!store) return;
    const token = getSlackSendClient().token;
    await restoreQueueNotices({
        store,
        channel: 'slack',
        expiredText: t('tg.queueExpired', {}, currentLocale()),
        transport: (record) => (token
            ? createSlackNoticeTransport(token, record.target.targetId, record.messageId)
            : null),
        onError: (e) => log.info('[slack:queue-notice] restore failed', logErrorText(e)),
    });
}

/** Stand in for a live queued-reply listener without opening a socket. */
export function claimSlackQueueRequestForTest(requestId: string): void {
    pendingQueueRequestIds.add(requestId);
}
export function releaseSlackQueueRequestForTest(requestId: string): void {
    pendingQueueRequestIds.delete(requestId);
}
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
let slackApprovalIngress: DispatchApprovalTransport | null = null;
function createSlackSocketIngress(): DispatchApprovalTransport {
    const transport = Object.freeze({ platform: 'slack' as const });
    registerProductionTransport(transport);
    return transport;
}
export function getSlackSelfUserId(): string | null { return selfUserId; }
export function setSlackSelfUserIdForTest(value: string | null): void { selfUserId = value; }
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
        channelIds: readSlackAllowlist(sc.channelIds),
        // Thread continuation defaults ON (threadRequireMention=false):
        // once mentioned, a thread keeps flowing without re-mention.
        threadRequireMention: sc.threadRequireMention === true,
        threadParticipation: threadParticipationKind,
    };
}

function buildSlackTarget(event: SlackMessageEvent): RemoteTarget {
    const replyInThread = settings["slack"]?.replyInThread !== false;
    // Reply address and session identity are separate questions: a top-level
    // message's own ts is where a reply would open a thread, but it does not
    // name a conversation (#520). Both callers of this function reach the
    // journal and dispatch paths through the returned target.
    const placement = resolveSlackThreadPlacement(event, replyInThread);
    const teamId = settings["slack"]?.teamId;
    return slackTargetFromId(event.channel as string, {
        ...(placement.threadTs ? { threadTs: placement.threadTs } : {}),
        ...(placement.synthetic ? { threadIsSynthetic: true } : {}),
        ...(teamId ? { teamId: String(teamId) } : {}),
    });
}

/**
 * Answer a queued turn nobody is waiting on any more.
 *
 * The ordinary queued reply rides a temporary listener armed by the request
 * that was queued (see the `queued` branch below). A restart destroys it — and
 * the boot drain (#407) runs exactly those messages. Without this the drain
 * consumes the item, deletes its row, and the answer goes nowhere: the user
 * loses the message instead of merely waiting for it.
 *
 * Installed once at module scope, like the Telegram equivalent
 * (`installTelegramTargetReplyForwarder`), and keyed on the target the item
 * carried through the queue rather than on whoever spoke most recently.
 */
let targetReplyForwarderInstalled = false;

function installSlackTargetReplyForwarder(): void {
    if (targetReplyForwarderInstalled) return;
    targetReplyForwarderInstalled = true;
    addBroadcastListener((type, data) => {
        if (type !== 'orchestrate_done' || data["origin"] !== 'slack' || !data["text"]) return;
        // Queued turns only. An ordinary turn is posted by the dispatch path
        // that is still standing there awaiting it; answering that here too
        // would post every reply twice.
        //
        // Errors included: after a restart there is no waiter to show them, so
        // dropping them here means the user's message vanishes without even a
        // failure notice.
        if (data["fromQueue"] !== true) return;
        const target = data["target"] as RemoteTarget | undefined;
        if (!target || target.channel !== 'slack' || !target.targetId) return;
        // A live requester is already listening for this exact result; posting
        // here too would double-post it.
        if (data["requestId"] && hasPendingQueueWaiter(String(data["requestId"]))) return;
        const token = getSlackSendClient().token;
        if (!token) return;
        const text = String(data["text"]);
        void (async () => {
            const outbound = slackOutboundRegistry.start();
            try {
                const result = await sendSlackText(token, target, text, { signal: outbound.signal });
                if (!result.ok) {
                    log.error('[slack:target-reply]', logErrorText(result.error || 'send failed'));
                    return;
                }
                if (target.threadId) markThreadParticipated(target.targetId, target.threadId);
                // The answer is delivered, so the queue notice for this request
                // is now noise. The live waiter usually owns this; when the
                // forwarder delivers instead, it must also keep the promise.
                if (data["requestId"]) {
                    await closeSlackNoticeAsAnsweredByRequestId(String(data["requestId"]));
                }
                await relaySlackImages(token, target, text, { signal: outbound.signal });
            } catch (e) {
                log.error('[slack:target-reply]', logErrorText(e));
            } finally {
                outbound.done();
            }
        })();
    });
}

installSlackTargetReplyForwarder();

// ─── Dispatch (full reply path) ─────────────────────

async function slackOrchestrate(
    target: RemoteTarget,
    prompt: string,
    displayMsg: string,
    signal: AbortSignal,
    dedupe: {
        eventKey?: string;
        reservationGeneration?: number;
        preResolvedScope?: string | null;
        /** The inbound message's ts — the ACK reaction's anchor. Passed explicitly
         *  because this function cannot recover it, and the caller has it. */
        ackTs?: string;
        /** Ack scope inputs, resolved by the caller that knows the event shape. */
        isDirect?: boolean;
        isMention?: boolean;
    } = {},
) {
    const client = getSlackSendClient();
    if (!client.token) return;
    const token = client.token;
    const chatId = target.targetId;
    if (signal.aborted) return;
    // #321: the reservation was taken before an `await` and several early
    // returns. If a reset landed in that window this delivery belongs to a dead
    // generation — a redelivery has already re-reserved it, and admitting here
    // would run the same message twice.
    if (dedupe.reservationGeneration !== undefined
        && !isIngressGenerationCurrent(dedupe.reservationGeneration)) {
        log.info('[slack:in] skipped (stale_generation)');
        return;
    }
    // Built before admission: a queued turn never enters runReply (ingress.ts
    // returns early unless disposition is 'new_run'), so a handle created inside
    // it would never exist for exactly the case this feature is for.
    const ack = dedupe.ackTs
        ? buildSlackAck(token, target, dedupe.ackTs, {
            isDirect: dedupe.isDirect ?? false,
            isMention: dedupe.isMention ?? false,
        })
        : null;
    const result = admitSlackRun({
        target, prompt, displayText: displayMsg, chatId,
        ...(dedupe.preResolvedScope !== undefined
            ? { preResolvedScope: dedupe.preResolvedScope } : {}),
        runReply: async (ctx: SlackRunContext) => {
            let ackOutcome: 'success' | 'failure' = 'failure';
            let ackSettled = false;
            try {
                const progress = await startSlackProgress(
                    token, target, t('slack.progress.start', {}, currentLocale()),
                ).catch(() => null);
                const progressHandler = (type: string, data: Record<string, unknown>) => {
                    if (!progress || type !== 'agent_tool') return;
                    // Only this run's events. The old test was `origin !== 'slack'`,
                    // which every concurrent Slack run passes, so two channels each
                    // received the other's tool log — and a tool log carries command
                    // lines and paths, so that crossed a channel boundary people set
                    // up precisely to separate access (#398).
                    //
                    // An event with no requestId cannot prove which run it belongs to.
                    // Letting it through would restore the old behaviour, so it is
                    // dropped; emitAgentTool and the jwc mapper both stamp the field.
                    if (data['requestId'] !== ctx.requestId) return;
                    // Thinking/commentary entries are live-UI-only narration.
                    // Telegram already drops its 💭 lines; Slack's progress
                    // placeholder gets real tool activity only, so agent
                    // reasoning text never lands in the channel even briefly.
                    // 💬 is the untagged-codex assistant-message badge (spark
                    // visibility) — also narration from the channel's view.
                    if (data['toolType'] === 'thinking' || data['icon'] === '💬') return;
                    const line = statusFromToolEvent(data, t('slack.progress.working', {}, currentLocale()));
                    if (line) progress.update(line);
                };
                if (progress) addBroadcastListener(progressHandler);
                // Anchors the delivery claim below. Taken BEFORE the agent runs,
                // so only a send made during THIS turn can suppress this turn's
                // post — an identical answer from an earlier turn must not.
                const turnStartedAt = nextDeliverySeq();
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
                // Scoped for shutdown cancellation (#417): the body send and the
                // image relay below share one abortable scope, released when the
                // turn settles either way.
                const outbound = slackOutboundRegistry.start();
                let sendResult: { ok: boolean; error?: string; status?: number; ts?: string };
                try {
                    // The agent may already have posted this exact answer itself
                    // through /api/channel/send while the turn was still running,
                    // in which case posting it again is the duplicate the user
                    // sees. Skipping the POST is all this does: the outcome below
                    // is still success, because the user has the answer — so the
                    // ACK still settles (#417) and the notice still closes as
                    // answered (#418), exactly as if we had sent it.
                    const alreadyDelivered = wasSelfDelivered({ target, text, since: turnStartedAt });
                    sendResult = alreadyDelivered
                        ? { ok: true }
                        : await sendSlackText(token, target, text, { signal: outbound.signal });
                    // Recorded here, settled once in the finally below. The image
                    // relay can still throw after the text is out, and the user did
                    // get their answer in that case — so the outcome is success and
                    // settling twice would be a lie about which one happened.
                    ackOutcome = sendResult.ok ? 'success' : 'failure';
                    // A successful reply records presence, not ownership (marking
                    // point b). Replying into a thread we were invited to does not
                    // make the rest of that conversation ours; the default `joined`
                    // says so, and an already-`owned` thread keeps its kind (#400).
                    if (sendResult.ok && target.threadId) {
                        markThreadParticipated(target.targetId, target.threadId);
                    }
                    // Settled BEFORE the relay: the upload is now abortable but
                    // still slow, and the reaction must not sit on `running`
                    // while the answer is already visible (#417).
                    await ack?.settle(ackOutcome);
                    ackSettled = true;
                    // Relayed even when the text above was suppressed. Whether
                    // the agent already uploaded these bytes cannot be proven
                    // from a path (see turn-delivery.ts), and a skip that cannot
                    // be proven is a silent drop.
                    await relaySlackImages(token, target, text, { signal: outbound.signal });
                    // Logged either way, and labelled, because the previous
                    // silence here is what made the duplicate hard to see: only
                    // the dispatch post wrote [slack:out], so the log showed one
                    // delivery while the user had received two.
                    log.info(`[slack:out${alreadyDelivered ? ':skipped-self-delivered' : ''}] ${target.targetId}: ${redactOutboundText(text).slice(0, 80)}`);
                } finally {
                    outbound.done();
                }
            } catch (err: unknown) {
                log.error('[slack:error]', logErrorText(err));
                await sendSlackText(token, target, `❌ Error: ${(err as Error).message}`).catch(() => { });
            } finally {
                // Exactly one settle per turn, whichever way the body exited.
                // The happy path already settled before the image relay.
                if (!ackSettled) await ack?.settle(ackOutcome);
            }
        },
    });
    // Durable commit AFTER admission, with no await in between: an event that
    // died before this line stays redeliverable, which is the whole point of
    // ordering it here rather than at reservation time.
    if (dedupe.eventKey && result.action !== 'rejected') commitSlackEvent(dedupe.eventKey);
    result.laneTail?.catch(error => log.error('[slack:lane]', logErrorText(error)));

    if (result.action === 'queued') {
        log.info(`[slack:queue] agent busy, queued (${result.pending} pending)`);
        const requestId = result.requestId;
        // Anchored when this queued run STARTS, not when it was queued: the turn
        // ahead of it is still running and can record a claim after this point,
        // which would otherwise sort as "after this turn began" and swallow the
        // queued answer. Until it latches it reads as Infinity, so nothing is
        // suppressed. A restart loses claims entirely, which keeps the #407
        // orphan delivery intact.
        const queuedAnchor = pendingDeliveryAnchor();
        const queuedRunStarted = (type: string, data: Record<string, unknown>) => {
            // Keyed on THIS request. A scope-blind "an agent started" signal can
            // fire for the turn ahead of this one, latching the anchor while that
            // turn is still running — and a claim it records afterwards would then
            // sort as newer than the anchor and swallow this answer.
            if (type === 'queued_run_started' && data['requestId'] === requestId) queuedAnchor.latch();
        };
        addBroadcastListener(queuedRunStarted);
        let queueTimeout: ReturnType<typeof setTimeout>;
        let disposed = false;
        const notice = createQueueNotice({
            expiredText: t('tg.queueExpired', {}, currentLocale()),
            onError: (e) => log.info('[slack:queue-notice]', logErrorText(e)),
        });
        const disposeListener = () => {
            if (disposed) return;
            disposed = true;
            clearTimeout(queueTimeout);
            removeBroadcastListener(queueHandler);
            removeBroadcastListener(queuedRunStarted);
            if (requestId) pendingQueueRequestIds.delete(requestId);
        };
        // One terminal outcome per turn, shared by whoever gets there first.
        //
        // A boolean flag would pick a winner and let the loser return
        // immediately — and the loser here is the shutdown drain, which would
        // then tear the transport down while the winner is still sending. The
        // broadcast bus never awaits listener promises (core/bus.ts), so nothing
        // else would hold it. Handing back the winner's promise makes both paths
        // converge on the same completion.
        let terminal: Promise<void> | null = null;
        // Assigned immediately below, but referenced by finishExpired, which is
        // defined first. Declared here so the terminal claim can unregister.
        let unregister: () => void = () => {};
        const claimTerminal = (run: () => Promise<void>): Promise<void> => {
            if (!terminal) {
                terminal = run().catch(e => log.info('[slack:queue]', logErrorText(e)));
            }
            return terminal;
        };
        const finishExpired = (signal?: AbortSignal) => claimTerminal(async () => {
            disposeListener();
            try {
                // Started together, not in sequence: awaiting the notice first can
                // eat the whole drain deadline before the reaction is even attempted.
                await Promise.allSettled([
                    notice.close('expired', signal),
                    ack?.settle('failure') ?? Promise.resolve(),
                ]);
                // The in-process handle just closed this notice, so the durable
                // record has nothing left to restore. Dropping it here is what
                // keeps the next boot from rewriting a message this turn already
                // dealt with.
                if (requestId) closeSlackNoticeRecord(requestId);
            } finally {
                // Centralized here, as in the Discord path: every terminal route
                // passes through a claim, so unregistering in one place is what
                // makes "exactly once" true. The plain timeout used to leave its
                // registry entry behind, so a later shutdown re-ran a turn that
                // had already finished.
                unregister();
            }
        });
        unregister = slackNoticeRegistry.add((signal) => finishExpired(signal));
        const queueHandler = async (type: string, data: Record<string, unknown>) => {
            // No !data.text gate: an empty completion must still claim the
            // terminal, or the notice sits until the 5-minute timeout rewrites
            // it to "expired" — the reported "안 없어지는" symptom for empty or
            // error turns. Empty text closes the notice as expired immediately.
            if (type !== 'orchestrate_done' || data["origin"] !== 'slack'
                || data["requestId"] !== requestId) return;
            if (disposed) return;
            // Dispose FIRST so a duplicate broadcast cannot double-post, but the
            // notice deliberately outlives it: deleting before the answer is out
            // would leave a failed send with neither answer nor notice.
            disposeListener();
            await claimTerminal(async () => {
                try {
                    const text = String(data["text"] ?? '');
                    const outbound = slackOutboundRegistry.start();
                    let queuedSendResult: { ok: boolean };
                    try {
                        // Same rule as the normal dispatch: if the queued agent
                        // already posted this answer itself, posting it again is
                        // the duplicate. The notice still closes as answered
                        // because the user does have the answer.
                        const alreadyDelivered = text
                            && wasSelfDelivered({ target, text, since: queuedAnchor.value() });
                        queuedSendResult = text
                            ? (alreadyDelivered
                                ? { ok: true }
                                : await sendSlackText(token, target, text, { signal: outbound.signal }))
                            : { ok: false as const };
                    } finally {
                        // Released after the body; the relay below opens its own
                        // scope so a slow upload does not hold this one.
                        outbound.done();
                    }
                    await notice.close(queuedSendResult.ok ? 'answered' : 'expired');
                    if (queuedSendResult.ok && target.threadId) {
                        markThreadParticipated(target.targetId, target.threadId);
                    }
                    // Settled before the relay for the same reason as the normal
                    // path: the text is what the user was waiting for, and an
                    // uncancellable upload must not hold the reaction on running.
                    await ack?.settle(queuedSendResult.ok ? 'success' : 'failure');
                    if (text) {
                        const relayScope = slackOutboundRegistry.start();
                        await relaySlackImages(token, target, text, {
                            signal: relayScope.signal
                        })
                            .catch(e => log.error('[slack:queue-send]', logErrorText(e)))
                            .finally(() => relayScope.done());
                    }
                    // The notice is closed, so the durable record has nothing
                    // left to restore on the next boot (#418).
                    if (requestId) closeSlackNoticeRecord(requestId);
                } finally {
                    // Same "exactly once" reasoning as finishExpired: whichever
                    // path claims the terminal owns the registry cleanup.
                    unregister();
                }
            });
        };
        // Everything below is armed SYNCHRONOUSLY, before any await. A reaction
        // call that takes a moment must not be able to outlive the completion it
        // is acknowledging: without the listener and the request-id claim in
        // place, a fast queued job would either be missed here or answered by the
        // standing fallback forwarder instead (#407).
        addBroadcastListener(queueHandler);
        if (requestId) pendingQueueRequestIds.add(requestId);
        queueTimeout = setTimeout(() => { void finishExpired(); }, 300000);
        // Only now, with the lifecycle armed. Not awaited: the notice below is
        // what the user needs to see, and the reaction is decoration on top.
        void ack?.to('running', { wasQueued: true });
        // Reserved BEFORE the post, so the crash window falls the harmless way: a
        // record without an id restores to nothing, while a posted message without
        // a record is unreachable forever (#418).
        if (requestId) reserveSlackNoticeRecord(requestId, target);
        const posted = await sendSlackText(
            token, target, t('tg.queued', { count: result.pending }, currentLocale()),
        );
        if (posted.ok && posted.ts) {
            const ts = posted.ts;
            // The exported factory, not an inline object: the restart path builds
            // the same transport, and a second copy is how the two drift.
            notice.bind(createSlackNoticeTransport(token, target.targetId, ts));
            if (requestId) attachSlackNoticeRecord(requestId, ts);
        } else {
            // No ts will ever arrive, so a deferred close would wait for a bind
            // that cannot happen and the drain would burn its whole deadline.
            notice.abandon();
            // Nothing was posted, so the reservation describes a message that does
            // not exist. Leaving it would make every later boot look for it.
            if (requestId) closeSlackNoticeRecord(requestId);
        }
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
    opts: {
        prefetchToken?: number;
        prefetchOwner?: SessionOwnerToken;
        preResolvedScope?: string | null;
        eventKey?: string;
        reservationGeneration?: number;
    } = {},
): Promise<void> {
    // The claim was taken synchronously in handleSlackEnvelope, before this task
    // was queued. Every path out of here that did NOT inject history has to give
    // it back, or one skipped attempt silences the thread for the whole runtime.
    // The paths are many (empty prompt, all attachments failed, abort, continue
    // intent, config off, lookup failure, deadline), so the release is a finally
    // rather than a return-by-return audit.
    let prefetchCommitted = false;
    try {
        await runSlackMessageEvent(event, target, text, signal, opts, () => {
            prefetchCommitted = Boolean(opts.prefetchToken && opts.prefetchOwner) && commitThreadPrefetch(
                event.channel || '', event.thread_ts || '', opts.prefetchOwner!, opts.prefetchToken || 0,
            );
        });
    } finally {
        if (opts.prefetchToken && opts.prefetchOwner && !prefetchCommitted) {
            releaseThreadPrefetch(
                event.channel || '', event.thread_ts || '', opts.prefetchOwner, opts.prefetchToken,
            );
        }
    }
}

async function runSlackMessageEvent(
    event: SlackMessageEvent,
    target: RemoteTarget,
    text: string,
    signal: AbortSignal,
    opts: {
        prefetchToken?: number;
        prefetchOwner?: SessionOwnerToken;
        preResolvedScope?: string | null;
        eventKey?: string;
        reservationGeneration?: number;
    },
    commitPrefetch: () => void,
): Promise<void> {
    const files = event.files || [];
    let prompt = text;
    let displayText = text;
    // Start identity resolution alongside the downloads. Running them in series
    // would add a round trip to every attachment message.
    const identityPromise = resolveSenderIdentity(event, { signal });
    // Several paths below return before awaiting it (all files failed, ingress
    // reset). Absorb now so an early exit cannot leave a floating rejection.
    void identityPromise.catch(() => undefined);
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
    const identity = await identityPromise;
    // The gateway reads continue intent from the prompt body itself
    // (gateway.ts:234). A sender line in front of "계속" stops it being a
    // continuation, so control text travels undecorated. Reset is already
    // intercepted upstream and never reaches here.
    if (!isContinueIntent(prompt)) {
        const block = await buildInboundContextBlock(event, identity, signal, opts, commitPrefetch);
        // An empty block lands EXACTLY on the previous behavior: config off and
        // total lookup failure must be indistinguishable from before this
        // feature existed.
        prompt = block
            ? applySlackContext(block, prompt)
            : buildSenderPrompt(identity, prompt);
        // Display text is unchanged either way: the UI/DB bubble shows who sent
        // the message, and the conversation is already obvious in Slack's own UI.
        displayText = buildSenderDisplay(identity, displayText);
    }
    await slackOrchestrate(target, prompt, displayText, signal, {
        ...(opts.eventKey ? { eventKey: opts.eventKey } : {}),
        ...(opts.reservationGeneration !== undefined
            ? { reservationGeneration: opts.reservationGeneration } : {}),
        ...(opts.preResolvedScope !== undefined ? { preResolvedScope: opts.preResolvedScope } : {}),
        // The ACK anchor is the user's own message. Only this caller has the raw
        // event, so the scope inputs are resolved here rather than re-derived.
        ...(event.ts ? { ackTs: event.ts } : {}),
        isDirect: event.channel_type === 'im',
        isMention: event.type === 'app_mention',
    });
}

/**
 * Inbound deadline for the whole context phase.
 *
 * Larger than identity's 400ms because this is up to two round trips, but still
 * a hard bound: naming a conversation must never hold a user's message. Work
 * that outlives the deadline keeps running and warms the cache, so the next
 * message in the same conversation gets the full block.
 */
// Two round trips against Slack, so 700ms lost the race often enough that the
// first message in a thread — the only one carrying history — regularly arrived
// with no context at all. The socket acks BEFORE dispatch (socket.ts), so a
// longer deadline cannot cause redelivery; it only delays this one reply (#518).
const INBOUND_CONTEXT_DEADLINE_MS = 2500;

async function buildInboundContextBlock(
    event: SlackMessageEvent, identity: SlackIdentity, signal: AbortSignal,
    opts: { prefetchToken?: number; preResolvedScope?: string | null } = {},
    commitPrefetch: () => void = () => { },
): Promise<string> {
    const channel = event.channel || '';
    // The caller's finally releases an uncommitted claim, so early returns here
    // need no cleanup of their own.
    if (settings["slack"]?.conversationContext === false) return '';
    if (!channel) return '';
    const token = getSlackSendClient().token;
    if (!token) return '';
    const teamId = String(settings["slack"]?.teamId || 'unknown');
    const threadTs = event.thread_ts || '';

    const work = (async (): Promise<string> => {
        // First entry into a conversation already in progress: give the agent
        // what was said before it was pulled in. Once only per owner generation
        // (thread-tracker claim) — later messages ride the agent session, and
        // re-injecting would waste tokens and Tier 3 budget.
        const shouldPrefetch = Boolean(opts.prefetchToken) || opts.preResolvedScope === null;
        // A top-level channel message has no thread to read; the channel's own
        // recent history (ending before this event) is its context (#518 r2).
        const isTopLevelChannel = !threadTs
            && (event.channel_type === 'channel' || event.channel_type === 'group');
        // Independent lookups: serial would double the round trips inside a
        // deadline that exists to stay small.
        const [conversation, thread, channelHistory] = await Promise.all([
            resolveConversationInfo(token, channel, { teamId, signal }),
            threadTs
                ? resolveThreadInfo(token, channel, threadTs, { teamId, signal })
                : Promise.resolve(undefined),
            // Paced like the other Tier-3 lookups: declined rather than queued,
            // and a declined window just means this message goes without.
            shouldPrefetch && isTopLevelChannel && event.ts && admitHistoryStart()
                ? fetchSlackHistory(token, channel, {
                    latest: event.ts, limit: THREAD_FETCH_LIMIT,
                    noRetryOnRateLimit: true, signal,
                })
                : Promise.resolve(undefined),
        ]);
        const roster = await resolveRosterContext(token, channel, teamId, conversation.kind, signal);
        const block = buildSlackContextBlock({
            identity, conversation, ...(thread ? { thread } : {}),
            ...(roster ? { roster } : {}), selfUserId,
        });
        const messages = thread?.resolved && thread.messages?.length
            ? thread.messages
            : channelHistory?.ok ? channelHistory.messages : [];
        if (!shouldPrefetch || !messages.length) return block;
        // The current message is already the prompt body; repeating it here
        // would show the agent its own input twice.
        const prior = messages.filter(message => message.ts !== event.ts);
        if (!prior.length) return block;
        const authorIds = prior.map(message => message.user || message.botId || '').filter(Boolean);
        const preamble = buildThreadPreamble(
            formatHistoryForAgent(prior, selfUserId, cachedNameMap(teamId, authorIds)),
            thread?.replyCount ?? prior.length,
        );
        if (!preamble) return block;
        // History is actually going into the prompt: the claim is spent.
        commitPrefetch();
        return block ? `${block}\n${preamble}` : preamble;
    })();

    return raceContextDeadline(work, INBOUND_CONTEXT_DEADLINE_MS);
}

/** Opt-in channel roster. Off by default: see 021 contract §설정. */
async function resolveRosterContext(
    token: string, channel: string, teamId: string,
    kind: string, signal: AbortSignal,
): Promise<{ names: string[]; total: number; approximate?: boolean } | undefined> {
    if (settings["slack"]?.channelRoster !== true) return undefined;
    // In a DM the other party is the sender; a roster line would just repeat it.
    if (kind === 'dm') return undefined;
    const result = await fetchSlackChannelMembers(token, channel, { teamId, signal, limit: 200 });
    if (!result.ok) return undefined;
    const humans = result.members.filter(member => !member.isBot);
    return {
        names: humans.slice(0, ROSTER_PREVIEW).map(member => member.name),
        total: humans.length,
        // The walk is page-bounded, so a truncated result is a lower bound.
        ...(result.hasMore ? { approximate: true } : {}),
    };
}

function raceContextDeadline(work: Promise<string>, ms: number): Promise<string> {
    return new Promise<string>(resolve => {
        const timer = setTimeout(() => resolve(''), ms);
        // unref: a pending deadline must never hold the process open.
        timer.unref?.();
        void work.then(
            value => { clearTimeout(timer); resolve(value); },
            () => { clearTimeout(timer); resolve(''); },
        );
    });
}


// ─── Durable ingress preflight (M3c) ────────────────

/**
 * Journals a Slack event BEFORE the socket acknowledges it. Runs the same gate the
 * dispatch path runs, because Slack sends a `message` copy and an `app_mention` copy
 * of one mention under a shared ts: journaling the copy the gate drops would claim
 * the key and suppress the canonical delivery.
 *
 * Throws when the journal write fails. That is deliberate — the socket layer turns a
 * throw into a withheld ack, so Slack redelivers instead of considering a message it
 * never recorded as delivered.
 */
export async function preflightSlackEnvelope(envelope: SlackEnvelope): Promise<SlackPreflightResult> {
    const journal = getIngressJournal();
    if (!journal) return 'committed';
    if (envelope.type !== 'events_api') return 'committed';

    const payload = envelope.payload as { event?: SlackMessageEvent } | undefined;
    const event = payload?.event;
    if (!event?.channel || !event?.ts) return 'committed';

    const decision = shouldProcessSlackEvent(event, gateConfig(), envelope.type);
    if (!decision.process) {
        // The dispatch consumer of this gate logs its reason (see the
        // handleSlackEvent path below); this one did not. That asymmetry is why
        // an allowlist mistake reads as "the bot is dead": preflight drops the
        // event, nothing ever reaches dispatch, and nothing is logged (#406).
        //
        // Only channel_not_allowed. self_message, bot_message and the
        // app_mention/message duplicate are ordinary traffic that would bury the
        // one reason that means a human configured us out of a conversation.
        if (decision.reason === 'channel_not_allowed') {
            log.info(`[slack:gate] dropped ${event.channel} (channel_not_allowed)`);
        }
        return 'ignored';
    }

    const inbound = slackInboundEnvelope({
        teamId: String(settings['slack']?.teamId || ''),
        channelId: event.channel,
        ts: event.ts,
        threadTs: event.thread_ts,
        userId: event.user,
        botId: event.bot_id,
        envelopeId: envelope.envelope_id,
        replyInThread: settings['slack']?.replyInThread !== false,
        target: buildSlackTarget(event),
    });
    if (!inbound) return 'committed';

    const admission = admitIngress(journal, inbound, slackPayloadDigest(event), undefined, inbound ? currentGenerationForEnvelope(inbound) : 0);
    if (!admission.admit) return 'duplicate';
    return 'committed';
}

/** Identity of the event body. Never the body itself: the journal is not an archive. */
function slackPayloadDigest(event: SlackMessageEvent): string {
    return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

// ─── Envelope routing ───────────────────────────────


function slackInteractiveUserId(payload: Record<string, unknown>): string {
    const user = payload['user'];
    if (typeof user === 'string') return user;
    if (user && typeof user === 'object' && 'id' in user) return String((user as { id: unknown }).id);
    return '';
}
export async function handleSlackEnvelope(envelope: SlackEnvelope, approvalTransport = slackApprovalIngress): Promise<void> {
    if (envelope.type === 'slash_commands') {
        await handleSlackSlashCommand(envelope.payload || {});
        return;
    }
    if (envelope.type === 'interactive') {
        const payload = envelope.payload || {};
        const actions = payload['actions'];
        const actionId = Array.isArray(actions) && actions[0] && typeof actions[0] === 'object'
            ? String((actions[0] as { action_id?: unknown })['action_id'] || '')
            : '';
        const parsed = parseApprovalCallbackData(actionId);
        if (!parsed) {
            log.info('[slack:interactive] received (not an approval action)');
            return;
        }
        const result = handleApprovalCallback(
            approvalTransport,
            payload,
            parsed.opaqueId,
            parsed.action,
            {
                conversationKey: slackInteractiveUserId(payload),
                sessionGeneration: 0,
            },
        );
        const reply = result.approved ? 'approved' : (result.reason || 'rejected');
        const channel = typeof payload['channel'] === 'object' && payload['channel']
            ? String((payload['channel'] as { id?: unknown })['id'] || '')
            : '';
        const token = getSlackSendClient().token;
        if (token && channel) {
            await sendSlackText(token, slackTargetFromId(channel), redactOutboundText(reply)).catch(() => undefined);
        }
        return;
    }
    const payload = envelope.payload as { event?: SlackMessageEvent } | undefined;
    const event = payload?.event;
    if (!event) return;

    const approval = handleApprovalCommand(approvalTransport, {
        ...event,
        __jawSelf: Boolean(event.user && event.user === getSlackSelfUserId()),
    }, String(event.text || ''));
    if (approval.handled) return;

    const target = buildSlackTarget(event);
    const decision = shouldProcessSlackEvent(event, gateConfig(), envelope.type);
    if (!decision.process) {
        log.info(`[slack:in] skipped (${decision.reason})`);
        return;
    }
    // Carried to the admission site so the durable commit happens only after a
    // run is accepted, and so a reset in between invalidates this delivery.
    let reservedEventKey: string | undefined;
    let reservationGeneration: number | undefined;
    // Message-level dedupe goes HERE — after the gate, before identity resolution.
    // After the gate, because Slack delivers a `message` copy and an `app_mention`
    // copy of one mention under the same ts; the gate drops the former, and letting
    // a dropped copy claim the key would suppress the canonical one and swallow the
    // mention. Before resolution, because the downstream dedupKey hashes the prompt
    // body, so a sender name that resolves on one delivery and degrades on the next
    // would split the key and run the same message twice.
    if (event.channel && event.ts) {
        const eventKey = slackEventKey(
            String(settings["slack"]?.teamId || ''), event.channel, event.ts,
        );
        if (claimSlackEvent(eventKey)) {
            log.info('[slack:in] skipped (duplicate_event)');
            return;
        }
        reservedEventKey = eventKey;
        reservationGeneration = currentIngressGeneration();
    }
    const preResolvedScope = resolveSlackScopeForTarget(target);
    const prefetchOwner = preResolvedScope
        ? getSessionOwnershipGeneration(preResolvedScope)
        : undefined;
    if (event.type === 'app_mention' && event.channel) {
        // A top-level mention starts a thread the bot will parent, so the whole
        // thread belongs to it. A mention INSIDE an existing thread is an
        // invitation into someone else's conversation, and only that (#400).
        markThreadParticipated(
            event.channel,
            event.thread_ts || event.ts || '',
            event.thread_ts ? 'joined' : 'owned',
        );
        if (!event.thread_ts && event.ts) {
            // A thread WE start needs no history: the parent mention and our
            // reply are already the session's own context. Spend the claim now
            // so the first follow-up does not re-inject what the agent said.
            if (prefetchOwner) {
                const token = claimThreadPrefetch(event.channel, event.ts, prefetchOwner);
                commitThreadPrefetch(event.channel, event.ts, prefetchOwner, token);
            }
        }
    }
    // Claim the one-time thread prefetch HERE, synchronously, before the ingress
    // task is queued. Asking inside the queue task instead would be a dead
    // branch for app_mention (the mark above already ran) and a race for
    // DM/listen-all channels (they are marked only after a successful reply,
    // which is not awaited). On the accepted message-event path no `await` runs
    // between this function's entry and this line, so the test-and-set is atomic
    // against a second envelope in the same tick.
    const prefetchSubject = event.thread_ts
        ?? ((event.channel_type === 'channel' || event.channel_type === 'group') ? '' : undefined);
    const prefetchToken = prefetchSubject !== undefined && prefetchOwner
        ? claimThreadPrefetch(event.channel || '', prefetchSubject, prefetchOwner)
        : 0;
    let prefetchHandedOff = false;
    try {
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

        prefetchHandedOff = enqueueSlackIngress(slackIngressLaneKey(target), signal =>
            processSlackMessageEvent(event, target, text, signal, {
                prefetchToken,
                ...(prefetchOwner ? { prefetchOwner } : {}),
                preResolvedScope,
                ...(reservedEventKey ? { eventKey: reservedEventKey } : {}),
                ...(reservationGeneration !== undefined ? { reservationGeneration } : {}),
            }));
    } finally {
        if (prefetchToken && prefetchOwner && !prefetchHandedOff) {
            releaseThreadPrefetch(
                event.channel || '', event.thread_ts || '', prefetchOwner, prefetchToken,
            );
        }
    }
}

// ─── Init / Shutdown ────────────────────────────────

export async function initSlack(): Promise<TransportStartOutcome> {
    if (slackInitLock) {
        // Do not discard the request: the running init may be about to abort
        // because THIS caller's shutdown superseded it.
        log.info('[slack] initSlack already in progress — queuing a follow-up');
        initRequestPending = true;
        return transportNotStarted('superseded');
    }
    slackInitLock = true;
    let outcome: TransportStartOutcome;
    try {
        outcome = await runSlackInit();
    } catch (err) {
        // A thrown init still owes the queue a drain, exactly as the old
        // `finally` did — otherwise a crash mid-start leaves Slack off until
        // something unrelated happens to call init again.
        await settleSlackInit();
        throw err;
    }
    // The follow-up is the call that actually opened the socket; this one only
    // lost the race, so its `superseded` outcome must not shadow the real one.
    return (await settleSlackInit()) ?? outcome;
}

/**
 * Release the lock, then run a queued request and hand back ITS outcome
 * (`null` when nothing was queued). Deliberately not a `finally` block: that
 * can only replace a return value by returning from `finally`, which also
 * swallows in-flight throws. Order is unchanged — the lock is dropped before
 * the follow-up runs, so the retry takes the normal path rather than queuing
 * itself forever.
 */
async function settleSlackInit(): Promise<TransportStartOutcome | null> {
    slackInitLock = false;
    if (!initRequestPending) return null;
    initRequestPending = false;
    return initSlack();
}

/** The init body proper. Runs only under `slackInitLock`. */
async function runSlackInit(): Promise<TransportStartOutcome> {
    // Claim the generation FIRST so an external shutdown that lands while
    // we are tearing down or authenticating is not lost, then tear down
    // WITHOUT bumping it — an internal teardown must not invalidate the
    // init it belongs to.
    const generation = ++lifecycleGeneration;
    await disposeSlackRuntime();
    const sc = settings["slack"];
    if (!sc?.enabled || !sc?.botToken) {
        log.info('[slack] ⏭️  Slack pending (disabled or no bot token)');
        return transportNotStarted('not_configured');
    }
    if (!sc.appToken) {
        // Outbound still works via the send transport; only inbound needs
        // the app-level token. Say so precisely instead of "failed".
        log.warn('[slack] app-level token missing — outbound only, no inbound events');
        return transportNotStarted('outbound_only');
    }
    // One bot, one instance: a second instance sharing these tokens would
    // silently swallow half the events (Socket Mode round-robin).
    if (!shouldAttachSlack(sc.attachPort, settings["port"])) {
        log.info(`[slack] not the attach instance (attach port ${sc.attachPort}, this :${settings["port"]}) — socket not opened`);
        return transportNotStarted('not_attach_instance');
    }

    const auth = await slackApi<{ user_id?: string; team_id?: string }>(sc.botToken, 'auth.test');
    // A shutdown may have landed while auth.test was in flight; resuming
    // here would resurrect a transport the caller asked us to stop.
    if (generation !== lifecycleGeneration) {
        log.info('[slack] init superseded during auth — aborting');
        return transportNotStarted('superseded');
    }
    if (!auth.ok) {
        log.error('[slack] auth.test failed:', auth.error);
        return transportNotStarted('failed', 'auth_test_failed');
    }
    selfUserId = auth.data?.user_id || null;
    // The grant is whatever the app was installed with, not whatever the
    // current manifest asks for. Record it here — auth.test already ran, so
    // this costs nothing — and say the whole gap once instead of leaking one
    // scope per failed call from identity.ts (#340).
    //
    // Deliberately behind the earlier returns: an unconfigured, outbound-only,
    // non-attach or superseded init has either no token to ask with or no
    // ownership of this workspace. Outbound-only is the one real gap; it still
    // makes Web API calls but never reaches here, and moving auth.test above
    // that return would make an unconfigured channel hit the network on every
    // start. Documented as a known limitation rather than silently ignored.
    recordSlackScopeObservation(auth.grantedScopes, null);
    for (const gap of describeSlackScopeGaps(getSlackScopeStatus())) {
        // Each group logs at its own level: a missing required scope is a real
        // break, a missing optional one is not, and one shared WARN made them
        // indistinguishable (#478).
        const emit = gap.level === 'warn' ? log.warn : log.info;
        emit(`[slack:scopes] ${gap.text}`);
    }
    if (auth.data?.team_id && !sc.teamId) sc.teamId = auth.data.team_id;
    // The team id namespaces every ingress dedup key, and `slackEventKey`
    // degrades an empty one to the literal 'unknown' — so two workspaces,
    // or one workspace across a restart, would share a key space and drop
    // each other's messages as duplicates. Refuse to open the socket at
    // all, the same way Telegram refuses to poll when getMe yields no id.
    if (!String(sc.teamId ?? '').trim()) {
        log.error(logErrorText('[slack] refusing to start inbound: workspace (team) id could not be resolved'));
        return transportNotStarted('failed', 'team_id_unresolved');
    }

    const client = new SlackSocketClient({
        appToken: sc.appToken,
        onEnvelope: envelope => handleSlackEnvelope(envelope, slackApprovalIngress),
        preflightEnvelope: preflightSlackEnvelope,
    });
    slackApprovalIngress = createSlackSocketIngress();
    socketClient = client;
    await client.start();
    if (generation !== lifecycleGeneration) {
        log.info('[slack] init superseded during connect — disposing socket');
        client.stop();
        if (socketClient === client) socketClient = null;
        return transportNotStarted('superseded');
    }

    forwarderHandler = createSlackForwarder({
        getToken: () => getSlackSendClient().token,
        getLastTarget: () => getLastActiveTarget('slack'),
        shouldSkip: (data) => shouldSkipForwarding(data, 'slack'),
    });
    addBroadcastListener(forwarderHandler);
    // Deliberately NOT awaited. A workspace with thousands of channels takes
    // minutes to reconcile at Slack's Tier 2/3 pacing, and the socket must not
    // wait for it — inbound already works the moment the connection is up.
    startSlackAutoJoin(sc, generation);
    log.info(`[slack] ✅ connected as ${selfUserId || 'unknown'}`);
    return transportStarted;
}

export async function shutdownSlack(): Promise<void> {
    lifecycleGeneration++;
    await disposeSlackRuntime();
}

// ─── Public-channel auto-join ──────────────────
// Owned here rather than inside auto-join.ts so the module stays a pure policy
// function the tests can drive without a live transport.
let autoJoinAbort: AbortController | null = null;

/**
 * Kick off the background reconciliation for this init generation.
 *
 * Two guards, and both are load-bearing. The AbortController wakes the pacing
 * sleeps immediately so a shutdown does not wait out a 3-second gap, and the
 * generation check stops a scan whose transport has already been replaced by a
 * newer init. Cleanup is identity-guarded: a stale run that finishes late must
 * not clear the controller belonging to the run that superseded it.
 */
function startSlackAutoJoin(sc: Record<string, unknown>, generation: number): void {
    const config = mergeSlackAutoJoin(undefined, sc?.["autoJoin"]);
    if (!config.enabled) return;
    const token = String(sc?.["botToken"] ?? '').trim();
    if (!token) return;

    autoJoinAbort?.abort();
    const controller = new AbortController();
    autoJoinAbort = controller;

    void runSlackAutoJoin({
        token,
        config,
        signal: controller.signal,
        isCurrent: () => generation === lifecycleGeneration,
        // The inbound allowlist is the operator's boundary; joining past it
        // would grant history access to conversations they silenced.
        allowlist: readSlackAllowlist(sc?.["channelIds"]),
    }).then(result => {
        if (result.cancelled) return;
        if (result.joined.length || result.failed.length || result.abortedReason) {
            log.info(redactOutboundText(
                `[slack:autojoin] scanned=${result.scanned} joined=${result.joined.length}`
                + ` skipped=${result.skipped} failed=${result.failed.length}`
                + (result.budgetExhausted ? ' budget=exhausted' : '')
                + (result.abortedReason ? ` stopped=${result.abortedReason}` : ''),
            ));
        }
        if (result.abortedReason === 'missing_scope') {
            log.warn('[slack:autojoin] channels:join is not granted — add it under'
                + ' OAuth & Permissions and reinstall the app to auto-join public channels');
        }
    }).catch(err => {
        log.warn('[slack:autojoin] run failed:', logErrorText(err));
    }).finally(() => {
        if (autoJoinAbort === controller) autoJoinAbort = null;
    });
}

/**
 * Release every runtime resource WITHOUT touching the lifecycle generation.
 * `initSlack` reuses this for its own teardown; only an external
 * `shutdownSlack` invalidates in-flight initializations.
 */
async function disposeSlackRuntime(): Promise<void> {
    await resetSlackIngress();
    // Wakes the pacing sleeps immediately instead of letting a teardown wait
    // out a 3-second gap between conversations.list pages.
    autoJoinAbort?.abort();
    autoJoinAbort = null;
    // A re-init can authenticate against a different workspace, whose app has
    // its own grant. Carrying the previous observation forward would report
    // the old workspace's scopes for the new one.
    resetSlackScopeStatus();
    // Identity is cached per (team, id). A re-init can authenticate against a
    // different workspace, so the cache must not outlive the runtime that filled it.
    resetSlackIdentityCache();
    // Same reasoning for channel names and thread participants: a workspace
    // switch would otherwise attribute the previous team's conversations.
    resetSlackConversationCache();
    // Prefetch claims are per-runtime: a fresh runtime has no agent session, so
    // the next message in a thread should get its history again.
    resetThreadPrefetchClaims();
    if (forwarderHandler) {
        removeBroadcastListener(forwarderHandler);
        forwarderHandler = null;
    }
    // Close out queued turns rather than leaving them armed for their 5-minute
    // timeout against a transport that no longer exists. Awaited and bounded:
    // dropping the callbacks (as this did) leaves the notice claiming the agent
    // is still working, while an unbounded await would hold shutdown open on a
    // stuck vendor call. The deadline covers the worst honest chain and the
    // signal cancels whatever is left.
    //
    // The registry is the single shutdown route, as on Discord. A parallel
    // waiter set used to hold one closure per queued turn and was cleared only
    // here, so a long-lived instance retained every historical turn's token,
    // target, notice and ACK closure. It also stripped the drain's abort signal:
    // a QueueNotice pins the signal from its FIRST close, so a waiter closing
    // without one made the later shutdown signal unreachable.
    // Abort in-flight answer sends FIRST (#417 review): a queued waiter that
    // already claimed its terminal is mid-send, and the notice drain below
    // awaits that same promise — un-aborted, a hung vendor POST would eat the
    // whole notice budget and blow past the server's 5s force-exit. Aborting
    // first makes the hung send settle immediately (as slack_send_aborted,
    // never a vendor failure), so the notice drain only pays for cleanup.
    await slackOutboundRegistry.drain();
    await slackNoticeRegistry.drain(SLACK_NOTICE_DRAIN_MS);
    pendingQueueRequestIds.clear();
    socketClient?.stop();
    socketClient = null;
    selfUserId = null;
}

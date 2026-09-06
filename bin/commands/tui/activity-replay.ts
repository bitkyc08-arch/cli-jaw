import { ActivityReplay } from '../../../src/shared/activity-replay.js';
import { activityKey, type ActivityState } from '../../../src/shared/activity-state.js';
import { readActivityRun, type ActivityRunSummary } from '../../../src/shared/activity-read.js';
import type { RuntimeEvent } from '../../../src/shared/runtime-contract.js';
import { presentationMode, type ActivityIdentity } from '../../../src/shared/presentation.js';
import { createActivityFromState, releaseActivityPreview, type ActivityTranscriptItem } from '../../../src/cli/tui/activity.js';
import { createActivityHistoryPanel } from '../../../src/cli/tui/activity-history.js';
import { bindActivityAnswerReceipt } from '../../../src/cli/tui/activity-answer.js';
import { activityLinearDelta } from '../../../src/cli/tui/activity-linear.js';
import { appendStatusItem, isVerboseRenderMode, settleActivityFallbackPreviews } from '../../../src/cli/tui/transcript.js';
import { settleActivityFallbackOutput } from './activity-fallback.js';
import { refreshActivityIdentity } from './api.js';
import { activityHttpRead } from './activity-http.js';
import { requestTuiActivityAnswer, cancelTuiActivityAnswers } from './activity-answer-read.js';
import type { TuiContext } from './types.js';

const sameIdentity = (a: ActivityIdentity | null | undefined, b: ActivityIdentity | null | undefined): boolean =>
    Boolean(a && b && a.sessionId === b.sessionId && a.scope === b.scope);
const turns = (ctx: TuiContext): ActivityTranscriptItem[] => ctx.store.transcript.items
    .filter((item): item is ActivityTranscriptItem => item.type === 'activity');

function adoptReplayModel(ctx: TuiContext, replay: ActivityReplay, model: ActivityState): void {
    const owner = ctx.activityIdentity ?? ctx.activitySettlementIdentity;
    if (!owner || owner.sessionId !== model.identity.sessionId) return;
    const key = activityKey(model.identity);
    let item = turns(ctx).find(item => item.key === key);
    if (item?.retired || item?.released) { replay.turns.delete(key); return; }
    if (!item) {
        item = createActivityFromState(model, isVerboseRenderMode());
        if (!bindActivityAnswerReceipt(ctx.store.transcript, item)) { replay.turns.delete(key); return; }
        item.presentation = presentationMode(ctx.settingsSnapshot);
        ctx.store.transcript.items.push(item);
    }
    item.model = model;
    if (model.end) { item.terminalStatus = model.end.status; item.degraded = item.recordingGap || item.displayGap; }
    item.revision++;
    if (ctx.displayMode === 'line' && ctx.activityRestoreToken && item.presentation === 'legacy') {
        for (const entry of model.entries.values()) process.stdout.write(activityLinearDelta(item, entry));
    }
    for (const old of turns(ctx)) {
        if (!old.released && old.terminalStatus && !replay.turns.has(old.key)) releaseActivityPreview(old);
    }
    ctx.requestFrame?.();
}

export function getActivityReplay(ctx: TuiContext): ActivityReplay {
    if (!ctx.activityReplay) {
        const replay = new ActivityReplay(model => adoptReplayModel(ctx, replay, model));
        ctx.activityReplay = replay;
    }
    const replay = ctx.activityReplay;
    for (const item of turns(ctx)) {
        if (item.released || item.retired) { replay.turns.delete(item.key); continue; }
        if (!sameIdentity(ctx.activityIdentity ?? ctx.activitySettlementIdentity, item.model.identity)) continue;
        if (!replay.turns.has(item.key)) replay.turns.set(item.key, item.model);
        if (item.terminalStatus) replay.markSettled(item.model.identity.runId);
    }
    return replay;
}

/** Selection/read/replay lifetime changes; input paste drain belongs to the CLI. */
export function retireActivityView(ctx: TuiContext, next: ActivityIdentity | null): void {
    cancelTuiActivityAnswers(ctx);
    if (ctx.activityHistoryEscapeTimer) clearTimeout(ctx.activityHistoryEscapeTimer);
    delete ctx.activityHistoryEscapeTimer;
    const panel = ctx.store.overlay.activityHistory;
    panel.generation++;
    panel.controller?.abort();
    ctx.store.overlay.activityHistory = createActivityHistoryPanel();
    ctx.activityReplay?.reset();
    delete ctx.activityReplay;
    delete ctx.activityRestoreToken;
    delete ctx.activeActivityKey;
    ctx.activityActiveGeneration = (ctx.activityActiveGeneration ?? 0) + 1;
    ctx.streaming = false;
    ctx.streamState = 'idle';
    ctx.turnStartedAt = 0;
    ctx.inputActive = true;
    ctx.streamSink = null;
    if (ctx.footerTimer) { clearInterval(ctx.footerTimer); ctx.footerTimer = null; }
    for (const item of turns(ctx)) {
        if (!sameIdentity(item.model.identity, next)) {
            const printed = settleActivityFallbackPreviews(ctx.store.transcript, item.key);
            if (printed && ctx.displayMode === 'line') process.stdout.write('\n[Provisional output ended; conversation changed.]\n');
            if (!item.terminalStatus) {
                item.retired = true;
                item.revision++;
            }
        }
    }
    ctx.requestFrame?.();
}

export function bindActivityContext(ctx: TuiContext): void {
    ctx.onActivityIdentityChanged = (previous, next) => {
        // The first confirmed identity has no previous native view to retire.
        // Keep the empty restore buffer installed before this bootstrap read.
        if (!previous && turns(ctx).length === 0) return;
        if (!sameIdentity(previous, next)) retireActivityView(ctx, next);
    };
}

export function invalidateActivityContext(ctx: TuiContext): void {
    retireActivityView(ctx, null);
    ctx.activityIdentityGeneration++;
    ctx.activityIdentity = null;
    ctx.activitySettlementIdentity = null;
    ctx.activityActiveRunId = null;
}

function syncRestoredDisplay(ctx: TuiContext, runId: string, closed: boolean, activeGeneration: number): void {
    const active = turns(ctx).find(item => item.key === ctx.activeActivityKey);
    if ((ctx.activityActiveGeneration ?? 0) !== activeGeneration && active?.model.identity.runId !== runId) return;
    if (ctx.activityActiveRunId !== runId && active?.model.identity.runId !== runId) return;
    const current = turns(ctx).filter(item => item.model.identity.runId === runId && !item.retired && !item.released).at(-1);
    if (!current) return;
    if (ctx.activeActivityKey !== current.key) {
        ctx.activityActiveGeneration = (ctx.activityActiveGeneration ?? 0) + 1;
        ctx.turnStartedAt = 0; // No fabricated elapsed time for a cold journal restore.
    }
    ctx.activeActivityKey = current.key;
    const ended = closed || Boolean(current.terminalStatus);
    ctx.streaming = !ended;
    ctx.streamState = ended ? 'idle' : 'responding';
    ctx.inputActive = true;
    if (ended && ctx.footerTimer) { clearInterval(ctx.footerTimer); ctx.footerTimer = null; }
}

/** Install the buffer BEFORE identity refresh or page reads, including catch-up. */
export async function restoreActiveActivity(ctx: TuiContext): Promise<void> {
    if (ctx.isRaw) return;
    const replay = getActivityReplay(ctx);
    const token = Symbol('activity-restore');
    ctx.activityRestoreToken = token;
    let generation = ctx.activityIdentityGeneration;
    const completion: { value: { runId: string; events: RuntimeEvent[]; incomplete: boolean; status: ActivityRunSummary['status']; activeGeneration: number } | null } = { value: null };
    const targetRun = ctx.activityActiveRunId ?? turns(ctx).find(item => item.key === ctx.activeActivityKey)?.model.identity.runId;
    try {
        await replay.restore(async signal => {
            const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
            await refreshActivityIdentity(ctx);
            if (ctx.activityReplay !== replay) return [];
            generation = ctx.activityIdentityGeneration;
            const activeGeneration = ctx.activityActiveGeneration ?? 0;
            const identity = ctx.activityIdentity;
            if (!identity) throw new Error('activity_identity_unavailable');
            const active = turns(ctx).find(item => item.key === ctx.activeActivityKey);
            const runId = ctx.activityActiveRunId ?? active?.model.identity.runId;
            if (!runId || (active?.released && active.terminalStatus && !ctx.activityActiveRunId)) return [];
            const known = turns(ctx).find(item => item.model.identity.runId === runId);
            if (known?.retired) return [];
            const read = activityHttpRead(ctx);
            const options = { runId, sessionId: identity.sessionId, signal: boundedSignal, read };
            const seed = await readActivityRun(options);
            const tail = await readActivityRun({ ...options, after: seed.through });
            if (generation !== ctx.activityIdentityGeneration || !sameIdentity(identity, ctx.activityIdentity)) throw new Error('activity_scope_changed');
            if (seed.scope !== tail.scope) throw new Error('activity_scope_changed');
            const seedTurn = seed.events[0]?.turnId;
            const tailTurn = tail.events[0]?.turnId;
            if (seedTurn && tailTurn && seedTurn !== tailTurn) throw new Error('activity_turn_changed');
            const events = [...seed.events, ...tail.events];
            if (events.length > 4096 || Buffer.byteLength(JSON.stringify(events), 'utf8') > 4 * 1024 * 1024) throw new Error('activity_restore_limit');
            completion.value = { runId, events, incomplete: seed.incomplete || tail.incomplete, status: tail.status, activeGeneration };
            return events;
        }, targetRun ? { runId: targetRun } : undefined);
        // Only a committed restore may publish full answers or settlement metadata.
        const result = completion.value;
        if (!result || generation !== ctx.activityIdentityGeneration || ctx.activityReplay !== replay) return;
        for (const event of result.events) {
            const item = turns(ctx).find(item => item.key === activityKey(event));
            if (!item || item.retired || item.released) continue;
            if (event.kind === 'turn-end') {
                settleActivityFallbackOutput(ctx, item.key, undefined);
                requestTuiActivityAnswer(ctx, item, { retry: true });
            }
        }
        for (const item of turns(ctx).filter(item => item.model.identity.runId === result.runId && !item.retired && !item.released)) {
            item.recordingGap ||= result.incomplete;
            item.displayGap = false;
            item.degraded = item.recordingGap || (result.status !== 'running' && !item.model.end);
            if (result.status !== 'running') {
                item.terminalStatus ??= result.status === 'interrupted' ? 'stopped' : result.status;
                item.model.requests.clear();
                replay.markSettled(result.runId);
                requestTuiActivityAnswer(ctx, item, { retry: true });
            }
            item.revision++;
        }
        syncRestoredDisplay(ctx, result.runId, result.status !== 'running', result.activeGeneration);
        ctx.requestFrame?.();
    } catch {
        if (generation !== ctx.activityIdentityGeneration || ctx.activityReplay !== replay) return;
        const text = 'Activity restore unavailable; open F6 history to retry.';
        if (!ctx.store.transcript.items.some(item => item.type === 'status' && item.text === text)) appendStatusItem(ctx.store.transcript, text);
        ctx.requestFrame?.();
    } finally {
        if (ctx.activityRestoreToken === token) delete ctx.activityRestoreToken;
    }
}

/** Called only after the screen reports an actual native flush. */
export function releaseCommittedActivity(ctx: TuiContext, frontier: number): void {
    for (let i = 0; i < Math.min(frontier, ctx.store.transcript.items.length); i++) {
        const item = ctx.store.transcript.items[i]!;
        if (item.type === 'activity' && (item.terminalStatus || item.retired)) {
            releaseActivityPreview(item);
            ctx.activityReplay?.turns.delete(item.key);
        } else if (item.type === 'assistant' && item.activityKey) { item.text = ''; item.activityReleased = true; }
    }
}

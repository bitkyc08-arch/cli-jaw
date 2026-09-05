import type { RuntimeEvent, RuntimeTurnOutcome } from '../../../src/shared/runtime-contract.js';
import { activityKey } from '../../../src/shared/activity-state.js';
import { presentationMode } from '../../../src/shared/presentation.js';
import { createActivityItem, renderActivityItem, releaseActivityPreview,
    type ActivityTranscriptItem } from '../../../src/cli/tui/activity.js';
import { appendActivityAnswer, writeActivityAnswer } from '../../../src/cli/tui/activity-answer.js';
import { isVerboseRenderMode, appendStatusItem } from '../../../src/cli/tui/transcript.js';
import { wrapActivityTerminalText } from '../../../src/cli/tui/activity-terminal-text.js';
import type { TuiContext } from './types.js';
import { activityLinearDelta, closeActivityLinear } from '../../../src/cli/tui/activity-linear.js';
import { getActivityReplay } from './activity-replay.js';

const MAX_ACTIVITY_MODELS = 16;

function ownsIdentity(ctx: TuiContext, identity: { sessionId: unknown; scope: unknown }): boolean {
    return !ctx.isRaw && Boolean(ctx.activityIdentity
        && identity.sessionId === ctx.activityIdentity.sessionId && identity.scope === ctx.activityIdentity.scope);
}

export function activityForCompatibility(ctx: TuiContext, wire: Record<string, unknown>): ActivityTranscriptItem | undefined {
    if (ctx.isRaw || typeof wire['traceRunId'] !== 'string') return;
    return ctx.store.transcript.items.find((item): item is ActivityTranscriptItem => item.type === 'activity'
        && item.model.identity.runId === wire['traceRunId'] && ownsAdmittedItem(ctx, item)
        && (wire['sessionId'] === undefined || wire['sessionId'] === item.model.identity.sessionId)
        && (wire['scope'] === undefined || wire['scope'] === item.model.identity.scope));
}

function ownsAdmittedItem(ctx: TuiContext, item: ActivityTranscriptItem): boolean {
    const identity = ctx.activityIdentity ?? ctx.activitySettlementIdentity;
    return !ctx.isRaw && Boolean(identity && identity.sessionId === item.model.identity.sessionId
        && identity.scope === item.model.identity.scope);
}

function admitActivity(ctx: TuiContext, event: RuntimeEvent): ActivityTranscriptItem | null {
    const key = activityKey(event);
    const existing = ctx.store.transcript.items.find((item): item is ActivityTranscriptItem => item.type === 'activity' && item.key === key);
    if (existing) return existing;
    const retained = ctx.store.transcript.items.filter((item): item is ActivityTranscriptItem => item.type === 'activity' && !item.released);
    if (retained.length >= MAX_ACTIVITY_MODELS) {
        const oldest = retained.find(item => item.terminalStatus);
        if (!oldest) return null;
        releaseActivityPreview(oldest);
    }
    const item = createActivityItem(event, isVerboseRenderMode());
    item.presentation = presentationMode(ctx.settingsSnapshot);
    ctx.store.transcript.items.push(item);
    return item;
}

function printSettledActivity(ctx: TuiContext, item: ActivityTranscriptItem): void {
    if (ctx.displayMode === 'fullscreen') return;
    const width = process.stdout.columns || 80;
    if (item.presentation === 'legacy') process.stdout.write(closeActivityLinear(item));
    const rows = item.presentation === 'legacy' ? [item.terminalStatus === 'done' ? 'Complete'
        : item.terminalStatus === 'stopped' ? 'Stopped' : 'Failed'] : renderActivityItem(item, width, item.presentation, 'Use fullscreen chat for retained history.');
    process.stdout.write('\r\x1b[2K' + rows.join('\n') + '\n');
    writeActivityAnswer(ctx.store.transcript, item.key, width, text => process.stdout.write(text));
}

/** Returns true only for a newly admitted event; duplicates must not restart clocks. */
export function handleActivityRuntime(ctx: TuiContext, event: RuntimeEvent): boolean {
    const existing = ctx.store.transcript.items.find((row): row is ActivityTranscriptItem => row.type === 'activity' && row.key === activityKey(event));
    // Refresh revokes admission, not the right to settle the exact run already
    // displayed. Explicit session switches still reject the old conversation.
    if (!ownsIdentity(ctx, event) && !(existing && ownsAdmittedItem(ctx, existing))) return false;
    const item = existing ?? admitActivity(ctx, event);
    if (!item || item.retired || item.released || event.seq <= item.model.seq) return false;
    const wasTerminal = Boolean(item.terminalStatus);
    item.presentation = presentationMode(ctx.settingsSnapshot);
    const previous = ctx.store.transcript.items.find(row => row.type === 'activity' && row.key === ctx.activeActivityKey);
    // Capture the full final before the shared reducer bounds its preview.
    if (event.kind === 'turn-end') appendActivityAnswer(ctx.store.transcript, item.key, event);
    try {
        if (!getActivityReplay(ctx).live(event)) return false;
        if (event.kind === 'turn-end') item.terminalStatus = event.status;
    } catch {
        item.degraded = true;
        item.displayGap = true;
        if (event.kind === 'turn-end') {
            item.terminalStatus = event.status;
            printSettledActivity(ctx, item);
        }
        item.revision++;
        ctx.requestFrame?.();
        return false;
    }
    // A terminal or an old existing run cannot reclaim the live owner from a
    // newer start. Even duplicate buffered starts must pass replay admission first.
    if (!wasTerminal && event.kind !== 'turn-end' && (!ctx.activeActivityKey || (!existing
        && (event.kind === 'turn-start' || ctx.activityActiveRunId === event.runId
            || (previous?.type === 'activity' && previous.terminalStatus))))) {
        if (ctx.activeActivityKey !== item.key) ctx.activityActiveGeneration = (ctx.activityActiveGeneration ?? 0) + 1;
        ctx.activeActivityKey = item.key;
    }
    if (item.model.seq < event.seq && event.kind !== 'turn-end') return !wasTerminal;
    if (ctx.displayMode !== 'fullscreen' && !wasTerminal) {
        const omitted = item.model.omitted;
        if (!item.lineLimitReported && (omitted.entries || omitted.textChars || omitted.requests)) {
            process.stdout.write(closeActivityLinear(item) + '\nActivity preview limited; use fullscreen chat for retained history.\n');
            item.lineLimitReported = true;
        }
        if (item.presentation === 'legacy' && event.kind !== 'message' && event.kind !== 'reasoning' && event.kind !== 'tool') {
            process.stdout.write(closeActivityLinear(item));
        }
        if (event.kind === 'turn-end' && !wasTerminal) printSettledActivity(ctx, item);
        else if (event.kind === 'request') {
            process.stdout.write('\r\x1b[2K' + wrapActivityTerminalText(`Waiting for ${event.requestType}: ${event.view.title}`,
                process.stdout.columns || 80).join('\n') + '\n');
        } else if (item.presentation === 'legacy' && (event.kind === 'message' || event.kind === 'reasoning' || event.kind === 'tool')) {
            const entry = item.model.entries.get(event.itemId);
            if (entry) process.stdout.write(activityLinearDelta(item, entry));
        } else {
            process.stdout.write('\r\x1b[2K' + (renderActivityItem(item, process.stdout.columns || 80)[0] ?? ''));
        }
    } else if (ctx.displayMode === 'line' && event.kind === 'turn-end') {
        process.stdout.write(closeActivityLinear(item));
        writeActivityAnswer(ctx.store.transcript, item.key, process.stdout.columns || 80, text => process.stdout.write('\n' + text));
    }
    ctx.requestFrame?.();
    return !wasTerminal;
}

/** A compatibility terminal can settle presentation after journal failure, without
 * inventing a semantic event or stealing another run's final/lifecycle cleanup. */
export function settleActivityCompatibility(ctx: TuiContext, wire: Record<string, unknown>): boolean {
    const item = activityForCompatibility(ctx, wire);
    if (!item || (wire['runtimeFinality'] !== 'present' && wire['runtimeFinality'] !== 'absent')) return false;
    const status = wire['runtimeStatus'];
    if (status !== 'done' && status !== 'error' && status !== 'stopped') return false;
    const outcome: Pick<RuntimeTurnOutcome, 'status' | 'finalText'> = {
        status, finalText: wire['runtimeFinality'] === 'absent' ? null : typeof wire['text'] === 'string' ? wire['text'] : '',
    };
    appendActivityAnswer(ctx.store.transcript, item.key, outcome);
    if (!item.terminalStatus) {
        item.terminalStatus = status;
        item.degraded = true;
        item.model.requests.clear();
        item.revision++;
        printSettledActivity(ctx, item);
    }
    if (ctx.displayMode === 'line') writeActivityAnswer(ctx.store.transcript, item.key, process.stdout.columns || 80, text => process.stdout.write(text));
    ctx.activityReplay?.markSettled(item.model.identity.runId);
    ctx.requestFrame?.();
    return true;
}

export function markActivityGap(ctx: TuiContext, identity: { sessionId: unknown; scope: unknown; runId: unknown }): void {
    const item = ctx.store.transcript.items.find((row): row is ActivityTranscriptItem => row.type === 'activity'
        && row.model.identity.runId === identity.runId && row.model.identity.sessionId === identity.sessionId
        && row.model.identity.scope === identity.scope && ownsAdmittedItem(ctx, row));
    if (!item && !ownsIdentity(ctx, identity)) return;
    if (item) { item.degraded = true; item.recordingGap = true; item.revision++; }
    else {
        const text = 'Activity unavailable; using legacy output.';
        if (!ctx.store.transcript.items.some(row => row.type === 'status' && row.text === text)) appendStatusItem(ctx.store.transcript, text);
    }
    ctx.requestFrame?.();
}

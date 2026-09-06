import type { RuntimeEvent, RuntimeTurnOutcome } from '../../../src/shared/runtime-contract.js';
import { activityKey } from '../../../src/shared/activity-state.js';
import { presentationMode } from '../../../src/shared/presentation.js';
import { createActivityItem, renderActivityItem, releaseActivityPreview,
    type ActivityTranscriptItem } from '../../../src/cli/tui/activity.js';
import { appendActivityAnswer, bindActivityAnswerReceipt, tuiAnswerKey, writeActivityAnswer } from '../../../src/cli/tui/activity-answer.js';
import { isVerboseRenderMode, appendStatusItem } from '../../../src/cli/tui/transcript.js';
import { safeActivityTerminalText, wrapActivityTerminalText } from '../../../src/cli/tui/activity-terminal-text.js';
import type { TuiContext } from './types.js';
import { activityLinearDelta, closeActivityLinear } from '../../../src/cli/tui/activity-linear.js';
import { getActivityReplay } from './activity-replay.js';
import { settleActivityFallbackOutput } from './activity-fallback.js';
import { requestTuiActivityAnswer } from './activity-answer-read.js';
import type { TuiAnswerReadTarget } from '../../../src/cli/tui/transcript.js';

const MAX_ACTIVITY_MODELS = 16;

/** Whole-instance streams may contain an unknown foreign run. Absence from the
 * local reducer is never permission to mutate the legacy composer or clocks. */
export function admitsCompatibility(ctx: TuiContext, wire: Record<string, unknown>): boolean {
    if (ctx.isRaw) return true;
    const modern = Object.hasOwn(wire, 'sessionId') || Object.hasOwn(wire, 'scope');
    if (!modern) return true; // explicit old-server path
    for (const name of ['sessionId', 'scope', 'traceRunId']) {
        if (Object.hasOwn(wire, name) && (typeof wire[name] !== 'string' || !wire[name]
            || (wire[name] as string).length > 240)) return false;
    }
    const matches = (identity: { sessionId: string; scope: string }) =>
        (!Object.hasOwn(wire, 'sessionId') || wire['sessionId'] === identity.sessionId)
        && (!Object.hasOwn(wire, 'scope') || wire['scope'] === identity.scope);
    if (ctx.activityIdentity && matches(ctx.activityIdentity)) return true;
    if (!ctx.activitySettlementIdentity || !matches(ctx.activitySettlementIdentity)) return false;
    return ctx.store.transcript.items.some(item => item.type === 'activity'
        ? !item.retired && item.model.identity.runId === wire['traceRunId'] && matches(item.model.identity)
        : item.type === 'assistant' && item.activityReadIdentity !== undefined && item.activityReadIdentity.runId === wire['traceRunId']
            && matches(item.activityReadIdentity));
}

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
    if (!bindActivityAnswerReceipt(ctx.store.transcript, item)) return null;
    item.presentation = presentationMode(ctx.settingsSnapshot);
    ctx.store.transcript.items.push(item);
    return item;
}

function printSettledActivity(ctx: TuiContext, item: ActivityTranscriptItem): void {
    if (ctx.displayMode === 'fullscreen') return;
    const width = process.stdout.columns || 80;
    if (item.presentation === 'legacy') process.stdout.write(closeActivityLinear(item));
    const rows = item.presentation === 'legacy' ? [item.terminalStatus === 'done' ? 'Complete'
        : item.terminalStatus === 'stopped' ? 'Stopped' : item.terminalStatus === 'finished' ? 'Finished' : 'Failed'] : renderActivityItem(item, width, item.presentation, 'Use fullscreen chat for retained history.');
    process.stdout.write('\r\x1b[2K' + rows.join('\n') + '\n');
    writeActivityAnswer(ctx.store.transcript, tuiAnswerKey(item), width, text => process.stdout.write(text));
}

/** Returns true only for a newly admitted event; duplicates must not restart clocks. */
export function handleActivityRuntime(ctx: TuiContext, event: RuntimeEvent): boolean {
    const existing = ctx.store.transcript.items.find((row): row is ActivityTranscriptItem => row.type === 'activity' && row.key === activityKey(event));
    // Refresh revokes admission, not the right to settle the exact run already
    // displayed. Explicit session switches still reject the old conversation.
    if (!ownsIdentity(ctx, event) && !(existing && ownsAdmittedItem(ctx, existing))) return false;
    const item = existing ?? admitActivity(ctx, event);
    if (!item || item.retired || event.seq <= item.model.seq) return false;
    const wasTerminal = Boolean(item.terminalStatus);
    const previousStatus = item.terminalStatus;
    if (event.kind === 'turn-end') {
        settleActivityFallbackOutput(ctx, item.key, undefined);
        item.terminalStatus = event.status;
        for (const row of ctx.store.transcript.items) {
            if (row.type === 'assistant' && row.activityKey === tuiAnswerKey(item)) row.activityStatus = event.status;
        }
        requestTuiActivityAnswer(ctx, item);
    }
    if (item.released) {
        if (event.kind === 'turn-end' && previousStatus === 'finished') {
            item.terminalStatus = event.status;
            item.model.seq = event.seq;
            item.degraded = item.recordingGap || item.displayGap;
            item.revision++;
            ctx.requestFrame?.();
        }
        return false;
    }
    item.presentation = presentationMode(ctx.settingsSnapshot);
    const previous = ctx.store.transcript.items.find(row => row.type === 'activity' && row.key === ctx.activeActivityKey);
    // Canonical terminal text is a redacted journal preview, not the answer.
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
        ctx.activityActiveRunId = event.runId;
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
        writeActivityAnswer(ctx.store.transcript, tuiAnswerKey(item), process.stdout.columns || 80, text => process.stdout.write('\n' + text));
    }
    ctx.requestFrame?.();
    return !wasTerminal;
}

/** A compatibility terminal can settle presentation after journal failure, without
 * inventing a semantic event or stealing another run's final/lifecycle cleanup. */
export function settleActivityCompatibility(ctx: TuiContext, wire: Record<string, unknown>): boolean {
    const item = activityForCompatibility(ctx, wire);
    if (!item) return settleMissingJournal(ctx, wire);
    // Print producers intentionally retain the legacy completion shape. Only a
    // previously admitted canonical run can claim this fallback; malformed native
    // markers must never be reinterpreted as a print completion.
    const printFinal = wire['runtimeFinality'] === undefined && wire['runtimeStatus'] === undefined
        && typeof wire['text'] === 'string';
    const status = printFinal ? undefined : wire['runtimeStatus'];
    if (!printFinal && ((wire['runtimeFinality'] !== 'present' && wire['runtimeFinality'] !== 'absent')
        || (status !== 'done' && status !== 'error' && status !== 'stopped'))) return false;
    const outcome: Pick<RuntimeTurnOutcome, 'finalText'> & { status?: RuntimeTurnOutcome['status'] } = {
        ...(status === undefined ? {} : { status: status as RuntimeTurnOutcome['status'] }),
        finalText: wire['runtimeFinality'] === 'absent' ? null : typeof wire['text'] === 'string' ? wire['text'] : '',
    };
    settleActivityFallbackOutput(ctx, item.key, outcome.finalText);
    retainAbsentDiagnostic(ctx, tuiAnswerKey(item), wire);
    appendActivityAnswer(ctx.store.transcript, tuiAnswerKey(item), outcome, 'compatibility');
    requestTuiActivityAnswer(ctx, item);
    if (!item.terminalStatus) {
        item.terminalStatus = outcome.status ?? 'finished';
        item.degraded = true;
        item.model.requests.clear();
        item.revision++;
        printSettledActivity(ctx, item);
    }
    if (ctx.displayMode === 'line') writeActivityAnswer(ctx.store.transcript, tuiAnswerKey(item), process.stdout.columns || 80, text => process.stdout.write(text));
    ctx.activityReplay?.markSettled(item.model.identity.runId);
    ctx.requestFrame?.();
    return true;
}

function settleMissingJournal(ctx: TuiContext, wire: Record<string, unknown>): boolean {
    if (!admitsCompatibility(ctx, wire) || !ctx.activityIdentity
        || typeof wire['traceRunId'] !== 'string' || typeof wire['sessionId'] !== 'string'
        || typeof wire['scope'] !== 'string') return false;
    const status = wire['runtimeStatus'];
    const finality = wire['runtimeFinality'];
    const print = finality === undefined && status === undefined && typeof wire['text'] === 'string';
    if (!print && ((finality !== 'present' && finality !== 'absent')
        || (status !== 'done' && status !== 'error' && status !== 'stopped'))) return false;
    const identity = { sessionId: wire['sessionId'], scope: wire['scope'], runId: wire['traceRunId'] };
    const key = JSON.stringify(['compatibility-answer', identity.sessionId, identity.scope, identity.runId]);
    retainAbsentDiagnostic(ctx, key, wire);
    appendActivityAnswer(ctx.store.transcript, key, { finalText: finality === 'absent' ? null : typeof wire['text'] === 'string' ? wire['text'] : '',
        ...(status === 'done' || status === 'error' || status === 'stopped' ? { status } : {}) }, 'compatibility');
    const receipt = ctx.store.transcript.items.find(row => row.type === 'assistant' && row.activityKey === key);
    if (receipt?.type !== 'assistant') return false;
    receipt.activityReadIdentity = identity;
    requestTuiActivityAnswer(ctx, receipt as TuiAnswerReadTarget);
    if (ctx.displayMode === 'line') writeActivityAnswer(ctx.store.transcript, key, process.stdout.columns || 80, text => process.stdout.write(text));
    ctx.requestFrame?.();
    return true;
}

function retainAbsentDiagnostic(ctx: TuiContext, key: string, wire: Record<string, unknown>): void {
    if (wire['runtimeFinality'] !== 'absent' || typeof wire['text'] !== 'string' || !wire['text'].trim()) return;
    if (ctx.store.transcript.items.some(row => row.type === 'command' && row.activityDiagnosticKey === key)) return;
    const text = safeActivityTerminalText(wire['text'].slice(0, 4096));
    ctx.store.transcript.items.push({ type: 'command', text, commandName: 'Runtime diagnostic', ok: false,
        activityDiagnosticKey: key, timestamp: Date.now() });
    if (ctx.displayMode === 'line') process.stdout.write('\nDiagnostic:\n' + wrapActivityTerminalText(text, process.stdout.columns || 80).join('\n') + '\n');
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

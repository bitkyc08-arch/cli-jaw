import { readActivityRun, readActivityRuns, type ActivityRunSummary } from '../../../src/shared/activity-read.js';
import { openActivityHistory, moveActivityHistory, moveActivityTurn, activityHistoryScrollLimit, consumeActivityHistoryInput } from '../../../src/cli/tui/activity-history.js';
import type { ActivityTranscriptItem } from '../../../src/cli/tui/activity.js';
import { classifyKeyAction, type KeyAction } from '../../../src/cli/tui/keymap.js';
import { apiJson, refreshActivityIdentity } from './api.js';
import { ESC_WAIT_MS, type TuiContext } from './types.js';

function scopedTurns(ctx: TuiContext): ActivityTranscriptItem[] {
    const identity = ctx.activityIdentity ?? ctx.activitySettlementIdentity;
    return ctx.store.transcript.items.filter((item): item is ActivityTranscriptItem => item.type === 'activity'
        && item.model.identity.sessionId === identity?.sessionId && item.model.identity.scope === identity?.scope);
}

function sortRuns(incoming: ActivityRunSummary[]): ActivityRunSummary[] {
    return [...incoming].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}

export function closeTuiActivityHistory(ctx: TuiContext): void {
    if (ctx.activityHistoryEscapeTimer) clearTimeout(ctx.activityHistoryEscapeTimer);
    delete ctx.activityHistoryEscapeTimer;
    const panel = ctx.store.overlay.activityHistory;
    panel.generation++;
    panel.controller?.abort();
    panel.controller = null;
    panel.loading = false;
    panel.open = false;
    ctx.requestFrame?.();
}

/** Modal input and its paste drain precede normal mouse/Escape/composer dispatch. */
export function routeActivityHistoryInput(ctx: TuiContext, input: string,
    onUnhandled: (token: string) => void, size: { columns: number; height: number }): boolean {
    const panel = ctx.store.overlay.activityHistory;
    const drain = ctx.store.activityPasteDrain;
    if (!panel.open && !drain.active && !drain.pending) return false;
    if (ctx.activityHistoryEscapeTimer) clearTimeout(ctx.activityHistoryEscapeTimer);
    delete ctx.activityHistoryEscapeTimer;
    const tokens = consumeActivityHistoryInput(drain, input);
    // Closing/resetting never hands the remaining paste chunk to the composer.
    if (!panel.open) return true;
    for (const token of tokens) {
        if (!handleActivityHistoryKey(ctx, classifyKeyAction(token), token, size)) onUnhandled(token);
    }
    if (!drain.active && drain.pending === '\x1b') {
        ctx.activityHistoryEscapeTimer = setTimeout(() => {
            delete ctx.activityHistoryEscapeTimer;
            if (ctx.store.overlay.activityHistory !== panel || !panel.open || drain.active || drain.pending !== '\x1b') return;
            drain.pending = '';
            closeTuiActivityHistory(ctx);
        }, ESC_WAIT_MS);
    }
    ctx.requestFrame?.();
    return true;
}

export function openTuiActivityHistory(ctx: TuiContext): void {
    if (ctx.isRaw || ctx.store.pasteCapture.active || ctx.store.pasteCapture.carry) return;
    openActivityHistory(ctx.store.overlay.activityHistory, scopedTurns(ctx));
    ctx.requestFrame?.();
    void loadTuiActivityHistory(ctx);
}

/** A selected run is the only retained raw payload; run discovery is descriptors only. */
export async function loadTuiActivityHistory(ctx: TuiContext, opts: { discover?: boolean; after?: string; records?: boolean } = {}): Promise<void> {
    const panel = ctx.store.overlay.activityHistory;
    if (!panel.open || ctx.isRaw) return;
    panel.controller?.abort();
    const controller = new AbortController();
    const generation = ++panel.generation;
    panel.controller = controller;
    panel.loading = true;
    panel.message = '';
    const panelCurrent = () => ctx.store.overlay.activityHistory === panel && panel.open && panel.generation === generation;
    let identityGeneration = ctx.activityIdentityGeneration;
    let discover = opts.discover ?? true;
    try {
        if (!ctx.activityIdentity) await refreshActivityIdentity(ctx);
        if (!panelCurrent() || controller.signal.aborted) return;
        const identity = ctx.activityIdentity;
        if (!identity) throw new Error('activity_identity_unavailable');
        identityGeneration = ctx.activityIdentityGeneration;
        const current = () => panelCurrent() && !controller.signal.aborted && identityGeneration === ctx.activityIdentityGeneration
            && ctx.activityIdentity?.sessionId === identity.sessionId && ctx.activityIdentity.scope === identity.scope;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
        const read = (path: string, requestSignal: AbortSignal) => apiJson(ctx, path, { signal: requestSignal });
        const options = { sessionId: identity.sessionId, signal, read };
        if (!panel.runId) {
            const discovery = await readActivityRuns({ ...options, ...(opts.after ? { after: opts.after } : {}) });
            if (!current()) return;
            panel.runs = sortRuns(discovery.runs);
            panel.discoveryLimited = discovery.incomplete;
            panel.discoveryLoaded = true;
            panel.discoveryAfter = discovery.nextAfter ?? null;
            panel.runId = panel.runs.at(-1)?.id ?? null;
            discover = false;
        }
        if (panel.runId && opts.records !== false) {
            const runId = panel.runId;
            const result = await readActivityRun({ ...options, runId });
            if (!current() || panel.runId !== runId) return;
            if (result.scope !== identity.scope) throw new Error('activity_scope_changed');
            panel.events = result.events;
            panel.through = result.through;
            panel.incomplete = result.incomplete;
            panel.loss = result.loss;
            panel.preview = null;
            if (panel.seq === null) moveActivityHistory(panel, 0);
            // Missing selected records remain explicitly missing; live writes do not
            // move the user to some other row while they are reading.
        }
        if (discover) {
            const discovery = await readActivityRuns({ ...options, ...(opts.after ? { after: opts.after } : {}) });
            if (!current()) return;
            if (discovery.runs.length || !opts.after) panel.runs = sortRuns(discovery.runs);
            panel.discoveryLimited = discovery.incomplete;
            panel.discoveryLoaded = true;
            panel.discoveryAfter = discovery.nextAfter ?? null;
            if (opts.after) panel.message = discovery.runs.length ? 'Run list advanced. Left/Right selects a run.' : 'No further retained runs.';
        }
    } catch {
        if (panelCurrent() && !controller.signal.aborted) panel.message = 'History unavailable. R retries; Esc closes.';
    } finally {
        if (panelCurrent()) {
            if (!panel.message && identityGeneration !== ctx.activityIdentityGeneration) panel.message = 'History refresh interrupted. R retries.';
            panel.loading = false;
            panel.controller = null;
            ctx.requestFrame?.();
        }
    }
}

export function handleActivityHistoryKey(ctx: TuiContext, action: KeyAction, token: string, size: { columns: number; height: number }): boolean {
    const panel = ctx.store.overlay.activityHistory;
    if (action === 'activity-history') {
        if (ctx.store.pasteCapture.active || ctx.store.pasteCapture.carry) return true;
        if (panel.open) closeTuiActivityHistory(ctx); else openTuiActivityHistory(ctx);
        return true;
    }
    if (!panel.open || action === 'ctrl-c') return false;
    if (action === 'escape-alone') closeTuiActivityHistory(ctx);
    else if (action === 'arrow-up' || action === 'arrow-down') moveActivityHistory(panel, action === 'arrow-up' ? -1 : 1);
    else if (action === 'arrow-left' || action === 'arrow-right') {
        if (moveActivityTurn(panel, action === 'arrow-left' ? -1 : 1)) void loadTuiActivityHistory(ctx, { discover: false });
    } else if (action === 'enter') { panel.expanded = !panel.expanded; panel.offset = 0; }
    else if (action === 'printable' && token.toLowerCase() === 'r') void loadTuiActivityHistory(ctx);
    else if (action === 'printable' && token.toLowerCase() === 'n') {
        if (panel.discoveryAfter) void loadTuiActivityHistory(ctx, { after: panel.discoveryAfter, records: false });
        else panel.message = 'No further retained run list. R starts a fresh discovery.';
    }
    else {
        const limit = activityHistoryScrollLimit(panel, size.columns, size.height);
        const page = Math.max(1, size.height - 4);
        if (action === 'home') panel.offset = 0;
        else if (action === 'end') panel.offset = limit;
        else if (action === 'page-up') panel.offset = Math.max(0, Math.min(limit, panel.offset) - page);
        else if (action === 'page-down') panel.offset = Math.min(limit, panel.offset + page);
    }
    ctx.requestFrame?.();
    return true;
}

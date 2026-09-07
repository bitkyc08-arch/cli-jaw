import { readSavedActivityAnswer } from '../../../src/shared/activity-read.js';
import { appendActivityAnswer, tuiAnswerKey, writeActivityAnswer } from '../../../src/cli/tui/activity-answer.js';
import type { TuiAnswerReadTarget, TuiAnswerReadIdentity, TuiAnswerReadState } from '../../../src/cli/tui/transcript.js';
import type { TuiContext } from './types.js';
import { activityHttpRead } from './activity-http.js';
import { writeAboveComposer } from './renderer.js';

const MAX_QUEUED_ANSWERS = 16;
interface AnswerJob {
    item: TuiAnswerReadTarget;
    key: string;
    identity: TuiAnswerReadIdentity;
    apiUrl: string;
    controller: AbortController;
}
export interface TuiActivityAnswers {
    generation: number;
    active: AnswerJob | null;
    queue: AnswerJob[];
}
const identityOf = (item: TuiAnswerReadTarget): TuiAnswerReadIdentity =>
    item.type === 'activity' ? item.model.identity : item.activityReadIdentity;

function eligible(ctx: TuiContext, job: AnswerJob): boolean {
    if (ctx.isRaw || ctx.apiUrl !== job.apiUrl || !ctx.store.transcript.items.includes(job.item)) return false;
    const current = identityOf(job.item);
    if (current.sessionId !== job.identity.sessionId || current.scope !== job.identity.scope
        || current.runId !== job.identity.runId || tuiAnswerKey(job.item) !== job.key) return false;
    if (job.item.type === 'activity' && job.item.retired) return false;
    const owner = ctx.activityIdentity ?? ctx.activitySettlementIdentity;
    return Boolean(owner && owner.sessionId === current.sessionId
        && (owner.scope === current.scope || (job.item.type === 'activity' && Boolean(job.item.terminalStatus))));
}

function mark(ctx: TuiContext, job: AnswerJob, state: TuiAnswerReadState | undefined): void {
    if (state) job.item.answerReadState = state;
    else delete job.item.answerReadState;
    // A later canonical model may have bound this exact compatibility receipt.
    for (const row of ctx.store.transcript.items) {
        if (row.type !== 'activity' || (row.answerKey ?? row.key) !== job.key) continue;
        if (row.model.identity.sessionId !== job.identity.sessionId || row.model.identity.runId !== job.identity.runId
            || row.model.identity.scope !== job.identity.scope) continue;
        if (state) row.answerReadState = state;
        else delete row.answerReadState;
        row.revision++;
    }
    ctx.requestFrame?.();
}

async function drain(ctx: TuiContext, state: TuiActivityAnswers): Promise<void> {
    if (state.active || ctx.activityAnswers !== state) return;
    const job = state.queue.shift();
    if (!job) return;
    if (!eligible(ctx, job)) {
        delete job.item.answerReadState;
        return drain(ctx, state);
    }
    state.active = job;
    const generation = state.generation;
    const owns = () => ctx.activityAnswers === state && state.generation === generation
        && state.active === job && !job.controller.signal.aborted && eligible(ctx, job);
    try {
        const saved = await readSavedActivityAnswer({ runId: job.identity.runId, sessionId: job.identity.sessionId,
            signal: job.controller.signal, read: activityHttpRead({ apiUrl: job.apiUrl }) });
        if (!owns()) return;
        if (saved) {
            const status = job.item.type === 'activity' ? job.item.terminalStatus : job.item.activityStatus;
            appendActivityAnswer(ctx.store.transcript, job.key, { finalText: saved.content,
                ...(status && status !== 'finished' ? { status } : {}) }, 'saved');
            mark(ctx, job, 'saved');
            if (ctx.displayMode === 'line') {
                // The composer may already be open; preserve its cursor rather
                // than re-running completion/IDE/prompt cleanup on this late read.
                writeActivityAnswer(ctx.store.transcript, job.key, process.stdout.columns || 80,
                    text => writeAboveComposer(ctx, text));
            }
        } else mark(ctx, job, 'absent');
    } catch {
        if (owns()) mark(ctx, job, 'unavailable');
    } finally {
        if (ctx.activityAnswers === state && state.generation === generation && !owns()
            && job.item.answerReadState === 'pending') mark(ctx, job, undefined);
        if (state.active === job) state.active = null;
        if (ctx.activityAnswers === state && state.generation === generation) void drain(ctx, state);
    }
}

export function requestTuiActivityAnswer(ctx: TuiContext, item: TuiAnswerReadTarget, options: { retry?: boolean } = {}): void {
    const state = ctx.activityAnswers ??= { generation: 0, active: null, queue: [] };
    const key = tuiAnswerKey(item);
    const receipt = ctx.store.transcript.items.find(row => row.type === 'assistant' && row.activityKey === key && row.activityReadIdentity);
    const target = receipt?.type === 'assistant' && receipt.activityReadIdentity ? receipt as TuiAnswerReadTarget : item;
    if (target.answerReadState === 'saved' || target.answerReadState === 'pending'
        || (target.answerReadState && !options.retry)) return;
    if (state.active?.key === key || state.queue.some(job => job.key === key)) return;
    const job: AnswerJob = { item: target, key, identity: { ...identityOf(target) }, apiUrl: ctx.apiUrl, controller: new AbortController() };
    if (!eligible(ctx, job)) return;
    if (state.queue.length >= MAX_QUEUED_ANSWERS) { mark(ctx, job, 'unavailable'); return; }
    mark(ctx, job, 'pending');
    state.queue.push(job);
    void drain(ctx, state);
}

export function cancelTuiActivityAnswers(ctx: TuiContext): void {
    const state = ctx.activityAnswers;
    if (!state) return;
    state.generation++;
    for (const job of [...state.queue, ...(state.active ? [state.active] : [])]) {
        if (job.item.answerReadState === 'pending') mark(ctx, job, undefined);
        job.controller.abort();
    }
    state.queue = [];
    state.active = null;
    delete ctx.activityAnswers;
}

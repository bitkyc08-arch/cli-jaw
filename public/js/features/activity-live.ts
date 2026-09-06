import type { RuntimeEvent, RuntimeItemStatus } from '../../../src/shared/runtime-contract.js';
import type { ActivityIdentity } from '../../../src/shared/presentation.js';
import { activityKey, createActivityState, type ActivityState } from '../../../src/shared/activity-state.js';
import { ActivityReplay, type ActivityRestoreOptions } from '../../../src/shared/activity-replay.js';
import type { SavedActivityAnswer } from '../../../src/shared/activity-read.js';
import { createActivityChoices, createActivityView, type ActivityChoices } from './activity-view.js';
import { getMessageScope, replaceCachedAnswer } from './idb-cache.js';

/** Legacy host actions are injected so this owner cannot join the renderer SCC. */
export interface ActivityHost {
    currentMessage(): HTMLElement | null;
    useMessage(message: HTMLElement): void;
    createMessage(): HTMLElement;
    reconcileMessage(id: string, update: (message: HTMLElement) => void): boolean;
    replaceAnswer(message: HTMLElement, text: string): void;
    inspectTrace(runId: string, sessionId: string): void;
    closeTrace?(): void;
    evicted?(message: HTMLElement): void;
}
let host: ActivityHost;
export function configureLiveActivityHost(next: ActivityHost): void { host = next; }

export class ActivityCapacityError extends Error {
    constructor() { super('activity_capacity'); }
}
const MAX_TURNS = 16;
type TerminalStatus = Exclude<RuntimeItemStatus, 'running'> | 'finished';
export interface LiveActivityTurn {
    model: ActivityState;
    choices: ActivityChoices;
    message: HTMLElement;
    view: ReturnType<typeof createActivityView>;
    degraded: boolean;
    recordingGap: boolean;
    canonicalTerminal: boolean;
    terminalStatus?: TerminalStatus;
    answerSource?: 'canonical' | 'compatibility' | 'saved' | 'unavailable';
    cacheScope: string;
}
const turns = new Map<string, LiveActivityTurn>();
const choicesByTurn = new Map<string, ActivityChoices>();
const replay = new ActivityReplay(model => {
    const turn = turns.get(activityKey(model.identity));
    if (turn) { turn.model = model; render(turn); }
}, canRelease, releaseRank);
let identity: ActivityIdentity | null = null;
let transportHealthy = true;

function canRelease(model: ActivityState): boolean {
    const message = turns.get(activityKey(model.identity))?.message;
    return !message?.contains(message.ownerDocument.activeElement);
}
function releaseRank(model: ActivityState): number {
    return turns.get(activityKey(model.identity))?.message.isConnected ? 1 : 0;
}

export function setActivityTransportHealthy(healthy: boolean): void {
    transportHealthy = healthy;
    for (const turn of turns.values()) render(turn);
}

export function closeActivityTrace(): void { host.closeTrace?.(); }
export function isCurrentActivityMessage(message: HTMLElement): boolean { return host.currentMessage() === message; }

function releaseTurn(key: string, turn: LiveActivityTurn): void {
    turn.view.dispose();
    delete turn.message.dataset['activityKey']; delete turn.message.dataset['activityLive'];
    turns.delete(key); replay.turns.delete(key);
    host.evicted?.(turn.message);
}

export function clearLiveActivity(): void {
    for (const turn of turns.values()) {
        turn.view.dispose();
        delete turn.message.dataset['activityKey'];
        delete turn.message.dataset['activityLive'];
    }
    turns.clear();
    replay.reset(); choicesByTurn.clear();
    identity = null;
}

export function setLiveActivityIdentity(next: ActivityIdentity | null): void {
    if (identity && next && (identity.sessionId !== next.sessionId || identity.scope !== next.scope)) clearLiveActivity();
    // Retain the last known pair while disconnected, but admission is owned by ws.
    if (next) identity = { ...next };
}

export function findLiveActivity(runId: string): LiveActivityTurn | undefined {
    for (const turn of turns.values()) if (turn.model.identity.runId === runId) return turn;
    return undefined;
}

function render(turn: LiveActivityTurn): void {
    const status = turn.model.end?.status ?? turn.terminalStatus;
    turn.degraded = turn.recordingGap || (!turn.model.end && !turn.canonicalTerminal && !!turn.terminalStatus);
    turn.message.dataset['activityLive'] = status || turn.message.dataset['activitySaved'] === 'true' ? 'false' : 'true';
    turn.view.render(turn.model, { ...(status ? { status } : {}), degraded: turn.degraded,
        connectionUnavailable: !status && (!transportHealthy || turn.model.identity.scope !== identity?.scope) });
}

function makeRoom(): boolean {
    if (turns.size < MAX_TURNS) return true;
    const candidate = [...turns].filter(([, turn]) => (turn.model.end || turn.terminalStatus) && canRelease(turn.model))
        .sort(([, a], [, b]) => releaseRank(a.model) - releaseRank(b.model))[0];
    if (!candidate) return false;
    // Keep full answers and explicit choices; only disposable preview data leaves.
    releaseTurn(candidate[0], candidate[1]); return true;
}

function choicesFor(key: string): ActivityChoices | null {
    const existing = choicesByTurn.get(key);
    if (existing) return existing;
    if (choicesByTurn.size >= 64) {
        const unused = [...choicesByTurn].find(([, value]) => !value.open && value.items.size === 0);
        if (!unused) return null;
        choicesByTurn.delete(unused[0]);
    }
    const choices = createActivityChoices();
    choicesByTurn.set(key, choices);
    return choices;
}

function bindModel(model: ActivityState, message: HTMLElement): LiveActivityTurn | null {
    const key = activityKey(model.identity);
    if (!turns.has(key) && !makeRoom()) return null;
    const choices = choicesFor(key);
    if (!choices) return null;
    message.dataset['activityKey'] = key;
    message.dataset['traceRunId'] = model.identity.runId;
    message.dataset['activitySession'] = model.identity.sessionId;
    message.dataset['messageSessionId'] = model.identity.sessionId;
    const body = message.querySelector<HTMLElement>('.agent-body');
    if (!body) return null;
    message.querySelector('.activity-turn')?.remove();
    const view = createActivityView(body, choices, current => {
        host.inspectTrace(current.identity.runId, current.identity.sessionId);
    });
    const turn: LiveActivityTurn = { model, choices, message, view, degraded: false, recordingGap: false,
        canonicalTerminal: !!model.end, cacheScope: getMessageScope() };
    turns.set(key, turn);
    replay.turns.set(key, model);
    render(turn);
    return turn;
}

/** The caller validates the event and the server-captured session/scope first. */
export function ingestLiveActivity(event: RuntimeEvent, reuseCurrent = true): LiveActivityTurn | null {
    if (!identity || identity.sessionId !== event.sessionId || identity.scope !== event.scope) return null;
    const key = activityKey(event);
    const existingRun = findLiveActivity(event.runId);
    if (existingRun && activityKey(existingRun.model.identity) !== key) return null;
    let turn = turns.get(key);
    if (!turn) {
        const seed = replay.turns.get(key);
        if (seed && (seed.end || event.seq <= seed.seq)) return null;
        if (!choicesFor(key) || !makeRoom()) throw new ActivityCapacityError();
        const current = host.currentMessage();
        const canReuse = reuseCurrent && current?.isConnected
            && (!current.dataset['activityKey'] || current.dataset['activityKey'] === key);
        const message = canReuse ? current : host.createMessage();
        const model = replay.turns.get(key) ?? createActivityState(event);
        turn = bindModel(model, message) ?? undefined;
        if (!turn) return null;
        turn.recordingGap = event.kind !== 'turn-start';
        host.useMessage(message);
    }
    try {
        if (!replay.live(event)) return null;
    } catch (error) {
        if (!turn.recordingGap) console.warn('[activity] live replay unavailable', error);
        turn.recordingGap = true;
    }
    if (event.kind === 'turn-end') { turn.canonicalTerminal = true; turn.terminalStatus = event.status; }
    render(turn);
    return turn;
}

/** Compatibility finality is a view state, never a fabricated journal event. */
export function settleLiveActivity(runId: string | null, status: TerminalStatus = 'finished'): void {
    if (!runId) return;
    replay.markSettled(runId);
    const turn = findLiveActivity(runId);
    if (!turn) return;
    if (!turn.model.end) turn.terminalStatus = status;
    render(turn);
}

/** Compatibility text keeps its original provenance after a canonical-first render. */
export function reconcileLiveActivityAnswer(runId: string, text: string): void {
    const turn = findLiveActivity(runId);
    if (!turn || (turn.answerSource !== 'canonical' && turn.answerSource !== 'unavailable')) return;
    const messageId = turn.message.dataset['messageId'];
    let replaced = false;
    const update = (message: HTMLElement) => {
        if (message.dataset['traceRunId'] !== runId
            || message.dataset['activityKey'] !== activityKey(turn.model.identity)) return;
        rebindLiveActivity(runId, message);
        host.replaceAnswer(message, text);
        replaced = true;
    };
    if (!messageId || !host.reconcileMessage(messageId, update)) update(turn.message);
    if (!replaced) return;
    turn.answerSource = 'compatibility';
    void replaceCachedAnswer(runId, text, turn.cacheScope, turn.model.identity.sessionId);
}

/** Caller has resolved the exact saved MESSAGE and settled any current lifecycle. */
export function reconcileSavedActivityAnswer(message: HTMLElement, saved: SavedActivityAnswer, cacheScope: string): boolean {
    if (host.currentMessage() === message) return false;
    const runId = saved.trace_run_id;
    let replaced = false;
    const update = (target: HTMLElement) => {
        if (target.dataset['traceRunId'] !== runId || target.dataset['messageSessionId'] !== saved.session_id
            || (target.dataset['serverMessageId'] && target.dataset['serverMessageId'] !== String(saved.id))) return;
        rebindLiveActivity(runId, target);
        host.replaceAnswer(target, saved.content);
        target.dataset['serverMessageId'] = String(saved.id); target.dataset['activitySaved'] = 'true';
        const turn = findLiveActivity(runId);
        if (turn?.message === target) { turn.answerSource = 'saved'; render(turn); }
        replaced = true;
    };
    const messageId = message.dataset['messageId'];
    if (!messageId || !host.reconcileMessage(messageId, update)) update(message);
    if (replaced) void replaceCachedAnswer(runId, saved.content, cacheScope, saved.session_id, saved.id);
    return replaced;
}

export function degradeLiveActivity(runId: string): void {
    const turn = findLiveActivity(runId);
    if (turn) { turn.recordingGap = true; render(turn); }
}

export function rebindLiveActivity(runId: string, message: HTMLElement): void {
    const turn = findLiveActivity(runId);
    if (!turn || (turn.message === message && message.contains(turn.view.element))) return;
    turn.view.dispose();
    message.querySelector('.activity-turn')?.remove();
    const body = message.querySelector<HTMLElement>('.agent-body');
    if (!body) return;
    message.dataset['activityKey'] = activityKey(turn.model.identity);
    message.dataset['traceRunId'] = runId;
    message.dataset['activitySession'] = turn.model.identity.sessionId;
    message.dataset['messageSessionId'] = turn.model.identity.sessionId;
    turn.message = message;
    turn.view = createActivityView(body, turn.choices, model => {
        host.inspectTrace(runId, model.identity.sessionId);
    });
    render(turn);
}

export async function restoreLiveActivity(read: (signal: AbortSignal) => Promise<readonly RuntimeEvent[]>, options?: ActivityRestoreOptions): Promise<void> {
    try { await replay.restore(read, options); }
    finally { for (const [key, turn] of turns) if (!replay.turns.has(key)) releaseTurn(key, turn); }
}

export function mountHistoryActivity(message: HTMLElement, runId: string): LiveActivityTurn | null {
    const existing = findLiveActivity(runId);
    if (existing) { rebindLiveActivity(runId, message); return existing; }
    const model = [...replay.turns.values()].find(value => value.identity.runId === runId);
    return model ? bindModel(model, message) : null;
}

export function recycleActivityHost(message: HTMLElement): void {
    const turn = turns.get(message.dataset['activityKey'] ?? '');
    if (turn?.message === message) turn.view.dispose();
}

export function setActivityReadHealth(runId: string, incomplete: boolean): void {
    const turn = findLiveActivity(runId);
    if (turn) { turn.recordingGap = incomplete; render(turn); }
}

/** Virtual scroll recreates DOM; reconnect retained disclosure choices to its rows. */
export function remountLiveActivity(root: ParentNode): void {
    for (const message of root.querySelectorAll<HTMLElement>('.msg-agent[data-activity-key], .activity-recorded-run[data-activity-key]')) {
        // Transcript markup is not a host registry. A copied key inside an
        // answer must never transfer the retained view away from its real row.
        if (message.parentElement?.closest('.msg-agent, .activity-recorded-run')) continue;
        const turn = turns.get(message.dataset['activityKey']!);
        if (!turn) {
            message.querySelector('.activity-turn')?.remove();
            delete message.dataset['activityKey'];
            delete message.dataset['activityLive'];
            continue;
        }
        if (message.dataset['traceRunId'] !== turn.model.identity.runId
            || message.dataset['messageSessionId'] !== turn.model.identity.sessionId
            || message.dataset['messageId'] !== turn.message.dataset['messageId']) continue;
        rebindLiveActivity(turn.model.identity.runId, message);
    }
}

import type { RuntimeEvent, RuntimeItemStatus } from '../../../src/shared/runtime-contract.js';
import type { ActivityIdentity } from '../../../src/shared/presentation.js';
import { activityKey, createActivityState, type ActivityState } from '../../../src/shared/activity-state.js';
import { ActivityReplay } from '../../../src/shared/activity-replay.js';
import { createActivityChoices, createActivityView, type ActivityChoices } from './activity-view.js';
import { addMessage } from './chat-messages.js';
import { state } from '../state.js';
import { replaceAgentAnswer } from '../ui.js';
import { getVirtualScroll } from '../virtual-scroll.js';
import { getMessageScope, replaceCachedAnswer } from './idb-cache.js';

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
    answerSource?: 'canonical' | 'compatibility';
    cacheScope: string;
}
const turns = new Map<string, LiveActivityTurn>();
const choicesByTurn = new Map<string, ActivityChoices>();
const replay = new ActivityReplay(model => {
    const turn = turns.get(activityKey(model.identity));
    if (turn) { turn.model = model; render(turn); }
});
let identity: ActivityIdentity | null = null;

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
    turn.message.dataset['activityLive'] = status ? 'false' : 'true';
    turn.view.render(turn.model, { ...(status ? { status } : {}), degraded: turn.degraded });
}

function makeRoom(): boolean {
    if (turns.size < MAX_TURNS) return true;
    for (const [key, turn] of turns) {
        if (!turn.model.end && !turn.terminalStatus) continue;
        // Keep the final answer; only this disposable Activity projection is removed.
        turn.view.dispose();
        delete turn.message.dataset['activityKey'];
        delete turn.message.dataset['activityLive'];
        turns.delete(key);
        replay.turns.delete(key);
        return true;
    }
    return false;
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
    const body = message.querySelector<HTMLElement>('.agent-body');
    if (!body) return null;
    message.querySelector('.activity-turn')?.remove();
    const view = createActivityView(body, choices, current => {
        void import('./trace-drawer.js').then(m => m.openTraceDrawer(current.identity.runId, undefined, current.identity.sessionId))
            .catch(error => console.warn('[activity] trace unavailable', error));
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
    let turn = turns.get(key);
    if (!turn) {
        if (!choicesFor(key)) return null;
        if (!makeRoom()) return null;
        const current = state.currentAgentDiv;
        const canReuse = reuseCurrent && current?.isConnected
            && (!current.dataset['activityKey'] || current.dataset['activityKey'] === key);
        const message = canReuse ? current : addMessage('agent', '');
        const model = replay.turns.get(key) ?? createActivityState(event);
        turn = bindModel(model, message) ?? undefined;
        if (!turn) return null;
        state.currentAgentDiv = message;
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
    if (!turn || turn.answerSource !== 'canonical') return;
    const messageId = turn.message.dataset['messageId'];
    let replaced = false;
    const update = (message: HTMLElement) => {
        if (message.dataset['traceRunId'] !== runId
            || message.dataset['activityKey'] !== activityKey(turn.model.identity)) return;
        rebindLiveActivity(runId, message);
        replaceAgentAnswer(message, text);
        replaced = true;
    };
    if (!messageId || !getVirtualScroll().reconcileMessage(messageId, update)) update(turn.message);
    if (!replaced) return;
    turn.answerSource = 'compatibility';
    void replaceCachedAnswer(runId, text, turn.cacheScope);
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
    turn.message = message;
    turn.view = createActivityView(body, turn.choices, model => {
        void import('./trace-drawer.js').then(m => m.openTraceDrawer(runId, undefined, model.identity.sessionId))
            .catch(error => console.warn('[activity] trace unavailable', error));
    });
    render(turn);
}

export async function restoreLiveActivity(read: (signal: AbortSignal) => Promise<readonly RuntimeEvent[]>): Promise<void> {
    await replay.restore(read);
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
    for (const message of root.querySelectorAll<HTMLElement>('.msg-agent[data-activity-key]')) {
        const turn = turns.get(message.dataset['activityKey']!);
        if (!turn) {
            message.querySelector('.activity-turn')?.remove();
            delete message.dataset['activityKey'];
            delete message.dataset['activityLive'];
            continue;
        }
        rebindLiveActivity(turn.model.identity.runId, message);
    }
}

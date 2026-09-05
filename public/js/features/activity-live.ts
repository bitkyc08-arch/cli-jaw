import type { RuntimeEvent, RuntimeItemStatus } from '../../../src/shared/runtime-contract.js';
import type { ActivityIdentity } from '../../../src/shared/presentation.js';
import { activityKey, applyActivityEvent, createActivityState, type ActivityState } from '../../../src/shared/activity-state.js';
import { createActivityChoices, createActivityView, type ActivityChoices } from './activity-view.js';
import { addMessage } from './chat-messages.js';
import { state } from '../state.js';

const MAX_TURNS = 16;
type TerminalStatus = Exclude<RuntimeItemStatus, 'running'>;
export interface LiveActivityTurn {
    model: ActivityState;
    choices: ActivityChoices;
    message: HTMLElement;
    view: ReturnType<typeof createActivityView>;
    degraded: boolean;
    recordingGap: boolean;
    terminalStatus?: TerminalStatus;
}
const turns = new Map<string, LiveActivityTurn>();
let identity: ActivityIdentity | null = null;

export function clearLiveActivity(): void {
    for (const turn of turns.values()) {
        turn.view.dispose();
        delete turn.message.dataset['activityKey'];
        delete turn.message.dataset['activityLive'];
    }
    turns.clear();
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
    turn.degraded = turn.recordingGap || (!turn.model.end && !!turn.terminalStatus);
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
        return true;
    }
    return false;
}

/** The caller validates the event and the server-captured session/scope first. */
export function ingestLiveActivity(event: RuntimeEvent, reuseCurrent = true): LiveActivityTurn | null {
    if (!identity || identity.sessionId !== event.sessionId || identity.scope !== event.scope) return null;
    const key = activityKey(event);
    let turn = turns.get(key);
    if (!turn) {
        if (!makeRoom()) return null;
        const current = state.currentAgentDiv;
        const canReuse = reuseCurrent && current?.isConnected
            && (!current.dataset['activityKey'] || current.dataset['activityKey'] === key);
        const message = canReuse ? current : addMessage('agent', '');
        message.dataset['activityKey'] = key;
        message.dataset['traceRunId'] = event.runId;
        message.dataset['activitySession'] = event.sessionId;
        const body = message.querySelector<HTMLElement>('.agent-body')!;
        const model = createActivityState(event);
        const choices = createActivityChoices();
        const view = createActivityView(body, choices);
        turn = { model, choices, message, view, degraded: false, recordingGap: false };
        turns.set(key, turn);
        state.currentAgentDiv = message;
    }
    if (!applyActivityEvent(turn.model, event)) return null;
    render(turn);
    return turn;
}

/** Compatibility finality is a view state, never a fabricated journal event. */
export function settleLiveActivity(runId: string | null, status: TerminalStatus = 'done'): void {
    if (!runId) return;
    const turn = findLiveActivity(runId);
    if (!turn) return;
    if (!turn.model.end) turn.terminalStatus = status;
    render(turn);
}

export function degradeLiveActivity(runId: string): void {
    const turn = findLiveActivity(runId);
    if (turn) { turn.recordingGap = true; render(turn); }
}

export function rebindLiveActivity(runId: string, message: HTMLElement): void {
    const turn = findLiveActivity(runId);
    if (!turn || turn.message === message) return;
    turn.view.dispose();
    message.querySelector('.activity-turn')?.remove();
    const body = message.querySelector<HTMLElement>('.agent-body');
    if (!body) return;
    message.dataset['activityKey'] = activityKey(turn.model.identity);
    message.dataset['traceRunId'] = runId;
    message.dataset['activitySession'] = turn.model.identity.sessionId;
    turn.message = message;
    turn.view = createActivityView(body, turn.choices);
    render(turn);
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

import type { ActivityIdentity } from '../../../src/shared/presentation.js';
import type { RuntimeRequestView } from '../../../src/shared/runtime-contract.js';
import { parseRuntimeRequestView } from '../../../src/shared/runtime-event-parse.js';
import { BoundedApiError, requestBoundedJson } from '../bounded-api.js';

type Pending = ActivityIdentity & {
    runId: string; turnId: string; requestId: string;
    requestType: 'approval' | 'question'; view: RuntimeRequestView; expiresAt: number;
};
type Answer = { selected: string[]; text?: string };
type ResponseValue = { optionId: string | null } | { answers: Record<string, Answer> };
const LIST_BYTES = 6 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 240;

function decode(value: Record<string, unknown>): Pending | null {
    const { runId, sessionId, scope, turnId, requestId, requestType, expiresAt } = value;
    if (!id(runId) || !id(sessionId) || !id(scope) || !id(turnId) || !id(requestId)
        || (requestType !== 'approval' && requestType !== 'question')
        || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) return null;
    const view = parseRuntimeRequestView(value['view']);
    return view ? { runId, sessionId, scope, turnId, requestId, requestType, expiresAt, view } : null;
}

/** Expiry may be refreshed without replacing a still-identical form or its draft. */
function key(item: Pending): string {
    return JSON.stringify([item.runId, item.sessionId, item.scope, item.turnId, item.requestId, item.requestType, item.view]);
}

function canAnswer(item: Pending): boolean {
    const fields = item.view.fields;
    return fields.length > 0 && (item.requestType === 'approval'
        ? fields.length === 1 && !fields[0]!.multiSelect && !fields[0]!.allowFreeform && fields[0]!.options.length > 0
        : fields.every(field => field.options.length > 0 || field.allowFreeform));
}

export function mountNativeRequests(host: HTMLElement, identity: ActivityIdentity): { refresh(): Promise<void>; suspend(): void; dispose(): void } {
    const captured = { ...identity };
    const doc = host.ownerDocument;
    const root = doc.createElement('section'); root.className = 'native-requests'; root.hidden = true;
    root.setAttribute('aria-label', 'Live runtime requests');
    const status = doc.createElement('p'); status.className = 'native-request-status';
    const announcer = doc.createElement('p'); announcer.className = 'native-request-announcer';
    announcer.setAttribute('role', 'status'); announcer.setAttribute('aria-live', 'polite'); announcer.setAttribute('aria-atomic', 'true');
    const title = doc.createElement('h2'); title.className = 'native-request-title';
    const controls = doc.createElement('div'); controls.className = 'native-request-controls';
    const retry = button('Refresh requests', () => { void refresh(); });
    root.append(title, status, controls, retry);
    const input = [...host.children].find(child => child.classList.contains('chat-input-area'));
    host.insertBefore(announcer, input ?? null);
    host.insertBefore(root, input ?? null);

    let selected: Pending | null = null;
    let getController: AbortController | null = null;
    let postController: AbortController | null = null;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0, revision = 0;
    let disposed = false, fresh = false, sending = false, suspended = false;
    let focusEpoch = 0, postFocus: number | null = null, pendingFocus: number | null = null;
    let windowBlurred = false;
    let lastOutcome: string | null = null;
    const view = doc.defaultView;
    const windowBlur = () => { windowBlurred = true; ++focusEpoch; pendingFocus = null; };
    const windowFocus = () => { windowBlurred = false; };
    const trackFocus = (event: FocusEvent) => {
        if (!root.contains(event.target as Node)) { ++focusEpoch; pendingFocus = null; }
    };
    doc.addEventListener('focusin', trackFocus);
    view?.addEventListener('blur', windowBlur);
    view?.addEventListener('focus', windowFocus);

    function captureFocus(): number | null {
        if (windowBlurred) return null;
        if (root.contains(doc.activeElement)) return focusEpoch;
        // Disabling a submitting field can blur it to body without a focusin event.
        return sending && doc.activeElement === doc.body ? postFocus : null;
    }
    function restoreFocus(final = true): void {
        if (pendingFocus === null) return;
        if (windowBlurred || pendingFocus !== focusEpoch) { pendingFocus = null; return; }
        const target = root.isConnected && !root.hidden
            ? controls.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), button:not(:disabled)[aria-disabled="false"]') ?? retry
            : host.querySelector<HTMLElement>('#chatInput') ?? doc.getElementById('chatInput');
        if (target?.isConnected && !target.hasAttribute('disabled')) target.focus({ preventScroll: true });
        if (final && !sending) pendingFocus = null;
    }

    function button(label: string, act: () => void): HTMLButtonElement {
        const node = doc.createElement('button'); node.type = 'button'; node.textContent = label;
        node.addEventListener('click', act); return node;
    }
    function announce(message: string, outcome = false): void {
        if (outcome) lastOutcome = message;
        if (status.textContent !== message) status.textContent = message;
        const spoken = message === 'No pending runtime requests.' ? lastOutcome ?? message : message;
        if (announcer.textContent !== spoken) announcer.textContent = spoken;
    }
    function lock(): void {
        // Do not blur the focused control during a routine GET. Response handlers
        // enforce freshness even when that control remains keyboard-focusable.
        controls.querySelectorAll('button').forEach(node => {
            const blocked = suspended || sending || !fresh;
            node.disabled = suspended || sending || (!fresh && doc.activeElement !== node);
            node.setAttribute('aria-disabled', String(blocked));
        });
        controls.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea').forEach(node => {
            node.disabled = sending;
        });
        root.setAttribute('aria-busy', String(sending));
    }
    function clear(focus = captureFocus()): void {
        pendingFocus = focus;
        clearTimeout(expiryTimer); expiryTimer = undefined;
        selected = null; fresh = false; revision++;
        title.textContent = ''; controls.replaceChildren();
        // Keep focus on the mounted refresh control while the next GET is pending.
        restoreFocus(false);
    }
    function armExpiry(): void {
        clearTimeout(expiryTimer);
        if (!selected || suspended) return;
        expiryTimer = setTimeout(() => {
            if (disposed) return;
            if (selected && selected.expiresAt > Date.now()) { armExpiry(); return; }
            clear(); announce('Request expired. Checking pending requests.', true);
            void refresh();
        }, Math.min(2_147_483_647, Math.max(0, selected.expiresAt - Date.now())));
    }

    function render(item: Pending): void {
        title.textContent = item.view.title;
        const fields = item.view.fields;
        if (!canAnswer(item)) return;
        const formRevision = revision;
        const send = (value: ResponseValue) => { if (revision === formRevision) void respond(value); };
        const form = doc.createElement('form'); form.noValidate = true;
        const inputs: Array<{ field: RuntimeRequestView['fields'][number]; choices: Array<{ id: string; input: HTMLInputElement }>; text: HTMLTextAreaElement | null }> = [];
        for (const [index, field] of fields.entries()) {
            const group = doc.createElement('fieldset');
            const legend = doc.createElement('legend'); legend.textContent = field.label; group.append(legend);
            const choices: Array<{ id: string; input: HTMLInputElement }> = [];
            for (const option of field.options) {
                if (item.requestType === 'approval') {
                    group.append(button(option.label, () => send({ optionId: option.id })));
                } else {
                    const label = doc.createElement('label');
                    const choice = doc.createElement('input'); choice.type = field.multiSelect ? 'checkbox' : 'radio';
                    choice.name = `native-question-${index}`; choice.value = option.id;
                    label.append(choice, doc.createTextNode(option.label)); group.append(label);
                    choices.push({ id: option.id, input: choice });
                }
            }
            let text: HTMLTextAreaElement | null = null;
            if (item.requestType === 'question' && field.allowFreeform) {
                if (!field.multiSelect && choices.length) group.append(button('Clear selection', () => {
                    choices.forEach(choice => { choice.input.checked = false; });
                }));
                const label = doc.createElement('label'); label.append(doc.createTextNode('Other answer'));
                text = doc.createElement('textarea'); text.maxLength = 2000; label.append(text); group.append(label);
            }
            if (item.requestType === 'question') {
                const hint = doc.createElement('p');
                hint.textContent = field.multiSelect ? 'Choose at least one answer.' : 'Choose exactly one answer.';
                group.append(hint);
            }
            inputs.push({ field, choices, text }); form.append(group);
        }
        if (item.requestType === 'question') {
            const submit = doc.createElement('button'); submit.type = 'submit'; submit.textContent = 'Submit answers'; form.append(submit);
        }
        form.addEventListener('submit', event => {
            event.preventDefault();
            if (item.requestType !== 'question' || disposed || suspended || sending || !fresh || revision !== formRevision) return;
            let total = 0;
            const answers: Array<[string, Answer]> = [];
            for (const { field, choices, text } of inputs) {
                const selectedIds = choices.filter(choice => choice.input.checked).map(choice => choice.id);
                const value = text?.value ?? '';
                const hasText = value.length > 0;
                const count = selectedIds.length + (hasText && value.trim() ? 1 : 0);
                if ((hasText && (!field.allowFreeform || !value.trim() || value.length > 2000))
                    || (field.multiSelect ? count < 1 || selectedIds.length > field.options.length : count !== 1)) {
                    announce('Answer every question. Choose one answer for single-choice questions; other answers must be nonblank and at most 2,000 characters.');
                    return;
                }
                total += value.length;
                answers.push([field.id, { selected: selectedIds, ...(hasText ? { text: value } : {}) }]);
            }
            if (total > 8000) { announce('Keep all other answers within 8,000 characters in total.'); return; }
            send({ answers: Object.fromEntries(answers) });
        });
        form.append(button('Cancel request', () => send({ optionId: null })));
        controls.append(form);
    }

    async function respond(response: ResponseValue): Promise<void> {
        const item = selected;
        if (disposed || suspended || sending || !fresh || !item) return;
        if (item.expiresAt <= Date.now()) { clear(); announce('Request expired.', true); await refresh(); return; }
        postFocus = captureFocus();
        const responseFocus = postFocus;
        sending = true; fresh = false;
        const ownRevision = revision;
        ++generation; getController?.abort();
        const controller = new AbortController(); postController = controller;
        lastOutcome = null;
        lock(); announce('Sending response.');
        let outcome = 'optionId' in response && response.optionId === null ? 'Request cancelled.' : 'Response accepted.';
        let accepted = false;
        try {
            const raw = await requestBoundedJson('/api/runtime/requests/' + encodeURIComponent(item.requestId), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ runId: item.runId, sessionId: item.sessionId, scope: item.scope, turnId: item.turnId, response }),
            }, controller.signal, 64 * 1024);
            if (!record(raw) || raw['ok'] !== true || !record(raw['data']) || raw['data']['accepted'] !== true) throw new Error('unconfirmed');
            accepted = true;
        } catch (error) {
            outcome = error instanceof BoundedApiError && error.status === 409
                ? 'Request expired or was already answered. Pending requests refreshed.'
                : 'Response could not be confirmed. Check pending requests before trying again.';
        } finally {
            if (postController === controller) postController = null;
            sending = false;
        }
        if (disposed) return;
        // The write may already have reached the server. Keep the suspended draft
        // inert until an explicit reconnect/retry GET verifies what is pending.
        if (suspended) { lock(); return; }
        if (revision !== ownRevision) { lock(); restoreFocus(); return; }
        if (accepted) clear(responseFocus);
        else fresh = false;
        announce(outcome, true);
        const refreshGeneration = generation + 1;
        await refresh();
        if (!disposed && !suspended && generation === refreshGeneration && !accepted && selected && key(selected) === key(item)) announce(outcome);
    }

    async function refresh(): Promise<void> {
        if (disposed) return;
        const gen = ++generation;
        getController?.abort();
        const controller = new AbortController(); getController = controller;
        fresh = false; lock();
        try {
            if (!id(captured.sessionId) || !id(captured.scope)) throw new Error('invalid_identity');
            const raw = await requestBoundedJson('/api/runtime/requests?sessionId=' + encodeURIComponent(captured.sessionId),
                { method: 'GET' }, controller.signal, LIST_BYTES);
            if (disposed || gen !== generation || controller.signal.aborted) return;
            if (!record(raw) || raw['ok'] !== true || !record(raw['data'])) throw new Error('invalid_list');
            const list = raw['data']['requests'];
            if (!Array.isArray(list) || list.length > 128) throw new Error('invalid_list');
            const seen = new Set<string>();
            let first: Pending | null = null, retained: Pending | null = null, unavailable = false;
            for (const value of list) {
                if (!record(value)) { unavailable = true; continue; }
                if (id(value['requestId'])) {
                    if (seen.has(value['requestId'])) throw new Error('duplicate_request');
                    seen.add(value['requestId']);
                }
                if (value['sessionId'] !== captured.sessionId || value['scope'] !== captured.scope) continue;
                const item = decode(value);
                if (!item) { unavailable = true; continue; }
                if (item.expiresAt <= Date.now()) continue;
                first ??= item;
                if (selected && key(selected) === key(item)) retained = item;
            }
            const next = retained ?? first;
            if (selected && !retained) announce(selected.expiresAt <= Date.now()
                ? 'Request expired.' : 'Request is no longer pending.', true);
            if (!retained) clear();
            selected = next; fresh = true; suspended = false;
            root.hidden = !selected && !unavailable;
            if (selected) {
                announce(canAnswer(selected) ? (lastOutcome ? lastOutcome + ' ' : '') + 'Runtime is waiting for your response.'
                    : 'This request cannot be answered here. Refresh requests or use Stop.');
                if (!retained) render(selected);
                armExpiry();
            } else if (unavailable) announce('This request cannot be displayed safely. Refresh requests or use Stop.');
            else announce('No pending runtime requests.');
            lock(); restoreFocus();
        } catch {
            if (disposed || gen !== generation || controller.signal.aborted) return;
            if (!suspended) clear();
            root.hidden = false; lock();
            announce('Pending requests could not be loaded. Refresh requests to retry.');
        } finally {
            if (getController === controller) getController = null;
        }
    }

    void refresh();
    return { refresh, suspend() {
        if (disposed) return;
        suspended = true; fresh = false; ++generation;
        getController?.abort(); getController = null;
        clearTimeout(expiryTimer); expiryTimer = undefined;
        lock(); announce('Connection lost. Your draft is kept. Refresh requests after reconnecting.');
    }, dispose() {
        if (disposed) return;
        disposed = true; ++generation; getController?.abort(); postController?.abort();
        clear(); root.remove(); announcer.remove(); restoreFocus();
        doc.removeEventListener('focusin', trackFocus);
        view?.removeEventListener('blur', windowBlur);
        view?.removeEventListener('focus', windowFocus);
    } };
}

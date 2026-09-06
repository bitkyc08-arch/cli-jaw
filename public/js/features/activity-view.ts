import {
    activityEntryLabel, activityEntryText, activityStatus, type ActivityState,
} from '../../../src/shared/activity-state.js';
import type { RuntimeItemStatus } from '../../../src/shared/runtime-contract.js';

export interface ActivityChoices {
    open: boolean;
    items: Map<string, boolean>;
    page: number | null;
}

const MAX_CHOICES = 128;
const PAGE_SIZE = 40;
const PREVIEW_CHARS = 3000;

export const createActivityChoices = (): ActivityChoices => ({ open: false, items: new Map(), page: null });

export function rememberActivityChoice(choices: ActivityChoices, id: string, open: boolean): boolean {
    // Closed is the default; saturation never evicts an existing explicit choice.
    if (!open) { choices.items.delete(id); return true; }
    if (!choices.items.has(id) && choices.items.size >= MAX_CHOICES) return false;
    choices.items.set(id, true);
    return true;
}

export interface ActivityDisplayStatus {
    status?: RuntimeItemStatus | 'finished';
    degraded?: boolean;
}

export function createActivityView(
    host: HTMLElement,
    choices: ActivityChoices,
    inspectHistory?: (state: ActivityState) => void,
) {
    const doc = host.ownerDocument;
    function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string) {
        const node = doc.createElement(tag);
        node.className = className;
        return node;
    }
    function button(label: string, className: string) {
        const node = element('button', className);
        node.type = 'button';
        node.textContent = label;
        return node;
    }
    function text(node: HTMLElement, value: string): void {
        if (node.textContent !== value) node.textContent = value;
    }

    const root = element('section', 'activity-turn');
    root.setAttribute('aria-label', 'Turn activity');
    const status = element('p', 'activity-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    const disclosure = element('details', 'activity-disclosure');
    const summary = element('summary', 'activity-summary');
    const list = element('div', 'activity-list');
    const empty = element('p', 'activity-empty');
    empty.textContent = 'No activity recorded';
    const nav = element('nav', 'activity-pages');
    nav.setAttribute('aria-label', 'Activity pages');
    const previous = button('Earlier activity', 'activity-previous');
    const next = button('Later activity', 'activity-next');
    const position = element('span', 'activity-page-position');
    nav.append(previous, position, next);
    disclosure.append(summary, empty, list, nav);
    const error = element('p', 'activity-error');
    const degraded = element('p', 'activity-degraded');
    const omitted = element('p', 'activity-omitted');
    const choiceNotice = element('p', 'activity-choice-notice');
    choiceNotice.setAttribute('role', 'status');
    const requests = element('p', 'activity-requests');
    for (const notice of [error, degraded, omitted, choiceNotice, requests]) notice.hidden = true;
    root.append(status, error, disclosure, degraded, omitted, choiceNotice, requests);
    const historyButton = inspectHistory ? button('Inspect retained activity', 'activity-trace') : null;
    if (historyButton) {
        historyButton.setAttribute('aria-label', 'Inspect retained activity in Trace');
        root.append(historyButton);
    }
    // The existing message and its copy/widget actions retain full answer ownership.
    host.insertBefore(root, host.querySelector(':scope > .msg-content'));

    let current: ActivityState | null = null;
    let display: ActivityDisplayStatus = {};
    let displayedPage = 0;
    let disposed = false;
    let choicesFull = false;
    const nodes = new Map<string, HTMLDetailsElement>();

    function updateChoiceNotice(): void {
        choiceNotice.hidden = !choicesFull;
        text(choiceNotice, choicesFull
            ? '128 details are remembered open. Close one before opening another; existing choices are preserved.' : '');
    }
    function saveItem(id: string, node: HTMLDetailsElement): void {
        if (disposed || nodes.get(id) !== node || node.open === (choices.items.get(id) === true)) return;
        if (!rememberActivityChoice(choices, id, node.open)) {
            node.open = false;
            choicesFull = true;
        } else {
            choicesFull = false;
            if (node.open && choices.page === null) choices.page = displayedPage;
        }
        updateChoiceNotice();
    }
    function saveChoices(): void {
        // Native toggle is queued. Capture synchronous open changes before recycle/end.
        choices.open = disclosure.open;
        for (const [id, node] of nodes) saveItem(id, node);
    }

    disclosure.open = choices.open;
    disclosure.ontoggle = () => { if (!disposed) choices.open = disclosure.open; };
    if (historyButton) historyButton.onclick = () => { if (current && !disposed) inspectHistory?.(current); };
    function changePage(offset: number, clicked: HTMLButtonElement, opposite: HTMLButtonElement): void {
        if (!current || disposed) return;
        saveChoices();
        const last = Math.max(0, Math.ceil(current.entries.size / PAGE_SIZE) - 1);
        choices.page = Math.max(0, Math.min(last, displayedPage + offset));
        render(current, display);
        const target = nav.hidden || !disclosure.open ? summary
            : !clicked.disabled ? clicked : !opposite.disabled ? opposite : summary;
        target.focus({ preventScroll: true });
    }
    previous.onclick = () => changePage(-1, previous, next);
    next.onclick = () => changePage(1, next, previous);

    function render(model: ActivityState, displayStatus: ActivityDisplayStatus = {}): void {
        if (disposed) return;
        saveChoices();
        current = model;
        display = { ...displayStatus };
        const phase = display.status ?? activityStatus(model);
        root.dataset['status'] = phase;
        root.dataset['degraded'] = String(display.degraded === true);
        const label = phase === 'running' ? 'Working' : phase === 'finished' ? 'Finished' : phase === 'done' ? 'Complete'
            : phase === 'stopped' ? 'Stopped' : 'Failed';
        text(status, label);
        const errorSummary = phase === 'error' && model.end?.status === 'error' ? model.end.error ?? '' : '';
        text(error, errorSummary);
        error.hidden = !errorSummary;
        const count = `${model.entries.size} retained preview${model.entries.size === 1 ? '' : 's'}`;
        text(summary, model.latestAction ? `Activity: ${model.latestAction} (${count})` : `Activity (${count})`);
        text(degraded, display.degraded ? 'Activity is incomplete. Some runtime updates were not received.' : '');
        degraded.hidden = !display.degraded;
        const loss = model.omitted;
        const entries = [...model.entries.values()];
        const limited = !!(loss.entries || loss.textChars || loss.requests || loss.finalChars)
            || entries.some(entry => activityEntryText(entry).length > PREVIEW_CHARS);
        text(omitted, limited
            ? 'Preview is limited. Some activity, text or request notices are omitted.' : '');
        omitted.hidden = !limited;
        const hasRequests = !!(model.requests.size || loss.requests);
        text(requests, hasRequests ? 'Request notices recorded; see live Requests controls for current requests.' : '');
        requests.hidden = !hasRequests;

        const last = Math.max(0, Math.ceil(entries.length / PAGE_SIZE) - 1);
        displayedPage = choices.page === null ? last : Math.max(0, Math.min(last, Math.floor(choices.page)));
        const visible = entries.slice(displayedPage * PAGE_SIZE, (displayedPage + 1) * PAGE_SIZE);
        const wanted = new Set(visible.map(entry => entry.itemId));
        const focused = doc.activeElement;
        let focusedRowRemoved = false;
        for (const [id, node] of nodes) {
            if (!wanted.has(id)) {
                if (node.contains(focused)) focusedRowRemoved = true;
                node.ontoggle = null;
                node.remove();
                nodes.delete(id);
            }
        }
        for (const [index, entry] of visible.entries()) {
            let node = nodes.get(entry.itemId);
            if (!node) {
                node = element('details', 'activity-item');
                node.dataset['activityItemId'] = entry.itemId;
                node.append(element('summary', 'activity-item-summary'), element('pre', 'activity-item-text'));
                node.open = choices.items.get(entry.itemId) === true;
                const itemNode = node;
                node.ontoggle = () => saveItem(entry.itemId, itemNode);
                nodes.set(entry.itemId, node);
            }
            text(node.querySelector('summary')!, activityEntryLabel(entry));
            const full = activityEntryText(entry);
            text(node.querySelector('pre')!, full.length > PREVIEW_CHARS
                ? `${full.slice(0, PREVIEW_CHARS)}\n[Preview limited; some text is omitted]` : full);
            // Leave existing nodes in place so streamed replacements preserve focus.
            if (list.children[index] !== node) list.insertBefore(node, list.children[index] ?? null);
        }
        empty.hidden = entries.length !== 0;
        previous.disabled = displayedPage === 0;
        next.disabled = displayedPage >= last;
        text(position, entries.length ? `${displayedPage + 1} / ${last + 1}` : '0 / 0');
        nav.hidden = entries.length <= PAGE_SIZE;
        updateChoiceNotice();
        if (focusedRowRemoved) summary.focus({ preventScroll: true });
    }

    function dispose(): void {
        if (disposed) return;
        saveChoices();
        disposed = true;
        disclosure.ontoggle = null;
        previous.onclick = next.onclick = null;
        if (historyButton) historyButton.onclick = null;
        for (const node of nodes.values()) node.ontoggle = null;
        nodes.clear();
        current = null;
        root.remove();
    }
    return { element: root, render, dispose };
}

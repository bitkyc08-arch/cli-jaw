import type { ActivityIdentity } from '../../../src/shared/presentation.js';
import { readActivityRuns, type ActivityRunSummary } from '../../../src/shared/activity-read.js';
import { readActivityHttp } from './activity-http.js';

interface DiscoveryActions {
    root(): HTMLElement | null;
    inspect(root: HTMLElement): void;
    recycle(root: HTMLElement): void;
    mutate(anchor: HTMLElement, action: () => void): void;
}

/** Extra records are not necessarily orphans or chronological history. */
export function createActivityDiscovery(actions: DiscoveryActions) {
    let identity: ActivityIdentity | null = null;
    let loadedSession: string | null = null;
    let loaded = new Set<string>();
    let rows: ActivityRunSummary[] = [];
    let page = 0, generation = 0;
    let after = '', nextAfter: string | undefined;
    let incomplete = false, enabled = true, open = false;
    let controller: AbortController | null = null;
    let root: HTMLDetailsElement | null = null;
    const messages = new Map<string, HTMLElement>();

    function clearRows(): void {
        for (const message of messages.values()) { actions.recycle(message); message.remove(); }
        messages.clear();
    }
    function ensureRoot(): HTMLDetailsElement | null {
        const chat = actions.root(); if (!chat) return null;
        if (root?.isConnected) return root;
        if (root) { open = root.open; clearRows(); root.remove(); }
        root = document.createElement('details'); root.className = 'activity-discovery'; root.id = 'activityDiscovery';
        root.open = open;
        const summary = document.createElement('summary'); summary.textContent = 'Recorded runs outside the loaded transcript';
        const status = document.createElement('p'); status.className = 'activity-discovery-status'; status.setAttribute('role', 'status');
        const list = document.createElement('div'); list.className = 'activity-discovery-runs';
        const nav = document.createElement('nav'); nav.setAttribute('aria-label', 'Other recorded runs');
        const button = (text: string, action: string, click: () => void) => {
            const element = document.createElement('button'); element.type = 'button'; element.textContent = text;
            element.dataset['discoveryAction'] = action; element.onclick = click; return element;
        };
        const move = (delta: number) => {
            page = Math.max(0, Math.min(Math.max(0, Math.ceil(rows.length / 16) - 1), page + delta)); render();
        };
        nav.append(button('Previous page', 'previous', () => move(-1)), button('Next page', 'next', () => move(1)),
            button('Next record window', 'window', () => { if (nextAfter) void refresh(nextAfter); }),
            button('Refresh recorded runs', 'refresh', () => { void refresh(); }));
        root.append(summary, status, list, nav);
        root.ontoggle = () => {
            if (!root) return;
            open = root.open;
            if (root.open) actions.inspect(root);
            else for (const message of messages.values()) actions.recycle(message);
        };
        chat.append(root); return root;
    }

    function render(): void {
        const panel = ensureRoot(); if (!panel) return;
        actions.mutate(panel, () => {
            panel.hidden = rows.length === 0 && !incomplete;
            const last = Math.max(0, Math.ceil(rows.length / 16) - 1); page = Math.min(page, last);
            const shown = rows.slice(page * 16, (page + 1) * 16);
            const wanted = new Set(shown.map(row => row.id));
            for (const [id, message] of messages) if (!wanted.has(id) || !message.isConnected) {
                actions.recycle(message); message.remove(); messages.delete(id);
            }
            const list = panel.querySelector<HTMLElement>('.activity-discovery-runs')!;
            for (const row of shown) {
                if (messages.has(row.id)) continue;
                // Not a .msg row: legacy first-user VS bootstrap scans that class.
                const message = document.createElement('div'); message.className = 'activity-recorded-run';
                message.dataset['traceRunId'] = row.id; message.dataset['activityDiscovered'] = 'true';
                message.dataset['messageSessionId'] = identity!.sessionId;
                message.dataset['messageId'] = `recorded:${identity!.sessionId}:${row.id}`;
                const body = document.createElement('div'); body.className = 'agent-body';
                const label = document.createElement('p'); label.className = 'activity-record-label';
                label.textContent = `Recorded run ${row.id}`;
                const answer = document.createElement('div'); answer.className = 'msg-content';
                body.append(label, answer); message.append(body); list.append(message); messages.set(row.id, message);
            }
            const status = panel.querySelector<HTMLElement>('.activity-discovery-status')!;
            status.textContent = `${rows.length} other runs in this record window. Page ${rows.length ? page + 1 : 0} / ${rows.length ? last + 1 : 0}.`
                + (incomplete ? ' Discovery is limited; more records may exist. IDs are not chronological.' : ' IDs are not chronological.');
            panel.querySelector<HTMLButtonElement>('[data-discovery-action="previous"]')!.disabled = page === 0;
            panel.querySelector<HTMLButtonElement>('[data-discovery-action="next"]')!.disabled = page >= last;
            panel.querySelector<HTMLButtonElement>('[data-discovery-action="window"]')!.disabled = !nextAfter;
        });
        if (panel.open && enabled) actions.inspect(panel);
    }

    async function refresh(cursor = ''): Promise<void> {
        if (!identity || !enabled || loadedSession !== identity.sessionId) return;
        controller?.abort(); const own = new AbortController(); controller = own;
        const captured = { ...identity }, epoch = ++generation;
        const timer = setTimeout(() => own.abort(new DOMException('Recorded-run read deadline', 'TimeoutError')), 30_000);
        const panel = ensureRoot();
        if (panel) panel.querySelector<HTMLElement>('.activity-discovery-status')!.textContent = 'Loading recorded runs.';
        try {
            const result = await readActivityRuns({ sessionId: captured.sessionId, after: cursor,
                signal: own.signal, read: readActivityHttp });
            if (own.signal.aborted || generation !== epoch || loadedSession !== captured.sessionId) return;
            after = cursor; nextAfter = result.nextAfter; incomplete = result.incomplete;
            rows = result.runs.filter(row => !loaded.has(row.id)); page = 0; render();
        } catch (error) {
            if (generation !== epoch) return;
            const current = ensureRoot();
            if (current) {
                current.hidden = false;
                current.querySelector<HTMLElement>('.activity-discovery-status')!.textContent =
                    'Recorded runs could not be loaded. The transcript is unchanged; use Refresh recorded runs to retry.';
            }
            if (!own.signal.aborted) console.warn('[activity] recorded-run discovery failed', error);
        } finally { clearTimeout(timer); if (controller === own) controller = null; }
    }

    return {
        refresh,
        owns(message: HTMLElement) { return messages.get(message.dataset['traceRunId'] ?? '') === message; },
        setIdentity(next: ActivityIdentity | null) {
            if (identity?.sessionId === next?.sessionId && identity?.scope === next?.scope) return;
            ++generation; controller?.abort(); controller = null;
            clearRows(); root?.remove(); root = null; rows = []; page = 0; after = ''; nextAfter = undefined; incomplete = false; open = false;
            identity = next ? { ...next } : null;
        },
        setTranscript(sessionId: string | null, runIds: ReadonlySet<string>) {
            loadedSession = sessionId; loaded = new Set(runIds);
            rows = rows.filter(row => !loaded.has(row.id)); if (root && identity) render();
        },
        setEnabled(value: boolean) {
            enabled = value;
            if (!value) { ++generation; controller?.abort(); controller = null; }
            else if (root?.open) actions.inspect(root);
        },
        retry() { return refresh(after); },
        dispose() {
            ++generation; controller?.abort(); controller = null;
            clearRows(); root?.remove(); root = null; rows = []; loaded.clear(); identity = null;
        },
    };
}

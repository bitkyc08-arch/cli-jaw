import { API_BASE, api, getAuthToken } from '../api.js';
import { escapeHtml } from '../render/html.js';
import { getLang, t } from './i18n.js';

export type SessionSource = 'local' | 'slack' | 'telegram' | 'discord';

export interface SessionListItem {
    id: string;
    seq: number;
    label: string | null;
    message_count: number;
    source?: SessionSource;
    remoteKey?: string | null;
    lastActivityAt?: string | null;
}

export interface SessionListResponse {
    sessions: SessionListItem[];
    active: string;
}

type SessionViewMode = 'off' | 'hub' | 'session' | 'redirect';

interface SessionViewState {
    enabled: boolean;
    mode: SessionViewMode;
    activeId: string | null;
    viewed: SessionListItem | null;
}

const viewState: SessionViewState = {
    enabled: false,
    mode: 'off',
    activeId: null,
    viewed: null,
};

let cancelRecordingOnReadonly: (() => void) | null = null;
let latestList: SessionListResponse | null = null;

const ALLOWED_READONLY_COMMAND = /^\s*(?:\/switch(?:\s|$)|\/sessions(?:\s|$)|\/fork(?:\s|$)|\/\d+(?:\s|$))/i;

function routePath(pathname: string): string {
    const withoutProxy = API_BASE && pathname.startsWith(API_BASE)
        ? pathname.slice(API_BASE.length)
        : pathname;
    return withoutProxy || '/';
}

function parsedSeq(pathname: string): number | null {
    const match = routePath(pathname).match(/^\/(\d+)\/?$/);
    return match ? Number(match[1]) : null;
}

function navigationFieldsPresent(response: SessionListResponse): boolean {
    return response.sessions.some(session => Object.prototype.hasOwnProperty.call(session, 'source'));
}

export function configureSessionView(response: SessionListResponse, pathname = window.location.pathname): SessionViewMode {
    latestList = response;
    if (!navigationFieldsPresent(response)) {
        Object.assign(viewState, { enabled: false, mode: 'off', activeId: null, viewed: null });
        return 'off';
    }

    const path = routePath(pathname);
    if (path === '/' || path === '') {
        Object.assign(viewState, { enabled: true, mode: 'hub', activeId: response.active, viewed: null });
        return 'hub';
    }

    const seq = parsedSeq(pathname);
    const viewed = seq === null ? null : response.sessions.find(session => session.seq === seq) || null;
    if (!viewed) {
        Object.assign(viewState, { enabled: true, mode: 'redirect', activeId: response.active, viewed: null });
        return 'redirect';
    }

    Object.assign(viewState, { enabled: true, mode: 'session', activeId: response.active, viewed });
    if (!canSendFromCurrentView()) cancelRecordingOnReadonly?.();
    return 'session';
}

export function canSendFromCurrentView(commandText = ''): boolean {
    // Fail CLOSED on numeric routes before initialization. Write listeners are
    // installed at module load (main.ts:120) but initializeSessionView() only
    // runs later in bootstrap, so an early click on /:seq would otherwise pass
    // the guard and write to the GLOBAL active session — the exact
    // cross-session write this guard exists to prevent.
    if (!viewState.enabled) {
        if (parsedSeq(window.location.pathname) === null) return true;
        return commandText ? ALLOWED_READONLY_COMMAND.test(commandText) : false;
    }
    if (commandText && ALLOWED_READONLY_COMMAND.test(commandText)) return true;
    return viewState.mode === 'session'
        && viewState.viewed?.id === viewState.activeId
        && viewState.viewed.remoteKey === null;
}

export function currentSessionId(): string | null {
    return viewState.enabled && viewState.mode === 'session' ? viewState.viewed?.id || null : null;
}

// Mirrors scopeForChatSession() on the server (src/orchestrator/scope.ts). A tab on the
// hub or on a pre-navigation build returns null, which means an unfiltered connection
// that receives everything — the behaviour before per-tab scoping existed.
//
// Remotely bound sessions run under their remote key, so a tab viewing one must
// subscribe to that key rather than a local scope it would never see events on.
export function currentEventScope(): string | null {
    if (!viewState.enabled || viewState.mode !== 'session') return null;
    const viewed = viewState.viewed;
    if (!viewed) return null;
    if (viewed.id === 'default') return 'default';
    if (viewed.remoteKey) return viewed.remoteKey;
    return `local:${viewed.id}`;
}

export function withCurrentSessionQuery(path: string): string {
    const sessionId = currentSessionId();
    if (!sessionId) return path;
    if (path.startsWith('?')) {
        const params = new URLSearchParams(path.slice(1));
        params.set('session', sessionId);
        return `?${params.toString()}`;
    }
    const url = new URL(path, 'http://session.local');
    url.searchParams.set('session', sessionId);
    return `${url.pathname}${url.search}${url.hash}`;
}

function sessionHref(seq: number): string {
    return `${API_BASE}/${seq}`;
}

function hubHref(): string {
    return API_BASE || '/';
}

function displayLabel(session: SessionListItem): string {
    if (session.seq === 0) return t('sessionHub.defaultSession');
    return session.label?.trim() || t('sessionHub.sessionLabel', { seq: session.seq });
}

function formatLastActivity(value: string | null | undefined): string {
    if (value == null) return t('sessionHub.noActivity');
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t('sessionHub.noActivity');
    return new Intl.DateTimeFormat(getLang(), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function sourceLabel(source: SessionSource | undefined): string {
    return t(`sessionHub.source.${source || 'local'}`);
}

function renderSessionCard(session: SessionListItem, activeId: string): string {
    const remoteBound = session.remoteKey != null;
    const canDelete = session.id !== 'default' && !remoteBound;
    const deleteReason = remoteBound ? t('sessionHub.deleteRemoteDisabled') : '';
    return `<article class="session-card${session.id === activeId ? ' is-active' : ''}" data-session-id="${escapeHtml(session.id)}">
        <a class="session-card-link" href="${escapeHtml(sessionHref(session.seq))}">
            <div class="session-card-heading">
                <span class="session-seq">/${session.seq}</span>
                <span class="session-source">${escapeHtml(sourceLabel(session.source))}</span>
            </div>
            <h2>${escapeHtml(displayLabel(session))}</h2>
            <dl class="session-card-meta">
                <div><dt>${escapeHtml(t('sessionHub.messages'))}</dt><dd>${session.message_count}</dd></div>
                <div><dt>${escapeHtml(t('sessionHub.lastActivity'))}</dt><dd>${escapeHtml(formatLastActivity(session.lastActivityAt))}</dd></div>
            </dl>
        </a>
        ${session.id === 'default' ? '' : (canDelete
            // A disabled button is not focusable and its title is unreliable on
            // touch and assistive tech, so the remote-bound reason is rendered as
            // visible text and wired with aria-describedby instead.
            ? `<button type="button" class="session-delete" data-delete-session="${escapeHtml(session.id)}">${escapeHtml(t('sessionHub.delete'))}</button>`
            : `<button type="button" class="session-delete" data-delete-session="${escapeHtml(session.id)}" aria-disabled="true" aria-describedby="delete-reason-${escapeHtml(session.id)}">${escapeHtml(t('sessionHub.delete'))}</button>
               <p class="session-delete-reason" id="delete-reason-${escapeHtml(session.id)}">${escapeHtml(deleteReason)}</p>`)}
    </article>`;
}

function renderHubSkeleton(): void {
    document.body.classList.add('session-hub-mode');
    let hub = document.getElementById('sessionHub');
    if (!hub) {
        hub = document.createElement('main');
        hub.id = 'sessionHub';
        hub.className = 'session-hub';
        document.body.prepend(hub);
    }
    hub.setAttribute('aria-busy', 'true');
    hub.innerHTML = `<div class="session-hub-shell">
        <header class="session-hub-header"><div><p class="session-hub-kicker">CLI-JAW</p><h1>${escapeHtml(t('sessionHub.title'))}</h1></div></header>
        <div class="session-grid session-grid-loading" aria-hidden="true">
            <div class="session-card-skeleton"><span></span><span></span><span></span></div>
            <div class="session-card-skeleton"><span></span><span></span><span></span></div>
        </div>
    </div>`;
}

function renderHub(response: SessionListResponse): void {
    document.body.classList.add('session-hub-mode');
    let hub = document.getElementById('sessionHub');
    if (!hub) {
        hub = document.createElement('main');
        hub.id = 'sessionHub';
        hub.className = 'session-hub';
        document.body.prepend(hub);
    }
    hub.removeAttribute('aria-busy');
    const onlyDefault = response.sessions.length === 1 && response.sessions[0]?.id === 'default';
    hub.innerHTML = `<div class="session-hub-shell">
        <header class="session-hub-header">
            <div><p class="session-hub-kicker">CLI-JAW</p><h1>${escapeHtml(t('sessionHub.title'))}</h1></div>
            <p>${escapeHtml(t('sessionHub.description'))}</p>
        </header>
        ${onlyDefault ? `<section class="session-hub-empty" aria-labelledby="sessionHubEmptyTitle">
            <h2 id="sessionHubEmptyTitle">${escapeHtml(t('sessionHub.empty.title'))}</h2>
            <p>${escapeHtml(t('sessionHub.empty.description'))}</p>
            <a href="${escapeHtml(sessionHref(0))}#settings">${escapeHtml(t('sessionHub.empty.action'))}</a>
        </section>` : ''}
        <section class="session-grid" aria-label="${escapeHtml(t('sessionHub.listAria'))}">
            ${response.sessions.map(session => renderSessionCard(session, response.active)).join('')}
        </section>
        <p class="session-hub-error" id="sessionHubError" role="status" aria-live="polite"></p>
    </div>`;
    if (!hub.dataset['eventsBound']) {
        hub.addEventListener('click', handleHubClick);
        hub.dataset['eventsBound'] = 'true';
    }
}

async function handleHubClick(event: Event): Promise<void> {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-delete-session]');
    // aria-disabled keeps the control focusable so its reason can be announced,
    // so activation has to be suppressed here rather than by the DOM.
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
    event.preventDefault();
    const sessionId = button.dataset['deleteSession'];
    if (!sessionId || !window.confirm(t('sessionHub.deleteConfirm'))) return;
    button.disabled = true;
    const token = await getAuthToken();
    try {
        const response = await fetch(`${API_BASE}/api/chat-sessions/${encodeURIComponent(sessionId)}`, {
            method: 'DELETE',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!response.ok) throw new Error(String(response.status));
        const refreshed = await api<SessionListResponse>('/api/chat-sessions');
        if (refreshed) {
            latestList = refreshed;
            renderHub(refreshed);
        }
    } catch {
        const error = document.getElementById('sessionHubError');
        if (error) error.textContent = t('sessionHub.deleteFailed');
        button.disabled = false;
    }
}

function renderSessionViewChrome(): void {
    const viewed = viewState.viewed;
    if (!viewed) return;
    document.title = `${displayLabel(viewed)} · CLI-JAW`;
    const header = document.querySelector<HTMLElement>('.chat-header > span');
    if (header) header.insertAdjacentHTML('beforeend', `<span class="session-view-label">/${viewed.seq} · ${escapeHtml(displayLabel(viewed))}</span>`);
    if (!canSendFromCurrentView()) showReadOnlySwitchAffordance();
}

export function showReadOnlySwitchAffordance(): void {
    if (!viewState.enabled || !viewState.viewed) return;
    let notice = document.getElementById('sessionReadonlyNotice');
    if (!notice) {
        notice = document.createElement('div');
        notice.id = 'sessionReadonlyNotice';
        notice.className = 'session-readonly-notice';
        notice.setAttribute('role', 'status');
        document.querySelector('.chat-input-area')?.before(notice);
    }
    const remote = viewState.viewed.remoteKey != null;
    const command = remote ? '/sessions' : `/switch ${viewState.viewed.seq}`;
    const actionLabel = remote
        ? t('sessionReadonly.openSessions')
        : t('sessionReadonly.switch', { seq: viewState.viewed.seq });
    notice.innerHTML = `<span>${escapeHtml(t(remote ? 'sessionReadonly.remote' : 'sessionReadonly.message'))}</span>
        <button type="button">${escapeHtml(actionLabel)}</button>`;
    notice.querySelector('button')?.addEventListener('click', () => {
        const input = document.getElementById('chatInput') as HTMLTextAreaElement | null;
        if (!input) return;
        input.value = command;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('cmd-execute', { bubbles: true }));
    });
}

export function handleSessionListBroadcast(message: { deleted?: { id?: unknown; seq?: unknown } }): boolean {
    if (!viewState.enabled || viewState.mode !== 'session' || !viewState.viewed) return false;
    const deleted = message.deleted;
    if (!deleted) return false;
    if (deleted.id !== viewState.viewed.id && deleted.seq !== viewState.viewed.seq) return false;
    window.location.assign(hubHref());
    return true;
}

export async function initializeSessionView(options: { cancelRecording?: () => void } = {}): Promise<SessionViewMode> {
    cancelRecordingOnReadonly = options.cancelRecording || null;
    const response = await api<SessionListResponse>('/api/chat-sessions');
    if (!response) {
        if (parsedSeq(window.location.pathname) !== null) {
            Object.assign(viewState, { enabled: true, mode: 'redirect', activeId: null, viewed: null });
            window.location.replace(hubHref());
            return 'redirect';
        }
        return 'off';
    }
    const mode = configureSessionView(response);
    if (mode === 'hub') {
        renderHubSkeleton();
        const refreshed = await api<SessionListResponse>('/api/chat-sessions');
        renderHub(refreshed || response);
    }
    if (mode === 'session') renderSessionViewChrome();
    if (mode === 'redirect') window.location.replace(hubHref());
    return mode;
}
